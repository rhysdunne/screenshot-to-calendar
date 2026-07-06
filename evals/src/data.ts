// Synthetic event data generation. The same EventCase object both fills the
// HTML template AND emits gold.json — ground truth is exact by construction.
// Every case is generated relative to a frozen "today" so relative-date
// phrasings ("this Saturday") stay deterministic forever.
import type { ExtractedEvent, Classification } from '../../backend/src/pipeline/types.js';
import { addDays } from '../../backend/src/pipeline/dates.js';

export const FROZEN_TODAY = '2026-07-06'; // a Monday

/** mulberry32 — tiny seeded PRNG so `--seed 42` regenerates identical cases. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EventCase {
  id: string;
  template: string;
  gold: ExtractedEvent;
  goldClassification: Classification;
  /** Values the template renders — date/time phrasings as printed on the poster. */
  display: {
    title: string;
    venue: string | null;
    address: string | null;
    dateText: string;
    timeText: string | null;
    handle: string | null;
    url: string | null;
    priceText: string | null;
    tagline: string;
  };
}

const VENUES = [
  { name: 'The Windmill', address: '22 Blenheim Gardens, London SW2 5BZ' },
  { name: 'Corsica Studios', address: '4/5 Elephant Road, London SE17 1LB' },
  { name: 'Whitechapel Gallery', address: '77-82 Whitechapel High St, London E1 7QX' },
  { name: 'Cafe OTO', address: '18-22 Ashwin St, London E8 3DL' },
  { name: 'The Old Operating Theatre', address: null },
  { name: 'Peckham Levels', address: null },
  { name: 'Round Chapel', address: '1D Glenarm Rd, London E5 0LY' },
  { name: 'Studio 9294', address: null },
] as const;

const EVENT_NAMES = [
  'Midnight Botany', 'Concrete Poetry Now', 'The Long Now', 'Soft Machines',
  'Night Bloom Market', 'Tape Loops & Echoes', 'Future Ruins', 'Salt & Signal',
  'Border Crossings', 'The Paper Architects', 'Low Tide High Fidelity',
  'Garden of Forking Paths', 'Analogue Sunset', 'Meridian Lines',
  'The Colour of Pomegranates', 'Slow Light', 'Wire & Wool', 'Static Bloom',
] as const;

// Taglines carry the event genre — when a template renders the tagline, the
// genre is readable from the image and goes into gold.category; ambiguous
// taglines (category: null) leave category unscored.
const TAGLINES = [
  { text: 'A group exhibition of new work', category: 'exhibition' },
  { text: 'Live music all night', category: 'music' },
  { text: 'DJs till late', category: 'club_night' },
  { text: 'Talks, tastings and records', category: null },
  { text: 'One night only', category: null },
  { text: 'Free entry, donations welcome', category: null },
  { text: 'A celebration of independent makers', category: 'market' },
  { text: 'New commissions and rare screenings', category: 'film' },
] as const;

const PRICES = ['Free', '£5', '£10', '£12.50', null, null] as const;

const HANDLES = ['@southlondonlistings', '@nightflowerspresents', '@ldn_art_diary', null, null] as const;
const URLS = ['tickets.example.com/e/4821', 'www.eventsite.co.uk', null, null] as const;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'] as const;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function pick<T>(random: () => number, arr: readonly T[]): T {
  return arr[Math.floor(random() * arr.length)] as T;
}

function fmt(ymd: string, style: 'long' | 'short' | 'dotty', withYear: boolean): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const month = MONTHS[m - 1] as string;
  switch (style) {
    case 'long':
      return `${d} ${month}${withYear ? ` ${y}` : ''}`;
    case 'short':
      return `${weekdayOf(ymd).slice(0, 3)} ${d} ${month.slice(0, 3)}${withYear ? ` ${y}` : ''}`;
    case 'dotty':
      return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${String(y).slice(2)}`;
  }
}

export function weekdayOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as string;
}

interface DateSpec {
  dateText: string;
  timeText: string | null;
  gold: Pick<ExtractedEvent, 'start_date' | 'end_date' | 'start_time' | 'end_time'>;
}

/** The date-phrasing corpus — each entry is a hard case seen in the wild. */
function makeDateSpec(random: () => number, today: string): DateSpec {
  const kind = Math.floor(random() * 6);
  const offset = 3 + Math.floor(random() * 40);
  const start = addDays(today, offset);

  switch (kind) {
    case 0: {
      // Single day with explicit year + times: "Sat 12 Jul 2026, 7pm–10:30pm"
      return {
        dateText: fmt(start, 'short', true),
        timeText: '7pm – 10:30pm',
        gold: { start_date: start, end_date: null, start_time: '19:00', end_time: '22:30' },
      };
    }
    case 1: {
      // Exhibition run with "until" — the classic end-date-only case.
      const end = addDays(start, 20 + Math.floor(random() * 30));
      return {
        dateText: `Until ${fmt(end, 'long', true)}`,
        timeText: null,
        gold: { start_date: null, end_date: end, start_time: null, end_time: null },
      };
    }
    case 2: {
      // Range without year: "12 – 18 September"
      const end = addDays(start, 4 + Math.floor(random() * 6));
      return {
        dateText: `${fmt(start, 'long', false)} – ${fmt(end, 'long', true)}`,
        timeText: null,
        gold: { start_date: start, end_date: end, start_time: null, end_time: null },
      };
    }
    case 3: {
      // Relative weekday: "This Saturday" (resolved against FROZEN_TODAY).
      const daysUntilSaturday = (6 - new Date(`${today}T00:00:00Z`).getUTCDay() + 7) % 7 || 7;
      const saturday = addDays(today, daysUntilSaturday);
      return {
        dateText: 'This Saturday',
        timeText: 'Doors 8pm',
        gold: { start_date: saturday, end_date: null, start_time: '20:00', end_time: null },
      };
    }
    case 4: {
      // Dotty European date, start time with "till late" (open end).
      return {
        dateText: fmt(start, 'dotty', true),
        timeText: '9pm till late',
        gold: { start_date: start, end_date: null, start_time: '21:00', end_time: null },
      };
    }
    default: {
      // Weekday + long date, no time (all-day).
      return {
        dateText: `${weekdayOf(start)} ${fmt(start, 'long', true)}`,
        timeText: null,
        gold: { start_date: start, end_date: null, start_time: null, end_time: null },
      };
    }
  }
}

export const TEMPLATE_NAMES = [
  'gallery', 'gig', 'club-night', 'ig-post', 'ig-story', 'market', 'talk', 'hard-mode',
] as const;

// What each template actually renders — gold labels must only contain facts
// visible in the image, so anything a template omits is null (or, for the
// v3 optional fields, absent) in gold.
interface TemplateCaps {
  address: boolean;
  url: boolean;
  price: boolean;
  tagline: boolean;
}
const TEMPLATE_CAPS: Record<string, TemplateCaps> = {
  gallery: { address: true, url: true, price: false, tagline: true },
  gig: { address: true, url: true, price: true, tagline: true },
  'club-night': { address: false, url: false, price: false, tagline: false },
  'ig-post': { address: true, url: true, price: true, tagline: true },
  'ig-story': { address: true, url: false, price: false, tagline: false },
  market: { address: true, url: true, price: true, tagline: true },
  talk: { address: true, url: true, price: true, tagline: true },
  'hard-mode': { address: false, url: false, price: false, tagline: false },
};

export function makeEventCase(random: () => number, index: number, today = FROZEN_TODAY): EventCase {
  const template = TEMPLATE_NAMES[index % TEMPLATE_NAMES.length] as string;
  const venue = pick(random, VENUES);
  const title = pick(random, EVENT_NAMES);
  const tagline = pick(random, TAGLINES);
  const handle = pick(random, HANDLES);
  const url = pick(random, URLS);
  const price = pick(random, PRICES);
  const spec = makeDateSpec(random, today);
  const caps = TEMPLATE_CAPS[template] ?? {
    address: false, url: false, price: false, tagline: false,
  };
  const showAddress = caps.address && venue.address !== null && random() > 0.35;
  const showUrl = caps.url && url !== null;

  const gold: ExtractedEvent = {
    title,
    venue: venue.name,
    address: showAddress ? venue.address : null,
    ...spec.gold,
    description: null, // free text — scored loosely, not against gold
    url: showUrl ? `https://${url}` : null,
    confidence: 'high',
  };
  // v3 optional fields carry a key only when the fact is decidable from the
  // image; absent keys are skipped by the scorer (pre-v3 gold stays valid).
  if (caps.price) gold.price = price;
  if (caps.tagline && tagline.category) gold.category = tagline.category;

  return {
    id: `syn-${String(index).padStart(3, '0')}-${template}`,
    template,
    gold,
    goldClassification: {
      category: template.startsWith('ig-') ? 'event_screenshot' : 'event_poster',
      is_event: true,
      confidence: 'high',
    },
    display: {
      title,
      venue: venue.name,
      address: showAddress ? venue.address : null,
      dateText: spec.dateText,
      timeText: spec.timeText,
      handle,
      url: showUrl ? url : null,
      priceText: caps.price ? price : null,
      tagline: tagline.text,
    },
  };
}

/** A non-event scrapbook case (menu photo) to exercise the classifier. */
export function makeNonEventCase(index: number): EventCase {
  return {
    id: `syn-${String(index).padStart(3, '0')}-menu`,
    template: 'menu',
    gold: {
      title: null, venue: null, address: null, start_date: null, end_date: null,
      start_time: null, end_time: null, description: null, url: null, confidence: 'low',
    },
    goldClassification: { category: 'other_scrapbook', is_event: false, confidence: 'high' },
    display: {
      title: 'Lunch Menu', venue: null, address: null, dateText: '', timeText: null,
      handle: null, url: null, priceText: null, tagline: '',
    },
  };
}
