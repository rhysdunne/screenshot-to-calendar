import { describe, expect, it } from 'vitest';
import { ownerAggregateQuery } from '../src/aggregate-corrections.js';

describe('owner-only aggregate', () => {
  it("queries the owner's partition only, never the whole table", () => {
    const input = ownerAggregateQuery('s2c-main-prod', '01OWNER');
    expect(input.TableName).toBe('s2c-main-prod');
    expect(input.KeyConditionExpression).toBe('PK = :pk');
    expect(input.ExpressionAttributeValues).toEqual({
      ':pk': 'USER#01OWNER',
      ':correction': 'CORRECTION#',
      ':capture': 'CAPTURE#',
      ':consent': true,
    });
  });

  it('keeps consented corrections and capture keys, and no capture content', () => {
    const input = ownerAggregateQuery('s2c-main-prod', '01OWNER');
    expect(input.FilterExpression).toBe(
      '(begins_with(SK, :correction) AND consentEvalUse = :consent) OR begins_with(SK, :capture)',
    );
    const projected = input.ProjectionExpression!.split(',').map((a) => a.trim());
    expect(projected).not.toContain('event');
    expect(projected).not.toContain('corrected');
  });

  it('passes the page key through', () => {
    const key = { PK: 'USER#01OWNER', SK: 'CAPTURE#01X' };
    expect(ownerAggregateQuery('t', '01OWNER', key).ExclusiveStartKey).toBe(key);
  });
});
