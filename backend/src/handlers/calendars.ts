// GET  /v1/calendars — the user's writable calendars (for the picker)
// POST /v1/calendars — create a new calendar and return it
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json, parseBody, type ApiHandler } from '../lib/http.js';

export function makeListHandler(deps: Deps): ApiHandler {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const accessToken = await deps.googleAccessToken(user);
      const calendars = await deps.calendar.listWritableCalendars(accessToken);
      return json(200, {
        calendars: calendars.map((c) => ({
          id: c.id,
          summary: c.summary,
          primary: c.primary ?? false,
        })),
      });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function makeCreateHandler(deps: Deps): ApiHandler {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const { summary } = parseBody<{ summary: string }>(event);
      if (!summary?.trim()) throw new HttpError(400, 'summary is required');
      const accessToken = await deps.googleAccessToken(user);
      const created = await deps.calendar.createCalendar(
        accessToken,
        summary.trim(),
        user.settings.timezone || 'Europe/London',
      );
      return json(201, { id: created.id, summary: created.summary });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export const listHandler = (event: APIGatewayProxyEventV2) =>
  makeListHandler(realDeps())(event);
export const createHandler = (event: APIGatewayProxyEventV2) =>
  makeCreateHandler(realDeps())(event);
