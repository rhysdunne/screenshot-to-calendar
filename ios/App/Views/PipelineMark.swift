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
