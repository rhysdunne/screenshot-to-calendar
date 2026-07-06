// POST /v1/captures/{id}/approve — the user reviewed a low-confidence (or
// failed-but-extracted) capture in the app and wants the calendar event
// created. Runs the same map → dedup → insert path as the processor, using
// the effective event (corrections overlaid on the original extraction).
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json } from '../lib/http.js';
import { createCalendarEntry } from './process-capture.js';
import { captureView } from './captures-read.js';
import { NoDateError, type ExtractedEvent } from '../pipeline/types.js';
import { logger } from '../lib/logger.js';

export function makeHandler(deps: Deps): APIGatewayProxyHandlerV2 {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const captureId = event.pathParameters?.id;
      if (!captureId) throw new HttpError(400, 'Missing capture id');
      const capture = await deps.store.getCapture(user.userId, captureId);
      if (!capture) throw new HttpError(404, 'Capture not found');
      if (capture.status !== 'needs_review' && capture.status !== 'failed') {
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
        throw e;
      }
      await deps.store.updateCapture(user.userId, captureId, { ...updates, error: null });
      logger.info('capture_approved', { userId: user.userId, captureId, status: updates.status });
      const updated = await deps.store.getCapture(user.userId, captureId);
      return json(200, captureView(updated!));
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export const handler: APIGatewayProxyHandlerV2 = (e, c, cb) =>
  makeHandler(realDeps())(e, c, cb);
