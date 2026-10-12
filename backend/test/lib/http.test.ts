// errorResponse (#37): a 500 must leave a GDPR-safe trace in the logs (class,
// code, upstream status) without the free-form message.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { errorResponse, HttpError } from '../../src/lib/http.js';
import { GoogleCalendarError } from '../../src/lib/google-calendar.js';
import { logger } from '../../src/lib/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorResponse', () => {
  it('logs an unhandled Google error with its status and reason, not its message', () => {
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const res = errorResponse(
      new GoogleCalendarError('Google Calendar: The Secret Garden is not found', 404, 'notFound'),
    ) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ error: 'Internal error' });
    expect(log).toHaveBeenCalledWith('unhandled_error', {
      error: { name: 'GoogleCalendarError' },
      status: 404,
      reason: 'notFound',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Secret Garden');
  });

  it('logs any other unhandled error by class name only', () => {
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    errorResponse(new TypeError('cannot read venue of undefined'));
    expect(log).toHaveBeenCalledWith('unhandled_error', { error: { name: 'TypeError' } });
  });

  it('does not log expected HttpErrors', () => {
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const res = errorResponse(new HttpError(404, 'Capture not found')) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(404);
    expect(log).not.toHaveBeenCalled();
  });
});
