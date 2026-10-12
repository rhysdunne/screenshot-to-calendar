// PATCH /v1/captures/{id} — user corrections. Values are validated and the
// Google Calendar event is patched first. Only then is each changed field
// recorded as a CORRECTION item (the prompt-improvement training signal — the
// original `event` object is never overwritten), and the merged view returned.
//
// Poisoning defense #1 lives here: max 20 corrections per user per day.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { authenticate, errorResponse, HttpError, json, parseBody, type ApiHandler } from '../lib/http.js';
import { endsAfterStart, mapEventToCalendar } from '../pipeline/map-to-calendar.js';
import { isValidHm, isValidYmd, todayInZone } from '../pipeline/dates.js';
import {
  CORRECTABLE_FIELDS,
  type CalendarEventInput,
  type CorrectableField,
  type ExtractedEvent,
} from '../pipeline/types.js';
import { captureView } from './captures-read.js';
import { logger } from '../lib/logger.js';

const DAILY_CORRECTION_LIMIT = 20;
const DATE_FIELDS: ReadonlySet<CorrectableField> = new Set(['start_date', 'end_date']);
const TIME_FIELDS: ReadonlySet<CorrectableField> = new Set(['start_time', 'end_time']);

type UpdateRequest = Partial<Record<CorrectableField, string | null>>;

export function makeHandler(deps: Deps): ApiHandler {
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
      const requested: UpdateRequest = {};
      for (const field of CORRECTABLE_FIELDS) {
        if (field in body) requested[field] = body[field] === '' ? null : (body[field] ?? null);
      }
      // The app's "Add an end time" switch starts the end at the start time,
      // so saving without moving it sends a zero-length event. A sent end time
      // equal to the start time on the start day is taken as no end time, and
      // the event gets the default length. Only a range that runs backwards, or
      // a start moved onto an end the user did not send, is refused below.
      const next: ExtractedEvent = { ...effective, ...requested };
      if (
        requested.end_time &&
        next.end_time === next.start_time &&
        (next.end_date ?? next.start_date) === next.start_date
      ) {
        requested.end_time = null;
      }
      const changes: Array<{ field: CorrectableField; oldValue: string | null; newValue: string | null }> = [];
      for (const field of CORRECTABLE_FIELDS) {
        if (!(field in requested)) continue;
        const newValue = requested[field] ?? null;
        if (newValue !== effective[field]) {
          changes.push({ field, oldValue: effective[field], newValue });
        }
      }
      if (changes.length === 0) return json(200, captureView(capture));

      for (const { field, newValue } of changes) {
        if (newValue === null) continue;
        if (DATE_FIELDS.has(field) && !isValidYmd(newValue)) {
          throw new HttpError(400, `${field} must be a date (YYYY-MM-DD)`);
        }
        if (TIME_FIELDS.has(field) && !isValidHm(newValue)) {
          throw new HttpError(400, `${field} must be a 24-hour time (HH:MM)`);
        }
      }

      const usedToday = await deps.store.countCorrectionsToday(user.userId);
      if (usedToday + changes.length > DAILY_CORRECTION_LIMIT) {
        throw new HttpError(429, 'Daily correction limit reached', 'correction_limit');
      }

      const corrected: Partial<ExtractedEvent> = { ...capture.corrected };
      for (const change of changes) {
        (corrected as Record<string, string | null>)[change.field] = change.newValue;
      }
      const merged: ExtractedEvent = { ...capture.event, ...corrected };

      // The calendar event to patch to match the corrected data. Never for a
      // duplicate: new duplicates have no calendarEventId, but records written
      // before matchedEventId existed still carry the matched event's id there,
      // and that event belongs to another capture or to the user.
      const target =
        capture.calendarEventId && capture.calendarId && capture.status !== 'duplicate'
          ? { calendarId: capture.calendarId, eventId: capture.calendarEventId }
          : undefined;

      // Map the merged event before anything is written, when it is going to
      // Google or its timing changed, so an edit that leaves it ending before
      // it starts is a 400 rather than a Google error or a capture that cannot
      // be approved. A title edit on a capture with no event is not blocked.
      const timingChanged = changes.some(
        ({ field }) => DATE_FIELDS.has(field) || TIME_FIELDS.has(field),
      );
      let calendarBody: CalendarEventInput | undefined;
      if ((target || timingChanged) && (merged.start_date || merged.end_date)) {
        const timeZone = user.settings.timezone || 'Europe/London';
        calendarBody = mapEventToCalendar(merged, {
          today: todayInZone(timeZone),
          timeZone,
          captureLink: `${deps.config.deepLinkBase}/c/${captureId}`,
        });
        if (!endsAfterStart(calendarBody, merged)) {
          throw new HttpError(400, 'The event must end after it starts', 'invalid_time_range');
        }
      }

      if (target) {
        if (!calendarBody) throw new HttpError(400, 'A calendar event needs a date');
        const accessToken = await deps.googleAccessToken(user);
        await deps.calendar.patchEvent(accessToken, target.calendarId, target.eventId, calendarBody);
      }

      // Recorded only once Google has the change. A failed patch leaves no
      // correction behind, so the training signal never holds an edit the
      // user saw fail.
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

export const handler = (event: APIGatewayProxyEventV2) =>
  makeHandler(realDeps())(event);
