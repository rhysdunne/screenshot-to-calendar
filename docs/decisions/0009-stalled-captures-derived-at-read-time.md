# 0009. Report stalled captures as failed at read time

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** Rhys + Claude Code

## Context

The processor Lambda (120 s timeout) takes captures from the SQS queue
`s2c-process-{stage}` (visibility timeout 180 s, `maxReceiveCount` 3) two at a
time. A processor that times out or crashes never reaches the `catch` block in
`process-capture.ts`, so it never writes `failed`. After the third attempt SQS
moves the message to the DLQ, and the stored status stays `queued` or
`processing`. The app showed the capture as Processing for ever: its poll stops
after 60 s, and the DLQ alarm tells the operator, not the user
([#122](https://github.com/rhysdunne/screenshot-to-calendar/issues/122)).

The options considered:

- **A DLQ consumer Lambda** that marks the capture `failed`. It would know
  sooner, about 9 minutes after the share (three attempts, each followed by a
  180 s visibility timeout). But a consumer deletes the messages it reads. The
  DLQ alarm (`s2c-dlq-not-empty-*`) watches the number of visible messages, and
  the runbook in [`docs/deploy.md`](../deploy.md) redrives them from the SQS
  console after a fix. A consumer would silence the first and leave nothing for
  the second, unless it also copied every message to a third queue. It also
  adds a Lambda, its IAM and its own failure mode.
- **`ApproximateReceiveCount` in the processor**: on the last receive, write
  `failed` before the work starts and clear it on success. The app would show
  Failed for the whole of a last attempt that might still succeed. The
  processor would need its own copy of `maxReceiveCount` from the infra stack.
  A crash before that write (in the Lambda's start-up, or in the reads before
  the first write) leaves the capture `queued` or `processing` for ever, which
  is the gap the change was meant to close.
- **A Lambda on-failure destination.** An SQS event source mapping does not
  support one: AWS offers on-failure destinations only for stream sources
  (Kinesis, DynamoDB Streams, Kafka), and the destinations for asynchronous
  invocation do not apply to a mapping. Even where one exists, it delivers the
  record to a queue, topic or bucket, so something still has to read it and
  write the status, which is the first option again.
- **Derive the status when the API reads the capture** (chosen).

## Decision

Implemented in [PR #127](https://github.com/rhysdunne/screenshot-to-calendar/pull/127):

- `captureView` in `backend/src/handlers/captures-read.ts` reports `failed`,
  with `STALLED_ERROR` ("delete this capture, then share the screenshot
  again"), when the stored status is `queued` or `processing` and nothing has
  written the capture for `STALLED_AFTER_MS` (10 minutes). `isStalled` uses
  `updatedAt`, and `createdAt` when that does not parse. Nothing is written on
  read.
- `captures-approve.ts` accepts a stalled capture as it accepts a `failed`
  one. `captures-update.ts` stores `status: "failed"` and the error when it
  corrects a stalled capture, because its write refreshes `updatedAt` and
  would otherwise bring the capture back as `processing`.
- An infra stack test (`infra/test/stacks.test.ts`) fails if the queue's
  visibility timeout goes above 300 s.

## Consequences

- Both stalled states are covered, `queued` as well as `processing`, with no
  new AWS resources. The DLQ alarm and console redrive work as before.
- A redrive repairs a stalled capture by itself. Every attempt writes
  `processing`, which refreshes `updatedAt`, so the API reports the live state
  again and then the result. It helps only captures the user has not deleted;
  for a deleted one the processor logs `capture_missing` and drops the message.
- Storage and the API disagree on purpose. The account export and anything
  else that reads DynamoDB directly see the stored `processing`. A new reader
  that shows status to a user goes through `captureView` or `isStalled`.
- The threshold is coupled to the visibility timeout. A capture waiting for its
  retry was last written up to one visibility timeout ago, so that timeout must
  stay well under 10 minutes. AWS suggests 6 x the function timeout (720 s
  here), which would break this. The stack test guards it, and comments by the
  queue setting and the constant name each other.
- Time in the queue counts towards the 10 minutes, and the threshold does not
  allow for it. With two captures at a time, a live capture with about 60
  captures ahead of it at normal speed, or about 10 when every attempt times
  out, is reported as failed. A large DLQ redrive can cause that, so
  [`docs/deploy.md`](../deploy.md) says to run one at a quiet time.
- The user sees Failed about 16 minutes after sharing (the last attempt
  starts at about 6 minutes, plus 10), and only after a refresh.
- [#130](https://github.com/rhysdunne/screenshot-to-calendar/issues/130) (a
  deadline for the Claude and Calendar calls inside the Lambda timeout) would
  let a slow call fail through the normal `catch` path, sooner and with a
  specific error. Crashes would still need this check.
- Revisit if false failures from a backlog show up in practice, or if a second
  reader needs the derived status, such as the export or a reporting job. Then
  store the status (for example with a scheduled sweep) in a new ADR that
  supersedes this one.
