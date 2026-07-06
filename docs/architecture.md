# Architecture

```
┌─ iPhone ─────────────────────────────┐
│  Share Extension ──► POST /v1/captures (base64 image, JWT)
│  App (SwiftUI)   ──► the rest of the API
└──────────────────────────────────────┘
            │ HTTPS
            ▼
API Gateway HTTP API (s2c-api-{stage})
            │
   ┌────────┴──────────┐
   ▼                   ▼
API Lambdas       captures-create ──► S3 (image) + DynamoDB (capture) ──► SQS
                                                                            │
                                                                            ▼
                                                              process-capture Lambda
                                                                classify  (Haiku)
                                                                extract   (Sonnet)
                                                                places    (venue→address)
                                                                dedup     (calendar window)
                                                                insert    (Google Calendar)
```

## API contract (v1)

All authenticated routes take `Authorization: Bearer <JWT>`. Mirrored by
`ios/Shared/Models.swift` — change both together.

| Route | Body → Response |
|---|---|
| `POST /v1/auth/google` | `{serverAuthCode}` → `{token, user:{id,email,settings}}` |
| `POST /v1/captures` | `{imageBase64}` → 202 `{captureId, status:"queued"}` or 200 `{captureId, status:"duplicate", duplicateOf}` |
| `GET /v1/captures` | → `{captures:[CaptureView], cursor}` |
| `GET /v1/captures/{id}` | → CaptureView (the app's poll target) |
| `GET /v1/captures/{id}/image` | → `{url, expiresInSeconds}` (presigned, 5 min) |
| `PATCH /v1/captures/{id}` | partial `{title?, venue?, address?, start_date?, end_date?, start_time?, end_time?, description?, url?}` (empty string clears) → CaptureView |
| `DELETE /v1/captures/{id}?deleteEvent=true` | → `{deleted:true}` |
| `GET /v1/calendars` / `POST /v1/calendars` | → `{calendars:[{id,summary,primary}]}` / `{summary}` → `{id,summary}` |
| `GET/PUT /v1/settings` | `{calendarId, timezone, consentEvalUse}` |
| `POST /v1/account/export` | → `{url, expiresInSeconds}` |
| `DELETE /v1/account` | → `{deleted:true}` (S3+DDB purge, Google token revoked) |
| `GET /v1/health` | unauthenticated liveness |

**CaptureView**: `{captureId, status, createdAt, classification, event, corrected, calendarEventId, eventLink, possibleDuplicateOf, error}` where `status ∈ queued|processing|completed|failed|duplicate|not_event`. `event` is the original extraction (never mutated); `corrected` is the user's overlay.

## DynamoDB single table (`s2c-main-{stage}`)

| Entity | PK | SK | Notes |
|---|---|---|---|
| User | `USER#<ulid>` | `PROFILE` | `GSI1PK=GSUB#<googleSub>` for sign-in lookup; `encRefreshToken` AES-256-GCM; `tokenVersion` revokes JWTs |
| Capture | `USER#<id>` | `CAPTURE#<ulid>` | ULID sort = newest-first library feed |
| Image hash | `USER#<id>` | `IMGHASH#<sha256>` | conditional put = exact re-upload dedup |
| Correction | `USER#<id>` | `CORRECTION#<ulid>` | field, old/new value, consent snapshot |
| AI call | `USER#<id>` | `AICALL#<ulid>` | stage, model, tokens, cost, latency |

## Security / auth flow

1. App: GoogleSignIn (scope `auth/calendar`) → `serverAuthCode`.
2. Backend exchanges the code (web client id + secret from AWS Systems Manager
   Parameter Store), validates the id_token claims, stores the refresh token
   encrypted (key in Parameter Store SecureString), and issues an HS256 JWT
   (`{sub, ver}`, 30 days).
3. Per request: JWT verified + `ver` compared to the user's `tokenVersion`
   (bump = revoke all sessions).
4. Calendar calls mint short-lived Google access tokens from the refresh
   token; `invalid_grant` flags `needsReauth` and the app re-runs sign-in.

## Cost model

- AWS: Lambda/DynamoDB/SQS well inside free tier at personal volume; S3 +
  CloudFront pennies. Expected ≲ $2/month steady state.
- Anthropic: ~$0.01/capture (Haiku classify + Sonnet extract at ~1.5k input
  tokens each). Tracked per call in `AICALL#` records; the eval report gives
  $/100 images per model.
- Google: Calendar API free; Places free tier covers hobby volume.

## Dedup design

1. **Exact**: SHA-256 of image bytes claimed via conditional put at upload.
2. **Fuzzy**: before insert, list calendar events in `[start−1d, end+1d]`;
   normalize titles (case/diacritics/punctuation/stopwords), score
   max(Jaccard, containment). ≥0.7 + same start date → skip and link the
   existing event; ≥0.5 → create but flag `possibleDuplicateOf`.

## Deep links

Calendar descriptions end with `View capture: https://<cloudfront>/c/<id>`.
The CloudFront web stack serves `/.well-known/apple-app-site-association`, so
iOS opens the app (capture detail); without the app the link falls back to a
static explainer page.
