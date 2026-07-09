import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DdbStore } from '../../src/lib/ddb.js';

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
