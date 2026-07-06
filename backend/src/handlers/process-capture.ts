// The pipeline orchestrator: SQS-triggered, one capture per message.
//   classify → extract → resolve venue → dedup → create calendar event
// Pure logic lives in src/pipeline/; this file sequences I/O.
import type { SQSHandler } from 'aws-lambda';
import { realDeps, type Deps } from './deps.js';
import { loadPrompt, renderPrompt } from '../prompts/prompts.js';
import { CLASSIFY_IMAGE_SCHEMA, EXTRACT_EVENT_SCHEMA } from '../prompts/schemas.js';
import { extractEventData, normalizeEventData } from '../pipeline/extract.js';
import { mapEventToCalendar } from '../pipeline/map-to-calendar.js';
import { addDays, todayInZone } from '../pipeline/dates.js';
import { findDuplicate } from '../pipeline/dedup.js';
import { NoDateError, type Classification } from '../pipeline/types.js';
import type { ImageMediaType } from '../pipeline/image.js';
import { logger } from '../lib/logger.js';

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
      schema: EXTRACT_EVENT_SCHEMA,
      maxTokens: 1024,
      stage: 'extract',
    });
    totalCost += extractCall.usage.costUsd;
    await store.putAiCall(msg.userId, {
      ...extractCall.usage,
      userId: msg.userId,
      captureId: msg.captureId,
    });
    let event = extractEventData(extractCall.response);

    // 3. Resolve venue → address via Places when missing (non-fatal).
    if (event.venue && !event.address) {
      try {
        const placesKey = await deps.getSecret('places-api-key');
        const place = await deps.resolveVenue(placesKey, event.venue);
        if (place) event = { ...event, address: place.formattedAddress };
      } catch (e) {
        logger.warn('places_lookup_failed', { error: String(e) });
      }
    }

    const captureLink = `${config.deepLinkBase}/c/${msg.captureId}`;
    const calendarBody = mapEventToCalendar(event, { today, timeZone, captureLink });

    const calendarId = user.settings.calendarId;
    if (!calendarId) {
      await store.updateCapture(msg.userId, msg.captureId, {
        status: 'failed',
        classification,
        event,
        costUsd: totalCost,
        error: 'No target calendar selected — open the app and pick a calendar in Settings.',
      });
      return;
    }

    // 4. Dedup against existing events in a ±1 day window around the event.
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
      await store.updateCapture(msg.userId, msg.captureId, {
        status: 'duplicate',
        classification,
        event,
        calendarEventId: verdict.event.id,
        calendarId,
        eventLink: verdict.event.htmlLink,
        costUsd: totalCost,
      });
      return;
    }

    // 5. Create the event.
    const created = await deps.calendar.insertEvent(accessToken, calendarId, calendarBody);
    await store.updateCapture(msg.userId, msg.captureId, {
      status: 'completed',
      classification,
      event,
      calendarEventId: created.id,
      calendarId,
      eventLink: created.htmlLink,
      costUsd: totalCost,
      ...(verdict.kind === 'possible'
        ? { possibleDuplicateOf: verdict.event.id }
        : {}),
    });
  } catch (e) {
    const message =
      e instanceof NoDateError
        ? 'No date could be read from this image.'
        : `Processing failed: ${(e as Error).message}`;
    logger.error('process_capture_failed', { ...msg, error: String(e) });
    await store.updateCapture(msg.userId, msg.captureId, {
      status: 'failed',
      error: message,
    });
    // NoDateError is terminal — retrying won't conjure a date. Anything else
    // rethrows so SQS retries (×3) and then parks the message on the DLQ.
    if (!(e instanceof NoDateError)) throw e;
  }
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
