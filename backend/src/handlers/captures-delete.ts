// DELETE /v1/captures/{id}[?deleteEvent=true] — remove a capture (image +
// records); optionally also delete the calendar event it created.
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json } from '../lib/http.js';
import { logger } from '../lib/logger.js';

export function makeHandler(deps: Deps): APIGatewayProxyHandlerV2 {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const captureId = event.pathParameters?.id;
      if (!captureId) throw new HttpError(400, 'Missing capture id');
      const capture = await deps.store.getCapture(user.userId, captureId);
      if (!capture) throw new HttpError(404, 'Capture not found');

      if (
        event.queryStringParameters?.deleteEvent === 'true' &&
        capture.calendarEventId &&
        capture.calendarId
      ) {
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

export const handler: APIGatewayProxyHandlerV2 = (e, c, cb) =>
  makeHandler(realDeps())(e, c, cb);
