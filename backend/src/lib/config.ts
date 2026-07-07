// Secrets come from AWS Systems Manager Parameter Store SecureStrings under /s2c/{stage}/…,
// cached in memory for the lifetime of the Lambda container (with a TTL so
// rotations propagate within ~5 minutes). Non-secret config is plain env vars
// set by the CDK stack.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: string; fetchedAt: number }>();

export type SecretName =
  | 'anthropic-api-key'
  | 'google-oauth-client-secret'
  | 'places-api-key'
  | 'jwt-secret'
  | 'token-enc-key';

export async function getSecret(name: SecretName): Promise<string> {
  const stage = env('STAGE');
  const key = `/s2c/${stage}/${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.value;

  const result = await ssm.send(
    new GetParameterCommand({ Name: key, WithDecryption: true }),
  );
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`Parameter Store parameter ${key} is empty or missing`);
  cache.set(key, { value, fetchedAt: Date.now() });
  return value;
}

/** Required environment variable; throws at call time if unset. */
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/** Test hook. */
export function clearConfigCache(): void {
  cache.clear();
}
