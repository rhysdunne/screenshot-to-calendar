Classify this image. It was shared by a user into an app that turns images of events into calendar entries, and will later also handle general scrapbooking.

Return ONLY valid JSON with no markdown formatting:
{
  "category": "event_poster | event_screenshot | ticket | other_scrapbook | not_useful",
  "is_event": true or false,
  "confidence": "high/medium/low"
}

Definitions:
- "event_poster": a poster, flyer, or graphic advertising an event, gig, exhibition, market, talk, or similar happening.
- "event_screenshot": a screenshot (e.g. of an Instagram post or story, a website, or a message) that describes an event with at least a name and some date or venue information.
- "ticket": a ticket, booking confirmation, or QR/barcode pass for a specific event.
- "other_scrapbook": a photo or image worth keeping (a place, an artwork, a menu, a product, a note) that does NOT describe an upcoming event.
- "not_useful": accidental captures, blank or unreadable images.

"is_event" is true only if the image contains enough information to plausibly create a calendar entry (an event name plus at least a date, day, or venue).
