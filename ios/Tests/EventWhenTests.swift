import Foundation
import Testing

// Exact strings assume the en_GB region that the test scheme pins. The year
// adds a comma in en_GB (CLDR "EEE, d MMM y"): "Sun, 3 Jan 2027".
@Suite("EventWhen")
struct EventWhenTests {
    @Test(arguments: [
        (event(start: today, startTime: "20:00"), "Today, 20:00"),
        (event(start: today), "Today"),
        (event(start: "2026-10-18", startTime: "19:30", endTime: "23:00"), "Sun 18 Oct, 19:30–23:00"),
        (event(start: "2026-10-18", end: "2026-10-18", startTime: "19:30"), "Sun 18 Oct, 19:30"),
        (event(start: "2026-10-18", startTime: "22:00", endTime: "04:00"), "Sun 18 Oct, 22:00–04:00"),
        (event(start: "2026-10-20", endTime: "22:00"), "Tue 20 Oct"),
        (event(start: "2026-10-18", startTime: "7pm"), "Sun 18 Oct"),
        (event(start: "2026-10-14", end: "2026-10-18"), "Wed 14 Oct – Sun 18 Oct"),
        (event(start: today, end: "2026-10-18"), "Tue 13 Oct – Sun 18 Oct"),
        (event(start: "2026-12-27", end: "2027-01-03"), "Sun 27 Dec – Sun, 3 Jan 2027"),
        (event(start: "2026-10-20", end: "2026-10-15"), "Tue 20 Oct – Thu 15 Oct"),
        (event(start: "2027-10-03", startTime: "19:00"), "Sun, 3 Oct 2027, 19:00"),
        (event(start: "2025-10-01"), "Wed, 1 Oct 2025"),
        (event(end: "2026-10-31"), "Until Sat 31 Oct"),
        (event(start: "2026-03-29"), "Sun 29 Mar"),
        (event(start: "2026-10-25"), "Sun 25 Oct"),
    ])
    func full(event: ExtractedEvent, expected: String) {
        #expect(EventWhen.text(for: event, today: today) == expected)
    }

    @Test("A well-shaped but impossible date is shown as it is")
    func impossibleDate() {
        // DateFormatter rolls 30 Feb over to 2 Mar unless isLenient is set
        // explicitly, although its getter already reports false.
        withKnownIssue("wireParser needs isLenient = false") {
            #expect(EventWhen.text(for: event(start: "2026-02-30"), today: today) == "2026-02-30")
        }
    }

    @Test(arguments: [
        (event(start: "2026-09-01", end: "2026-11-30"), "Until Mon 30 Nov"),
        (event(start: "2026-09-01", end: today), "Until Tue 13 Oct"),
        (event(end: "2026-10-31"), "Until Sat 31 Oct"),
    ])
    func until(event: ExtractedEvent, expected: String) {
        #expect(EventWhen.text(for: event, today: today, style: .until) == expected)
    }

    @Test("No valid date gives no when line", arguments: [
        event(), event(startTime: "19:00"), event(start: "2026-10-1"), event(start: "soon", end: "later"),
    ])
    func noDate(event: ExtractedEvent) {
        #expect(EventWhen.text(for: event, today: today) == nil)
    }
}
