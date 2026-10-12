# Adding real screenshots to the eval dataset

Synthetic posters cover layout variety, but real Instagram screenshots are the
distribution that matters. Add any capture the pipeline got wrong (or right —
regression cases are valuable too).

**Consent rule**: only add images from users whose `consentEvalUse` setting
was on (for your own screenshots, that's you). The eval harness refuses to
run if any case in `dataset/real/` lacks `"consent": true` in its
`meta.json`, and `npm test` in `evals/` checks every committed case. The
harness can only check that the field is there, not that the consent is
real, so the rule still rests on you.

**This repo is public.** Everything you commit, image pixels included, stays
readable in git history for good. Work through the checklist under
[Before you commit](#before-you-commit) for every case.

## Steps

1. Create a directory `evals/dataset/real/<case-id>/` — name it something
   descriptive, e.g. `real-012-ig-story-relative-date`.
2. Drop the screenshot in as `image.png` (or `image.jpg`).
3. Create `gold.json` with the CORRECT extraction — what a careful human
   reads off the image (not what the model said):

```json
{
  "title": "…",
  "venue": "… or null",
  "address": "only if actually visible in the image, else null",
  "start_date": "YYYY-MM-DD or null",
  "end_date": "YYYY-MM-DD or null",
  "start_time": "HH:MM or null",
  "end_time": "HH:MM or null",
  "description": null,
  "url": "only if visible, else null",
  "price": "as printed, e.g. \"Free\" or \"£12.50\", else null",
  "category": "exhibition | music | theatre | club_night | food_drink | market | workshop | talk | film | other",
  "confidence": "high"
}
```

`price` and `category` are the fields extract-event v3 added. Label them the
way that prompt asks: "free entry" is `"Free"`, and when several prices show
(advance and door, say) use the lowest with its label, e.g. `"£8 adv"`.

4. Create `meta.json`. `frozenToday` is the date you took the screenshot —
   it's what `{{TODAY}}` is set to during evals, which is what makes
   relative phrasings ("this Saturday", missing years) resolvable forever:

```json
{
  "source": "user",
  "frozenToday": "2026-07-06",
  "classification": { "category": "event_screenshot", "is_event": true, "confidence": "high" },
  "notes": "model missed the end date on first encounter",
  "consent": true
}
```

5. Verify it loads: `cd evals && npm run eval -- --mock --dataset real`.

## Before you commit

- [ ] **Redact third parties in the pixels.** Blur or box out the names,
      handles and faces of private people, such as commenters, tagged friends
      and whoever sent you the post. The organiser's or venue's own name and
      handle can stay. Check the image itself, not just the labels.
- [ ] **No camera-roll filenames.** Keep `IMG_####`-style source names out of
      `meta.json`, including the `notes` field.
- [ ] **Consent recorded.** `meta.json` has `"consent": true`, and you have
      that consent.
- [ ] **Tests pass.** `cd evals && npm test` checks consent on every real
      case.

## Labeling rules

- **Null means not visible.** If the poster shows a venue but no address,
  `address` is null even though the address is findable — Places resolution
  is a separate pipeline stage that isn't being evaluated here.
- **Resolve dates fully.** "Sat 12 July" with no year → work out the year
  from `frozenToday` and write `2026-07-12`.
- **24h times.** "7pm" → `19:00`. "Doors 7 / show 8" → start is `20:00`
  (the prompt says show time wins).
