// Thin wrapper over Rekognition DetectModerationLabels. Returns the raw labels
// only — the block/allow decision lives in pipeline/moderation.ts so it stays a
// pure, testable function (same split as anthropic.ts → pipeline/extract.ts).
// Empty-config client resolves to the Lambda's region (eu-west-2), matching
// S3Client/DynamoDBClient elsewhere.
import {
  DetectModerationLabelsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
// The label shape is defined in the pure pipeline module (which owns the
// block/allow decision); this wrapper only produces it.
import type { ModerationLabel } from '../pipeline/moderation.js';

export class RekognitionModerator {
  constructor(private readonly client: RekognitionClient = new RekognitionClient({})) {}

  /** Rekognition supports JPEG and PNG only; callers must gate on media type. */
  async detect(bytes: Buffer): Promise<ModerationLabel[]> {
    const out = await this.client.send(
      new DetectModerationLabelsCommand({ Image: { Bytes: bytes } }),
    );
    return (out.ModerationLabels ?? []).map((l) => ({
      name: l.Name ?? '',
      parentName: l.ParentName ?? '',
      confidence: l.Confidence ?? 0,
    }));
  }
}
