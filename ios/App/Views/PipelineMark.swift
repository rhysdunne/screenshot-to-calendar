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
        drawBeat1(ctx, t)
        drawBeat2(ctx, t)
        drawBeat3(ctx, t)
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
}

#Preview("PipelineMark — looping") {
    PipelineMark(width: 240)
        .padding()
}

#Preview("PipelineMark — reduced motion") {
    PipelineMark(width: 240)
        .padding()
        .environment(\.accessibilityReduceMotion, true)
}

enum PipelineFieldIcon { case notes, clock, pin }
