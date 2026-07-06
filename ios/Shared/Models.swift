import Foundation

// Mirrors of the backend JSON contracts (docs/architecture.md). Field names
// match the wire format via snake_case CodingKeys where needed — change these
// together with backend/src/pipeline/types.ts.

struct ExtractedEvent: Codable, Equatable {
    var title: String?
    var venue: String?
    var address: String?
    var startDate: String?
    var endDate: String?
    var startTime: String?
    var endTime: String?
    var description: String?
    var url: String?
    var confidence: String?

    enum CodingKeys: String, CodingKey {
        case title, venue, address, description, url, confidence
        case startDate = "start_date"
        case endDate = "end_date"
        case startTime = "start_time"
        case endTime = "end_time"
    }
}

struct Classification: Codable, Equatable {
    var category: String
    var isEvent: Bool
    var confidence: String

    enum CodingKeys: String, CodingKey {
        case category, confidence
        case isEvent = "is_event"
    }
}

enum CaptureStatus: String, Codable {
    case queued, processing, completed, failed, duplicate
    case notEvent = "not_event"

    var label: String {
        switch self {
        case .queued: return "Queued"
        case .processing: return "Processing…"
        case .completed: return "In calendar"
        case .failed: return "Failed"
        case .duplicate: return "Already in calendar"
        case .notEvent: return "Saved (not an event)"
        }
    }

    var isTerminal: Bool { self != .queued && self != .processing }
}

struct Capture: Codable, Identifiable, Equatable {
    var captureId: String
    var status: CaptureStatus
    var createdAt: String
    var classification: Classification?
    var event: ExtractedEvent?
    var corrected: ExtractedEvent?
    var calendarEventId: String?
    var eventLink: String?
    var possibleDuplicateOf: String?
    var error: String?

    var id: String { captureId }

    /// The user-facing view of the event: corrections overlaid on extraction.
    var effectiveEvent: ExtractedEvent? {
        guard var merged = event else { return nil }
        guard let corrected else { return merged }
        if let v = corrected.title { merged.title = v }
        if let v = corrected.venue { merged.venue = v }
        if let v = corrected.address { merged.address = v }
        if let v = corrected.startDate { merged.startDate = v }
        if let v = corrected.endDate { merged.endDate = v }
        if let v = corrected.startTime { merged.startTime = v }
        if let v = corrected.endTime { merged.endTime = v }
        if let v = corrected.description { merged.description = v }
        if let v = corrected.url { merged.url = v }
        return merged
    }
}

struct UserSettings: Codable, Equatable {
    var calendarId: String?
    var timezone: String
    var consentEvalUse: Bool
}

struct AuthResponse: Codable {
    struct User: Codable {
        var id: String
        var email: String
        var settings: UserSettings
    }
    var token: String
    var user: User
}

struct CaptureListResponse: Codable {
    var captures: [Capture]
    var cursor: String?
}

struct CreateCaptureResponse: Codable {
    var captureId: String
    var status: String
    var duplicateOf: String?
}

struct CalendarEntry: Codable, Identifiable {
    var id: String
    var summary: String
    var primary: Bool?
}

struct CalendarListResponse: Codable {
    var calendars: [CalendarEntry]
}

struct ImageUrlResponse: Codable {
    var url: String
    var expiresInSeconds: Int
}

struct ExportResponse: Codable {
    var url: String
    var expiresInSeconds: Int
}

struct APIErrorBody: Codable {
    var error: String
    var code: String?
}
