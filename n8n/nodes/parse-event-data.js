// Parse the Claude response into structured event data, then map it to the
// fields the Google Calendar node (v1.3) expects.
//
// This file is round-tripped by `make pull` / `make push`: its contents are
// the jsCode of the "Parse Event Data" n8n Code node, so it must stay
// self-contained — no require/import — for n8n to run it as a bare script.
// The typeof guards at the bottom let `node --test` import the pure functions
// without n8n's $input being present. Tests live in parse-event-data.test.js.

// Pull the JSON event object out of the Anthropic API response.
function extractEventData(response) {
  let rawText = '';
  if (response.content && Array.isArray(response.content)) {
    rawText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  } else {
    throw new Error('Unexpected API response structure');
  }

  // Clean up — sometimes the model wraps in code fences despite instructions
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Failed to parse event JSON: ${e.message}\nRaw response: ${rawText}`);
  }
}

// Map extracted event data to Google Calendar node v1.3 fields.
// Required params: start, end. Additional fields: summary, description, location, allday.
function mapEventToCalendar(eventData) {
  const descParts = [];
  if (eventData.description) descParts.push(eventData.description);
  if (eventData.venue) descParts.push(`Venue: ${eventData.venue}`);
  if (eventData.address) descParts.push(`Address: ${eventData.address}`);
  if (eventData.url) descParts.push(`Link: ${eventData.url}`);
  descParts.push(`\n[Auto-captured · Confidence: ${eventData.confidence || 'unknown'}]`);

  const hasTime = !!eventData.start_time;
  let startDate = eventData.start_date;
  let endDate = eventData.end_date || eventData.start_date;

  // Exhibition posters often show only a closing date ("until 30 July").
  // If we have an end but no start, treat it as running from today.
  if (!startDate && endDate) {
    startDate = new Date().toISOString().split('T')[0];
  }
  if (!startDate && !endDate) {
    throw new Error('No start or end date could be extracted from the image');
  }
  if (!endDate) endDate = startDate;

  let startDateTime, endDateTime, allDay;

  if (hasTime) {
    allDay = 'no';
    startDateTime = `${startDate}T${eventData.start_time}:00`;
    if (eventData.end_time) {
      endDateTime = `${endDate}T${eventData.end_time}:00`;
    } else {
      // Default to 2 hours after start, clamped within the same day.
      const [sh, sm] = eventData.start_time.split(':').map(Number);
      const overflow = sh + 2 > 23;
      const endH = overflow ? 23 : sh + 2;
      const endM = overflow ? 59 : sm;
      endDateTime = `${startDate}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;
    }
  } else {
    allDay = 'yes';
    startDateTime = startDate;
    // Google Calendar all-day end date is exclusive, so add 1 day
    const end = new Date(endDate);
    end.setDate(end.getDate() + 1);
    endDateTime = end.toISOString().split('T')[0];
  }

  return {
    start: startDateTime,
    end: endDateTime,
    summary: eventData.title || 'Untitled Event',
    description: descParts.join('\n'),
    location: eventData.address || eventData.venue || '',
    allDay: allDay,
    confidence: eventData.confidence,
    _raw: eventData,
  };
}

// n8n Code node entry point — only runs inside n8n, where $input is defined.
if (typeof $input !== 'undefined') {
  return { json: mapEventToCalendar(extractEventData($input.first().json)) };
}

// Test harness export — only when imported by `node --test`, not by n8n.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractEventData, mapEventToCalendar };
}
