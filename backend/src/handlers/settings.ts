// GET/PUT /v1/settings — {calendarId, timezone, consentEvalUse}.
// consentEvalUse is the GDPR consent flag gating whether this user's
// corrections may feed the prompt-improvement pipeline. Images never do. Today
// only the owner's data is read at all: aggregate and materialize both require
// OWNER_USER_ID, so another user's consent has no effect yet.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json, parseBody, type ApiHandler } from '../lib/http.js';
import type { UserSettings } from '../lib/ddb.js';

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function makeGetHandler(deps: Deps): ApiHandler {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      return json(200, user.settings);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function makePutHandler(deps: Deps): ApiHandler {
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

export const getHandler = (event: APIGatewayProxyEventV2) =>
  makeGetHandler(realDeps())(event);
export const putHandler = (event: APIGatewayProxyEventV2) =>
  makePutHandler(realDeps())(event);
