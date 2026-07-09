# 0002. Real eval dataset labelling conventions

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Rhys + Claude Code

## Context

[`evals/dataset/real/`](../../evals/dataset/real/) holds hand-labelled real
captures whose gold files are ground truth for scoring. Ambiguous cases (an IG
screenshot naming a venue that isn't printed on the poster; an exhibition with only
an end date) need consistent rules, or the golds become noise and the eval measures
labelling inconsistency instead of the model. [`docs/adding-eval-images.md`](../adding-eval-images.md)
covers the mechanics; this records the judgement calls.

## Decision

- **Venue from handle:** when a venue appears only as the posting Instagram account
  *and that account is the venue* (a theatre, gallery, arts centre), resolve it
  (`@thecoronettheatre` → "The Coronet Theatre"). For promoter/personal accounts,
  `venue` stays `null` unless printed. This deliberately encodes the *desired*
  product behaviour.
- **`null` = not visible.** `address` is `null` unless a street/postcode is printed,
  even when the venue is known — Places resolution is a separate, unevaluated stage.
- **Dates resolved fully** against `meta.frozenToday` (the capture date): bare days
  get the year; printed weekdays are used to confirm it.
- **End-date-only** captures keep `start_date: null`. The "starts today" fill is a
  downstream calendar-mapping step (`mapEventToCalendar`), not applied at
  extraction, so it must not appear in the gold.
- **Category** uses the v3 enum; performing arts with no dedicated slot map to the
  nearest fit (dance / cabaret / circus → `theatre`).

## Consequences

- Golds are reproducible across contributors and sessions.
- The eval scores extraction, not the downstream calendar mapping.
- Because venue-from-handle encodes desired behaviour, a model that fails to resolve
  the handle scores *lower* — surfacing a real product gap rather than hiding it.
- Revisit if the product changes (e.g. if venue resolution moves into the pipeline,
  end-date-only golds may need to change).
