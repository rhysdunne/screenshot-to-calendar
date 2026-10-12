// GET /v1/captures          — library feed (newest first, cursor pagination)
// GET /v1/captures/{id}     — capture detail; the app's processing-status poll target
// GET /v1/captures/{id}/image — short-lived presigned URL for the source image
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json, type ApiHandler } from '../lib/http.js';
import type { CaptureRecord } from '../lib/ddb.js';

// The app does not follow the cursor yet, so the first page is the whole
// library it shows. 200 keeps a personal library on one page. At 1-2 KB a
// capture that is inside DynamoDB's 1 MB read per Query (past which the page
// comes back short, with a cursor) and well inside the 6 MB Lambda response.
const LIBRARY_PAGE_SIZE = 200;

export function captureView(c: CaptureRecord) {
  // A duplicate created no event, so it never reports a calendarEventId.
  // Records written before matchedEventId existed kept the matched event's id
  // in calendarEventId, so for those that id is reported as the match.
  const duplicate = c.status === 'duplicate';
  return {
    captureId: c.captureId,
    status: c.status,
    createdAt: c.createdAt,
    classification: c.classification ?? null,
    event: c.event ?? null,
    corrected: c.corrected ?? null,
    calendarEventId: duplicate ? null : (c.calendarEventId ?? null),
    eventLink: c.eventLink ?? null,
    matchedEventId: duplicate ? (c.matchedEventId ?? c.calendarEventId ?? null) : null,
    possibleDuplicateOf: c.possibleDuplicateOf ?? null,
    error: c.error ?? null,
  };
}

export function makeListHandler(deps: Deps): ApiHandler {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const cursor = event.queryStringParameters?.cursor;
      const { items, cursor: next } = await deps.store.listCaptures(
        user.userId,
        LIBRARY_PAGE_SIZE,
        cursor,
      );
      return json(200, { captures: items.map(captureView), cursor: next ?? null });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function makeGetHandler(deps: Deps): ApiHandler {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const captureId = event.pathParameters?.id;
      if (!captureId) throw new HttpError(400, 'Missing capture id');
      const capture = await deps.store.getCapture(user.userId, captureId);
      if (!capture) throw new HttpError(404, 'Capture not found');
      return json(200, captureView(capture));
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function makeImageUrlHandler(deps: Deps): ApiHandler {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const captureId = event.pathParameters?.id;
      if (!captureId) throw new HttpError(400, 'Missing capture id');
      const capture = await deps.store.getCapture(user.userId, captureId);
      if (!capture) throw new HttpError(404, 'Capture not found');
      const url = await deps.images.presignGet(capture.imageKey, 300);
      return json(200, { url, expiresInSeconds: 300 });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export const listHandler = (event: APIGatewayProxyEventV2) =>
  makeListHandler(realDeps())(event);
export const getHandler = (event: APIGatewayProxyEventV2) =>
  makeGetHandler(realDeps())(event);
export const imageUrlHandler = (event: APIGatewayProxyEventV2) =>
  makeImageUrlHandler(realDeps())(event);
