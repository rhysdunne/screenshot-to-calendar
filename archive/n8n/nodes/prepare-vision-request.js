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
const promptTemplate = `{{PROMPT}}`;

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
          text: promptTemplate.replace('{{TODAY}}', today)
        }
      ]
    }
  ]
};

return { json: requestBody };
