// Turn consented, corrected captures into permanent eval cases — the missing
// link that makes the eval dataset grow from real failures. Each corrected
// capture becomes evals/dataset/real/corr-<captureId>/ with gold = the
// user-approved values (original extraction + corrections) and frozenToday =
// the capture date, so relative-date phrasings stay resolvable forever.
//
//   TABLE_NAME=s2c-main-prod BUCKET_NAME=s2c-images-<acct>-prod npm run materialize
//
// Idempotent: existing case directories are never touched (their gold may
// have been hand-refined).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { CaptureRecord, CorrectionRecord } from '../../../backend/src/lib/ddb.js';
import type { ExtractedEvent } from '../../../backend/src/pipeline/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_DATASET_DIR = join(__dirname, '..', '..', '..', 'evals', 'dataset', 'real');

export interface MaterializedCase {
  id: string;
  gold: ExtractedEvent;
  meta: {
    source: 'user';
    frozenToday: string;
    classification?: CaptureRecord['classification'];
    notes: string;
    consent: true;
  };
}

/**
 * Pure case construction (unit-tested). Returns null when the capture can't
 * become a useful eval case (no extraction, or nothing was corrected).
 */
export function buildEvalCase(
  capture: Pick<
    CaptureRecord,
    'captureId' | 'event' | 'corrected' | 'classification' | 'createdAt'
  >,
  correctedFields: string[],
): MaterializedCase | null {
  if (!capture.event || !capture.corrected || correctedFields.length === 0) return null;
  const gold: ExtractedEvent = { ...capture.event, ...capture.corrected };
  return {
    id: `corr-${capture.captureId}`,
    gold,
    meta: {
      source: 'user',
      frozenToday: capture.createdAt.slice(0, 10),
      classification: capture.classification,
      notes: `User corrected: ${[...new Set(correctedFields)].sort().join(', ')}`,
      consent: true,
    },
  };
}

async function main(): Promise<void> {
  const tableName = process.env.TABLE_NAME;
  const bucketName = process.env.BUCKET_NAME;
  if (!tableName || !bucketName) throw new Error('Set TABLE_NAME and BUCKET_NAME');

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const s3 = new S3Client({});

  // Consented corrections only — the consent snapshot travels on each record.
  const corrections: CorrectionRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
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

  const byCapture = new Map<string, CorrectionRecord[]>();
  for (const c of corrections) {
    const key = `${c.userId}/${c.captureId}`;
    byCapture.set(key, [...(byCapture.get(key) ?? []), c]);
  }
  console.log(`${corrections.length} consented corrections across ${byCapture.size} captures`);

  let written = 0;
  for (const [key, records] of byCapture) {
    const [userId, captureId] = key.split('/') as [string, string];
    const caseDir = join(REAL_DATASET_DIR, `corr-${captureId}`);
    if (existsSync(caseDir)) continue; // never overwrite hand-refined cases

    const r = await doc.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `USER#${userId}`, SK: `CAPTURE#${captureId}` },
      }),
    );
    const capture = r.Item as CaptureRecord | undefined;
    if (!capture) continue;

    const evalCase = buildEvalCase(capture, records.map((c) => c.field));
    if (!evalCase) continue;

    const obj = await s3.send(
      new GetObjectCommand({ Bucket: bucketName, Key: capture.imageKey }),
    );
    const bytes = await obj.Body?.transformToByteArray();
    if (!bytes) continue;

    mkdirSync(caseDir, { recursive: true });
    const ext = capture.imageKey.split('.').pop() ?? 'jpg';
    writeFileSync(join(caseDir, `image.${ext === 'png' ? 'png' : 'jpg'}`), Buffer.from(bytes));
    writeFileSync(join(caseDir, 'gold.json'), JSON.stringify(evalCase.gold, null, 2));
    writeFileSync(join(caseDir, 'meta.json'), JSON.stringify(evalCase.meta, null, 2));
    console.log(`✓ ${evalCase.id} (${evalCase.meta.notes})`);
    written++;
  }
  console.log(`\nMaterialized ${written} new eval cases into ${REAL_DATASET_DIR}`);
}

const isMain = process.argv[1] && process.argv[1].endsWith('materialize-eval-cases.ts');
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
