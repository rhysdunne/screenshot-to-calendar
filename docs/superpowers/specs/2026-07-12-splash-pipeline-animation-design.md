# Splash pipeline animation — design

**Status:** approved (brainstorming), ready for implementation plan
**Date:** 2026-07-12
**Motion reference:** [`2026-07-12-splash-pipeline-animation-reference.html`](./2026-07-12-splash-pipeline-animation-reference.html) — the signed-off loop (v11). Source of truth for timings, shapes, palette, and cadence.

## Problem

The launch splash and the sign-in screen both use a static 📸 emoji as the brand
mark (`LaunchSplashView`, `SignInView` — they deliberately mirror each other).
It's a placeholder. We want a distinctive looping animation that tells the
product's story — a screenshot of a poster being processed, its fields extracted,
and a calendar event created — and that reuses across the two brand moments *and*
the live "processing a capture" state.

## Concept

A **photocopier × blueprint** motif. The animation lives on a dark blue-grey
"blueprint" ground (`#33414b`) drawn in fine near-white line-work with a single
gold accent (`#E0AD4B`, the kōwhai-gold from the app icon). Gold is used
semantically throughout as the "this is the information" thread: the fields
identified on the poster, the field icons, and the new calendar event are all the
only gold things on screen.

It reads as one **three-beat story**, and each beat follows the same
**appear → act → confirm** rhythm at one shared cadence:

| Beat | Appear | Act | Confirm |
|---|---|---|---|
| **1 — Extract** | the flyer scales/fades in | a photocopier lamp sweeps across it | its three pill "fields" turn gold, top-down |
| **2 — Structure** | — (the bars are the content) | three field bars slide down into a stack | each led by a gold icon (notes, clock/time, pin/location) |
| **3 — Schedule** | the calendar scales/fades in | two existing days (white) appear | the new event (gold) slides into its slot |

The consistent triplet cadence is what makes it feel composed rather than a loose
sequence. Beat 2 has no "appear" step by design — the bars *are* the content, so
they arrive immediately; this is the one bit of punch and must not be dulled by
forcing symmetry.

### Palette

- Ground `#33414b` (blueprint blue-grey) — the mark carries its own dark ground so
  it reads identically in light and dark mode. It sits as a self-contained panel
  on the host screen's system background.
- Lines `#e4ebee` (near-white), stroke width ~1.4pt at the reference 270×230 scale.
- Gold `#E0AD4B` — accent only; the sole non-white colour.
- A faint blueprint grid behind everything at ~10% line opacity.

## Motion timeline

Loop period **7.5s**. All values are percentages of the loop. The reference HTML
is authoritative; this table is for orientation. The per-item cadence (fields
gold, bars sliding, days appearing) is a shared ~4% (~0.3s) stagger — deliberately
identical across beats.

| % | Event |
|---|---|
| 0–6 | Beat 1: flyer fades in + scales `.96→1` |
| 9–27 | lamp sweeps left→right (fields stay white) |
| 28–33 / 32–37 / 36–41 | three pill outlines flip gold, top → down |
| 42–47 | beat 1 fades out |
| 47–52 / 51–56 / 55–60 | Beat 2: three bars slide down (`−14pt→0`), staggered |
| 62–66 | bars fade out |
| 61–67 | Beat 3: calendar fades in + scales `.97→1` (**overlaps** beat 2 exit — no dead air) |
| 67–71 / 71–75 | two white days appear (top-middle, bottom-left) |
| 75–82 | gold event slides in (`−22pt→0`, slight settle) at middle-right |
| 90–94 | beat 3 fades out |
| 94–100 | a short breath before the loop restarts |

Timing was tuned specifically so beat 3 doesn't stall after beat 2's immediacy:
the calendar starts arriving *while beat 2 is still fading* and renders fast, so
the first day lands the instant the grid is there.

## The three homes

One reusable SwiftUI view, `PipelineMark`, used in all three:

1. **`LaunchSplashView`** — replaces the 📸. Loops while `!didBootstrap`. Because
   bootstrap can resolve in a few hundred ms, the loop must read at any duration —
   which it does (it's a loop, not a one-shot narrative).
2. **`SignInView`** — replaces the 📸. Loops ambiently; this is where a user
   actually dwells.
3. **Processing state** — shown while a capture is non-terminal
   (`status ∈ {queued, processing}`, i.e. during `pollWhileProcessing()`). Replaces
   the generic `ProgressView` treatment as the "working on it" indicator.

### Resolve-on-done (processing only)

In the processing home the loop runs uniformly while polling, and when the capture
reaches a terminal state the current cycle **plays out to the beat-3 gold-event
landing, then hands off** to the result view. The "done" landing is worth the small
amount of extra state. In the two brand homes the mark just loops; there is no
resolve.

This is the one place with meaningful integration nuance, so it is scoped as a
distinct step in the plan — the two brand homes are the simpler, higher-value first
increment (`C` was chosen: reuse everywhere, but the brand homes land first).

## SwiftUI mapping

- **`PipelineMark`** — a self-contained `View`, parameters:
  - `size: CGFloat` (the mark scales as a whole; internal geometry is defined in
    the reference's 270×230 space and scaled to fit).
  - `mode: Mode` — `.loop` (brand homes) or `.resolveOnDone(isComplete: Bool)`
    (processing). In resolve mode, when `isComplete` flips true the view lets the
    current loop finish to the gold-event landing, then calls an `onFinished`
    closure / stops.
- **Driving clock** — `TimelineView(.animation)` computing a normalised phase
  `t = (elapsed.truncatingRemainder(dividingBy: period)) / period`. Every element's
  opacity / offset / scale is a pure function of `t`, mirroring the percentage
  keyframes above. A small easing helper `segment(_ t:, in:, out:, ease:)` maps the
  keyframe windows to 0…1 values. This gives exact control and matches the CSS
  reference 1:1; it also makes `resolveOnDone` trivial (watch for the cycle
  boundary nearest the gold landing).
- **Rendering** — `Canvas` (`GraphicsContext`), drawing: faint grid → the active
  beat's shapes as strokes/fills derived from `t`. `Canvas` keeps it one file,
  cheap, and precise. (Alternative: a `ZStack` of `RoundedRectangle`/`Path` shapes
  with phase-bound `.opacity`/`.offset`/`.scaleEffect` — more idiomatic but more
  view churn. Either is acceptable; `Canvas` is the recommendation.)
- **No draw-on/`.trim` needed** — the final motion is all fades, slides, and
  scales, so the Shape-trimming approach considered earlier isn't required.
- **Colours** — a small local palette (ground, line, gold). The mark defines its
  own world; it does not adopt the system foreground, so it looks right in both
  light and dark mode.

### Accessibility

- `@Environment(\.accessibilityReduceMotion)` → render the **static end-state**
  (calendar with the two white days and the gold event, tick shown), no motion.
- The mark carries an `accessibilityLabel` such as "Turning your screenshot into a
  calendar event" and is an image element, not an interactive one.

## Non-goals / YAGNI

- No Lottie or any new dependency — pure SwiftUI.
- No configurable colours/themes beyond the fixed blueprint palette.
- No per-field real data binding in the mark — it's a stylised motif, not a live
  render of the actual extraction.
- Not touching the capture tile's real thumbnail behaviour beyond swapping the
  processing indicator (tile-level integration is part of the processing step, and
  can be the last increment).

## Open items for the plan

- Exact insertion points for the processing home (LibraryView tile overlay vs.
  CaptureDetailView vs. both) — resolve during planning against the current views.
- Whether the launch splash keeps the "Screenshot to Calendar" wordmark + a
  smaller `PipelineMark`, or the mark alone. Current lean: keep the wordmark, drop
  the separate `ProgressView` (the mark *is* the progress indicator).
