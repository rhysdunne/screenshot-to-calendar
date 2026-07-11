// Real dependency wiring for the Lambda handlers, built lazily so tests can
// import handler modules without AWS env vars set. Handlers accept a Deps
// object (dependency injection) and export a default handler bound to these.
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DdbStore, type UserRecord } from '../lib/ddb.js';
import { ImageStore } from '../lib/s3.js';
import { env, envOr, getSecret } from '../lib/config.js';
import { decrypt } from '../lib/crypto.js';
import { GoogleAuthError, refreshAccessToken } from '../lib/google-auth.js';
import { HttpError } from '../lib/http.js';
import { callClaude } from '../lib/anthropic.js';
import * as gcal from '../lib/google-calendar.js';
import { resolveVenue } from '../lib/google-places.js';
import { DEFAULT_MODELS } from '../lib/models.js';

// Structural types (public methods only) so tests can inject in-memory fakes.
export type Store = Pick<
  DdbStore,
  | 'getUser'
  | 'getUserByGoogleSub'
  | 'putUser'
  | 'updateUser'
  | 'createCapture'
  | 'getCapture'
  | 'listCaptures'
  | 'updateCapture'
  | 'deleteCapture'
  | 'claimImageHash'
  | 'putCorrection'
  | 'countCorrectionsToday'
  | 'putAiCall'
  | 'listAllUserItems'
  | 'deleteAllUserItems'
>;
export type Images = Pick<
  ImageStore,
  'captureKey' | 'putImage' | 'getImage' | 'presignGet' | 'putExport' | 'deleteObject' | 'deleteUserObjects'
>;

export interface Deps {
  store: Store;
  images: Images;
  enqueueProcess: (userId: string, captureId: string) => Promise<void>;
  /** Mint a short-lived Google access token from the user's stored refresh token. */
  googleAccessToken: (user: UserRecord) => Promise<string>;
  callClaude: typeof callClaude;
  calendar: Pick<
    typeof gcal,
    'listWritableCalendars' | 'createCalendar' | 'listEventsInWindow' | 'insertEvent' | 'patchEvent' | 'deleteEvent'
  >;
  resolveVenue: typeof resolveVenue;
  getSecret: typeof getSecret;
  config: {
    deepLinkBase: string;
    classifyModel: string;
    extractModel: string;
    googleClientId: string;
  };
}

let real: Deps | undefined;

export function realDeps(): Deps {
  if (real) return real;
  const sqs = new SQSClient({});
  const queueUrl = env('QUEUE_URL');
  const store = new DdbStore(env('TABLE_NAME'));

  real = {
    store,
    images: new ImageStore(env('BUCKET_NAME')),
    enqueueProcess: async (userId, captureId) => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ userId, captureId }),
        }),
      );
    },
    googleAccessToken: async (user) => {
      if (!user.encRefreshToken) {
        throw new HttpError(401, 'Google account not connected', 'needs_reauth');
      }
      const [encKey, clientSecret] = await Promise.all([
        getSecret('token-enc-key'),
        getSecret('google-oauth-client-secret'),
      ]);
      const refreshToken = decrypt(user.encRefreshToken, encKey);
      try {
        return await refreshAccessToken(refreshToken, env('GOOGLE_CLIENT_ID'), clientSecret);
      } catch (e) {
        if (e instanceof GoogleAuthError && e.code === 'invalid_grant') {
          await store.updateUser(user.userId, { needsReauth: true });
          throw new HttpError(401, 'Google access revoked — sign in again', 'needs_reauth');
        }
        throw e;
      }
    },
    callClaude,
    calendar: gcal,
    resolveVenue,
    getSecret,
    config: {
      deepLinkBase: env('DEEPLINK_BASE_URL'),
      classifyModel: envOr('CLASSIFY_MODEL', DEFAULT_MODELS.classify),
      extractModel: envOr('EXTRACT_MODEL', DEFAULT_MODELS.extract),
      googleClientId: env('GOOGLE_CLIENT_ID'),
    },
  };
  return real;
}
