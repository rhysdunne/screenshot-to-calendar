import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class ImageStore {
  constructor(
    private readonly bucket: string,
    private readonly s3: S3Client = new S3Client({}),
  ) {}

  captureKey(userId: string, captureId: string, ext: string): string {
    return `users/${userId}/captures/${captureId}.${ext}`;
  }

  async putImage(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  async getImage(key: string): Promise<Buffer> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await r.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty S3 object: ${key}`);
    return Buffer.from(bytes);
  }

  async presignGet(key: string, expiresInSeconds = 300): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async putExport(userId: string, exportId: string, bytes: Buffer): Promise<string> {
    const key = `exports/${userId}/${exportId}.json`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: 'application/json',
      }),
    );
    return key;
  }

  async deleteObject(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Delete every object under a user's prefix (captures + exports). */
  async deleteUserObjects(userId: string): Promise<number> {
    let deleted = 0;
    for (const prefix of [`users/${userId}/`, `exports/${userId}/`]) {
      let token: string | undefined;
      do {
        const list = await this.s3.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const obj of list.Contents ?? []) {
          if (obj.Key) {
            await this.deleteObject(obj.Key);
            deleted++;
          }
        }
        token = list.NextContinuationToken;
      } while (token);
    }
    return deleted;
  }
}
