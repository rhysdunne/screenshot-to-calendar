import Foundation
import Testing

@Suite("EventSections")
struct EventSectionsTests {
    // The unsorted sections (processing, review, other) get their input in
    // real API order: newest share, so highest id, first. The dates run in
    // neither direction, so a sort by id or by date changes the result.

    @Test("Queued and processing captures stay in API order, whatever their date")
    func processing() {
        let s = EventSections([
            capture("12", .queued, event(start: "2026-10-20")),
            capture("11", .processing),
            capture("10", .queued, event(start: "2026-10-01")),
        ], today: today)
        #expect(ids(s.processing) == ["12", "11", "10"])
        #expect(s.upcoming.isEmpty)
        #expect(s.past.isEmpty)
    }

    @Test("Review holds needs_review and failed-with-event captures, even past-dated ones")
    func review() {
        let s = EventSections([
            capture("16", .needsReview, event(start: "2025-10-01")),
            capture("15", .failed, event(start: "2026-10-20")),
            capture("14", .failed),
            capture("13", .needsReview, event()),
            capture("12", .completed, event(start: "2026-10-20"), possibleDuplicateOf: "01OTHER"),
        ], today: today)
        #expect(ids(s.review) == ["16", "15", "13"])
        #expect(ids(s.other) == ["14"])
        #expect(ids(s.upcoming) == ["12"], "a possible duplicate never sits in review")
    }

    @Test("Upcoming: soonest first, all-day before timed on the same day")
    func upcoming() {
        let s = EventSections([
            capture("16", .completed, event(start: today, startTime: "20:00")),
            capture("17", .completed, event(start: today)),
            capture("18", .completed, event(start: "2026-10-18", startTime: "19:30")),
            capture("27", .completed, event(start: "2026-10-20", end: "2026-10-15")),
        ], today: today)
        #expect(ids(s.upcoming) == ["17", "16", "18", "27"])
    }

    @Test("On now: started before today or end-only, not ended, closing soonest first")
    func onNow() {
        let s = EventSections([
            capture("20", .completed, event(start: "2026-09-01", end: "2026-11-30")),
            capture("21", .completed, event(end: "2026-10-20")),
            capture("24", .completed, event(start: "2026-10-12", end: today)),
        ], today: today)
        #expect(ids(s.onNow) == ["24", "21", "20"])
    }

    @Test("Past: most recently finished first, later start time first on a day")
    func past() {
        let s = EventSections([
            capture("22", .completed, event(start: "2026-10-12")),
            capture("23", .completed, event(start: "2026-10-01", end: "2026-10-12")),
            capture("28", .completed, event(start: "2026-10-05", startTime: "21:00")),
            capture("29", .completed, event(start: "2026-10-05", startTime: "09:00")),
            capture("20", .completed, event(start: "2026-10-12", end: "2026-10-05")),
        ], today: today)
        #expect(ids(s.past) == ["20", "22", "23", "28", "29"])
    }

    @Test("Other: not events, failures with nothing, and no valid date")
    func other() {
        let s = EventSections([
            capture("19", .failed),
            capture("18", .notEvent),
            capture("17", .completed, event(start: "not-a-date")),
            capture("16", .completed, event(start: "2026-10-1")),
            capture("15", .completed, event(startTime: "19:00")),
        ], today: today)
        #expect(ids(s.other) == ["19", "18", "17", "16", "15"])
    }

    @Test("Corrections decide the section: a moved date moves it, a cleared date drops it to Other")
    func corrections() {
        let s = EventSections([
            capture("30", .completed, event(start: "2026-10-20"), corrected: ["start_date": "2026-10-01"]),
            capture("31", .completed, event(start: "2026-10-20"), corrected: ["start_date": String?.none]),
        ], today: today)
        #expect(ids(s.past) == ["30"])
        #expect(ids(s.other) == ["31"])
    }

    @Test("A duplicate sits directly under its original, even across sections")
    func duplicates() {
        let s = EventSections([
            capture("A1", .completed, event(start: "2026-10-18", startTime: "19:30"), calendarEventId: "gA"),
            capture("B1", .completed, event(start: "2026-10-18", startTime: "19:30")),
            capture("A2", .duplicate, event(start: "2026-10-18"), matchedEventId: "gA"),
            capture("A3", .duplicate, event(start: "2026-10-18", startTime: "19:00"), matchedEventId: "gA"),
            capture("H1", .completed, event(start: "2026-09-01", end: "2026-11-30"), calendarEventId: "gH"),
            capture("H2", .duplicate, event(start: "2026-09-01"), matchedEventId: "gH"),
            capture("X1", .duplicate, event(start: "2026-10-20"), matchedEventId: "gMadeByHand"),
        ], today: today)
        #expect(ids(s.upcoming) == ["A1", "A2", "A3", "B1", "X1"])
        #expect(ids(s.onNow) == ["H1", "H2"])
        #expect(s.past.isEmpty)
    }

    @Test("Sorted sections do not depend on API order, so the 2s poll never reshuffles")
    func stableOrder() {
        let input = [
            capture("01", .completed, event(start: "2026-10-18", startTime: "19:30")),
            capture("02", .completed, event(start: "2026-10-18", startTime: "19:30")),
            capture("03", .completed, event(start: "2026-09-01", end: "2026-11-30")),
            capture("04", .completed, event(start: "2026-08-01", end: "2026-11-30")),
            capture("05", .completed, event(start: "2026-10-01")),
            capture("06", .completed, event(start: "2026-10-01")),
        ]
        let a = EventSections(input, today: today)
        let b = EventSections(input.reversed(), today: today)
        #expect(a.upcoming == b.upcoming)
        #expect(a.onNow == b.onNow)
        #expect(a.past == b.past)
    }
}

@Suite("Capture")
struct CaptureTests {
    @Test func needsAttention() {
        #expect(capture("1", .needsReview, event()).needsAttention)
        #expect(capture("2", .failed, event()).needsAttention)
        #expect(!capture("3", .failed).needsAttention)
        #expect(!capture("4", .completed, event(), possibleDuplicateOf: "x").needsAttention)
    }

    @Test("A null in corrected clears the field; an absent key keeps the extraction")
    func decodesClearedCorrection() throws {
        let json = #"""
        {"captureId":"01","status":"completed","createdAt":"2026-10-12T14:22:01.456Z",
         "event":{"title":"Gig","start_date":"2026-10-18","start_time":"19:30"},
         "corrected":{"start_time":null,"title":"Better gig"}}
        """#
        let c = try JSONDecoder().decode(Capture.self, from: Data(json.utf8))
        #expect(c.effectiveEvent?.title == "Better gig")
        #expect(c.effectiveEvent?.startTime == nil)
        #expect(c.effectiveEvent?.startDate == "2026-10-18")
        #expect(c.event?.startTime == "19:30", "the original event is never overwritten")
    }
}
