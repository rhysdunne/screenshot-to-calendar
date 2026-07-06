// PATCH /v1/captures/{id} — user corrections. Each changed field is recorded
// as a CORRECTION item (the prompt-improvement training signal — the original
// `event` object is never overwritten), the Google Calendar event is patched,
// and the merged view is returned.
//
// Poisoning defense #1 lives here: max 20 corrections per user per day.
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json, parseBody } from '../lib/http.js';
import { mapEventToCalendar } from '../pipeline/map-to-calendar.js';
import { todayInZone } from '../pipeline/dates.js';
import {
  CORRECTABLE_FIELDS,
  type CorrectableField,
  type ExtractedEvent,
} from '../pipeline/types.js';
import { captureView } from './captures-read.js';
import { logger } from '../lib/logger.js';

const DAILY_CORRECTION_LIMIT = 20;

type UpdateRequest = Partial<Record<CorrectableField, string | null>>;

export function makeHandler(deps: Deps): APIGatewayProxyHandlerV2 {
  return async (event) => {
    try {
      const user = await authenticate(event, deps.store, deps.getSecret);
      const captureId = event.pathParameters?.id;
      if (!captureId) throw new HttpError(400, 'Missing capture id');
      const capture = await deps.store.getCapture(user.userId, captureId);
      if (!capture) throw new HttpError(404, 'Capture not found');
      if (!capture.event) throw new HttpError(409, 'Capture has no extracted event to correct');

      const body = parseBody<UpdateRequest>(event);
      const effective: ExtractedEvent = { ...capture.event, ...capture.corrected };
      const changes: Array<{ field: CorrectableField; oldValue: string | null; newValue: string | null }> = [];
      for (const field of CORRECTABLE_FIELDS) {
        if (!(field in body)) continue;
        const newValue = body[field] === '' ? null : (body[field] ?? null);
        if (newValue !== effective[field]) {
          changes.push({ field, oldValue: effective[field], newValue });
        }
      }
      if (changes.length === 0) return json(200, captureView(capture));

      const usedToday = await deps.store.countCorrectionsToday(user.userId);
      if (usedToday + changes.length > DAILY_CORRECTION_LIMIT) {
        throw new HttpError(429, 'Daily correction limit reached', 'correction_limit');
      }

      for (const change of changes) {
        await deps.store.putCorrection({
          userId: user.userId,
          captureId,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          imageKey: capture.imageKey,
          consentEvalUse: user.settings.consentEvalUse,
        });
      }

      const corrected: Partial<ExtractedEvent> = { ...capture.corrected };
      for (const change of changes) {
        (corrected as Record<string, string | null>)[change.field] = change.newValue;
      }
      const merged: ExtractedEvent = { ...capture.event, ...corrected };

      // Patch the calendar event to match the corrected data.
      if (capture.calendarEventId && capture.calendarId) {
        const timeZone = user.settings.timezone || 'Europe/London';
        const calendarBody = mapEventToCalendar(merged, {
          today: todayInZone(timeZone),
          timeZone,
          captureLink: `${deps.config.deepLinkBase}/c/${captureId}`,
        });
        const accessToken = await deps.googleAccessToken(user);
        await deps.calendar.patchEvent(
          accessToken,
          capture.calendarId,
          capture.calendarEventId,
          calendarBody,
        );
      }

      await deps.store.updateCapture(user.userId, captureId, { corrected });
      logger.info('capture_corrected', {
        userId: user.userId,
        captureId,
        fields: changes.map((c) => c.field),
      });
      const updated = await deps.store.getCapture(user.userId, captureId);
      return json(200, captureView(updated!));
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export const handler: APIGatewayProxyHandlerV2 = (e, c, cb) =>
  makeHandler(realDeps())(e, c, cb);
