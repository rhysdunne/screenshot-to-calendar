# CLAUDE.md

## Project: screenshot-to-irl

An automation pipeline that turns screenshots and photos of event posters, flyers, and Instagram posts into Google Calendar events. Built to solve the universal habit of screenshotting things you want to do and then never acting on them.

## How it works

```
iPhone Share Sheet
  → iOS Shortcut (base64 encodes the image)
    → Scriptable (resizes image, POSTs to n8n webhook, shows result)
      → n8n Webhook (receives base64 image)
        → Claude Vision API (extracts structured event data as JSON)
          → Google Calendar (creates event with title, dates, venue, description)
            → Response back to Scriptable (confirmation alert with "Open in Calendar" option)
```

The user's flow: see a poster or Instagram post → share the image → tap "Capture Event" → get a calendar event created automatically.

## Key files

| File | Purpose |
|------|---------|
| `screenshot-to-calendar.js` | Scriptable script that runs on iPhone. Handles three input modes: via iOS Shortcut (receives base64 string), via Scriptable Share Sheet (receives image directly), or manual run (photo picker). POSTs to the n8n webhook and displays the result. |
| `n8n/workflow.json` | n8n workflow JSON — import into n8n via Workflows → Import. The live workflow in n8n may have diverged. **Always `make pull` before making changes here.** |
| `n8n/nodes/prepare-vision-request.js` | JavaScript code for the Prepare Vision Request n8n node, extracted by `make pull`. Contains `{{PROMPT}}` placeholder — do not edit the prompt here, edit `n8n/prompts/extract-event.md` instead. `make push` injects the prompt and deploys. |
| `n8n/prompts/extract-event.md` | The Claude Vision prompt. Edit this to change what Claude extracts or how. Uses `{{TODAY}}` as a placeholder for today's date, injected at runtime. |
| `scripts/pull-prompt.py` | Extracts the prompt from `n8n/nodes/prepare-vision-request.js` to `n8n/prompts/extract-event.md` and restores the `{{PROMPT}}` placeholder. Called by `make pull`. |
| `scripts/push-prompt.py` | Injects `n8n/prompts/extract-event.md` into `n8n/nodes/prepare-vision-request.js` and writes the result to stdout. Called by `make push`. |
| `docker-compose.yml` | Docker Compose config for the self-hosted n8n instance. Mounts `~/.n8n` for persistent data. |
| `images/test-image.jpg` | A test image of an event poster, used during development for testing the pipeline via curl. |
| `images/ios-shortcut-setup.png` | Screenshot of the iOS Shortcut configuration, referenced in the README. |

## n8n workflow nodes (in execution order)

1. **Webhook** — Receives POST at `/webhook/screenshot-to-calendar` with `{type: "image", image: "<base64>"}`. Response mode is set to "last node" so the Scriptable script gets the final output.
2. **Route by Type** (Switch) — Branches on `body.type`: `"image"` goes to the vision pipeline, `"url"` goes to a placeholder (not yet implemented).
3. **Prepare Vision Request** (Code) — Builds the Anthropic API request body. Detects image format from base64 magic bytes (PNG starts with `iVBOR`, JPEG with `/9j/`). Injects today's date into the prompt so Claude can resolve relative dates like "next Saturday".
4. **Claude Vision API** (HTTP Request) — POSTs to `https://api.anthropic.com/v1/messages` with the image and extraction prompt. Uses Header Auth credential for the API key. 120s timeout.
5. **Parse Event Data** (Code) — Extracts JSON from Claude's response, handles markdown code fences. Builds Google Calendar fields: maps dates/times, handles all-day vs timed events, constructs description from venue/address/URL/confidence.
6. **Google Calendar** (v1.3) — Creates the event. `start` and `end` are top-level required params. `summary`, `description`, `location`, and `allday` go inside `additionalFields`.
7. **Format Response** (Code) — Returns `{status, message, calendarEventId, eventLink}` to the Scriptable script.
8. **URL Path (TODO)** (Code) — Placeholder that returns an error message. Instagram URL parsing is not yet implemented.

## iOS Shortcut configuration

The Shortcut is called "Capture Event" and appears at the top level of the iOS Share Sheet.

Actions:
1. Receive **Images** from Share Sheet (if no input: Ask For Photos — allows the Shortcut to be run directly from the Shortcuts app)
2. **Connect to Tailscale network** — no-op if already connected, so no conditional check needed
3. **Resize Image** to longest edge 1000px
4. **Base64 Encode** the resized image (Line Breaks: None)
5. **Run Script** "screenshot-to-calendar" in Scriptable, passing the Base64 Encoded string as text input

Note: The Shortcut passes text (base64) to Scriptable because Scriptable's "Run Script" action from Shortcuts silently drops image inputs — it only supports text via `args.shortcutParameter`. Resizing must happen in the Shortcut before encoding: large screenshots (e.g. 1.4 MB PNG) produce ~1.9 MB base64 strings that exceed the Shortcuts→Scriptable text size limit, causing `Data.fromBase64String()` to return null on a truncated string.

## Infrastructure

- **n8n**: Self-hosted via Docker Desktop on macOS. Data persists in `~/.n8n/` (bind mount, contains `database.sqlite`).
- **Networking**: n8n is exposed to the iPhone via Tailscale (MagicDNS hostname in the compose file). No custom domain.
- **Google Calendar OAuth**: Set up via `localhost:5678` callback URL. The `N8N_EDITOR_BASE_URL` env var ensures the OAuth callback uses localhost while `WEBHOOK_URL` uses the Tailscale hostname for external webhooks.
- **Anthropic API**: Uses Header Auth credential in n8n. Model is `claude-sonnet-4-20250514`.
- **n8n version**: 2.3.6 (as of initial development). Google Calendar node is v1.3.

## First-time setup

### 1. Environment
```bash
cp .env.example .env
# Fill in N8N_WEBHOOK_URL (your Tailscale hostname), N8N_API_KEY, and N8N_WORKFLOW_ID
make up
```

### 2. n8n credentials (via n8n UI at http://localhost:5678)

**Anthropic API key:**
- Settings → Credentials → Add → Header Auth
- Name: `Header Auth account`
- Name field: `x-api-key`, Value field: your Anthropic API key

**Google Calendar OAuth:**
- Settings → Credentials → Add → Google Calendar OAuth2
- Follow the OAuth flow — callback URL is `http://localhost:5678/oauth2/callback`
- `N8N_EDITOR_BASE_URL=http://localhost:5678/` in docker-compose.yml ensures this works locally

### 3. Workflow
```bash
make push   # deploy workflow JSON to n8n
```
Then activate the workflow in the n8n editor (toggle in top-right).

### 4. Scriptable (iPhone)
```bash
make deploy  # copies screenshot-to-calendar.js to Scriptable's iCloud folder
```
- Open Scriptable on iPhone, run `screenshot-to-calendar` — it will prompt for your n8n hostname (e.g. `myhost.ts.net`)
- Port defaults to `5678`; set `n8n_port` in Keychain only if different

### 5. iOS Shortcut
- Create a Shortcut called "Capture Event" (or similar) in the Share Sheet
- Actions: Receive Images (Ask For Photos if no input) → Connect to Tailscale → Base64 Encode → Run Script "screenshot-to-calendar" in Scriptable

### Subsequent use
- `make pull` before editing the workflow JSON, `make push` to deploy changes
- `make deploy` after editing `screenshot-to-calendar.js`

## Claude Vision prompt

The prompt lives in `n8n/prompts/extract-event.md`. It asks Claude to extract:
```json
{
  "title": "event or exhibition name",
  "venue": "venue name if visible, otherwise null",
  "address": "full address if visible, otherwise null",
  "start_date": "YYYY-MM-DD or null",
  "end_date": "YYYY-MM-DD or null",
  "start_time": "HH:MM or null (24h format)",
  "end_time": "HH:MM or null (24h format)",
  "description": "brief one-sentence summary",
  "url": "any website or ticket link visible, otherwise null",
  "confidence": "high/medium/low"
}
```

Key prompt rules: infer end dates from "until" / "runs through" phrasing, resolve day-of-week references relative to today, assume 2026 for ambiguous years, include Instagram handles in description.

## Known issues and quirks

- **Base64 encoding in Shortcuts outputs PNG** regardless of input format. The n8n Code node detects format from base64 magic bytes to set the correct `media_type` for the Anthropic API.
- **n8n Google Calendar node v1.3**: `summary`, `description`, `location`, and `allday` must be inside `additionalFields`, not top-level params. `allday` accepts string values `"yes"` / `"no"`, not booleans.
- **Webhook paths**: `/webhook/screenshot-to-calendar` only works when workflow is Active. `/webhook-test/screenshot-to-calendar` only works for a single request while the editor is listening.
- **Large images**: iPhone photos can be 10MB+, base64 inflates by ~33%. Scriptable resizes to longest edge 1000px before POSTing, which keeps payloads manageable.
- **Anthropic API key in Claude Vision API node**: The node uses a Header Auth credential reference — do not also add an `x-api-key` header parameter manually. Having both causes the key to be stored in plaintext in the workflow JSON, which will be exposed by `make pull`. The credential reference alone is sufficient.
- **`make pull` strips metadata**: The pull target uses `jq` to keep only `name`, `nodes`, `connections`, `settings`, and `staticData` from the n8n API response. The raw response includes personal account data and internal IDs that shouldn't be committed.
- **n8n PUT API rejects certain settings fields**: `availableInMCP` and `timeSavedMode` are returned by the GET endpoint but rejected by PUT. The `make push` target strips them via `jq` before sending.

## Configuration

- **Scriptable (iPhone)**: `n8n_host` and `n8n_port` are stored in the Scriptable Keychain. Set once by running `screenshot-to-calendar.js` manually with no image — it will prompt for the hostname. Port defaults to `5678`.
- **Docker**: `N8N_WEBHOOK_URL`, `N8N_API_KEY`, and `N8N_WORKFLOW_ID` are set in `.env` (gitignored). See `.env.example`.
- **n8n**: Anthropic API key and Google Calendar OAuth are stored in n8n's credential store (`~/.n8n/database.sqlite`), not in this repo.

## Things still to parameterise

- `MAX_LONGEST_EDGE` in `screenshot-to-calendar.js`
- Claude model name in the "Prepare Vision Request" Code node
- Google Calendar ID (currently targeting the `ig-events` calendar)

## Planned enhancements

Tracked as GitHub issues:

- [#8 Deduplication](../../issues/8) — Before creating an event, query Google Calendar for events with similar titles in the same date range. Fuzzy match to catch duplicates from different sources.
- [#3 Image attachment](../../issues/3) — Upload the source image to Google Drive, attach it to the calendar event so the original poster/screenshot is reviewable alongside the parsed data.
- [#6 Weekly digest](../../issues/6) — Scheduled n8n workflow that runs Monday mornings: queries the events calendar for the next 7 days, formats a summary, sends via email or Telegram.
- [#5 Venue enrichment](../../issues/5) — If `address` is null but `venue` is present, hit Google Places Text Search API to resolve the full address and Google Maps link.
- [#7 Category tagging](../../issues/7) — Extend the Claude prompt to classify events (exhibition, music, theatre, food/drink, workshop, talk). Could map to colour-coded calendars or description prefixes.
- [#2 Confidence gating](../../issues/2) — If Claude returns `confidence: low`, send a review notification instead of auto-creating the event.
- [#4 Price extraction](../../issues/4) — Add a `price` field (free / £amount / unknown) to the Claude prompt.
- [#1 Instagram URL path](../../issues/1) — Accept Instagram post URLs, resolve via oEmbed API, extract image and caption for parsing. Optionally fetch account bio for venue address.
- [#9 Simplify iOS Shortcut](../../issues/9) ✓ — Resizing happens in the Shortcut (Resize Image action, longest edge 1000px) before base64 encoding. Scriptable uses the pre-resized base64 as-is. Decode+resize inside Scriptable was attempted but fails for large screenshots because the base64 string exceeds the Shortcuts→Scriptable text size limit.

## Development notes

- Use `make pull` before editing — it fetches the live workflow, extracts `n8n/nodes/prepare-vision-request.js`, and extracts the prompt to `n8n/prompts/extract-event.md`. To change the prompt, edit `n8n/prompts/extract-event.md`. To change request logic, edit `n8n/nodes/prepare-vision-request.js`. Then `make push` to deploy. Do not edit the workflow JSON directly.
- Use `make deploy` to copy `screenshot-to-calendar.js` to the Scriptable iCloud folder. iCloud sync to the iPhone takes a few seconds.
- Use `make up` / `make down` / `make logs` to manage the n8n Docker container.
- To test the webhook locally: `curl -X POST http://localhost:5678/webhook/screenshot-to-calendar -H "Content-Type: application/json" -d '{"type":"image","image":"<base64>"}'`
- n8n credentials (Anthropic API key, Google Calendar OAuth) are stored in n8n's database (`~/.n8n/database.sqlite`) and are not in this repo.
