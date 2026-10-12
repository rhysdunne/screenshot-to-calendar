// DELETE /v1/captures/{id}[?deleteEvent=true] — remove a capture (image +
// records); optionally also delete the calendar event it created.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json, type ApiHandler } from '../lib/http.js';
import { logger } from '../lib/logger.js';

export function makeHandler(deps: Deps): ApiHandler {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const captureId = event.pathParameters?.id;
      if (!captureId) throw new HttpError(400, 'Missing capture id');
      const capture = await deps.store.getCapture(user.userId, captureId);
      if (!capture) throw new HttpError(404, 'Capture not found');

      const deleteEvent = event.queryStringParameters?.deleteEvent === 'true';
      if (deleteEvent && capture.status === 'duplicate') {
        // A duplicate created no event. New duplicates have no calendarEventId,
        // but records written before matchedEventId existed still carry the
        // matched event's id there, and that event belongs to another capture
        // or to the user. Remove the capture only.
        logger.info('capture_delete_event_skipped_duplicate', { userId: user.userId, captureId });
      } else if (deleteEvent && capture.calendarEventId && capture.calendarId) {
        const accessToken = await deps.googleAccessToken(user);
        await deps.calendar.deleteEvent(accessToken, capture.calendarId, capture.calendarEventId);
      }

      await deps.images.deleteObject(capture.imageKey);
      await deps.store.deleteCapture(user.userId, captureId, capture.imageSha256);
      logger.info('capture_deleted', { userId: user.userId, captureId });
      return json(200, { deleted: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export const handler = (event: APIGatewayProxyEventV2) =>
  makeHandler(realDeps())(event);
