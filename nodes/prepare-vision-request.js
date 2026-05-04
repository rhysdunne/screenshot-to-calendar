// Prepare the Anthropic Vision API request body
const inputData = $input.first().json.body;
const imageBase64 = inputData.image;

// Detect media type from data URI prefix or magic bytes
let mediaType = 'image/jpeg';
if (imageBase64.startsWith('data:')) {
  const match = imageBase64.match(/^data:(image\/[a-zA-Z+]+);base64,/);
  if (match) {
    mediaType = match[1];
  }
} else {
  // No data URI prefix — detect from base64 magic bytes
  if (imageBase64.startsWith('iVBOR')) {
    mediaType = 'image/png';
  } else if (imageBase64.startsWith('R0lGOD')) {
    mediaType = 'image/gif';
  } else if (imageBase64.startsWith('UklGR')) {
    mediaType = 'image/webp';
  }
  // else stays as image/jpeg (starts with /9j/)
}

// Strip data URI prefix if present
const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');

const today = new Date().toISOString().split('T')[0];

const requestBody = {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: cleanBase64
          }
        },
        {
          type: 'text',
          text: `Today's date is ${today}. Analyse this image. It shows a poster, flyer, social media post, or screenshot advertising an event or exhibition, likely in London.\n\nExtract the following and return ONLY valid JSON with no markdown formatting:\n{\n  "title": "event or exhibition name",\n  "venue": "venue name if visible, otherwise null",\n  "address": "full address if visible, otherwise null",\n  "start_date": "YYYY-MM-DD or null",\n  "end_date": "YYYY-MM-DD or null (for exhibitions with a run period)",\n  "start_time": "HH:MM or null (24h format)",\n  "end_time": "HH:MM or null (24h format)",\n  "description": "brief one-sentence summary of the event",\n  "url": "any website or ticket link visible, otherwise null",\n  "confidence": "high/medium/low — how confident you are in the extracted dates"\n}\n\nRules:\n- If a date says "until 30 March" or "runs through April", infer the end_date.\n- If only a day of the week is given (e.g. "Saturday"), infer the next occurrence from today.\n- If the year is ambiguous, assume 2026.\n- If you see an Instagram handle or account name, include it in the description.\n- Return ONLY the JSON object, no explanation or markdown.`
        }
      ]
    }
  ]
};

return { json: requestBody };
