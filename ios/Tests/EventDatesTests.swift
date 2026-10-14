import Foundation
import Testing

@Suite("EventDates")
struct EventDatesTests {
    // Each row: the instant, the settings zone, and "today" in that zone.
    @Test("today(in:) is the date in the settings zone, never UTC or the device zone",
          arguments: [
              // The v1 bug: UTC "today" was wrong from midnight to 1am BST.
              ("2026-07-01T23:30:00Z", "Europe/London", "2026-07-02"),
              ("2026-07-01T22:59:00Z", "Europe/London", "2026-07-01"),
              ("2026-10-13T23:30:00Z", "Pacific/Auckland", "2026-10-14"),
              ("2026-10-13T23:30:00Z", "America/New_York", "2026-10-13"),
              // DST change days (backend tests use the same two dates).
              ("2026-03-29T00:30:00Z", "Europe/London", "2026-03-29"),
              ("2026-03-29T23:30:00Z", "Europe/London", "2026-03-30"),
              ("2026-10-24T23:30:00Z", "Europe/London", "2026-10-25"),
              ("2026-10-25T23:30:00Z", "Europe/London", "2026-10-25"),
              // Calendar year, not week-based year (the YYYY trap).
              ("2026-12-28T12:00:00Z", "Europe/London", "2026-12-28"),
              ("2026-12-31T23:30:00Z", "Europe/London", "2026-12-31"),
          ])
    func today(iso: String, zone: String, expected: String) {
        #expect(EventDates.today(in: EventDates.zone(identifier: zone), now: instant(iso)) == expected)
    }

    @Test("A missing or unknown settings zone falls back to Europe/London",
          arguments: [nil, "", "Mars/Olympus"] as [String?])
    func zoneFallback(identifier: String?) {
        #expect(EventDates.zone(identifier: identifier).identifier == "Europe/London")
    }

    @Test func zoneKnown() {
        #expect(EventDates.zone(identifier: "Pacific/Auckland").identifier == "Pacific/Auckland")
    }

    @Test("valid(date:) accepts only yyyy-MM-dd",
          arguments: [
              ("2026-10-13", true), ("2026-02-30", true), // shape only, not calendar validity
              ("2026-1-13", false), ("2026-10-1", false), (" 2026-10-13", false),
              ("2026-10-13T00:00", false), ("", false), ("not-a-date", false),
          ])
    func validDate(input: String, accepted: Bool) {
        #expect((EventDates.valid(date: input) != nil) == accepted)
    }

    @Test("valid(time:) accepts only HH:mm",
          arguments: [("19:30", true), ("7:30", false), ("19:30:00", false), ("7pm", false), ("", false)])
    func validTime(input: String, accepted: Bool) {
        #expect((EventDates.valid(time: input) != nil) == accepted)
    }

    @Test("lastDay is the later valid date; an end before the start falls back to the start")
    func lastDay() {
        #expect(EventDates.lastDay(of: event(start: "2026-10-18")) == "2026-10-18")
        #expect(EventDates.lastDay(of: event(end: "2026-10-31")) == "2026-10-31")
        #expect(EventDates.lastDay(of: event(start: "2026-09-01", end: "2026-11-30")) == "2026-11-30")
        #expect(EventDates.lastDay(of: event(start: "2026-10-20", end: "2026-10-15")) == "2026-10-20")
        #expect(EventDates.lastDay(of: event(start: "2026-10-20", end: "soon")) == "2026-10-20")
        #expect(EventDates.lastDay(of: event()) == nil)
    }
}
