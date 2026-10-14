// GET /v1/captures          — library feed (newest first, cursor pagination)
// GET /v1/captures/{id}     — capture detail; the app's processing-status poll target
// GET /v1/captures/{id}/image — short-lived presigned URL for the source image
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json, type ApiHandler } from '../lib/http.js';
import type { CaptureRecord } from '../lib/ddb.js';

// The app does not follow the cursor yet, so the first page is the whole
// library it shows. 200 keeps a personal library on one page. listCaptures
// reads one capture more, to return a cursor only when an older one exists.
// At 1-2 KB a capture those 201 are inside DynamoDB's 1 MB read per Query
// (past which the page comes back short, with a cursor) and the page is well
// inside the 6 MB Lambda response.
const LIBRARY_PAGE_SIZE = 200;

// A processor that times out or crashes never reaches the catch block in
// process-capture.ts, so the stored status stays queued or processing after
// SQS moves the message to the DLQ. Every attempt rewrites `processing`, which
// refreshes updatedAt, and SQS retries a dead attempt once the queue's
// visibility timeout runs out (infra/lib/backend-stack.ts: processor timeout
// 120 s, visibility 180 s, maxReceiveCount 3). The visibility timeout starts
// when the attempt receives the message, so its write and the retry are about
// 3 of the 10 minutes apart. A capture that nothing has written for 10 minutes
// is reported as failed. The stack tests hold the visibility timeout well
// under this; change them together.
//
// Time in the queue counts too, and the threshold does not allow for it.
// Nothing writes a capture while its message waits: a new capture keeps
// updatedAt from its creation, and one between retries keeps the start of its
// last attempt. The processor takes two captures at a time (maxConcurrency 2),
// so a backlog can hold a live capture past 10 minutes: a burst of shares, a
// DLQ redrive, or slow Claude replies where each attempt runs to the 120 s
// timeout. That needs about 60 captures ahead at normal speed, or about 10
// when every attempt times out. The API then reports the live capture as
// failed and tells the user to delete it. If the user does, the processor
// drops the message when it gets to it (capture_missing).
export const STALLED_AFTER_MS = 10 * 60 * 1000;
// Says delete first: sharing the same image again without deleting returns
// this capture as a duplicate (the exact-image dedup in captures-create.ts).
export const STALLED_ERROR =
  'Processing did not finish. Delete this capture, then share the screenshot again.';

/**
 * True when the stored status is queued or processing but nothing has written
 * the capture for STALLED_AFTER_MS. Elapsed time, not a calendar date, so no
 * timezone is involved. Falls back to createdAt when updatedAt does not parse;
 * when neither parses, the capture is not stalled.
 */
export function isStalled(c: CaptureRecord, now: Date): boolean {
  if (c.status !== 'queued' && c.status !== 'processing') return false;
  const updated = Date.parse(c.updatedAt);
  const since = Number.isNaN(updated) ? Date.parse(c.createdAt) : updated;
  if (Number.isNaN(since)) return false;
  return now.getTime() - since > STALLED_AFTER_MS;
}

// `now` is a Date, not a number, so `items.map(captureView)` does not compile:
// map would pass the array index as `now`.
export function captureView(c: CaptureRecord, now: Date = new Date()) {
  // A duplicate created no event, so it never reports a calendarEventId.
  // Records written before matchedEventId existed kept the matched event's id
  // in calendarEventId, so for those that id is reported as the match.
  const duplicate = c.status === 'duplicate';
  // Derived on read only: the stored item keeps its status, so a redrive that
  // restarts the capture reports processing again.
  const stalled = isStalled(c, now);
  return {
    captureId: c.captureId,
    status: stalled ? 'failed' : c.status,
    createdAt: c.createdAt,
    classification: c.classification ?? null,
    event: c.event ?? null,
    corrected: c.corrected ?? null,
    calendarEventId: duplicate ? null : (c.calendarEventId ?? null),
    eventLink: c.eventLink ?? null,
    matchedEventId: duplicate ? (c.matchedEventId ?? c.calendarEventId ?? null) : null,
    possibleDuplicateOf: c.possibleDuplicateOf ?? null,
    error: stalled ? STALLED_ERROR : (c.error ?? null),
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
      const now = new Date();
      return json(200, {
        captures: items.map((c) => captureView(c, now)),
        cursor: next ?? null,
      });
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
