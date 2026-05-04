Today's date is {{TODAY}}. Analyse this image. It shows a poster, flyer, social media post, or screenshot advertising an event or exhibition, likely in London.

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
  "confidence": "high/medium/low — how confident you are in the extracted dates"
}

Rules:
- If a date says "until 30 March" or "runs through April", infer the end_date.
- If only a day of the week is given (e.g. "Saturday"), infer the next occurrence from today.
- If the year is ambiguous, assume 2026.
- If you see an Instagram handle or account name, include it in the description.
- Return ONLY the JSON object, no explanation or markdown.
