# Archive — v1 pipeline (n8n + Scriptable)

This directory preserves the original hobby pipeline that ran the product before the
production rewrite: an iOS Shortcut passed a base64 image to a Scriptable script,
which POSTed it to a self-hosted n8n instance (Docker on a laptop, exposed via
Tailscale), which called Claude Vision and created a Google Calendar event.

Nothing in here is deployed or maintained. It is kept for reference because the
core logic was ported into the new backend:

| Archived file | Ported to |
|---|---|
| `n8n/prompts/extract-event.md` | `backend/src/prompts/extract-event.v2.md` |
| `n8n/nodes/parse-event-data.js` (`extractEventData`, `mapEventToCalendar`) | `backend/src/pipeline/extract.ts`, `backend/src/pipeline/map-to-calendar.ts` |
| `n8n/nodes/parse-event-data.test.js` | `backend/test/pipeline/map-to-calendar.test.ts` |
| `n8n/nodes/prepare-vision-request.js` (magic-byte format detection) | `backend/src/pipeline/image.ts` |
| `scriptable/screenshot-to-calendar.js` (resize convention, response contract) | `ios/ShareExtension/` + `ios/Shared/APIClient.swift` |

Known bug fixed during the port: the original date math used UTC
(`new Date().toISOString()`) despite the workflow running in Europe/London —
"today" was wrong between midnight and 1am BST. The new `backend/src/pipeline/dates.ts`
does all date arithmetic in the user's IANA timezone.
