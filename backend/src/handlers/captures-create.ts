// POST /v1/captures — accept a base64 image, exact-dup check by content hash,
// store to S3, record the capture, queue processing. Returns 202 (queued) or
// 200 (exact duplicate of a previous upload).
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json, parseBody } from '../lib/http.js';
import {
  cleanBase64,
  detectMediaType,
  extensionFor,
  imageSha256,
} from '../pipeline/image.js';
import { isBlocked } from '../pipeline/moderation.js';
import { logger, safeError } from '../lib/logger.js';

interface CreateRequest {
  imageBase64: string;
}

// Client resizes to ~1000px longest edge (~300KB); 8MB decoded is a hard
// backstop well under API Gateway's 10MB payload cap.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function makeHandler(deps: Deps): APIGatewayProxyHandlerV2 {
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

      const mediaType = detectMediaType(clean);

      // Content moderation, fail-closed: reject explicit images before anything
      // is persisted — no S3 object, no hash claim, no capture, no queue message.
      // See docs/decisions/0004-content-moderation-at-ingest.md.
      if (deps.config.moderationEnabled) {
        if (mediaType !== 'image/jpeg' && mediaType !== 'image/png') {
          // Rekognition inspects JPEG/PNG only; the client always sends resized
          // JPEG, so an unmoderatable format can't be checked → refuse it.
          throw new HttpError(415, 'Unsupported image format');
        }
        let labels;
        try {
          labels = await deps.moderate(bytes, mediaType);
        } catch (e) {
          logger.error('moderation_unavailable', { error: safeError(e) });
          throw new HttpError(503, 'Image could not be checked right now — please try again');
        }
        if (
          isBlocked(labels, {
            blockCategories: deps.config.moderationBlockCategories,
            minConfidence: deps.config.moderationMinConfidence,
          })
        ) {
          // No content or labels in logs — just that a block happened.
          logger.warn('moderation_blocked', { userId: user.userId });
          throw new HttpError(422, 'This image can’t be added');
        }
      }

      const sha256 = imageSha256(clean);
      const captureId = ulid();
      const existing = await deps.store.claimImageHash(user.userId, sha256, captureId);
      if (existing) {
        return json(200, { captureId: existing, status: 'duplicate', duplicateOf: existing });
      }

      const imageKey = deps.images.captureKey(user.userId, captureId, extensionFor(mediaType));
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
      logger.info('capture_queued', { userId: user.userId, captureId });
      return json(202, { captureId, status: 'queued' });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export const handler: APIGatewayProxyHandlerV2 = (event, context, callback) =>
  makeHandler(realDeps())(event, context, callback);
