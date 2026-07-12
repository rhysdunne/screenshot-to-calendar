import SwiftUI
import Observation

/// State the share extension walks through: working → success/failure.
/// Mutated by `ShareViewController`; observed by `ShareStatusView`.
@Observable
final class ShareStatusModel {
    enum Phase: Equatable {
        case working
        case success(String)
        case failure(String)
    }

    var phase: Phase = .working
}

/// The extension's whole UI: the PipelineMark brand animation while the shared
/// image is being read and enqueued, then a symbol + message. The mark doubles
/// as the progress indicator (and carries its own reduced-motion fallback).
struct ShareStatusView: View {
    let model: ShareStatusModel

    var body: some View {
        VStack(spacing: 20) {
            switch model.phase {
            case .working:
                PipelineMark(width: 160)
                Text("Capturing…")
                    .font(.headline)
            case .success(let message):
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Color.brandGold)
                Text(message)
                    .font(.headline)
            case .failure(let message):
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(.orange)
                Text(message)
                    .font(.headline)
            }
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeInOut(duration: 0.25), value: model.phase)
    }
}

#Preview("Working") {
    ShareStatusView(model: ShareStatusModel())
}

#Preview("Success") {
    let model = ShareStatusModel()
    model.phase = .success("Added — processing.\nOpen the app to see the result.")
    return ShareStatusView(model: model)
}

#Preview("Failure") {
    let model = ShareStatusModel()
    model.phase = .failure("Open Screenshot to Calendar and sign in first.")
    return ShareStatusView(model: model)
}
