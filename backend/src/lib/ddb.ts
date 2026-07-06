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
  calendarEventId?: string;
  calendarId?: string;
  eventLink?: string;
  possibleDuplicateOf?: string;
  error?: string;
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

const userPk = (userId: string) => `USER#${userId}`;

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

  async listCaptures(
    userId: string,
    limit = 50,
    cursor?: string,
  ): Promise<{ items: CaptureRecord[]; cursor?: string }> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': userPk(userId), ':sk': 'CAPTURE#' },
        ScanIndexForward: false, // newest first (ULID sort)
        Limit: limit,
        ExclusiveStartKey: cursor
          ? { PK: userPk(userId), SK: `CAPTURE#${cursor}` }
          : undefined,
      }),
    );
    const items = (r.Items ?? []) as CaptureRecord[];
    const nextCursor = r.LastEvaluatedKey
      ? String(r.LastEvaluatedKey.SK).replace('CAPTURE#', '')
      : undefined;
    return { items, cursor: nextCursor };
  }

  async updateCapture(
    userId: string,
    captureId: string,
    updates: Partial<CaptureRecord>,
  ): Promise<void> {
    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
    const sets: string[] = ['#updatedAt = :updatedAt'];
    for (const [k, v] of Object.entries(updates)) {
      if (k === 'updatedAt') continue;
      names[`#${k}`] = k;
      values[`:${k}`] = v;
      sets.push(`#${k} = :${k}`);
    }
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: userPk(userId), SK: `CAPTURE#${captureId}` },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
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

  async deleteAllUserItems(userId: string): Promise<number> {
    const items = await this.listAllUserItems(userId);
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      await this.doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.tableName]: batch.map((item) => ({
              DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
            })),
          },
        }),
      );
    }
    return items.length;
  }
}
