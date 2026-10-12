Today's date is {{TODAY}} and the user's timezone is {{TIMEZONE}}. Analyse this image. It shows a poster, flyer, social media post, ticket, or screenshot advertising an event or exhibition.

Extract the following and return ONLY valid JSON with no markdown formatting:
{
  "title": "event or exhibition name",
  "venue": "venue name if visible, otherwise null",
  "address": "full address if visible, otherwise null",
  "start_date": "YYYY-MM-DD or null",
  "end_date": "YYYY-MM-DD or null (for exhibitions with a run period)",
  "start_time": "HH:MM or null (24h format)",
  "end_time": "HH:MM or null (24h format)",
  "description": "brief one-sentence summary of the event",
  "url": "any website or ticket link visible, otherwise null",
  "price": "ticket price as shown, e.g. \"Free\" or \"£12.50\", otherwise null",
  "category": "exhibition | music | theatre | club_night | food_drink | market | workshop | talk | film | other",
  "confidence": "high/medium/low — how confident you are in the extracted dates"
}

Rules:
- If a date says "until 30 March" or "runs through April", infer the end_date. Leave end_date null for a one-day event.
- If only a day of the week is given (e.g. "Saturday"), infer the next occurrence from today.
- If the year is not shown, work it out from today's date:
  - If the date last fell no more than 30 days before today, use that past date, even if the image reads like an advert for an upcoming event. The event has most likely just happened or is still running, so do not move it to next year.
  - Otherwise, use the next occurrence of that date from today.
  - For a run period, settle the end date first, then give the start date the latest year that keeps it on or before the end date.
- Times like "7pm" become "19:00"; "doors 7 / show 8" means start_time is the show time "20:00"; "7pm–late" means start_time "19:00" and end_time null.
- If you see an Instagram handle or account name, include it in the description.
- Do not guess a venue or address that is not visible in the image — use null.
- Price: "free entry" or "free" means "Free"; if multiple prices are shown (e.g. advance/door), use the lowest with its label, e.g. "£8 adv". Null if no price is shown.
- Category: pick the single best fit from the list based on what the event is, not where it is; use "other" if genuinely unclear.
- Return ONLY the JSON object, no explanation or markdown.
