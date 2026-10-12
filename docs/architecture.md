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
                                                                gate      (low confidence → needs_review)
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
| `GET /v1/captures` | → `{captures:[CaptureView], cursor}`, newest first, up to 200 per page (the app reads only the first page) |
| `GET /v1/captures/{id}` | → CaptureView (the app's poll target) |
| `GET /v1/captures/{id}/image` | → `{url, expiresInSeconds}` (presigned, 5 min) |
| `PATCH /v1/captures/{id}` | partial `{title?, venue?, address?, start_date?, end_date?, start_time?, end_time?, description?, url?}` (empty string or null clears) → CaptureView. A changed date must be `YYYY-MM-DD` and a changed time `HH:MM` (else 400). A sent `end_time` equal to the start time on the start day is stored as no end time, so the event gets the default length (start + 2 h, clamped to 23:59). When the event goes to Google or a date or time changed, the merged event must end after it starts (else 400 `invalid_time_range`). Both are checked before anything is written. The Google event is patched only through `calendarEventId`, so never for a duplicate. Each changed field then becomes a `CORRECTION#` item, only once any patch has succeeded (max 20 per user per day, else 429 `correction_limit`) |
| `POST /v1/captures/{id}/approve` | no body → CaptureView. Only for a `needs_review` or `failed` capture that has an extracted `event` (else 409). Runs the processor's dedup + insert on the effective event (corrections overlaid) and clears a stale `error`; 409 if it has no date or does not end after it starts. With no target calendar it returns the capture still `failed`, with `error` saying to pick one |
| `DELETE /v1/captures/{id}?deleteEvent=true` | → `{deleted:true}`. `deleteEvent=true` also deletes the event in `calendarEventId`; a duplicate ignores it and only the capture goes |
| `GET /v1/calendars` / `POST /v1/calendars` | → `{calendars:[{id,summary,primary}]}` / `{summary}` → `{id,summary}` |
| `GET/PUT /v1/settings` | `{calendarId, timezone, consentEvalUse}` |
| `POST /v1/account/export` | → `{url, expiresInSeconds}` |
| `DELETE /v1/account` | → `{deleted:true}` (S3+DDB purge, Google token revoked) |
| `GET /v1/health` | unauthenticated liveness |

**CaptureView**: `{captureId, status, createdAt, classification, event, corrected, calendarEventId, eventLink, matchedEventId, possibleDuplicateOf, error}` where `status ∈ queued|processing|completed|failed|duplicate|not_event|needs_review`.

- `event` is the original extraction (never mutated). `corrected` is the user's overlay, keyed by field name: a key with a string value replaces the extracted value, a key with `null` means the user cleared that field, and an absent key means not corrected.
- `needs_review`: the extraction came back with `confidence: "low"`, so no calendar event was created. The app shows the fields for checking and calls `approve`.
- `failed`: `error` says why. A failure that a retry cannot fix (no date, an event that does not end after it starts, a Google grant that needs a new sign-in) keeps `classification` and `event`, so the app can show the fields for fixing and call `approve`. A model refusal is also final, but it leaves no `event`, so `error` tells the user to add the event to their calendar themselves. Other failures, including a reply cut off at max_tokens, are retried by SQS and keep no `event`.
- `calendarEventId` is only ever an event this capture created. It is null for a duplicate.
- `duplicate`: the dedup step matched an existing event, so nothing was created. `matchedEventId` is that event, and `eventLink` opens it. The capture never edits or deletes it. `matchedEventId` is null for every other status.
- `possibleDuplicateOf`: the event was created, but a similar existing event (by title) was found.

## DynamoDB single table (`s2c-main-{stage}`)

| Entity | PK | SK | Notes |
|---|---|---|---|
| User | `USER#<ulid>` | `PROFILE` | `GSI1PK=GSUB#<googleSub>` for sign-in lookup; `encRefreshToken` AES-256-GCM; `tokenVersion` revokes JWTs |
| Capture | `USER#<id>` | `CAPTURE#<ulid>` | ULID sort = newest-first library feed; `calendarEventId`/`calendarId` = the event it created; `matchedEventId`/`matchedCalendarId` = the event a duplicate matched |
| Image hash | `USER#<id>` | `IMGHASH#<sha256>` | conditional put = exact re-upload dedup |
| Correction | `USER#<id>` | `CORRECTION#<ulid>` | field, old/new value, consent snapshot |
| AI call | `USER#<id>` | `AICALL#<ulid>` | stage, model, tokens, cost, latency |

## Security / auth flow

1. App: GoogleSignIn (scope `auth/calendar`) → `serverAuthCode`.
2. Backend exchanges the code (web client id + secret from AWS Systems Manager
   Parameter Store), validates the id_token claims, stores the refresh token
   encrypted (key in Parameter Store SecureString), and issues an HS256 JWT
   (`{sub, ver}`, 180 days).
3. Per request: JWT verified + `ver` compared to the user's `tokenVersion`
   (bump = revoke all sessions). `scripts/sessions.sh revoke-user <stage>
   <email>` bumps it for one user; `revoke-all <stage>` rotates `jwt-secret`.
4. Calendar calls mint short-lived Google access tokens from the refresh
   token; `invalid_grant` flags `needsReauth` and the app re-runs sign-in.
   A Calendar 401, or a 403 for a missing calendar scope, also answers
   401 `needs_reauth`; in the processor it fails the capture terminally
   and flags `needsReauth`.

## Cost model

- AWS: Lambda/DynamoDB/SQS well inside free tier at personal volume; S3 +
  CloudFront pennies. Expected ≲ $2/month steady state.
- Anthropic: ~$0.006/capture (Haiku 5.5 classify at ~1.6k input tokens, about
  $0.0002, plus Sonnet 5 extract at ~2.3k, about $0.006; measured in
  `evals/reports/model-refresh-2026-10/`). Tracked per call in `AICALL#`
  records; the eval report gives $/100 images per model.
- Google: Calendar API free; Places free tier covers hobby volume.

## Dedup design

1. **Exact**: SHA-256 of image bytes claimed via conditional put at upload.
2. **Own event**: before insert, list calendar events in `[start−1d, end+1d]`.
   An event whose description carries this capture's `/c/<captureId>` link
   was created by an earlier attempt at the same capture (an SQS redelivery,
   or a double approve). The capture adopts it as `completed` with that
   `calendarEventId` instead of inserting again or matching itself as a
   duplicate, and patches it with the current attempt's details so the
   calendar matches the stored extraction.
3. **Fuzzy**: otherwise, normalize the titles in that window
   (case/diacritics/punctuation/stopwords) and score max(Jaccard,
   containment). ≥0.7 + same start date → skip, mark the capture `duplicate`
   and store the match in `matchedEventId` (not `calendarEventId`); ≥0.5 →
   create but flag `possibleDuplicateOf`.

## Deep links

Calendar descriptions carry `View capture: https://<cloudfront>/c/<id>` (just
above the `[Auto-captured · Confidence: …]` footer); dedup also uses it to
recognise a capture's own event.
The CloudFront web stack serves `/.well-known/apple-app-site-association`, so
iOS opens the app (capture detail); without the app the link falls back to a
static explainer page.
