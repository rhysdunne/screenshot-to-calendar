// GET /v1/captures          — library feed (newest first, cursor pagination)
// GET /v1/captures/{id}     — capture detail; the app's processing-status poll target
// GET /v1/captures/{id}/image — short-lived presigned URL for the source image
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json } from '../lib/http.js';
import type { CaptureRecord } from '../lib/ddb.js';

export function captureView(c: CaptureRecord) {
  return {
    captureId: c.captureId,
    status: c.status,
    createdAt: c.createdAt,
    classification: c.classification ?? null,
    event: c.event ?? null,
    corrected: c.corrected ?? null,
    calendarEventId: c.calendarEventId ?? null,
    eventLink: c.eventLink ?? null,
    possibleDuplicateOf: c.possibleDuplicateOf ?? null,
    error: c.error ?? null,
  };
}

export function makeListHandler(deps: Deps): APIGatewayProxyHandlerV2 {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const cursor = event.queryStringParameters?.cursor;
      const { items, cursor: next } = await deps.store.listCaptures(user.userId, 50, cursor);
      return json(200, { captures: items.map(captureView), cursor: next ?? null });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function makeGetHandler(deps: Deps): APIGatewayProxyHandlerV2 {
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

export function makeImageUrlHandler(deps: Deps): APIGatewayProxyHandlerV2 {
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

export const listHandler: APIGatewayProxyHandlerV2 = (e, c, cb) =>
  makeListHandler(realDeps())(e, c, cb);
export const getHandler: APIGatewayProxyHandlerV2 = (e, c, cb) =>
  makeGetHandler(realDeps())(e, c, cb);
export const imageUrlHandler: APIGatewayProxyHandlerV2 = (e, c, cb) =>
  makeImageUrlHandler(realDeps())(e, c, cb);
