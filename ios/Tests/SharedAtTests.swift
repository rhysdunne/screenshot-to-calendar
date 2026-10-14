import Foundation
import Testing

// SharedAt sets its static formatters' timeZone on every call, so two tests
// calling it at once could race. Swift Testing runs tests in parallel by
// default; .serialized keeps this suite's tests one at a time.
@Suite("SharedAt", .serialized)
struct SharedAtTests {
    @Test(arguments: [
        ("2026-10-12T14:22:01.456Z", "Europe/London", "Shared 12 Oct, 15:22"),
        ("2026-10-12T14:22:01Z", "Europe/London", "Shared 12 Oct, 15:22"),
        ("2026-10-12T23:30:00.000Z", "Europe/London", "Shared 13 Oct, 00:30"),
        ("2026-10-12T23:30:00.000Z", "America/New_York", "Shared 12 Oct, 19:30"),
        ("2026-12-01T09:05:00.000Z", "Europe/London", "Shared 1 Dec, 09:05"),
    ])
    func text(createdAt: String, zone: String, expected: String) {
        #expect(SharedAt.text(createdAt: createdAt, zone: EventDates.zone(identifier: zone)) == expected)
    }

    @Test(arguments: ["", "yesterday", "2026-10-12"])
    func unparseable(createdAt: String) {
        #expect(SharedAt.text(createdAt: createdAt, zone: EventDates.zone(identifier: nil)) == nil)
    }
}
