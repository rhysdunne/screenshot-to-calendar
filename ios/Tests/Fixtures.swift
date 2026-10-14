import Foundation

// Shared builders for the Events list tests. "Today" is pinned to Tuesday
// 13 October 2026 unless a test says otherwise.

let today = "2026-10-13"

func event(start: String? = nil, end: String? = nil,
           startTime: String? = nil, endTime: String? = nil) -> ExtractedEvent {
    ExtractedEvent(title: "T", startDate: start, endDate: end, startTime: startTime, endTime: endTime)
}

func capture(_ id: String, _ status: CaptureStatus = .completed, _ event: ExtractedEvent? = nil,
             corrected: [String: String?]? = nil,
             calendarEventId: String? = nil, matchedEventId: String? = nil,
             possibleDuplicateOf: String? = nil) -> Capture {
    Capture(captureId: id, status: status, createdAt: "2026-10-12T14:22:01.456Z",
            event: event, corrected: corrected, calendarEventId: calendarEventId,
            matchedEventId: matchedEventId, possibleDuplicateOf: possibleDuplicateOf)
}

func ids(_ captures: [Capture]) -> [String] { captures.map(\.captureId) }

func instant(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }
