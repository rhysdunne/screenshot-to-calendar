// Single-table DynamoDB store (table s2c-main-{stage}).
//
//   Entity      PK              SK
//   User        USER#<id>       PROFILE            (GSI1: GSUB#<googleSub> / PROFILE)
//   Capture     USER#<id>       CAPTURE#<ulid>
//   Image hash  USER#<id>       IMGHASH#<sha256>
//   Correction  USER#<id>       CORRECTION#<ulid>
//   AI call     USER#<id>       AICALL#<ulid>
//
// ULIDs sort by creation time, so a reverse Query over CAPTURE# is the
// library feed with no extra index.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import type { EncryptedValue } from './crypto.js';
import type { Classification, CaptureStatus, ExtractedEvent } from '../pipeline/types.js';

export interface UserSettings {
  calendarId: string | null;
  timezone: string;
  consentEvalUse: boolean;
}

export interface UserRecord {
  userId: string;
  email: string;
  googleSub: string;
  encRefreshToken: EncryptedValue | null;
  tokenVersion: number;
  needsReauth?: boolean;
  settings: UserSettings;
  createdAt: string;
}

export interface CaptureRecord {
  userId: string;
  captureId: string;
  status: CaptureStatus;
  imageKey: string;
  imageSha256: string;
  mediaType: string;
  classification?: Classification;
  event?: ExtractedEvent;
  corrected?: Partial<ExtractedEvent>;
  /** Only ever an event this capture created (never set for a duplicate). */
  calendarEventId?: string;
  calendarId?: string;
  eventLink?: string;
  /** Status duplicate: the existing event it matched, which it must not edit or delete. */
  matchedEventId?: string;
  matchedCalendarId?: string;
  possibleDuplicateOf?: string;
  error?: string;
  /** Raw model text kept when extraction failed — debugging only. */
  rawModelOutput?: string;
  costUsd?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CorrectionRecord {
  userId: string;
  correctionId: string;
  captureId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  imageKey: string;
  consentEvalUse: boolean;
  createdAt: string;
}

export interface AiCallRecord {
  userId: string;
  captureId: string;
  stage: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

/** Partial capture update; null clears the attribute. */
export type CaptureUpdates = { [K in keyof CaptureRecord]?: CaptureRecord[K] | null };

/**
 * updateCapture found no capture to update: it was deleted after the caller
 * read it (by the user, or by account deletion). The processor stops on it,
 * and the API handlers answer 404.
 */
export class CaptureGoneError extends Error {
  constructor(readonly captureId: string) {
    super(`Capture ${captureId} no longer exists`);
    this.name = 'CaptureGoneError';
  }
}

const userPk = (userId: string) => `USER#${userId}`;

// AI-call log items are operational telemetry (tokens/cost), not user-facing
// content, so they carry a DynamoDB TTL and age out. Captures/corrections have
// no TTL — they are the user's history and only leave on explicit deletion.
// `expiresAt` is a Unix epoch (seconds); the table's timeToLiveAttribute points
// at it. This is a system clock, not user-timezone date math, so bare Date.now
// is correct here (unlike pipeline/dates.ts).
const AICALL_TTL_DAYS = 90;
const aiCallExpiry = () => Math.floor(Date.now() / 1000) + AICALL_TTL_DAYS * 24 * 60 * 60;

// BatchWrite can succeed overall yet hand back UnprocessedItems when the
// table throttles. Retried with exponential backoff (50, 100, 200, 400 ms)
// before giving up.
const BATCH_WRITE_MAX_ATTEMPTS = 5;
const BATCH_WRITE_BASE_DELAY_MS = 50;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DdbStore {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  // ---- Users -------------------------------------------------------------

  async getUser(userId: string): Promise<UserRecord | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userPk(userId), SK: 'PROFILE' },
      }),
    );
    return (r.Item as (UserRecord & Record<string, unknown>) | undefined) ?? null;
  }

  async getUserByGoogleSub(googleSub: string): Promise<UserRecord | null> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
        ExpressionAttributeValues: { ':pk': `GSUB#${googleSub}`, ':sk': 'PROFILE' },
        Limit: 1,
      }),
    );
    return (r.Items?.[0] as UserRecord | undefined) ?? null;
  }

  async putUser(user: UserRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: userPk(user.userId),
          SK: 'PROFILE',
          GSI1PK: `GSUB#${user.googleSub}`,
          GSI1SK: 'PROFILE',
          ...user,
        },
      }),
    );
  }

  async updateUser(userId: string, updates: Partial<UserRecord>): Promise<void> {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    for (const [k, v] of Object.entries(updates)) {
      names[`#${k}`] = k;
      values[`:${k}`] = v;
      sets.push(`#${k} = :${k}`);
    }
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: userPk(userId), SK: 'PROFILE' },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }

  // ---- Captures ----------------------------------------------------------

  async createCapture(
    capture: Omit<CaptureRecord, 'captureId' | 'createdAt' | 'updatedAt'>,
    captureId: string = ulid(),
  ): Promise<CaptureRecord> {
    const now = new Date().toISOString();
    const record: CaptureRecord = { ...capture, captureId, createdAt: now, updatedAt: now };
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { PK: userPk(capture.userId), SK: `CAPTURE#${captureId}`, ...record },
      }),
    );
    return record;
  }

  async getCapture(userId: string, captureId: string): Promise<CaptureRecord | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userPk(userId), SK: `CAPTURE#${captureId}` },
      }),
    );
    return (r.Item as CaptureRecord | undefined) ?? null;
  }

  /**
   * Up to `limit` captures, newest first. The cursor is the id of the last
   * capture returned, and the next page starts after it. It is set only when
   * older captures may exist.
   */
  async listCaptures(
    userId: string,
    limit = 50,
    cursor?: string,
  ): Promise<{ items: CaptureRecord[]; cursor?: string }> {
    // One item more than the page shows whether an older capture exists.
    // DynamoDB returns a LastEvaluatedKey whenever a Query stops at its Limit,
    // even when nothing follows, so with Limit: limit a library of exactly
    // `limit` captures got a cursor.
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': userPk(userId), ':sk': 'CAPTURE#' },
        ScanIndexForward: false, // newest first (ULID sort)
        Limit: limit + 1,
        ExclusiveStartKey: cursor
          ? { PK: userPk(userId), SK: `CAPTURE#${cursor}` }
          : undefined,
      }),
    );
    const found = (r.Items ?? []) as Array<CaptureRecord & { SK: string }>;
    const items = found.slice(0, limit);
    const lastReturned = found.length > limit ? found[limit - 1] : undefined;
    let nextCursor: string | undefined;
    if (lastReturned) {
      nextCursor = lastReturned.SK.replace('CAPTURE#', '');
    } else if (r.LastEvaluatedKey) {
      // DynamoDB's 1 MB read limit cut the page short, so more may follow.
      nextCursor = String(r.LastEvaluatedKey.SK).replace('CAPTURE#', '');
    }
    return { items, cursor: nextCursor };
  }

  /**
   * Update an existing capture. Throws CaptureGoneError when there is none:
   * UpdateItem on its own creates a missing item, and a capture made only of
   * the updated attributes (no captureId, createdAt or imageKey) stops the
   * app decoding the whole list.
   */
  async updateCapture(
    userId: string,
    captureId: string,
    updates: CaptureUpdates,
  ): Promise<void> {
    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
    const sets: string[] = ['#updatedAt = :updatedAt'];
    const removes: string[] = [];
    for (const [k, v] of Object.entries(updates)) {
      if (k === 'updatedAt' || v === undefined) continue;
      names[`#${k}`] = k;
      if (v === null) {
        // null means "clear this attribute" (e.g. a stale error after approval).
        removes.push(`#${k}`);
      } else {
        values[`:${k}`] = v;
        sets.push(`#${k} = :${k}`);
      }
    }
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: userPk(userId), SK: `CAPTURE#${captureId}` },
          UpdateExpression:
            `SET ${sets.join(', ')}` + (removes.length ? ` REMOVE ${removes.join(', ')}` : ''),
          ConditionExpression: 'attribute_exists(SK)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    } catch (e) {
      if ((e as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new CaptureGoneError(captureId);
      }
      throw e;
    }
  }

  async deleteCapture(userId: string, captureId: string, imageSha256: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: userPk(userId), SK: `CAPTURE#${captureId}` },
      }),
    );
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: userPk(userId), SK: `IMGHASH#${imageSha256}` },
      }),
    );
  }

  /**
   * Claim an image hash for exact-duplicate detection. Returns the captureId
   * of the existing claim if this image was already uploaded, else null.
   */
  async claimImageHash(
    userId: string,
    sha256: string,
    captureId: string,
  ): Promise<string | null> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { PK: userPk(userId), SK: `IMGHASH#${sha256}`, captureId },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return null;
    } catch (e) {
      if ((e as { name?: string }).name === 'ConditionalCheckFailedException') {
        const r = await this.doc.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { PK: userPk(userId), SK: `IMGHASH#${sha256}` },
          }),
        );
        return (r.Item?.captureId as string | undefined) ?? 'unknown';
      }
      throw e;
    }
  }

  // ---- Corrections -------------------------------------------------------

  async putCorrection(
    correction: Omit<CorrectionRecord, 'correctionId' | 'createdAt'>,
  ): Promise<CorrectionRecord> {
    const correctionId = ulid();
    const record: CorrectionRecord = {
      ...correction,
      correctionId,
      createdAt: new Date().toISOString(),
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: userPk(correction.userId),
          SK: `CORRECTION#${correctionId}`,
          ...record,
        },
      }),
    );
    return record;
  }

  /** Corrections made today (UTC) — the per-user poisoning rate limit input. */
  async countCorrectionsToday(userId: string): Promise<number> {
    // ULIDs are lexicographic by timestamp, so filtering on createdAt via a
    // begins_with over today's records is done client-side after a bounded query.
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': userPk(userId), ':sk': 'CORRECTION#' },
        ScanIndexForward: false,
        Limit: 100,
      }),
    );
    const today = new Date().toISOString().slice(0, 10);
    return ((r.Items ?? []) as CorrectionRecord[]).filter((c) =>
      c.createdAt.startsWith(today),
    ).length;
  }

  // ---- AI call log -------------------------------------------------------

  async putAiCall(userId: string, call: AiCallRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: userPk(userId),
          SK: `AICALL#${ulid()}`,
          ...call,
          createdAt: new Date().toISOString(),
          expiresAt: aiCallExpiry(),
        },
      }),
    );
  }

  // ---- GDPR --------------------------------------------------------------

  /** Everything stored for a user (paginated internally). */
  async listAllUserItems(userId: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': userPk(userId) },
          ExclusiveStartKey: lastKey,
        }),
      );
      items.push(...((r.Items ?? []) as Record<string, unknown>[]));
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return items;
  }

  /**
   * Delete everything stored for a user. Throws if DynamoDB still leaves
   * items unprocessed after the retries: account erasure must not report
   * success while data remains.
   */
  async deleteAllUserItems(userId: string): Promise<number> {
    const items = await this.listAllUserItems(userId);
    for (let i = 0; i < items.length; i += 25) {
      let requests = items.slice(i, i + 25).map((item) => ({
        DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
      }));
      for (let attempt = 1; requests.length > 0; attempt++) {
        if (attempt > BATCH_WRITE_MAX_ATTEMPTS) {
          throw new Error(
            `${requests.length} items still unprocessed after ${BATCH_WRITE_MAX_ATTEMPTS} delete attempts`,
          );
        }
        if (attempt > 1) await sleep(BATCH_WRITE_BASE_DELAY_MS * 2 ** (attempt - 2));
        const r = await this.doc.send(
          new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } }),
        );
        requests = (r.UnprocessedItems?.[this.tableName] ?? []) as typeof requests;
      }
    }
    return items.length;
  }
}
