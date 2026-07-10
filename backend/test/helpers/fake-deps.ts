// In-memory fakes implementing the Deps container for handler tests. The
// whole pipeline runs for real; only I/O boundaries (DynamoDB, S3, SQS,
// Anthropic, Google) are faked.
import { ulid } from 'ulid';
import type { Deps, Images, Store } from '../../src/handlers/deps.js';
import type {
  AiCallRecord,
  CaptureRecord,
  CorrectionRecord,
  UserRecord,
} from '../../src/lib/ddb.js';
import type { ClaudeCallOptions, ClaudeCallResult } from '../../src/lib/anthropic.js';
import type { CalendarEventInput, ExistingCalendarEvent } from '../../src/pipeline/types.js';
import type { ModerationLabel } from '../../src/pipeline/moderation.js';

export class FakeStore implements Store {
  users = new Map<string, UserRecord>();
  captures = new Map<string, CaptureRecord>();
  imageHashes = new Map<string, string>();
  corrections: CorrectionRecord[] = [];
  aiCalls: AiCallRecord[] = [];

  async getUser(userId: string) {
    return this.users.get(userId) ?? null;
  }
  async getUserByGoogleSub(googleSub: string) {
    return [...this.users.values()].find((u) => u.googleSub === googleSub) ?? null;
  }
  async putUser(user: UserRecord) {
    this.users.set(user.userId, user);
  }
  async updateUser(userId: string, updates: Partial<UserRecord>) {
    const user = this.users.get(userId);
    if (user) this.users.set(userId, { ...user, ...updates });
  }
  async createCapture(
    capture: Omit<CaptureRecord, 'captureId' | 'createdAt' | 'updatedAt'>,
    captureId: string = ulid(),
  ) {
    const now = new Date().toISOString();
    const record: CaptureRecord = { ...capture, captureId, createdAt: now, updatedAt: now };
    this.captures.set(`${capture.userId}/${captureId}`, record);
    return record;
  }
  async getCapture(userId: string, captureId: string) {
    return this.captures.get(`${userId}/${captureId}`) ?? null;
  }
  async listCaptures(userId: string) {
    const items = [...this.captures.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => (a.captureId < b.captureId ? 1 : -1));
    return { items, cursor: undefined };
  }
  async updateCapture(
    userId: string,
    captureId: string,
    updates: { [K in keyof CaptureRecord]?: CaptureRecord[K] | null },
  ) {
    const key = `${userId}/${captureId}`;
    const capture = this.captures.get(key);
    if (!capture) return;
    const next = { ...capture } as Record<string, unknown>;
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined) continue;
      if (v === null) delete next[k]; // mirrors the DDB REMOVE semantics
      else next[k] = v;
    }
    next.updatedAt = new Date().toISOString();
    this.captures.set(key, next as unknown as CaptureRecord);
  }
  async deleteCapture(userId: string, captureId: string, imageSha256: string) {
    this.captures.delete(`${userId}/${captureId}`);
    this.imageHashes.delete(`${userId}/${imageSha256}`);
  }
  async claimImageHash(userId: string, sha256: string, captureId: string) {
    const key = `${userId}/${sha256}`;
    const existing = this.imageHashes.get(key);
    if (existing) return existing;
    this.imageHashes.set(key, captureId);
    return null;
  }
  async putCorrection(correction: Omit<CorrectionRecord, 'correctionId' | 'createdAt'>) {
    const record: CorrectionRecord = {
      ...correction,
      correctionId: ulid(),
      createdAt: new Date().toISOString(),
    };
    this.corrections.push(record);
    return record;
  }
  async countCorrectionsToday(userId: string) {
    const today = new Date().toISOString().slice(0, 10);
    return this.corrections.filter(
      (c) => c.userId === userId && c.createdAt.startsWith(today),
    ).length;
  }
  async putAiCall(_userId: string, call: AiCallRecord) {
    this.aiCalls.push(call);
  }
  async listAllUserItems(userId: string) {
    return [
      ...[...this.users.values()].filter((u) => u.userId === userId),
      ...[...this.captures.values()].filter((c) => c.userId === userId),
      ...this.corrections.filter((c) => c.userId === userId),
    ] as unknown as Record<string, unknown>[];
  }
  async deleteAllUserItems(userId: string) {
    const before =
      this.users.size + this.captures.size + this.corrections.length;
    this.users.delete(userId);
    for (const key of [...this.captures.keys()]) {
      if (key.startsWith(`${userId}/`)) this.captures.delete(key);
    }
    for (const key of [...this.imageHashes.keys()]) {
      if (key.startsWith(`${userId}/`)) this.imageHashes.delete(key);
    }
    this.corrections = this.corrections.filter((c) => c.userId !== userId);
    return before - (this.users.size + this.captures.size + this.corrections.length);
  }
}

export class FakeImages implements Images {
  objects = new Map<string, Buffer>();

  captureKey(userId: string, captureId: string, ext: string) {
    return `users/${userId}/captures/${captureId}.${ext}`;
  }
  async putImage(key: string, bytes: Buffer, _contentType?: string) {
    this.objects.set(key, bytes);
  }
  async getImage(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error(`No such object: ${key}`);
    return bytes;
  }
  async presignGet(key: string) {
    return `https://signed.example.com/${key}`;
  }
  async putExport(userId: string, exportId: string, bytes: Buffer) {
    const key = `exports/${userId}/${exportId}.json`;
    this.objects.set(key, bytes);
    return key;
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
  async deleteUserObjects(userId: string) {
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(`users/${userId}/`) || key.startsWith(`exports/${userId}/`)) {
        this.objects.delete(key);
        deleted++;
      }
    }
    return deleted;
  }
}

function textResponse(json: unknown): ClaudeCallResult['response'] {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content: [{ type: 'text', text: JSON.stringify(json), citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1500, output_tokens: 150 },
  } as unknown as ClaudeCallResult['response'];
}

export interface FakeDepsOptions {
  classifyResult?: unknown;
  extractResult?: unknown;
  existingEvents?: ExistingCalendarEvent[];
  placesAddress?: string | null;
  /** Labels the moderation fake returns; defaults to [] (allow). */
  moderateLabels?: ModerationLabel[];
  /** When true, the moderation fake throws (simulates Rekognition unavailable). */
  moderateThrows?: boolean;
  /** Override the moderationEnabled config flag; defaults to true. */
  moderationEnabled?: boolean;
}

export function makeFakeDeps(opts: FakeDepsOptions = {}) {
  const store = new FakeStore();
  const images = new FakeImages();
  const insertedEvents: Array<{ calendarId: string; event: CalendarEventInput }> = [];
  const patchedEvents: Array<{ calendarId: string; eventId: string }> = [];
  const claudeCalls: ClaudeCallOptions[] = [];
  const moderationCalls: Buffer[] = [];

  const deps: Deps = {
    store,
    images,
    enqueueProcess: async () => {},
    googleAccessToken: async () => 'access-token-test',
    callClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
      claudeCalls.push(options);
      const result =
        options.stage === 'classify'
          ? (opts.classifyResult ?? {
              category: 'event_poster',
              is_event: true,
              confidence: 'high',
            })
          : (opts.extractResult ?? {});
      return {
        response: textResponse(result),
        usage: {
          stage: options.stage,
          model: options.model,
          inputTokens: 1500,
          outputTokens: 150,
          costUsd: 0.002,
          latencyMs: 42,
        },
      };
    },
    calendar: {
      listWritableCalendars: async () => [
        { id: 'primary', summary: 'Primary', primary: true, accessRole: 'owner' },
      ],
      createCalendar: async (_t, summary) => ({
        id: `cal-${summary}`,
        summary,
        accessRole: 'owner',
      }),
      listEventsInWindow: async () => opts.existingEvents ?? [],
      insertEvent: async (_t, calendarId, event) => {
        insertedEvents.push({ calendarId, event });
        return { id: 'created-event-1', htmlLink: 'https://calendar.google.com/event?eid=1' };
      },
      patchEvent: async (_t, calendarId, eventId) => {
        patchedEvents.push({ calendarId, eventId });
        return { id: eventId, htmlLink: 'https://calendar.google.com/event?eid=1' };
      },
      deleteEvent: async () => {},
    },
    resolveVenue: async () =>
      opts.placesAddress === null || opts.placesAddress === undefined
        ? opts.placesAddress === null
          ? null
          : { formattedAddress: '1 Test St, London' }
        : { formattedAddress: opts.placesAddress },
    getSecret: async (name) => {
      if (name === 'token-enc-key') return 'a'.repeat(64);
      return `secret-${name}`;
    },
    moderate: async (bytes: Buffer) => {
      moderationCalls.push(bytes);
      if (opts.moderateThrows) throw new Error('rekognition unavailable');
      return opts.moderateLabels ?? [];
    },
    config: {
      deepLinkBase: 'https://app.example.com',
      classifyModel: 'claude-haiku-4-5',
      extractModel: 'claude-sonnet-5',
      googleClientId: 'client-id.apps.googleusercontent.com',
      moderationEnabled: opts.moderationEnabled ?? true,
      moderationMinConfidence: 80,
      moderationBlockCategories: ['Explicit Nudity'],
    },
  };

  return { deps, store, images, insertedEvents, patchedEvents, claudeCalls, moderationCalls };
}

export function testUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: 'user-1',
    email: 'test@example.com',
    googleSub: 'gsub-1',
    encRefreshToken: { iv: '00', ct: '00', tag: '00' },
    tokenVersion: 1,
    settings: { calendarId: 'cal-events', timezone: 'Europe/London', consentEvalUse: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
