# Privacy policy

The published, user-facing privacy policy is served from the CloudFront web
stack at `https://<WebDomain>/privacy.html`. **The source of truth is
[`infra/web-assets/privacy.html`](../infra/web-assets/privacy.html)** — edit
it there and redeploy `S2cWeb-{stage}` to publish changes.

Summary of the commitments it makes (keep code changes consistent with these):

- Stored: Google identity (email + sub), an encrypted Calendar refresh token,
  shared images, extracted event data, corrections. All in eu-west-2,
  encrypted at rest. Invited emails sit on the sign-up allowlist
  (`/s2c/{stage}/signup-allowlist`); account deletion does not remove them.
- Processing: images go to Anthropic (Claude) for classification/extraction;
  venue names may go to Google Places. No other third parties, no ads, no
  analytics.
- Prompt-improvement use of corrections is **opt-in** (`consentEvalUse`,
  default false, snapshotted per correction). It uses the correction's field
  and old/new value, never images, and drops corrections whose capture was
  deleted. Correction values are sent to Anthropic to draft a candidate
  prompt, and are never printed in CI logs.
- The eval dataset is built **only from the owner's own captures** and
  synthetic images, never from other users' data, even with consent.
  `npm run materialize` reads only the `OWNER_USER_ID` account.
- GDPR rights implemented in-app: full export (`POST /v1/account/export`) and
  full deletion (`DELETE /v1/account`): every `USER#<id>` item and every S3
  object under `users/<id>/` and `exports/<id>/`. The Google token revocation
  is **best-effort**: deletion goes ahead if it fails. Events already in the
  user's Google Calendar stay there.
- Deleting one capture removes its image, capture and image-hash records; its
  `CORRECTION#` items stay until account deletion.
- Retention: AI-call records 90 days (TTL), exports 7 days, Lambda logs 30
  days (IDs only, no content). Prod DynamoDB point-in-time recovery keeps 35
  days, so deleted data ages out of backups within 35 days. Re-applying
  deletions after a restore is a manual, best-effort step. S3 is not
  versioned, so a deleted image is gone at once.
