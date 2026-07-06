// GET/PUT /v1/settings — {calendarId, timezone, consentEvalUse}.
// consentEvalUse is the GDPR consent flag gating whether this user's images
// and corrections may enter the eval dataset / prompt-improvement pipeline.
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json, parseBody } from '../lib/http.js';
import type { UserSettings } from '../lib/ddb.js';

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function makeGetHandler(deps: Deps): APIGatewayProxyHandlerV2 {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      return json(200, user.settings);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function makePutHandler(deps: Deps): APIGatewayProxyHandlerV2 {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const body = parseBody<Partial<UserSettings>>(event);
      const settings: UserSettings = { ...user.settings };
      if ('calendarId' in body) settings.calendarId = body.calendarId ?? null;
      if (body.timezone !== undefined) {
        if (!isValidTimezone(body.timezone)) throw new HttpError(400, 'Invalid timezone');
        settings.timezone = body.timezone;
      }
      if (body.consentEvalUse !== undefined) {
        settings.consentEvalUse = body.consentEvalUse === true;
      }
      await deps.store.updateUser(user.userId, { settings });
      return json(200, settings);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export const getHandler: APIGatewayProxyHandlerV2 = (e, c, cb) =>
  makeGetHandler(realDeps())(e, c, cb);
export const putHandler: APIGatewayProxyHandlerV2 = (e, c, cb) =>
  makePutHandler(realDeps())(e, c, cb);
