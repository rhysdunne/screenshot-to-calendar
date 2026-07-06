# Google Cloud setup

One project provides OAuth (sign-in + calendar) and the Places API.

> The consent-screen **privacy/terms URLs** point at the deployed `WebDomain`
> (`https://<WebDomain>/privacy.html`), which doesn't exist until the deploy
> step. Save the consent screen without them and fill them in afterwards — this
> is the one part of Google setup that waits on AWS.

## 1. Project and APIs

1. [console.cloud.google.com](https://console.cloud.google.com) → New project
   (e.g. `screenshot-to-calendar`).
2. **APIs & Services → Library**: enable
   - **Google Calendar API**
   - **Places API (New)** — the one labelled "New"; the legacy Places API has
     a different surface.

## 2. OAuth consent screen — read this part carefully

**APIs & Services → OAuth consent screen**:

1. User type: **External**. Fill in app name, support email, and the privacy
   policy URL (`https://<WebDomain>/privacy.html` once the web stack is up).
2. Scopes: add `https://www.googleapis.com/auth/calendar`.
3. Add yourself (and any testers) as test users.
4. ⚠️ **Publish the app to Production** (Publishing status → "In
   production"), even though it stays "unverified". **In Testing status,
   Google expires refresh tokens after 7 days** — the app would silently
   lose calendar access weekly. Production-unverified shows a warning screen
   during sign-in and caps you at 100 users; that's fine for personal use.
   Full verification (needs a demo video and domain ownership) is only
   required for a public launch.

## 3. OAuth clients (two of them)

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

1. **iOS client** — bundle id `digital.callaeas.s2c`. Copy:
   - the client id → `GIDClientID` in `ios/project.yml`
   - the reversed client id (shown in the console) → URL scheme in
     `ios/project.yml`
2. **Web application client** — no redirect URIs needed (the backend
   exchanges server auth codes directly). Copy:
   - client id → `googleClientId` in `infra/cdk.json`
   - client secret → SSM `/s2c/{stage}/google-oauth-client-secret`

The iOS app uses both: the **iOS client id** (`GIDClientID`) identifies the
app to Google, and the **web client id** (`GIDServerClientID`) is what makes
Google return a `serverAuthCode` that the backend can exchange for a refresh
token. Both keys live in `ios/project.yml` under the app target's Info
properties — replace the two placeholders there.

## 4. Places API key

**Credentials → Create credentials → API key**, then restrict it:

- API restriction: **Places API (New)** only.
- Store it in SSM: `/s2c/{stage}/places-api-key`.

Pricing: the free tier (~10k Essentials calls/month) vastly exceeds personal
usage; the pipeline calls Places at most once per capture and only when the
image showed a venue without an address.

## 5. Sanity check

After the backend is deployed and the app signed in once:

```bash
aws logs tail /aws/lambda/s2c-authgoogle-staging --since 10m --region eu-west-2
```

A successful sign-in logs `user_created`. `invalid_grant` at sign-in usually
means the consent screen is still in Testing status or the wrong client
id/secret pairing.
