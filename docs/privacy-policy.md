# Privacy policy

The published, user-facing privacy policy is served from the CloudFront web
stack at `https://<WebDomain>/privacy.html`. **The source of truth is
[`infra/web-assets/privacy.html`](../infra/web-assets/privacy.html)** — edit
it there and redeploy `S2cWeb-{stage}` to publish changes.

Summary of the commitments it makes (keep code changes consistent with these):

- Stored: Google identity (email + sub), an encrypted Calendar refresh token,
  shared images, extracted event data, corrections. All in eu-west-2,
  encrypted at rest.
- Processing: images go to Anthropic (Claude) for classification/extraction;
  venue names may go to Google Places. No other third parties, no ads, no
  analytics.
- Eval/prompt-improvement use of corrections and images is **opt-in**
  (`consentEvalUse`, default false, snapshotted per correction).
- GDPR rights implemented in-app: full export (`POST /v1/account/export`) and
  full deletion including Google token revocation (`DELETE /v1/account`).
