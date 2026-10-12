// POST /v1/captures — accept a base64 image, exact-dup check by content hash,
// store to S3, record the capture, queue processing. Returns 202 (queued) or
// 200 (exact duplicate of a previous upload).
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json, parseBody, type ApiHandler } from '../lib/http.js';
import {
  cleanBase64,
  detectMediaType,
  extensionFor,
  imageSha256,
} from '../pipeline/image.js';
import { logger, safeError } from '../lib/logger.js';

interface CreateRequest {
  imageBase64: string;
}

// Client resizes to ~1000px longest edge (~300KB); 8MB decoded is a hard
// backstop well under API Gateway's 10MB payload cap.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function makeHandler(deps: Deps): ApiHandler {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const { imageBase64 } = parseBody<CreateRequest>(event);
      if (!imageBase64) throw new HttpError(400, 'imageBase64 is required');

      const clean = cleanBase64(imageBase64);
      const bytes = Buffer.from(clean, 'base64');
      if (bytes.length === 0) throw new HttpError(400, 'imageBase64 is not valid base64');
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new HttpError(413, 'Image too large — resize before uploading');
      }

      const sha256 = imageSha256(clean);
      const captureId = ulid();
      const existing = await deps.store.claimImageHash(user.userId, sha256, captureId);
      if (existing) {
        return json(200, { captureId: existing, status: 'duplicate', duplicateOf: existing });
      }

      const mediaType = detectMediaType(clean);
      const imageKey = deps.images.captureKey(user.userId, captureId, extensionFor(mediaType));
      try {
        await deps.images.putImage(imageKey, bytes, mediaType);
        await deps.store.createCapture(
          {
            userId: user.userId,
            status: 'queued',
            imageKey,
            imageSha256: sha256,
            mediaType,
          },
          captureId,
        );
        await deps.enqueueProcess(user.userId, captureId);
      } catch (e) {
        // The hash is already claimed, so without this a retry of the same
        // upload would come back as a duplicate of a capture that was never
        // stored or queued. Release the claim and any partial capture, then
        // fail as before. Best-effort: a cleanup error must not hide the cause.
        await deps.store.deleteCapture(user.userId, captureId, sha256).catch((cleanupError: unknown) => {
          logger.warn('capture_create_cleanup_failed', {
            userId: user.userId,
            captureId,
            error: safeError(cleanupError),
          });
        });
        throw e;
      }
      logger.info('capture_queued', { userId: user.userId, captureId });
      return json(202, { captureId, status: 'queued' });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export const handler = (event: APIGatewayProxyEventV2) =>
  makeHandler(realDeps())(event);
