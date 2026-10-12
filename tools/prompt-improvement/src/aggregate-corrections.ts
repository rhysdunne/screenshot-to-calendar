// Pull the owner's consented corrections from DynamoDB and cluster them into
// failure patterns. Run offline with admin AWS credentials (never in the
// request path):
//
//   AWS_PROFILE=... OWNER_USER_ID=<your userId> TABLE_NAME=s2c-main-prod \
//     npm run aggregate
//
// OWNER ONLY: it reads nothing but the OWNER_USER_ID account's partition and
// refuses to run without it (see owner.ts). Other users' corrections stay out
// even with consent: propose-prompt.ts sends the values to Claude, and the CI
// job pushes the candidate prompt to a public branch.
//
// Writes work/patterns.json for propose-prompt.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { CorrectionRecord } from '../../../backend/src/lib/ddb.js';
import { clusterCorrections, dropOrphanedCorrections, summarizePattern } from './cluster.js';
import { ownerUserIdFrom } from './owner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = join(__dirname, '..', 'work');

/**
 * One page of the owner's partition: consented corrections, plus the keys of
 * every capture. A Query on the owner's own partition, so no other user's
 * records are read at all. Returning capture keys from the same read saves a
 * GetItem per correction to check its capture still exists. The projection
 * keeps capture content (the extracted event) out of this tool: a capture
 * item brings back only its keys and ids. It lists every CorrectionRecord
 * field, so keep it in step with that type.
 */
export function ownerAggregateQuery(
  tableName: string,
  ownerUserId: string,
  exclusiveStartKey?: Record<string, unknown>,
): QueryCommandInput {
  return {
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk',
    FilterExpression:
      '(begins_with(SK, :correction) AND consentEvalUse = :consent) OR begins_with(SK, :capture)',
    ProjectionExpression:
      'SK, userId, captureId, correctionId, #field, oldValue, newValue, imageKey, consentEvalUse, createdAt',
    ExpressionAttributeNames: { '#field': 'field' },
    ExpressionAttributeValues: {
      ':pk': `USER#${ownerUserId}`,
      ':correction': 'CORRECTION#',
      ':capture': 'CAPTURE#',
      ':consent': true,
    },
    ExclusiveStartKey: exclusiveStartKey,
  };
}

async function main(): Promise<void> {
  const ownerUserId = ownerUserIdFrom(process.env);
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('Set TABLE_NAME (e.g. s2c-main-prod)');

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const found: CorrectionRecord[] = [];
  const liveCaptures = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand(ownerAggregateQuery(tableName, ownerUserId, lastKey)));
    for (const item of r.Items ?? []) {
      if (String(item.SK).startsWith('CAPTURE#')) {
        liveCaptures.add(`${item.userId}/${item.captureId}`);
      } else {
        found.push(item as CorrectionRecord);
      }
    }
    lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  const corrections = dropOrphanedCorrections(found, liveCaptures);
  console.log(
    `${corrections.length} consented corrections from the owner's account ` +
      `(${found.length - corrections.length} dropped: their capture was deleted)`,
  );
  const patterns = clusterCorrections(corrections);
  if (patterns.length === 0) {
    console.log('No eligible failure patterns (need ≥3 independent captures per pattern).');
  }
  // Counts only: this runs in CI, whose logs are public, and correction
  // values are what users typed. The values stay in work/patterns.json.
  for (const p of patterns) console.log(summarizePattern(p));

  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(join(WORK_DIR, 'patterns.json'), JSON.stringify(patterns, null, 2));
  console.log(`\nWrote ${patterns.length} patterns to work/patterns.json`);
}

const isMain = process.argv[1] && process.argv[1].endsWith('aggregate-corrections.ts');
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
