// The pipeline orchestrator: SQS-triggered, one capture per message.
//   classify → extract → resolve venue → dedup → create calendar event
// Pure logic lives in src/pipeline/; this file sequences I/O.
import type { SQSHandler } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { extractSchemaFor, loadPrompt, renderPrompt } from '../prompts/prompts.js';
import { CLASSIFY_IMAGE_SCHEMA } from '../prompts/schemas.js';
import { extractEventData } from '../pipeline/extract.js';
import { mapEventToCalendar } from '../pipeline/map-to-calendar.js';
import { addDays, todayInZone } from '../pipeline/dates.js';
import { findDuplicate } from '../pipeline/dedup.js';
import { NoDateError, type Classification, type ExtractedEvent } from '../pipeline/types.js';
import type { ImageMediaType } from '../pipeline/image.js';
import type { CaptureRecord, UserRecord } from '../lib/ddb.js';
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

  await store.updateCapture(msg.userId, msg.captureId, { status: 'processing' });

  // Kept in scope so a failure can persist what the model actually said —
  // otherwise debugging a bad extraction means reproducing the call.
  let rawExtractOutput: string | undefined;

  try {
    const imageBase64 = (await images.getImage(capture.imageKey)).toString('base64');
    const mediaType = capture.mediaType as ImageMediaType;
    const anthropicApiKey = await deps.getSecret('anthropic-api-key');
    const timeZone = user.settings.timezone || 'Europe/London';
    const today = todayInZone(timeZone);
    let totalCost = 0;

    // 1. Classify (cheap model). Non-events stay in the library for the
    // scrapbook direction but skip calendar creation.
    const classifyCall = await deps.callClaude({
      apiKey: anthropicApiKey,
      model: config.classifyModel,
      prompt: loadPrompt('classify-image'),
      imageBase64,
      mediaType,
      schema: CLASSIFY_IMAGE_SCHEMA,
      maxTokens: 256,
      stage: 'classify',
    });
    totalCost += classifyCall.usage.costUsd;
    await store.putAiCall(msg.userId, {
      ...classifyCall.usage,
      userId: msg.userId,
      captureId: msg.captureId,
    });
    const classification = extractClassification(classifyCall.response);

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
      maxTokens: 1024,
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
    let event = extractEventData(extractCall.response);

    // 3. Resolve venue → address via Places when missing (non-fatal).
    if (event.venue && !event.address) {
      try {
        const placesKey = await deps.getSecret('places-api-key');
        const place = await deps.resolveVenue(placesKey, event.venue);
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
    const message =
      e instanceof NoDateError
        ? 'No date could be read from this image.'
        : `Processing failed: ${(e as Error).message}`;
    logger.error('process_capture_failed', { ...msg, error: safeError(e) });
    await store.updateCapture(msg.userId, msg.captureId, {
      status: 'failed',
      error: message,
      // Debugging aid, never shown in the app (excluded from captureView) and
      // removed by account erasure. Kept short to minimise event content at rest.
      ...(rawExtractOutput ? { rawModelOutput: rawExtractOutput.slice(0, 1000) } : {}),
    });
    // NoDateError is terminal — retrying won't conjure a date. Anything else
    // rethrows so SQS retries (×3) and then parks the message on the DLQ.
    if (!(e instanceof NoDateError)) throw e;
  }
}

/**
 * Map → dedup → insert, returning the capture updates to store. Shared by the
 * processor (auto path) and the approve endpoint (needs_review path). Throws
 * NoDateError when the event has no dates; the caller decides terminality.
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
  const verdict = findDuplicate(calendarBody, existing);

  if (verdict.kind === 'duplicate') {
    return {
      status: 'duplicate',
      calendarEventId: verdict.event.id,
      calendarId,
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

function extractClassification(response: {
  content?: Array<{ type: string; text?: string }>;
}): Classification {
  const text = (response.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const raw = JSON.parse(text) as Partial<Classification>;
  const categories = [
    'event_poster',
    'event_screenshot',
    'ticket',
    'other_scrapbook',
    'not_useful',
  ] as const;
  const category = categories.includes(raw.category as (typeof categories)[number])
    ? (raw.category as Classification['category'])
    : 'not_useful';
  return {
    category,
    is_event: raw.is_event === true,
    confidence:
      raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low',
  };
}

export const handler: SQSHandler = async (sqsEvent) => {
  const deps = realDeps();
  for (const record of sqsEvent.Records) {
    await processCapture(deps, JSON.parse(record.body) as ProcessMessage);
  }
};
