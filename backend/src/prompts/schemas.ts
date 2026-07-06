// JSON Schemas for Anthropic structured outputs (output_config.format).
// Kept alongside the prompt files: prompt text describes the task, these
// guarantee the shape. additionalProperties:false is required by the API.

export const EXTRACT_EVENT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    venue: { type: ['string', 'null'] },
    address: { type: ['string', 'null'] },
    start_date: { type: ['string', 'null'], format: 'date' },
    end_date: { type: ['string', 'null'], format: 'date' },
    start_time: { type: ['string', 'null'] },
    end_time: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    url: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: [
    'title',
    'venue',
    'address',
    'start_date',
    'end_date',
    'start_time',
    'end_time',
    'description',
    'url',
    'confidence',
  ],
  additionalProperties: false,
} as const;

export const CLASSIFY_IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['event_poster', 'event_screenshot', 'ticket', 'other_scrapbook', 'not_useful'],
    },
    is_event: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['category', 'is_event', 'confidence'],
  additionalProperties: false,
} as const;
