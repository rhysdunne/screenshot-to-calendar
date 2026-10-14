import Foundation

// The Events list's date logic. Foundation only, with no SwiftUI or AppState,
// so the Screenshot2CalTests target (ios/Tests/) compiles it on its own.
//
// Every rule compares `yyyy-MM-dd` strings against "today" in the user's
// settings timezone. There is no date arithmetic, so the DST change days and
// the v1 UTC-"today" bug (wrong between midnight and 1am BST) cannot arise.

/// Captures sorted into the Events list's sections. A capture lands in the
/// first section whose rule it matches, in the order of the fields below.
struct EventSections: Equatable {
    /// Queued or processing, newest share first.
    var processing: [Capture] = []
    /// `needsAttention`, newest share first, whatever the date: the date may
    /// itself be the misread (a wrong year, #27), so it never moves them.
    var review: [Capture] = []
    /// Starts today or later. Soonest first, all-day before timed.
    var upcoming: [Capture] = []
    /// Started before today (or has only an end date) and has not ended.
    /// Closing soonest first, so a long exhibition never crowds Upcoming.
    var onNow: [Capture] = []
    /// Last day before today. Most recently finished first.
    var past: [Capture] = []
    /// No event, or no valid date: not_event, failed with nothing extracted.
    var other: [Capture] = []

    /// `captures` in API order (newest share first). `today` is
    /// `EventDates.today(in:)`, passed in so a preview can pin it.
    init(_ captures: [Capture], today: String) {
        for capture in captures {
            if !capture.status.isTerminal {
                processing.append(capture)
            } else if capture.needsAttention {
                review.append(capture)
            } else if let event = capture.effectiveEvent, let lastDay = EventDates.lastDay(of: event) {
                if lastDay < today {
                    past.append(capture)
                } else if let start = EventDates.valid(date: event.startDate), start >= today {
                    upcoming.append(capture)
                } else {
                    onNow.append(capture)
                }
            } else {
                other.append(capture)
            }
        }
        // captureId is a ULID, so it orders by share time. As the last key it
        // keeps the order stable across the 2s poll's re-renders.
        upcoming.sort { Self.upcomingKey($0) < Self.upcomingKey($1) }
        onNow.sort { Self.onNowKey($0) < Self.onNowKey($1) }
        past.sort { a, b in
            let (ka, kb) = (Self.pastKey(a), Self.pastKey(b))
            if ka.day != kb.day { return ka.day > kb.day }
            if ka.time != kb.time { return ka.time > kb.time }
            return a.captureId < b.captureId
        }
        groupDuplicates()
    }

    /// Moves each duplicate directly under the capture that created the
    /// calendar event it matched, even across sections. Sorting alone can't:
    /// the backend matches on title and start date only, so a duplicate's own
    /// time or end date can differ (a doors time, no end date). A duplicate
    /// whose original isn't listed (an event made by hand in Google, or a
    /// capture beyond the 200 loaded) keeps its own sorted place.
    private mutating func groupDuplicates() {
        // A duplicate never reports a calendarEventId, so only an original can.
        var originalByEventId: [String: String] = [:]
        for capture in upcoming + onNow + past {
            if let eventId = capture.calendarEventId { originalByEventId[eventId] = capture.captureId }
        }
        var duplicatesByOriginal: [String: [Capture]] = [:]
        func takeDuplicates(from list: inout [Capture]) {
            list.removeAll { capture in
                guard capture.status == .duplicate,
                      let eventId = capture.matchedEventId,
                      let original = originalByEventId[eventId]
                else { return false }
                duplicatesByOriginal[original, default: []].append(capture)
                return true
            }
        }
        takeDuplicates(from: &upcoming)
        takeDuplicates(from: &onNow)
        takeDuplicates(from: &past)
        guard !duplicatesByOriginal.isEmpty else { return }
        func insertDuplicates(into list: inout [Capture]) {
            list = list.flatMap { capture in
                [capture] + (duplicatesByOriginal[capture.captureId] ?? []).sorted { $0.captureId < $1.captureId }
            }
        }
        insertDuplicates(into: &upcoming)
        insertDuplicates(into: &onNow)
        insertDuplicates(into: &past)
    }

    // A missing start time sorts as "", which is before any "HH:mm", so
    // all-day events come first on their day.
    private static func upcomingKey(_ c: Capture) -> (String, String, String) {
        let event = c.effectiveEvent
        return (EventDates.valid(date: event?.startDate) ?? "",
                EventDates.valid(time: event?.startTime) ?? "",
                c.captureId)
    }

    private static func onNowKey(_ c: Capture) -> (String, String) {
        (c.effectiveEvent.flatMap(EventDates.lastDay(of:)) ?? "", c.captureId)
    }

    private static func pastKey(_ c: Capture) -> (day: String, time: String) {
        let event = c.effectiveEvent
        return (event.flatMap(EventDates.lastDay(of:)) ?? "",
                EventDates.valid(time: event?.startTime) ?? "")
    }
}

extension Capture {
    /// Captures that need the user to act: low-confidence extractions, or
    /// failures that still produced an event to salvage. They sit at the top
    /// of the list. Possible duplicates are left out: the backend never clears
    /// that flag, so they could never leave the section. The detail view
    /// still warns about them.
    var needsAttention: Bool {
        status == .needsReview || (status == .failed && event != nil)
    }
}

/// Wire-format date helpers. Dates are `yyyy-MM-dd` and times `HH:mm`,
/// wall-clock with no timezone.
enum EventDates {
    /// The zone that decides "today": the user's settings zone, else
    /// Europe/London, the backend's own fallback. Event dates were read in
    /// this zone, so "today" must come from it too, never from the device.
    static func zone(identifier: String?) -> TimeZone {
        identifier.flatMap(TimeZone.init(identifier:))
            ?? TimeZone(identifier: "Europe/London")!
    }

    /// Today as `yyyy-MM-dd` in `zone`. Never ISO8601DateFormatter (that is
    /// the UTC date) or Calendar.current (that is the device zone).
    static func today(in zone: TimeZone, now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: now)
    }

    /// The date when it is a well-formed `yyyy-MM-dd`, else nil. String
    /// comparison orders dates correctly only in this exact shape.
    static func valid(date: String?) -> String? {
        guard let date, date.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
        else { return nil }
        return date
    }

    /// The time when it is a well-formed `HH:mm`, else nil.
    static func valid(time: String?) -> String? {
        guard let time, time.range(of: #"^\d{2}:\d{2}$"#, options: .regularExpression) != nil
        else { return nil }
        return time
    }

    /// The event's last day: the later of its valid start and end dates. The
    /// end date is inclusive here. Google's exclusive +1 for all-day events
    /// belongs to the backend's calendar mapping only. Taking the later date
    /// also places an end-before-start event sensibly.
    static func lastDay(of event: ExtractedEvent) -> String? {
        [valid(date: event.startDate), valid(date: event.endDate)].compactMap { $0 }.max()
    }
}

/// The text for a row's "when" line.
enum EventWhen {
    enum Style {
        /// The dates as extracted: "Sat 18 Oct, 19:30–23:00", or a range.
        case full
        /// For a running event: "Until Sun 30 Nov".
        case until
    }

    /// Nil when the event has no valid date. `today` turns a start of today
    /// into "Today". The year shows only when it is not today's year, so a
    /// misread year stands out.
    static func text(for event: ExtractedEvent, today: String, style: Style = .full) -> String? {
        let start = EventDates.valid(date: event.startDate)
        let end = EventDates.valid(date: event.endDate)
        let year = String(today.prefix(4))

        if style == .until, let last = EventDates.lastDay(of: event) {
            return "Until \(day(last, currentYear: year))"
        }
        guard let start else {
            return end.map { "Until \(day($0, currentYear: year))" }
        }
        if let end, end != start {
            // Times are left out of a range: "19:30" on a two-week run says
            // little, and the detail sheet has them.
            return "\(day(start, currentYear: year)) – \(day(end, currentYear: year))"
        }
        let dayText = start == today ? "Today" : day(start, currentYear: year)
        guard let startTime = EventDates.valid(time: event.startTime) else { return dayText }
        if let endTime = EventDates.valid(time: event.endTime) {
            return "\(dayText), \(startTime)–\(endTime)"
        }
        return "\(dayText), \(startTime)"
    }

    /// "Sat 18 Oct", or "Sat 18 Oct 2027" outside the current year, in the
    /// user's locale. Parse and display share one fixed zone (GMT), so the
    /// shown day never shifts and a DST-gap midnight cannot fail the parse.
    /// A date that does not parse is shown as it is.
    static func day(_ wire: String, currentYear: String) -> String {
        guard let date = wireParser.date(from: wire) else { return wire }
        return (wire.hasPrefix(currentYear) ? dayFormatter : dayWithYearFormatter).string(from: date)
    }

    private static let gmt = TimeZone(identifier: "GMT")!

    private static let wireParser: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = gmt
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func displayFormatter(template: String) -> DateFormatter {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = gmt
        f.setLocalizedDateFormatFromTemplate(template)
        return f
    }

    private static let dayFormatter = displayFormatter(template: "EEEdMMM")
    private static let dayWithYearFormatter = displayFormatter(template: "EEEdMMMy")
}

/// The "Shared 12 Oct, 15:22" line on rows without an event.
enum SharedAt {
    /// Nil when `createdAt` does not parse. The day and the time are joined
    /// here, because a day-and-time template makes English read "12 Oct at
    /// 15:22". The time is "HH:mm", like the event times on other rows.
    static func text(createdAt: String, zone: TimeZone) -> String? {
        guard let date = withFraction.date(from: createdAt) ?? withoutFraction.date(from: createdAt)
        else { return nil }
        dayFormatter.timeZone = zone
        timeFormatter.timeZone = zone
        return "Shared \(dayFormatter.string(from: date)), \(timeFormatter.string(from: date))"
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("dMMM")
        return f
    }()
    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f
    }()

    // The backend writes `new Date().toISOString()`, which has milliseconds.
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let withoutFraction = ISO8601DateFormatter()
}

/// The v3 extraction's category as a label, or nil for "other", a missing
/// category or a value this build does not know.
enum EventCategoryLabel {
    static func text(_ category: String?) -> String? {
        switch category {
        case "exhibition": return "Exhibition"
        case "music": return "Music"
        case "theatre": return "Theatre"
        case "club_night": return "Club night"
        case "food_drink": return "Food & drink"
        case "market": return "Market"
        case "workshop": return "Workshop"
        case "talk": return "Talk"
        case "film": return "Film"
        default: return nil
        }
    }
}
