import { Logger } from '@aws-lambda-powertools/logger';

export const logger = new Logger({
  serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 's2c',
});

/**
 * Reduce an unknown error to a log-safe summary. Raw `String(e)` can echo
 * third-party API response bodies (Google/Places/Anthropic) into CloudWatch,
 * which may carry user content (venue names) or token detail. This keeps only
 * the error name and, when present, a machine `code` — never the free-form
 * message. Full detail can still be surfaced locally via a debugger.
 */
export function safeError(e: unknown): { name: string; code?: string } {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? { name: e.name, code } : { name: e.name };
  }
  return { name: 'UnknownError' };
}
