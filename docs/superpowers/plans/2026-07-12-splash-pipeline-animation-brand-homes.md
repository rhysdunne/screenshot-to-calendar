# Splash pipeline animation (brand homes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable looping SwiftUI animation (`PipelineMark`) that tells the extract → structure → schedule story, and drop it into the launch splash and sign-in screens in place of the 📸 emoji.

**Architecture:** One self-contained view, `PipelineMark`, drives a normalised phase `t ∈ [0,1)` over a 7.5s loop from `TimelineView(.animation)` and renders every element as a pure function of `t` inside a single `Canvas`. Geometry is authored in the motion reference's 270×230 coordinate space and scaled to fit. The mark carries its own dark "blueprint" ground so it reads identically in light and dark mode. This plan covers the two brand homes only; the live-processing home and resolve-on-done are a later plan.

**Tech Stack:** SwiftUI (iOS 17, Swift 5.10), `TimelineView` + `Canvas`, XcodeGen. No new dependencies.

## Global Constraints

- iOS deployment target 17.0; Swift 5.10 (from `ios/project.yml`).
- **No new dependencies** — pure SwiftUI only (no Lottie, no packages).
- **Palette (exact hex):** ground `#33414b`, line `#e4ebee`, gold `#E0AD4B`. Gold is the only non-white colour and is used only for identified information (fields, icons, the new event).
- **Loop period:** 7.5 seconds. **Coordinate space:** 270 × 230 (width × height), authored to match the motion reference.
- **Motion source of truth:** `docs/superpowers/specs/2026-07-12-splash-pipeline-animation-reference.html`. Every timing/shape below is copied from it. When a preview disagrees with the reference, the reference wins.
- **The mark defines its own world:** it does not adopt the system foreground colour; it must look right in both light and dark mode.
- **Reduced motion:** when `accessibilityReduceMotion` is on, render a static end-state (calendar + two white days + gold event), no animation.
- **No iOS test target** exists in the repo (confirmed in `.github/workflows/ios.yml`: "no tests (no XCTest target exists yet)"). Do **not** add an XCTest target — the repo deliberately has none. The two verification gates are: an automated **compile gate** (CI) and a manual **visual gate** (Xcode `#Preview`, human on a Mac).

### Build / verify commands (used by every task)

**Compile gate — automated via CI.** The repo has a required PR check, `iOS / ios-build`
(`.github/workflows/ios.yml`), that runs on every `pull_request`: macOS runner, pinned
Xcode 26.5, `xcodegen generate` then `xcodebuild build`, no signing. This is the
authoritative compile gate — it does **not** need a local Mac. Practical flow: open a
PR for this branch early, then every push re-runs the check; a task's compile gate is
"the `ios-build` check is green on the PR after the task's commit is pushed". Check with:

```bash
gh pr checks --watch   # or: gh run list --workflow=ios.yml --branch feat/splash-pipeline-animation
```

Expected: the `ios-build` check passes.

**Optional local compile** (only if working on a Mac with Xcode — faster than waiting on
CI; mirrors what CI runs):

```bash
cd ios && xcodegen generate && \
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer && \
xcodebuild build -scheme Screenshot2Cal -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO && \
rm -rf build
```

Expected: `** BUILD SUCCEEDED **`. (`ios/build/` is not gitignored; the `rm -rf build` keeps the tree clean.)

**Visual gate — manual, needs a Mac.** Open `ios/App/Views/PipelineMark.swift` in Xcode,
show the `#Preview`, and open `docs/superpowers/specs/2026-07-12-splash-pipeline-animation-reference.html`
in a browser side by side; they should match. This gate can be **deferred** — code the
tasks with CI as the running compile gate, and do the visual sign-off in one pass on a Mac
once the branch is up. The animation is a faithful translation of the reference, so the
main risk the visual gate catches is Canvas API/geometry details, not motion design.

---

## File Structure

- **Create `ios/App/Views/PipelineMark.swift`** — the whole animation: palette, the pure timing core (`PipelineTiming`), the `Canvas` drawing, the `PipelineMark` view, and `#Preview`s. One file, one responsibility (the brand mark). Built up across Tasks 1–5.
- **Modify `ios/App/Views/LaunchSplashView.swift`** — replace the 📸 + `ProgressView` with `PipelineMark`, keep the wordmark (Task 6).
- **Modify `ios/App/Views/SignInView.swift`** — replace the 📸 with `PipelineMark` (Task 7).

---

## Task 1: Mark scaffold — palette, timing core, ground panel, faint grid

**Files:**
- Create: `ios/App/Views/PipelineMark.swift`

**Interfaces:**
- Produces:
  - `enum PipelinePalette { static let ground, line, gold: Color }`
  - `enum PipelineTiming { static let period: Double; static func phase(at: Date) -> Double; static let restPhase: Double }`
  - `func pipelineLerp(_ t: Double, _ frames: [(Double, Double)]) -> Double` (fileprivate)
  - `struct PipelineMark: View { var width: CGFloat }`
  - `PipelineMark.draw(_ ctx: inout GraphicsContext, size: CGSize, t: Double)` — extended by later tasks.

- [ ] **Step 1: Create the file with palette, timing, lerp, and a grid-only Canvas**

Create `ios/App/Views/PipelineMark.swift`:

```swift
import SwiftUI

/// The looping brand animation: a screenshot's fields are extracted, structured,
/// and scheduled into a calendar. Rendered in a "blueprint" style on its own dark
/// ground so it reads in both light and dark mode. Geometry is authored in a
/// 270×230 space (see docs/superpowers/specs/…-reference.html) and scaled to fit.
enum PipelinePalette {
    static let ground = Color(red: 0x33 / 255, green: 0x41 / 255, blue: 0x4b / 255)
    static let line   = Color(red: 0xe4 / 255, green: 0xeb / 255, blue: 0xee / 255)
    static let gold   = Color(red: 0xE0 / 255, green: 0xAD / 255, blue: 0x4b / 255)
}

enum PipelineTiming {
    /// One full extract → structure → schedule loop.
    static let period: Double = 7.5
    /// Phase 0..<1 across the loop, derived from wall-clock time.
    static func phase(at date: Date) -> Double {
        let s = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period)
        return (s < 0 ? s + period : s) / period
    }
    /// A phase where beat 3 is fully resolved — used for the reduced-motion still.
    static let restPhase: Double = 0.88
}

/// Linear interpolation across keyframes `(position 0..1, value)`, sorted by position.
/// Mirrors CSS @keyframes: clamps before the first and after the last frame.
fileprivate func pipelineLerp(_ t: Double, _ frames: [(Double, Double)]) -> Double {
    guard let first = frames.first else { return 0 }
    if t <= first.0 { return first.1 }
    for i in 1..<frames.count {
        let (aPos, aVal) = frames[i - 1]
        let (bPos, bVal) = frames[i]
        if t <= bPos {
            let span = bPos - aPos
            let f = span > 0 ? (t - aPos) / span : 1
            return aVal + (bVal - aVal) * f
        }
    }
    return frames.last!.1
}

struct PipelineMark: View {
    /// Width in points; height follows the 270:230 aspect.
    var width: CGFloat = 220

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(PipelinePalette.ground)
            if reduceMotion {
                Canvas { ctx, size in
                    var c = ctx
                    Self.draw(&c, size: size, t: PipelineTiming.restPhase)
                }
            } else {
                TimelineView(.animation) { timeline in
                    Canvas { ctx, size in
                        var c = ctx
                        Self.draw(&c, size: size, t: PipelineTiming.phase(at: timeline.date))
                    }
                }
            }
        }
        .frame(width: width, height: width * 230 / 270)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityElement()
        .accessibilityLabel("Turning your screenshot into a calendar event")
    }

    /// Draw the whole mark at phase `t` into a context scaled to the 270×230 space.
    static func draw(_ ctx: inout GraphicsContext, size: CGSize, t: Double) {
        let s = size.width / 270
        ctx.scaleBy(x: s, y: s)
        ctx.clip(to: Path(roundedRect: CGRect(x: 0, y: 0, width: 270, height: 230), cornerRadius: 12))
        drawGrid(ctx)
    }

    /// Faint blueprint grid behind everything (~10% opacity).
    static func drawGrid(_ ctx: GraphicsContext) {
        var g = ctx
        g.opacity *= 0.10
        let shading = GraphicsContext.Shading.color(PipelinePalette.line)
        var p = Path()
        for y in [58.0, 115, 172] { p.move(to: CGPoint(x: 0, y: y)); p.addLine(to: CGPoint(x: 270, y: y)) }
        for x in [90.0, 180] { p.move(to: CGPoint(x: x, y: 0)); p.addLine(to: CGPoint(x: x, y: 230)) }
        g.stroke(p, with: shading, lineWidth: 1.4)
    }
}

#Preview("PipelineMark") {
    PipelineMark(width: 240)
        .padding()
}
```

- [ ] **Step 2: Compile gate**

Run the compile gate command from Global Constraints.
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Visual gate**

Open the `#Preview` in Xcode. Expected: a dark rounded panel (270:230 aspect) with a faint grid of 3 horizontal + 2 vertical lines. No other content yet.

- [ ] **Step 4: Commit**

```bash
git add ios/App/Views/PipelineMark.swift
git commit -m "$(printf 'Add PipelineMark scaffold: palette, timing core, ground + grid\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 2: Beat 1 — flyer appears, lamp scans, fields turn gold

**Files:**
- Modify: `ios/App/Views/PipelineMark.swift`

**Interfaces:**
- Consumes: `pipelineLerp`, `PipelinePalette`, the `draw` entry point (Task 1).
- Produces: `drawBeat1(_:_:)`, `strokePoster(_:)`, `drawLamp(_:)`, `drawGoldPill(_:_:rect:r:frames:)`.

- [ ] **Step 1: Add the Beat 1 drawing helpers**

In `PipelineMark`, add these methods (inside the `struct`, after `drawGrid`):

```swift
    // MARK: Beat 1 — extract

    static func drawBeat1(_ ctx: GraphicsContext, _ t: Double) {
        // Envelope: the whole flyer fades in (0–6%), holds, fades out (42–47%).
        let gA = pipelineLerp(t, [(0, 0), (0.06, 1), (0.42, 1), (0.47, 0), (1, 0)])
        if gA > 0.001 {
            var g = ctx
            g.opacity *= gA
            // "Document appears": scale .96→1 about the poster centre (142,106).
            let sc = pipelineLerp(t, [(0, 0.96), (0.06, 1), (1, 1)])
            var doc = g
            doc.translateBy(x: 142, y: 106)
            doc.scaleBy(x: sc, y: sc)
            doc.translateBy(x: -142, y: -106)
            strokePoster(doc)
            // "Scan": the lamp sweeps left→right (9–27%), visible 11–26%.
            let lampOp = pipelineLerp(t, [(0, 0), (0.08, 0), (0.11, 1), (0.26, 1), (0.28, 0), (1, 0)])
            if lampOp > 0.001 {
                var l = g
                l.opacity *= lampOp
                let lampX = pipelineLerp(t, [(0, 0), (0.09, 0), (0.27, 94), (1, 94)])
                l.translateBy(x: lampX, y: 0)
                drawLamp(l)
            }
        }
        // "Confirm": the three pill outlines flip gold, top → down. Independent of gA.
        drawGoldPill(ctx, t, rect: CGRect(x: 104, y: 50, width: 74, height: 14), r: 7,
                     frames: [(0, 0), (0.28, 0), (0.33, 1), (0.42, 1), (0.47, 0), (1, 0)])
        drawGoldPill(ctx, t, rect: CGRect(x: 104, y: 86, width: 52, height: 12), r: 6,
                     frames: [(0, 0), (0.32, 0), (0.37, 1), (0.42, 1), (0.47, 0), (1, 0)])
        drawGoldPill(ctx, t, rect: CGRect(x: 116, y: 140, width: 62, height: 13), r: 6.5,
                     frames: [(0, 0), (0.36, 0), (0.41, 1), (0.42, 1), (0.47, 0), (1, 0)])
    }

    /// The flyer: frame, three pill fields (white outline), and text lines.
    static func strokePoster(_ ctx: GraphicsContext) {
        let ink = GraphicsContext.Shading.color(PipelinePalette.line)
        ctx.stroke(Path(roundedRect: CGRect(x: 96, y: 42, width: 92, height: 128), cornerRadius: 3), with: ink, lineWidth: 1.4)
        ctx.stroke(Path(roundedRect: CGRect(x: 104, y: 50, width: 74, height: 14), cornerRadius: 7), with: ink, lineWidth: 1.4)
        ctx.stroke(Path(roundedRect: CGRect(x: 104, y: 86, width: 52, height: 12), cornerRadius: 6), with: ink, lineWidth: 1.4)
        ctx.stroke(Path(roundedRect: CGRect(x: 116, y: 140, width: 62, height: 13), cornerRadius: 6.5), with: ink, lineWidth: 1.4)
        var lines = Path()
        for (x1, y, x2) in [(104.0, 72.0, 152.0), (104, 110, 172), (104, 118, 146), (104, 126, 162)] {
            lines.move(to: CGPoint(x: x1, y: y)); lines.addLine(to: CGPoint(x: x2, y: y))
        }
        ctx.stroke(lines, with: ink, lineWidth: 1.4)
    }

    /// The photocopier lamp: a soft gold band with a bright leading line and arrow caps.
    static func drawLamp(_ ctx: GraphicsContext) {
        var band = ctx
        band.opacity *= 0.28
        band.fill(Path(CGRect(x: 90, y: 40, width: 12, height: 132)), with: .color(PipelinePalette.gold))
        let gold = GraphicsContext.Shading.color(PipelinePalette.gold)
        var edge = Path(); edge.move(to: CGPoint(x: 96, y: 38)); edge.addLine(to: CGPoint(x: 96, y: 174))
        ctx.stroke(edge, with: gold, lineWidth: 2.4)
        var caps = Path()
        caps.move(to: CGPoint(x: 96, y: 36)); caps.addLine(to: CGPoint(x: 92, y: 30)); caps.addLine(to: CGPoint(x: 100, y: 30)); caps.closeSubpath()
        caps.move(to: CGPoint(x: 96, y: 176)); caps.addLine(to: CGPoint(x: 92, y: 182)); caps.addLine(to: CGPoint(x: 100, y: 182)); caps.closeSubpath()
        ctx.fill(caps, with: gold)
    }

    /// A single field pill whose gold outline fades in per `frames`.
    static func drawGoldPill(_ ctx: GraphicsContext, _ t: Double, rect: CGRect, r: CGFloat, frames: [(Double, Double)]) {
        let op = pipelineLerp(t, frames)
        if op <= 0.001 { return }
        var g = ctx
        g.opacity *= op
        g.stroke(Path(roundedRect: rect, cornerRadius: r), with: .color(PipelinePalette.gold), lineWidth: 1.9)
    }
```

- [ ] **Step 2: Call Beat 1 from `draw`**

In `draw(_:size:t:)`, add after `drawGrid(ctx)`:

```swift
        drawBeat1(ctx, t)
```

- [ ] **Step 3: Compile gate**

Run the compile gate. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Visual gate**

Open the `#Preview`. Expected, looping: the flyer fades/scales in, a gold lamp sweeps left→right, then the three pill outlines turn gold top→down and the flyer fades out (then the panel is empty until the loop restarts, since beats 2–3 don't exist yet). Compare beat 1 to the reference's first ~47%.

- [ ] **Step 5: Commit**

```bash
git add ios/App/Views/PipelineMark.swift
git commit -m "$(printf 'PipelineMark: add beat 1 (flyer appears, lamp scan, fields gold)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 3: Beat 2 — three field bars slide down

**Files:**
- Modify: `ios/App/Views/PipelineMark.swift`

**Interfaces:**
- Consumes: `pipelineLerp`, `PipelinePalette`, `draw` (Tasks 1–2).
- Produces: `drawBeat2(_:_:)`, `drawBar(_:yTop:icon:value1:value2:)`, `enum PipelineFieldIcon { case notes, clock, pin }`, `drawFieldIcon(_:_:cx:cy:)`.

- [ ] **Step 1: Add the field-icon enum and drawing**

At the end of the file (outside the `struct`), add:

```swift
enum PipelineFieldIcon { case notes, clock, pin }
```

Inside `PipelineMark` (after `drawGoldPill`), add:

```swift
    // MARK: Beat 2 — structure

    static func drawBeat2(_ ctx: GraphicsContext, _ t: Double) {
        // Envelope for the whole stack: fade in 45–48%, fade out 62–66%.
        let gB = pipelineLerp(t, [(0, 0), (0.45, 0), (0.48, 1), (0.62, 1), (0.66, 0), (1, 0)])
        if gB <= 0.001 { return }
        var g = ctx
        g.opacity *= gB
        // Top bar first, then each slides down (−14→0) one cadence-beat later.
        drawBar(g, t, yTop: 64, icon: .notes, value1: 36, value2: 54,
                opFrames: [(0, 0), (0.47, 0), (0.52, 1), (1, 1)],
                yFrames: [(0, -14), (0.47, -14), (0.52, 0), (1, 0)])
        drawBar(g, t, yTop: 98, icon: .clock, value1: 40, value2: 58,
                opFrames: [(0, 0), (0.51, 0), (0.56, 1), (1, 1)],
                yFrames: [(0, -14), (0.51, -14), (0.56, 0), (1, 0)])
        drawBar(g, t, yTop: 132, icon: .pin, value1: 38, value2: 64,
                opFrames: [(0, 0), (0.55, 0), (0.60, 1), (1, 1)],
                yFrames: [(0, -14), (0.55, -14), (0.60, 0), (1, 0)])
    }

    /// One field bar: white rounded rect, gold icon at left, two white value lines.
    static func drawBar(_ ctx: GraphicsContext, _ t: Double, yTop: CGFloat, icon: PipelineFieldIcon,
                        value1: CGFloat, value2: CGFloat,
                        opFrames: [(Double, Double)], yFrames: [(Double, Double)]) {
        let op = pipelineLerp(t, opFrames)
        if op <= 0.001 { return }
        var g = ctx
        g.opacity *= op
        g.translateBy(x: 0, y: pipelineLerp(t, yFrames))
        let ink = GraphicsContext.Shading.color(PipelinePalette.line)
        g.stroke(Path(roundedRect: CGRect(x: 80, y: yTop, width: 130, height: 26), cornerRadius: 2), with: ink, lineWidth: 1.4)
        drawFieldIcon(g, icon, cx: 96, cy: yTop + 13)
        var vals = Path()
        vals.move(to: CGPoint(x: 112, y: yTop + 10)); vals.addLine(to: CGPoint(x: 112 + value1, y: yTop + 10))
        vals.move(to: CGPoint(x: 112, y: yTop + 17)); vals.addLine(to: CGPoint(x: 112 + value2, y: yTop + 17))
        g.stroke(vals, with: ink, lineWidth: 1.4)
    }

    /// A gold field icon centred at (cx, cy): notes lines, a clock, or a map pin.
    static func drawFieldIcon(_ ctx: GraphicsContext, _ icon: PipelineFieldIcon, cx: CGFloat, cy: CGFloat) {
        let gold = GraphicsContext.Shading.color(PipelinePalette.gold)
        switch icon {
        case .notes:
            var p = Path()
            p.move(to: CGPoint(x: cx - 6, y: cy - 4)); p.addLine(to: CGPoint(x: cx + 6, y: cy - 4))
            p.move(to: CGPoint(x: cx - 6, y: cy));     p.addLine(to: CGPoint(x: cx + 6, y: cy))
            p.move(to: CGPoint(x: cx - 6, y: cy + 4)); p.addLine(to: CGPoint(x: cx + 2, y: cy + 4))
            ctx.stroke(p, with: gold, lineWidth: 1.6)
        case .clock:
            ctx.stroke(Path(ellipseIn: CGRect(x: cx - 7, y: cy - 7, width: 14, height: 14)), with: gold, lineWidth: 1.6)
            var hands = Path()
            hands.move(to: CGPoint(x: cx, y: cy - 4)); hands.addLine(to: CGPoint(x: cx, y: cy)); hands.addLine(to: CGPoint(x: cx + 3, y: cy + 2))
            ctx.stroke(hands, with: gold, lineWidth: 1.6)
        case .pin:
            var p = Path()
            p.move(to: CGPoint(x: cx, y: cy - 7))
            p.addCurve(to: CGPoint(x: cx - 6, y: cy - 1), control1: CGPoint(x: cx - 4, y: cy - 7), control2: CGPoint(x: cx - 6, y: cy - 4))
            p.addCurve(to: CGPoint(x: cx, y: cy + 9),     control1: CGPoint(x: cx - 6, y: cy + 3), control2: CGPoint(x: cx, y: cy + 9))
            p.addCurve(to: CGPoint(x: cx + 6, y: cy - 1), control1: CGPoint(x: cx, y: cy + 9),     control2: CGPoint(x: cx + 6, y: cy + 3))
            p.addCurve(to: CGPoint(x: cx, y: cy - 7),     control1: CGPoint(x: cx + 6, y: cy - 4), control2: CGPoint(x: cx + 4, y: cy - 7))
            p.closeSubpath()
            ctx.stroke(p, with: gold, lineWidth: 1.6)
            ctx.stroke(Path(ellipseIn: CGRect(x: cx - 2, y: cy - 3, width: 4, height: 4)), with: gold, lineWidth: 1.6)
        }
    }
```

- [ ] **Step 2: Call Beat 2 from `draw`**

In `draw(_:size:t:)`, add after `drawBeat1(ctx, t)`:

```swift
        drawBeat2(ctx, t)
```

- [ ] **Step 3: Compile gate**

Run the compile gate. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Visual gate**

Open the `#Preview`. Expected: after beat 1's gold flip, three white bars slide down in sequence (notes, clock, pin — each with a gold icon), hold, then fade. Compare to the reference's ~47–66%.

- [ ] **Step 5: Commit**

```bash
git add ios/App/Views/PipelineMark.swift
git commit -m "$(printf 'PipelineMark: add beat 2 (field bars slide down with gold icons)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 4: Beat 3 — calendar appears, white days, gold event slides in

**Files:**
- Modify: `ios/App/Views/PipelineMark.swift`

**Interfaces:**
- Consumes: `pipelineLerp`, `PipelinePalette`, `draw` (Tasks 1–3).
- Produces: `drawBeat3(_:_:)`, `drawCalendarGrid(_:)`, `drawWhiteDay(_:_:rect:frames:)`, `drawGoldEvent(_:_:)`.

- [ ] **Step 1: Add the Beat 3 drawing helpers**

Inside `PipelineMark` (after `drawFieldIcon`), add:

```swift
    // MARK: Beat 3 — schedule

    static func drawBeat3(_ ctx: GraphicsContext, _ t: Double) {
        // Calendar appears (61–67%), overlapping beat 2's exit; scale .97→1.
        let calOp = pipelineLerp(t, [(0, 0), (0.61, 0), (0.67, 1), (0.90, 1), (0.94, 0), (1, 0)])
        if calOp > 0.001 {
            var g = ctx
            g.opacity *= calOp
            let sc = pipelineLerp(t, [(0, 0.97), (0.61, 0.97), (0.67, 1), (1, 1)])
            g.translateBy(x: 135, y: 112); g.scaleBy(x: sc, y: sc); g.translateBy(x: -135, y: -112)
            drawCalendarGrid(g)
        }
        // Two existing days (white) fade in, one cadence-beat apart.
        drawWhiteDay(ctx, t, rect: CGRect(x: 121, y: 80, width: 29, height: 31),
                     frames: [(0, 0), (0.67, 0), (0.71, 1), (0.90, 1), (0.94, 0), (1, 0)])
        drawWhiteDay(ctx, t, rect: CGRect(x: 92, y: 142, width: 29, height: 30),
                     frames: [(0, 0), (0.71, 0), (0.75, 1), (0.90, 1), (0.94, 0), (1, 0)])
        // The new event (gold) slides into its slot with a slight settle.
        drawGoldEvent(ctx, t)
    }

    /// The calendar frame, header ticks, and 3×3 grid lines (all white).
    static func drawCalendarGrid(_ ctx: GraphicsContext) {
        let ink = GraphicsContext.Shading.color(PipelinePalette.line)
        ctx.stroke(Path(roundedRect: CGRect(x: 92, y: 52, width: 86, height: 120), cornerRadius: 3), with: ink, lineWidth: 1.4)
        var grid = Path()
        grid.move(to: CGPoint(x: 92, y: 80));  grid.addLine(to: CGPoint(x: 178, y: 80))
        grid.move(to: CGPoint(x: 121, y: 80)); grid.addLine(to: CGPoint(x: 121, y: 172))
        grid.move(to: CGPoint(x: 150, y: 80)); grid.addLine(to: CGPoint(x: 150, y: 172))
        grid.move(to: CGPoint(x: 92, y: 111)); grid.addLine(to: CGPoint(x: 178, y: 111))
        grid.move(to: CGPoint(x: 92, y: 142)); grid.addLine(to: CGPoint(x: 178, y: 142))
        ctx.stroke(grid, with: ink, lineWidth: 1.4)
        var ticks = ctx
        ticks.opacity *= 0.8
        var tp = Path()
        tp.move(to: CGPoint(x: 108, y: 46)); tp.addLine(to: CGPoint(x: 108, y: 58))
        tp.move(to: CGPoint(x: 162, y: 46)); tp.addLine(to: CGPoint(x: 162, y: 58))
        ticks.stroke(tp, with: ink, lineWidth: 1.4)
    }

    /// An existing calendar day: a white cell at 85% alpha, fading in per `frames`.
    static func drawWhiteDay(_ ctx: GraphicsContext, _ t: Double, rect: CGRect, frames: [(Double, Double)]) {
        let op = pipelineLerp(t, frames)
        if op <= 0.001 { return }
        var g = ctx
        g.opacity *= op
        g.fill(Path(rect), with: .color(PipelinePalette.line.opacity(0.85)))
    }

    /// The new event: a gold cell that slides down into its slot, with a gold tick.
    static func drawGoldEvent(_ ctx: GraphicsContext, _ t: Double) {
        let op = pipelineLerp(t, [(0, 0), (0.75, 0), (0.79, 1), (0.90, 1), (0.94, 0), (1, 0)])
        if op <= 0.001 { return }
        var g = ctx
        g.opacity *= op
        // Overshoot slightly past 0 (+2) then settle — the "drop into slot" feel.
        let dy = pipelineLerp(t, [(0, -22), (0.75, -22), (0.82, 2), (0.86, 0), (1, 0)])
        g.translateBy(x: 0, y: dy)
        g.fill(Path(CGRect(x: 150, y: 111, width: 28, height: 31)), with: .color(PipelinePalette.gold))
        var tick = Path()
        tick.move(to: CGPoint(x: 156, y: 127)); tick.addLine(to: CGPoint(x: 162, y: 134)); tick.addLine(to: CGPoint(x: 174, y: 119))
        g.stroke(tick, with: .color(PipelinePalette.gold), lineWidth: 2.4)
    }
```

- [ ] **Step 2: Call Beat 3 from `draw`**

In `draw(_:size:t:)`, add after `drawBeat2(ctx, t)`:

```swift
        drawBeat3(ctx, t)
```

- [ ] **Step 3: Compile gate**

Run the compile gate. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Visual gate (full loop)**

Open the `#Preview` and watch a full 7.5s loop against the reference HTML end-to-end. Expected: beat 1 (flyer → scan → gold fields) → beat 2 (bars slide) → beat 3 (calendar appears, two white days, gold event slides in) with no stall between beats 2 and 3. The tick sits inside the gold cell.

- [ ] **Step 5: Commit**

```bash
git add ios/App/Views/PipelineMark.swift
git commit -m "$(printf 'PipelineMark: add beat 3 (calendar, existing days, new gold event)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 5: Reduced-motion still + preview coverage

**Files:**
- Modify: `ios/App/Views/PipelineMark.swift`

**Interfaces:**
- Consumes: everything from Tasks 1–4 (`restPhase` already routes through `draw`).

- [ ] **Step 1: Add a preview-only override, then a reduced-motion preview**

The reduced-motion branch already calls `draw(_:size:t: restPhase)`, so it renders beat 3's resolved frame (calendar + two white days + gold event + tick) with no animation. To *preview* that branch you cannot inject `\.accessibilityReduceMotion` — it is a **read-only** `EnvironmentValues` key, and `.environment(\.accessibilityReduceMotion, true)` fails to compile. Add a preview-only flag instead.

In `PipelineMark`, add the stored property (after `var width`) and use it in the branch condition:

```swift
    /// Forces the reduced-motion still regardless of the system setting. Only for
    /// previews — `\.accessibilityReduceMotion` is a read-only environment value and
    /// cannot be injected, so this flag is the way to preview the static frame.
    var forceReducedMotion = false
```

```swift
            if reduceMotion || forceReducedMotion {
```

Then replace the existing `#Preview("PipelineMark")` block with:

```swift
#Preview("PipelineMark — looping") {
    PipelineMark(width: 240)
        .padding()
}

#Preview("PipelineMark — reduced motion") {
    PipelineMark(width: 240, forceReducedMotion: true)
        .padding()
}
```

- [ ] **Step 2: Compile gate**

Run the compile gate. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Visual gate**

Open both previews. Expected: "looping" animates the full loop; "reduced motion" shows a *static* calendar with two white days and the gold event + tick, no motion. Confirm the still is legible on its own (it should read as "an event added to a calendar").

- [ ] **Step 4: Commit**

```bash
git add ios/App/Views/PipelineMark.swift
git commit -m "$(printf 'PipelineMark: reduced-motion still + preview coverage\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 6: Use PipelineMark in the launch splash

**Files:**
- Modify: `ios/App/Views/LaunchSplashView.swift`

**Interfaces:**
- Consumes: `PipelineMark(width:)` (Tasks 1–5).

- [ ] **Step 1: Replace the emoji + spinner with the mark**

The current file (`ios/App/Views/LaunchSplashView.swift`) is:

```swift
struct LaunchSplashView: View {
    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("📸").font(.system(size: 64))
            Text("Screenshot to Calendar")
                .font(.title2.weight(.semibold))
            ProgressView()
                .padding(.top, 8)
            Spacer()
        }
    }
}
```

Replace the `body` with (keep the file's doc comment and `import SwiftUI`):

```swift
    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            PipelineMark(width: 200)
            Text("Screenshot to Calendar")
                .font(.title2.weight(.semibold))
            Spacer()
        }
    }
```

Note: the `PipelineMark` loop *is* the progress indicator, so the separate `ProgressView` is removed.

- [ ] **Step 2: Compile gate**

Run the compile gate. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Visual gate**

Add a temporary `#Preview { LaunchSplashView() }` at the bottom of the file if one isn't present, open it, and confirm the animated mark sits above the "Screenshot to Calendar" wordmark, centred, no spinner. Remove the temporary preview if you added it (or keep it — the codebase has no strong convention either way; prefer keeping it for future review).

- [ ] **Step 4: Commit**

```bash
git add ios/App/Views/LaunchSplashView.swift
git commit -m "$(printf 'Use PipelineMark on the launch splash in place of the emoji\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 7: Use PipelineMark in the sign-in screen

**Files:**
- Modify: `ios/App/Views/SignInView.swift`

**Interfaces:**
- Consumes: `PipelineMark(width:)` (Tasks 1–5).

- [ ] **Step 1: Replace the emoji with the mark**

In `ios/App/Views/SignInView.swift`, the `body` currently opens with:

```swift
        VStack(spacing: 24) {
            Spacer()
            Text("📸").font(.system(size: 64))
            Text("Screenshot to Calendar")
                .font(.title2.weight(.semibold))
```

Replace the `Text("📸")…` line with the mark:

```swift
        VStack(spacing: 24) {
            Spacer()
            PipelineMark(width: 200)
            Text("Screenshot to Calendar")
                .font(.title2.weight(.semibold))
```

Leave the rest of `SignInView` (description, sign-in button, legal copy, alert) unchanged.

- [ ] **Step 2: Compile gate**

Run the compile gate. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Visual gate**

Add a temporary `#Preview { SignInView().environmentObject(AppState()) }` if needed, open it, and confirm the animated mark replaces the emoji above the wordmark, with the description and "Sign in with Google" button intact below.

- [ ] **Step 4: Commit**

```bash
git add ios/App/Views/SignInView.swift
git commit -m "$(printf 'Use PipelineMark on the sign-in screen in place of the emoji\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-review notes

- **Spec coverage:** concept + palette (Task 1), the three beats and their exact timings (Tasks 2–4), the shared cadence (baked into the keyframes), reduced-motion still + accessibility label (Tasks 1 & 5), the two brand homes (Tasks 6–7). The processing home and resolve-on-done are explicitly out of scope for this plan (deferred, per the "brand homes first" decision).
- **Wordmark:** kept on the splash; the separate `ProgressView` removed because the mark is the progress indicator (spec open item resolved this way).
- **Type consistency:** `PipelinePalette`, `PipelineTiming`, `pipelineLerp`, `PipelineFieldIcon`, and the `draw*`/`stroke*` helpers are named identically wherever referenced across tasks.
- **Known soft spot:** Canvas scales stroke widths with `size` (a small mark → thinner lines). If lines look too thin at 200pt in the visual gate, bump the base line widths (1.4 → ~1.6) rather than changing the geometry.
