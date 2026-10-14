import Testing

@Suite("EventCategoryLabel")
struct EventCategoryLabelTests {
    @Test func labels() {
        #expect(EventCategoryLabel.text("food_drink") == "Food & drink")
        #expect(EventCategoryLabel.text("club_night") == "Club night")
        #expect(EventCategoryLabel.text("other") == nil)
        #expect(EventCategoryLabel.text("rave") == nil)
        #expect(EventCategoryLabel.text(nil) == nil)
    }
}
