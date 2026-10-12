// Pull consented corrections from DynamoDB and cluster them into failure
// patterns. Run offline with admin AWS credentials (never in the request
// path):
//
//   AWS_PROFILE=... TABLE_NAME=s2c-main-prod npm run aggregate
//
// Writes work/patterns.json for propose-prompt.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { CorrectionRecord } from '../../../backend/src/lib/ddb.js';
import { clusterCorrections, dropOrphanedCorrections, summarizePattern } from './cluster.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = join(__dirname, '..', 'work');

async function main(): Promise<void> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('Set TABLE_NAME (e.g. s2c-main-prod)');

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const scanned: CorrectionRecord[] = [];
  const liveCaptures = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    // Corrections are a tiny fraction of the table; a filtered scan is fine
    // at this scale and avoids another GSI. A scan reads every item whatever
    // the filter, so also returning capture keys costs no extra read and
    // saves a GetItem per correction to check its capture still exists. The
    // projection keeps capture content (the extracted event) out of this
    // tool: a capture item brings back only its keys and ids. It lists every
    // CorrectionRecord field, so keep it in step with that type.
    const r = await doc.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          '(begins_with(SK, :correction) AND consentEvalUse = :consent) OR begins_with(SK, :capture)',
        ProjectionExpression:
          'SK, userId, captureId, correctionId, #field, oldValue, newValue, imageKey, consentEvalUse, createdAt',
        ExpressionAttributeNames: { '#field': 'field' },
        ExpressionAttributeValues: {
          ':correction': 'CORRECTION#',
          ':capture': 'CAPTURE#',
          ':consent': true,
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of r.Items ?? []) {
      if (String(item.SK).startsWith('CAPTURE#')) {
        liveCaptures.add(`${item.userId}/${item.captureId}`);
      } else {
        scanned.push(item as CorrectionRecord);
      }
    }
    lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  const corrections = dropOrphanedCorrections(scanned, liveCaptures);
  console.log(
    `${corrections.length} consented corrections ` +
      `(${scanned.length - corrections.length} dropped: their capture was deleted)`,
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
