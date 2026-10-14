// POST /v1/captures/{id}/approve — the user reviewed a low-confidence (or
// failed-but-extracted) capture in the app and wants the calendar event
// created. Runs the same map → dedup → insert path as the processor, using
// the effective event (corrections overlaid on the original extraction).
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json, type ApiHandler } from '../lib/http.js';
import { createCalendarEntry } from './process-capture.js';
import { captureView, isStalled } from './captures-read.js';
import { NoDateError, TerminalProcessingError, type ExtractedEvent } from '../pipeline/types.js';
import { CaptureGoneError } from '../lib/ddb.js';
import { logger } from '../lib/logger.js';

export function makeHandler(deps: Deps): ApiHandler {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const captureId = event.pathParameters?.id;
      if (!captureId) throw new HttpError(400, 'Missing capture id');
      const capture = await deps.store.getCapture(user.userId, captureId);
      if (!capture) throw new HttpError(404, 'Capture not found');
      // A stalled capture is reported as failed (captureView). One that kept
      // an event from an earlier attempt (a redelivery or a redrive of a
      // capture that had already finished) shows the approve action, so it is
      // accepted here as a failed one is.
      if (
        capture.status !== 'needs_review' &&
        capture.status !== 'failed' &&
        !isStalled(capture, new Date())
      ) {
        throw new HttpError(409, `Capture is ${capture.status}, not awaiting approval`);
      }
      if (!capture.event) {
        throw new HttpError(409, 'Capture has no extracted event to approve');
      }

      const effective: ExtractedEvent = { ...capture.event, ...capture.corrected };
      let updates;
      try {
        updates = await createCalendarEntry(deps, user, captureId, effective);
      } catch (e) {
        if (e instanceof NoDateError) {
          throw new HttpError(409, 'Add a date before approving — none was extracted.');
        }
        if (e instanceof TerminalProcessingError) throw new HttpError(409, e.message);
        throw e;
      }
      // Clear the old error first and let updates override it: when there is
      // still no target calendar, updates carries fresh guidance to show.
      try {
        await deps.store.updateCapture(user.userId, captureId, { error: null, ...updates });
      } catch (e) {
        // Deleted since it was read above, for example from another device.
        if (e instanceof CaptureGoneError) throw new HttpError(404, 'Capture not found');
        throw e;
      }
      logger.info('capture_approved', { userId: user.userId, captureId, status: updates.status });
      const updated = await deps.store.getCapture(user.userId, captureId);
      if (!updated) throw new HttpError(404, 'Capture not found');
      return json(200, captureView(updated));
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export const handler = (event: APIGatewayProxyEventV2) =>
  makeHandler(realDeps())(event);
