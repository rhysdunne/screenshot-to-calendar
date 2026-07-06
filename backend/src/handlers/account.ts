// GDPR endpoints.
// POST   /v1/account/export — bundle every stored record (minus secrets) into
//                             an S3 object and return a presigned URL (7-day
//                             lifecycle expiry on the exports/ prefix).
// DELETE /v1/account        — delete all images and records, revoke the Google
//                             refresh token, and invalidate all sessions.
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, json } from '../lib/http.js';
import { decrypt } from '../lib/crypto.js';
import { revokeToken } from '../lib/google-auth.js';
import { logger } from '../lib/logger.js';

export function makeExportHandler(deps: Deps): APIGatewayProxyHandlerV2 {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const items = await deps.store.listAllUserItems(user.userId);
      // Never export the encrypted refresh token or index attributes.
      const sanitized = items.map((item) => {
        const { encRefreshToken, PK, SK, GSI1PK, GSI1SK, ...rest } = item;
        return rest;
      });
      const exportId = ulid();
      const key = await deps.images.putExport(
        user.userId,
        exportId,
        Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), items: sanitized }, null, 2)),
      );
      const url = await deps.images.presignGet(key, 3600);
      logger.info('account_exported', { userId: user.userId, exportId });
      return json(200, { url, expiresInSeconds: 3600 });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function makeDeleteHandler(deps: Deps): APIGatewayProxyHandlerV2 {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);

      // Revoke Google access first (best-effort — deletion proceeds regardless).
      if (user.encRefreshToken) {
        try {
          const encKey = await deps.getSecret('token-enc-key');
          await revokeToken(decrypt(user.encRefreshToken, encKey));
        } catch (e) {
          logger.warn('google_revoke_failed', { userId: user.userId, error: String(e) });
        }
      }

      const objectsDeleted = await deps.images.deleteUserObjects(user.userId);
      const recordsDeleted = await deps.store.deleteAllUserItems(user.userId);
      logger.info('account_deleted', {
        userId: user.userId,
        objectsDeleted,
        recordsDeleted,
      });
      return json(200, { deleted: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export const exportHandler: APIGatewayProxyHandlerV2 = (e, c, cb) =>
  makeExportHandler(realDeps())(e, c, cb);
export const deleteHandler: APIGatewayProxyHandlerV2 = (e, c, cb) =>
  makeDeleteHandler(realDeps())(e, c, cb);
