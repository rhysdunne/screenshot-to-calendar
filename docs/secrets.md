# Secret management

Where every secret lives, why, and the commands to manage them. macOS-oriented
(no 1Password required — uses the built-in Keychain).

## The model — three jobs, don't conflate them

| Job | Where | Notes |
|---|---|---|
| **App runtime secrets** (source of truth) | **AWS Systems Manager Parameter Store** SecureStrings under `/s2c/{stage}/…` | The backend reads these at runtime via `backend/src/lib/config.ts`. This is the authoritative store. |
| **Personal backup + type-once** | **macOS Keychain** (built-in `security` tool) | Where *you* keep a copy so you can re-enter or rotate. Free, native, scriptable. |
| **Local-dev convenience** | a gitignored **`.env`** (or the Keychain helper) | For running `evals` / `tools` locally, which need `ANTHROPIC_API_KEY` as an env var. Never the home of production secrets. |

You don't strictly need a password manager here: **most secrets are regenerable**
(Google OAuth client secret + Places key from the Google console, Anthropic key
from the Anthropic console). The one that hurts to lose is `token-enc-key` — it
decrypts stored Google refresh tokens, so losing it forces every user to sign in
again — but it already lives durably in Parameter Store. macOS Keychain is a
convenient off-app backup and the place you type each value once.

## The five secrets

All are SecureStrings at `/s2c/{stage}/<name>`, per stage (`staging`, `prod`):

| Name | Source | Regenerable? |
|---|---|---|
| `anthropic-api-key` | [console.anthropic.com](https://console.anthropic.com/) | Yes |
| `google-oauth-client-secret` | Google Cloud → web OAuth client | Yes |
| `places-api-key` | Google Cloud → API key (restrict to Places API New) | Yes |
| `jwt-secret` | `openssl rand -hex 32` | Yes (rotating logs everyone out) |
| `token-enc-key` | `openssl rand -hex 32` | **No** — losing it forces all users to re-auth |

## What is and isn't a secret

- **Secrets** (never commit): the two API keys above, the OAuth client **secret**,
  and the two generated keys. These go to Parameter Store / Keychain only.
- **NOT secrets** (safe to commit, even in a public repo): OAuth **client IDs** —
  the web `googleClientId`, iOS `GIDClientID`/`GIDServerClientID`, and the reversed
  client id. They ship inside the iOS app binary, so they're public by design and
  live in `infra/cdk.json` / `ios/project.yml`.

## Workflow with the Keychain helper

[`scripts/secrets.sh`](../scripts/secrets.sh) wraps the macOS `security` tool with
a `s2c-<stage>-<param>` naming convention.

```bash
# 1. Store each secret once (hidden prompt, saved to the login keychain):
scripts/secrets.sh set staging anthropic-api-key
scripts/secrets.sh set staging google-oauth-client-secret
scripts/secrets.sh set staging places-api-key
scripts/secrets.sh set staging jwt-secret          # paste `openssl rand -hex 32`
scripts/secrets.sh set staging token-enc-key       # paste a different one

# 2. Push all five into Parameter Store in one go (uses --overwrite):
scripts/secrets.sh push staging                    # repeat: push prod

# 3. Read one back, or load the Anthropic key for a local eval run:
scripts/secrets.sh get staging token-enc-key
eval "$(scripts/secrets.sh env staging)"           # exports ANTHROPIC_API_KEY
```

The first `get`/`push` after storing may pop a keychain access prompt — click
**Always Allow** so later reads are non-interactive.

Prefer to skip the Keychain? Do it by hand — the raw commands are in
[setup-aws.md](setup-aws.md) §3 (`aws ssm put-parameter …`), and put
`ANTHROPIC_API_KEY` in a gitignored `.env` (see [`.env.example`](../.env.example)).

## Hygiene

- **`.gitignore` guards** the two local secret-staging files and any `*.secret.txt`,
  plus `.env*` (except this repo's `.env.example`). Stage secrets in a file named
  `something.secret.txt` if you must, then delete it once loaded.
- **Never commit** a real secret. Client IDs are fine; keys and the client secret
  are not.
- If a secret is ever exposed, **regenerate it** at the source and
  `scripts/secrets.sh set` + `push` the new value.
