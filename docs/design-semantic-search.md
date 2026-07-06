# Design: semantic search over captures (the scrapbook layer)

Status: **designed, not implemented** — to be validated against real usage
of the shipped event pipeline first. This doc is written to be executable in
a future session without re-deriving decisions.

## Product framing

The scrapbook thesis: **screenshots are the universal export from walled
gardens.** Instagram posts, LinkedIn articles, tweets — none of them can be
saved anywhere useful, but all of them can be screenshotted. The app becomes
the place those screenshots stop being dead pixels: searchable by meaning,
browsable by source and topic, and actionable (events already become
calendar entries).

### Why this beats Apple Photos search

| | Apple Photos | This |
|---|---|---|
| Corpus | Entire camera roll (noise) | Only what you deliberately shared in |
| Matching | OCR words visible in the image | Meaning: "that post about hiring juniors" finds an article that never contains those words |
| Metadata | None you can use | `platform`, `author`, `title`, `topics` per capture → boards/filters |
| Actions | Ends at "found it" | Events → calendar; later: reading lists, digests |

The honest overlap: exact-words-in-image search is already free on-device.
Don't compete there; build the curated, meaning-indexed, source-aware layer.

### Shape of the feature

1. **Phase 1 — search bar**: natural-language search over all captures.
2. **Phase 2 — the visual layout**: auto-grouped boards (by `platform`:
   "LinkedIn reads", "Instagram saves"; by topic clusters: "ceramics",
   "restaurants") — a Pinterest-style browse over your own screenshots.

## Architecture

```
process-capture (existing)
  classify → [describe (NEW, all captures)] → extract (events only) → …
                   │
                   ├─ capture.describe = {caption, platform, author, title, topics, summary}
                   └─ embed(describe text) → EMBED#<captureId> item (vector)

POST /v1/search {query}
  embed(query) → Query EMBED# items → cosine top-k in memory → hydrate captureViews
```

### 1. Describe stage (new pipeline step)

- New versioned prompt `backend/src/prompts/describe-image.v1.md`, pinned in
  the existing registry (`prompts.ts` `ACTIVE_VERSIONS`), structured-output
  schema in `schemas.ts`:

```json
{
  "caption": "one dense sentence of what the image shows",
  "platform": "instagram | linkedin | twitter | web | photo | other",
  "author": "handle/name if visible, else null",
  "title": "post/article title if any, else null",
  "topics": ["3-5 short topic tags"],
  "summary": "2-3 sentences of the CONTENT (what the article/post says), not the layout"
}
```

- Runs in `process-capture.ts` for **every** capture (events too — an event
  poster is also scrapbook content), model `claude-haiku-4-5`, via the
  existing `lib/anthropic.ts` (cost/latency tracked automatically, AICALL
  record, AiCostUsd metric). Non-fatal on failure.
- Stored as `describe` on the capture record; surfaced in `captureView`.

The `summary` field is the key to the LinkedIn use case: it captures what
the article *argues*, which is what you'll remember when searching.

### 2. Embeddings

- **Provider: Voyage AI** (`voyage-3.5-lite`, `output_dimension: 512`) —
  Anthropic's recommended embeddings partner; a few cents per thousand
  captures. Key at `/s2c/{stage}/voyage-api-key` (SSM SecureString, same
  pattern as the others). Alternative if a second AI vendor is unwanted:
  Google's `text-embedding` API (GCP project already exists).
- New `backend/src/lib/embeddings.ts` mirroring `lib/anthropic.ts`: single
  entry point, fetch-based, logs cost. `embedText(text: string): number[]`
  plus a batched variant for backfill.
- **Embed text, not pixels**: input is
  `[caption, title, author, topics.join(', '), summary]` joined — cheap,
  debuggable, and the caption already encodes what matters visually.
  Upgrade path (documented, not built): `voyage-multimodal-3` to embed the
  image directly, which would also catch purely visual queries.

### 3. Storage & retrieval — no vector DB

- New item: `PK=USER#<id>`, `SK=EMBED#<captureId>`, attributes:
  `vector` (base64-packed Float32Array, ~2KB at 512 dims), `model`,
  `createdAt`. Fits the single-table design; deleted alongside the capture
  (extend `deleteCapture` and account deletion accordingly).
- `POST /v1/search {query, limit=20}` handler: embed the query → Query all
  `EMBED#` items for the user (a few thousand captures ≈ a handful of 1MB
  pages) → cosine similarity in memory → top-k → `getCapture` hydration →
  `{results: [{capture, score}]}`.
- **Scale honesty**: brute force is comfortably fine to ~50k captures
  (50k × 512 floats ≈ 100MB… so in practice cache the packed matrix in an
  S3 object per user and refresh on write once past ~5k). A real vector
  index is 3+ orders of magnitude away from single-user reality. Do not
  build it.

### 4. Backfill

`tools/backfill-describe.ts` (pattern: `materialize-eval-cases.ts`): scan
captures lacking `describe`, fetch image from S3, run describe + embed,
write back. Idempotent, rate-limited, prints cost as it goes.

### 5. iOS

- Phase 1: search field in `LibraryView` → `POST /v1/search` → results in
  the existing `CaptureTile` grid, ranked. Empty query = normal library.
- Phase 2 (visual layout): a Boards tab — sections per `describe.platform`
  and per topic cluster. Topic clusters can start embarrassingly simple:
  group by most-common `topics` tags; k-means over embeddings only if tags
  feel noisy. `Models.swift` gains the `describe` mirror struct.

### 6. Retrieval evals (extend the harness)

The eval discipline carries over: retrieval quality gets measured, and
describe-prompt changes get gated like extraction-prompt changes.

- Labeled query set `evals/dataset/queries.json`:
  `[{query, expectedCaptureIds[]}]`. Derivable from synthetic gold
  (paraphrased titles, "venue + genre" phrasings) plus hand-written queries
  against real captures.
- Harness mode `npm run eval -- --retrieval`: build the index over the
  dataset, run queries, report **recall@5** and **MRR** per
  describe-prompt-version × embedding model.
- Gate rule: a `describe-image.v2` candidate must not regress recall@5.

### 7. GDPR / consent deltas

Captions, summaries, and embeddings are derived personal data:
- Included in the account export automatically (they live on user-keyed
  items → `listAllUserItems` already picks them up).
- Deleted with the capture and with the account (same key prefix).
- Privacy policy: broaden "extracted event data" to "extracted data
  (event details, captions, and search indexes)" and add Voyage AI to the
  processors list — one-sentence edits in `infra/web-assets/privacy.html`,
  flagged for when this ships.

### 8. Cost

- Describe: ~1.5k input tokens on Haiku ≈ $0.002/capture.
- Embedding: ≈ $0.0001/capture; queries ≈ $0.0001 each.
- Net: the scrapbook layer roughly **doubles** per-capture AI cost to
  ~$0.01–0.015 — still trivially inside the spend alarm.

## Non-goals (now)

- Vector database / OpenSearch / pgvector — premature by orders of magnitude
- Multimodal image embeddings — upgrade path, not v1
- Cross-user discovery or sharing
- On-device index (would sacrifice the backend views and cross-device state)

## Build checklist (future session)

1. `backend/src/prompts/describe-image.v1.md` + schema + registry pin
2. `backend/src/lib/embeddings.ts` (+ `voyage-api-key` secret, docs update)
3. `process-capture.ts`: describe + embed steps; `ddb.ts`: `describe` field,
   EMBED# put/delete; `captureView` exposure
4. `handlers/search.ts` + route in `infra/lib/backend-stack.ts`
5. `tools/backfill-describe.ts`
6. Retrieval eval mode + `queries.json` seed set
7. iOS: `Models.swift` describe mirror, `LibraryView` search field,
   `APIClient.search`
8. Privacy policy sentence + `docs/architecture.md` API table row
9. Tests throughout (fake embeddings provider in `test/helpers/fake-deps.ts`)
