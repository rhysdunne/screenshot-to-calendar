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
import { clusterCorrections, describePattern } from './cluster.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = join(__dirname, '..', 'work');

async function main(): Promise<void> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('Set TABLE_NAME (e.g. s2c-main-prod)');

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const corrections: CorrectionRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    // Corrections are a tiny fraction of the table; a filtered scan is fine
    // at this scale and avoids another GSI.
    const r = await doc.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(SK, :sk) AND consentEvalUse = :consent',
        ExpressionAttributeValues: { ':sk': 'CORRECTION#', ':consent': true },
        ExclusiveStartKey: lastKey,
      }),
    );
    corrections.push(...((r.Items ?? []) as CorrectionRecord[]));
    lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  console.log(`${corrections.length} consented corrections`);
  const patterns = clusterCorrections(corrections);
  if (patterns.length === 0) {
    console.log('No eligible failure patterns (need ≥3 independent captures per pattern).');
  }
  for (const p of patterns) console.log(`\n${describePattern(p)}`);

  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(join(WORK_DIR, 'patterns.json'), JSON.stringify(patterns, null, 2));
  console.log(`\nWrote ${patterns.length} patterns to work/patterns.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
