// GET /v1/health — unauthenticated liveness probe.
import { json, type ApiHandler } from '../lib/http.js';

export const handler: ApiHandler = async () =>
  json(200, { status: 'ok', stage: process.env.STAGE ?? 'unknown' });
