// The pipeline orchestrator: SQS-triggered, one capture per message.
//   classify → extract → resolve venue → dedup → create calendar event
// Pure logic lives in src/pipeline/; this file sequences I/O.
import type { SQSEvent } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { extractSchemaFor, loadPrompt, renderPrompt } from '../prompts/prompts.js';
import { CLASSIFY_IMAGE_SCHEMA } from '../prompts/schemas.js';
import { extractClassification, extractEventData } from '../pipeline/extract.js';
import { endsAfterStart, mapEventToCalendar } from '../pipeline/map-to-calendar.js';
import { addDays, todayInZone } from '../pipeline/dates.js';
import { findDuplicate } from '../pipeline/dedup.js';
import {
  NoDateError,
  TerminalProcessingError,
  type Classification,
  type ExtractedEvent,
} from '../pipeline/types.js';
import type { ImageMediaType } from '../pipeline/image.js';
import type { CaptureRecord, UserRecord } from '../lib/ddb.js';
import { HttpError } from '../lib/http.js';
import { logger, safeError } from '../lib/logger.js';

export interface ProcessMessage {
  userId: string;
  captureId: string;
}

export async function processCapture(deps: Deps, msg: ProcessMessage): Promise<void> {
  const { store, images, config } = deps;
  const capture = await store.getCapture(msg.userId, msg.captureId);
  if (!capture) {
    logger.warn('capture_missing', { ...msg });
    return;
  }
  const user = await store.getUser(msg.userId);
  if (!user) {
    logger.warn('user_missing', { ...msg });
    return;
  }

  // Clears the error an earlier failed attempt left, so a retry that succeeds
  // does not show it on a completed capture.
  await store.updateCapture(msg.userId, msg.captureId, { status: 'processing', error: null });

  // Kept in scope so a failure can persist what the model actually said —
  // otherwise debugging a bad extraction means reproducing the call.
  let rawExtractOutput: string | undefined;
  // Kept in scope so a terminal failure can store them for the app's review
  // screen, where the user fixes the event and approves it.
  let classification: Classification | undefined;
  let event: ExtractedEvent | undefined;

  try {
    const imageBase64 = (await images.getImage(capture.imageKey)).toString('base64');
    const mediaType = capture.mediaType as ImageMediaType;
    const anthropicApiKey = await deps.getSecret('anthropic-api-key');
    const timeZone = user.settings.timezone || 'Europe/London';
    const today = todayInZone(timeZone);
    let totalCost = 0;

    // 1. Classify (cheap model). Non-events skip calendar creation but stay in
    // the library so the user can review them. The scrapbook search design
    // they were kept for is parked.
    const classifyCall = await deps.callClaude({
      apiKey: anthropicApiKey,
      model: config.classifyModel,
      prompt: loadPrompt('classify-image'),
      imageBase64,
      mediaType,
      schema: CLASSIFY_IMAGE_SCHEMA,
      stage: 'classify',
    });
    totalCost += classifyCall.usage.costUsd;
    await store.putAiCall(msg.userId, {
      ...classifyCall.usage,
      userId: msg.userId,
      captureId: msg.captureId,
    });
    classification = extractClassification(classifyCall.response);

    if (!classification.is_event) {
      await store.updateCapture(msg.userId, msg.captureId, {
        status: 'not_event',
        classification,
        costUsd: totalCost,
      });
      return;
    }

    // 2. Extract event data.
    const extractCall = await deps.callClaude({
      apiKey: anthropicApiKey,
      model: config.extractModel,
      prompt: renderPrompt(loadPrompt('extract-event'), { today, timeZone }),
      imageBase64,
      mediaType,
      schema: extractSchemaFor(),
      stage: 'extract',
    });
    totalCost += extractCall.usage.costUsd;
    await store.putAiCall(msg.userId, {
      ...extractCall.usage,
      userId: msg.userId,
      captureId: msg.captureId,
    });
    rawExtractOutput = (extractCall.response.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('');
    event = extractEventData(extractCall.response);

    // 3. Resolve venue → address via Places when missing (non-fatal, and
    // capped at 5 s). The user's timezone picks the city hint.
    if (event.venue && !event.address) {
      try {
        const placesKey = await deps.getSecret('places-api-key');
        const place = await deps.resolveVenue(placesKey, event.venue, timeZone);
        if (place) event = { ...event, address: place.formattedAddress };
      } catch (e) {
        logger.warn('places_lookup_failed', { error: safeError(e) });
      }
    }

    // 4. Confidence gate (issue #2): low-confidence extractions wait for the
    // user to review/approve in the app instead of auto-creating an event.
    if (event.confidence === 'low') {
      await store.updateCapture(msg.userId, msg.captureId, {
        status: 'needs_review',
        classification,
        event,
        costUsd: totalCost,
      });
      return;
    }

    // 5. Dedup + create (shared with the approve endpoint).
    const updates = await createCalendarEntry(deps, user, msg.captureId, event);
    await store.updateCapture(msg.userId, msg.captureId, {
      classification,
      event,
      costUsd: totalCost,
      ...updates,
    });
  } catch (e) {
    // Terminal failures (no date, an end before the start, a model refusal, a
    // Google grant that needs a fresh sign-in) would fail the same way on every
    // retry. They keep whatever was extracted, so when there is an event the
    // app's review screen can fix and approve the capture. Anything else
    // rethrows so SQS retries (×3) and then parks the message on the DLQ.
    // A timeout or crash never gets here: captureView (captures-read.ts)
    // reports that capture as failed once it has stalled.
    const needsReauth = e instanceof HttpError && e.code === 'needs_reauth';
    const terminal = e instanceof TerminalProcessingError || needsReauth;
    const message =
      e instanceof NoDateError
        ? 'No date could be read from this image. Add the date, then add it to your calendar.'
        : e instanceof TerminalProcessingError
          ? e.message
          : needsReauth
            ? 'Google Calendar needs you to sign in again. Sign out in Settings, ' +
              'sign back in, then add this to your calendar.'
            : `Processing failed: ${(e as Error).message}`;
    logger.error('process_capture_failed', { ...msg, terminal, error: safeError(e) });
    if (needsReauth) {
      // The same flag the token refresh sets on invalid_grant; sign-in clears
      // it. Best-effort: losing the flag must not cost the capture its error.
      await store.updateUser(msg.userId, { needsReauth: true }).catch((flagError: unknown) => {
        logger.warn('needs_reauth_flag_failed', { ...msg, error: safeError(flagError) });
      });
    }
    await store.updateCapture(msg.userId, msg.captureId, {
      status: 'failed',
      error: message,
      ...(terminal ? { classification, event } : {}),
      // Debugging aid, never shown in the app (excluded from captureView) and
      // removed by account erasure. Kept short to minimise event content at rest.
      ...(rawExtractOutput ? { rawModelOutput: rawExtractOutput.slice(0, 1000) } : {}),
    });
    if (!terminal) throw e;
  }
}

/**
 * Map → dedup → insert, returning the capture updates to store. Shared by the
 * processor (auto path) and the approve endpoint (needs_review path). Throws a
 * TerminalProcessingError (NoDateError when the event has no dates) when the
 * event cannot become a calendar entry as it stands; each caller maps that.
 */
export async function createCalendarEntry(
  deps: Deps,
  user: UserRecord,
  captureId: string,
  event: ExtractedEvent,
): Promise<Partial<CaptureRecord>> {
  const timeZone = user.settings.timezone || 'Europe/London';
  const today = todayInZone(timeZone);
  const captureLink = `${deps.config.deepLinkBase}/c/${captureId}`;
  const calendarBody = mapEventToCalendar(event, { today, timeZone, captureLink });
  // Google rejects an event that ends before it starts, and a zero-length one
  // is no use either. Mapping already moves a same-day earlier end time to the
  // next day, so what is left here (an end date before the start, an end time
  // given equal to the start time) is a misread that a retry would read the
  // same way.
  if (!endsAfterStart(calendarBody, event)) {
    throw new TerminalProcessingError(
      'The event must end after it starts. Fix the dates or times, then add it to your calendar.',
    );
  }

  const calendarId = user.settings.calendarId;
  if (!calendarId) {
    return {
      status: 'failed',
      error: 'No target calendar selected — open the app and pick a calendar in Settings.',
    };
  }

  // Dedup against existing events in a ±1 day window around the event.
  const accessToken = await deps.googleAccessToken(user);
  const windowStart = 'date' in calendarBody.start
    ? calendarBody.start.date
    : calendarBody.start.dateTime.slice(0, 10);
  const windowEnd = 'date' in calendarBody.end
    ? calendarBody.end.date
    : calendarBody.end.dateTime.slice(0, 10);
  const existing = await deps.calendar.listEventsInWindow(
    accessToken,
    calendarId,
    `${addDays(windowStart, -1)}T00:00:00Z`,
    `${addDays(windowEnd, 1)}T23:59:59Z`,
  );

  // Every event this app creates carries its capture's deep link. One that
  // carries ours was made by an earlier attempt at this same capture: an SQS
  // redelivery after insertEvent succeeded but the Lambda died before the
  // DynamoDB update, or a double approve. Adopt it rather than marking the
  // capture a duplicate of itself or inserting a second copy. Checked across
  // the whole window, not just the dedup match, because a re-extraction can
  // differ enough to miss the duplicate threshold. The adopted event is then
  // patched with this attempt's body: this attempt's extraction is the one the
  // caller stores, so the calendar ends up matching what the app shows.
  const own = existing.find((e) => e.description?.includes(captureLink));
  if (own) {
    await deps.calendar.patchEvent(accessToken, calendarId, own.id, calendarBody);
    return {
      status: 'completed',
      calendarEventId: own.id,
      calendarId,
      eventLink: own.htmlLink,
    };
  }

  const verdict = findDuplicate(calendarBody, existing);

  if (verdict.kind === 'duplicate') {
    // The match is someone else's event (another capture's, or one the user
    // made by hand), so it goes in matchedEventId. calendarEventId stays unset:
    // edit and "delete with event" act on calendarEventId, and must only ever
    // touch an event this capture created. eventLink still opens the match.
    return {
      status: 'duplicate',
      matchedEventId: verdict.event.id,
      matchedCalendarId: calendarId,
      eventLink: verdict.event.htmlLink,
    };
  }

  const created = await deps.calendar.insertEvent(accessToken, calendarId, calendarBody);
  return {
    status: 'completed',
    calendarEventId: created.id,
    calendarId,
    eventLink: created.htmlLink,
    ...(verdict.kind === 'possible' ? { possibleDuplicateOf: verdict.event.id } : {}),
  };
}

export const handler = async (sqsEvent: SQSEvent): Promise<void> => {
  const deps = realDeps();
  for (const record of sqsEvent.Records) {
    await processCapture(deps, JSON.parse(record.body) as ProcessMessage);
  }
};
