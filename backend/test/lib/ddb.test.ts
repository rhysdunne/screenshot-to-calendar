import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { CaptureGoneError, DdbStore } from '../../src/lib/ddb.js';
import { FakeStore } from '../helpers/fake-deps.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => ddbMock.reset());

describe('DdbStore', () => {
  const store = new DdbStore('s2c-main-test');

  it('claimImageHash returns null on first claim', async () => {
    ddbMock.on(PutCommand).resolves({});
    expect(await store.claimImageHash('u1', 'abc', 'cap1')).toBeNull();
  });

  it('claimImageHash returns existing captureId when hash already claimed', async () => {
    const err = new Error('conditional');
    err.name = 'ConditionalCheckFailedException';
    ddbMock.on(PutCommand).rejects(err);
    ddbMock.on(GetCommand).resolves({ Item: { captureId: 'cap-original' } });
    expect(await store.claimImageHash('u1', 'abc', 'cap2')).toBe('cap-original');
  });

  it('createCapture writes PK/SK and returns a ULID-keyed record', async () => {
    ddbMock.on(PutCommand).resolves({});
    const record = await store.createCapture({
      userId: 'u1',
      status: 'queued',
      imageKey: 'users/u1/captures/x.jpg',
      imageSha256: 'abc',
      mediaType: 'image/jpeg',
    });
    expect(record.captureId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put.Item?.PK).toBe('USER#u1');
    expect(put.Item?.SK).toBe(`CAPTURE#${record.captureId}`);
  });

  it('putAiCall stamps a future TTL (expiresAt) so telemetry ages out', async () => {
    ddbMock.on(PutCommand).resolves({});
    const nowSec = Math.floor(Date.now() / 1000);
    await store.putAiCall('u1', {
      userId: 'u1',
      captureId: 'cap1',
      stage: 'extract',
      model: 'claude-sonnet-5',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      latencyMs: 12,
    });
    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(String(put.Item?.SK)).toMatch(/^AICALL#/);
    const expiresAt = put.Item?.expiresAt as number;
    // ~90 days out (allow a wide band so the test isn't clock-flaky).
    expect(expiresAt).toBeGreaterThan(nowSec + 89 * 24 * 60 * 60);
    expect(expiresAt).toBeLessThan(nowSec + 91 * 24 * 60 * 60);
  });

  it('updateCapture writes only to a capture that exists', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await store.updateCapture('u1', 'cap1', { status: 'processing', error: null });
    const update = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.Key).toEqual({ PK: 'USER#u1', SK: 'CAPTURE#cap1' });
    expect(update.ConditionExpression).toBe('attribute_exists(SK)');
    expect(update.UpdateExpression).toContain('REMOVE #error');
  });

  it('updateCapture reports a deleted capture as CaptureGoneError', async () => {
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} }),
    );
    await expect(store.updateCapture('u1', 'cap1', { status: 'failed' })).rejects.toBeInstanceOf(
      CaptureGoneError,
    );
  });

  it('updateCapture passes any other error through', async () => {
    const err = new Error('Rate exceeded');
    err.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(UpdateCommand).rejects(err);
    const write = store.updateCapture('u1', 'cap1', { status: 'failed' });
    await expect(write).rejects.toThrow('Rate exceeded');
    await expect(write).rejects.not.toBeInstanceOf(CaptureGoneError);
  });

  // The handler tests run on FakeStore, so it must refuse the same writes.
  it('FakeStore.updateCapture refuses a missing capture as DdbStore does', async () => {
    const fake = new FakeStore();
    await expect(fake.updateCapture('u1', 'cap1', { status: 'failed' })).rejects.toBeInstanceOf(
      CaptureGoneError,
    );
    expect(fake.captures.size).toBe(0);
  });

  it('listCaptures queries newest-first', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await store.listCaptures('u1');
    const q = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(q.ScanIndexForward).toBe(false);
    expect(q.ExpressionAttributeValues?.[':sk']).toBe('CAPTURE#');
  });

  it('getUserByGoogleSub queries GSI1', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ userId: 'u1' }] });
    const user = await store.getUserByGoogleSub('gsub-123');
    expect(user?.userId).toBe('u1');
    const q = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(q.IndexName).toBe('GSI1');
    expect(q.ExpressionAttributeValues?.[':pk']).toBe('GSUB#gsub-123');
  });

  it('deleteAllUserItems retries unprocessed deletes until DynamoDB takes them', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { PK: 'USER#u1', SK: 'PROFILE' },
        { PK: 'USER#u1', SK: 'CAPTURE#c1' },
      ],
    });
    const throttled = { DeleteRequest: { Key: { PK: 'USER#u1', SK: 'CAPTURE#c1' } } };
    ddbMock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { 's2c-main-test': [throttled] } })
      .resolves({});

    expect(await store.deleteAllUserItems('u1')).toBe(2);
    const calls = ddbMock.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args[0].input.RequestItems?.['s2c-main-test']).toEqual([throttled]);
  });

  it('deleteAllUserItems throws when items stay unprocessed after 5 attempts', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ PK: 'USER#u1', SK: 'PROFILE' }] });
    ddbMock.on(BatchWriteCommand).resolves({
      UnprocessedItems: {
        's2c-main-test': [{ DeleteRequest: { Key: { PK: 'USER#u1', SK: 'PROFILE' } } }],
      },
    });

    await expect(store.deleteAllUserItems('u1')).rejects.toThrow('still unprocessed');
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(5);
  });

  it('countCorrectionsToday only counts today (UTC)', async () => {
    const today = new Date().toISOString();
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { createdAt: today },
        { createdAt: today },
        { createdAt: '2020-01-01T00:00:00.000Z' },
      ],
    });
    expect(await store.countCorrectionsToday('u1')).toBe(2);
  });
});

describe('DdbStore.listCaptures paging', () => {
  const store = new DdbStore('s2c-main-test');

  // A user's captures as DynamoDB serves them, newest first. A Query stops at
  // its Limit or after `perRead` items (standing in for the 1 MB read limit),
  // and returns a LastEvaluatedKey whenever it stops at either, even when
  // nothing follows.
  function serveCaptures(count: number, perRead = Infinity) {
    const ids = Array.from({ length: count }, (_, i) => `cap${String(count - i).padStart(3, '0')}`);
    const rows = ids.map((id) => ({ PK: 'USER#u1', SK: `CAPTURE#${id}`, captureId: id }));
    ddbMock.on(QueryCommand).callsFake((input: { Limit: number; ExclusiveStartKey?: { SK: string } }) => {
      const start = input.ExclusiveStartKey
        ? rows.findIndex((r) => r.SK === input.ExclusiveStartKey!.SK) + 1
        : 0;
      const take = Math.min(input.Limit, perRead);
      const page = rows.slice(start, start + take);
      const last = page[page.length - 1];
      return {
        Items: page,
        LastEvaluatedKey: page.length === take && last ? { PK: last.PK, SK: last.SK } : undefined,
      };
    });
    return ids;
  }

  const ids = (items: Array<{ captureId: string }>) => items.map((c) => c.captureId);

  it('asks for one capture more than the page', async () => {
    serveCaptures(0);
    await store.listCaptures('u1', 200);
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input.Limit).toBe(201);
  });

  it('exactly a page of captures comes back with no cursor', async () => {
    const all = serveCaptures(3);
    const page = await store.listCaptures('u1', 3);
    expect(ids(page.items)).toEqual(all);
    expect(page.cursor).toBeUndefined();
  });

  it('one capture more than a page sets the cursor to the last one returned', async () => {
    const all = serveCaptures(4);
    const first = await store.listCaptures('u1', 3);
    expect(ids(first.items)).toEqual(all.slice(0, 3));
    expect(first.cursor).toBe(all[2]);

    // The next page starts with the capture after the last one returned.
    const second = await store.listCaptures('u1', 3, first.cursor);
    expect(ids(second.items)).toEqual(all.slice(3));
    expect(second.cursor).toBeUndefined();
  });

  it('a page cut short by the read limit keeps DynamoDB’s cursor', async () => {
    const all = serveCaptures(5, 2);
    const first = await store.listCaptures('u1', 3);
    expect(ids(first.items)).toEqual(all.slice(0, 2));
    expect(first.cursor).toBe(all[1]);
  });

  it('following the cursor returns every capture once, in order', async () => {
    for (const [count, perRead] of [[7, Infinity], [9, Infinity], [7, 2]] as const) {
      ddbMock.reset();
      const all = serveCaptures(count, perRead);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await store.listCaptures('u1', 3, cursor);
        seen.push(...ids(page.items));
        cursor = page.cursor;
        pages++;
      } while (cursor && pages < 20);
      expect(seen).toEqual(all);
      expect(cursor).toBeUndefined();
    }
  });
});
