// HTML poster templates. Each takes an EventCase and returns a full HTML
// document sized for a phone-screenshot-like capture. Deliberately varied
// typography/layout so extraction is tested across visual styles;
// 'hard-mode' is intentionally low-contrast with rotated text.
import type { EventCase } from './data.js';

const esc = (s: string | null): string =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page(body: string, css: string, width = 800, height = 1000): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${width}px; height: ${height}px; overflow: hidden; }
  ${css}</style></head><body>${body}</body></html>`;
}

type Template = (c: EventCase) => string;

const gallery: Template = (c) => page(
  `<div class="poster">
    <p class="kicker">${esc(c.display.venue)}</p>
    <h1>${esc(c.display.title)}</h1>
    <p class="tagline">${esc(c.display.tagline)}</p>
    <p class="dates">${esc(c.display.dateText)}${c.display.timeText ? ` · ${esc(c.display.timeText)}` : ''}</p>
    ${c.display.address ? `<p class="addr">${esc(c.display.address)}</p>` : ''}
    ${c.display.url ? `<p class="url">${esc(c.display.url)}</p>` : ''}
  </div>`,
  `.poster { height: 100%; background: #f4f1ea; padding: 80px 60px; font-family: Georgia, serif; color: #1d1d1b; display: flex; flex-direction: column; justify-content: space-between; }
   .kicker { text-transform: uppercase; letter-spacing: 4px; font-size: 20px; }
   h1 { font-size: 72px; line-height: 1.05; font-weight: normal; font-style: italic; }
   .tagline { font-size: 26px; color: #555; }
   .dates { font-size: 34px; border-top: 2px solid #1d1d1b; padding-top: 24px; }
   .addr, .url { font-size: 22px; color: #444; }`,
);

const gig: Template = (c) => page(
  `<div class="poster">
    <h1>${esc(c.display.title)}</h1>
    <div class="block">
      <p class="date">${esc(c.display.dateText)}</p>
      ${c.display.timeText ? `<p class="time">${esc(c.display.timeText)}</p>` : ''}
    </div>
    <p class="venue">${esc(c.display.venue)}</p>
    ${c.display.address ? `<p class="addr">${esc(c.display.address)}</p>` : ''}
    <p class="tag">${esc(c.display.tagline)}</p>
    ${c.display.url ? `<p class="url">TICKETS: ${esc(c.display.url)}</p>` : ''}
  </div>`,
  `.poster { height: 100%; background: #111; color: #fdf351; padding: 70px 50px; font-family: 'Arial Black', sans-serif; text-transform: uppercase; }
   h1 { font-size: 84px; line-height: 0.95; margin-bottom: 60px; }
   .block { border: 6px solid #fdf351; display: inline-block; padding: 20px 30px; margin-bottom: 50px; }
   .date { font-size: 40px; } .time { font-size: 30px; }
   .venue { font-size: 44px; color: #fff; }
   .addr { font-size: 22px; color: #aaa; margin-top: 10px; }
   .tag { font-size: 20px; color: #888; margin-top: 40px; }
   .url { font-size: 24px; color: #fdf351; margin-top: 30px; }`,
);

const clubNight: Template = (c) => page(
  `<div class="poster">
    <p class="date">${esc(c.display.dateText)}</p>
    <h1>${esc(c.display.title)}</h1>
    ${c.display.timeText ? `<p class="time">${esc(c.display.timeText)}</p>` : ''}
    <p class="venue">@ ${esc(c.display.venue)}</p>
    ${c.display.handle ? `<p class="handle">${esc(c.display.handle)}</p>` : ''}
  </div>`,
  `.poster { height: 100%; background: radial-gradient(circle at 30% 20%, #ff2d78, #2b0a3d 70%); color: #fff; padding: 60px; font-family: Verdana, sans-serif; text-align: center; display: flex; flex-direction: column; justify-content: center; gap: 40px; }
   .date { font-size: 34px; letter-spacing: 6px; }
   h1 { font-size: 78px; line-height: 1; text-shadow: 4px 4px 0 #000; }
   .time { font-size: 30px; } .venue { font-size: 36px; font-weight: bold; }
   .handle { font-size: 24px; opacity: 0.8; }`,
);

const igPost: Template = (c) => page(
  `<div class="chrome">
    <div class="bar"><span class="avatar"></span><b>${esc((c.display.handle ?? '@venue.events').replace('@', ''))}</b></div>
    <div class="img">
      <h1>${esc(c.display.title)}</h1>
      <p class="date">${esc(c.display.dateText)}</p>
      ${c.display.timeText ? `<p class="time">${esc(c.display.timeText)}</p>` : ''}
      <p class="venue">${esc(c.display.venue)}</p>
    </div>
    <div class="caption"><b>${esc((c.display.handle ?? '@venue.events').replace('@', ''))}</b>
      ${esc(c.display.tagline)}. ${esc(c.display.dateText)} at ${esc(c.display.venue)}.
      ${c.display.address ? esc(c.display.address) + '.' : ''}
      ${c.display.url ? `Tickets: ${esc(c.display.url)}` : 'Link in bio.'}</div>
  </div>`,
  `.chrome { height: 100%; background: #fff; font-family: -apple-system, Helvetica, sans-serif; }
   .bar { display: flex; align-items: center; gap: 12px; padding: 16px; font-size: 22px; border-bottom: 1px solid #eee; }
   .avatar { width: 44px; height: 44px; border-radius: 50%; background: linear-gradient(45deg, #f09433, #dc2743, #bc1888); display: inline-block; }
   .img { height: 620px; background: #23403a; color: #ffe8c9; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 26px; text-align: center; padding: 40px; }
   .img h1 { font-size: 60px; font-family: Georgia, serif; }
   .date { font-size: 32px; } .time { font-size: 26px; } .venue { font-size: 30px; text-transform: uppercase; letter-spacing: 3px; }
   .caption { padding: 20px; font-size: 22px; line-height: 1.5; color: #222; }`,
);

const igStory: Template = (c) => page(
  `<div class="story">
    <p class="handle">${esc(c.display.handle ?? '@venue.events')}</p>
    <div class="mid">
      <h1>${esc(c.display.title)}</h1>
      <p class="date">${esc(c.display.dateText)}</p>
      ${c.display.timeText ? `<p class="time">${esc(c.display.timeText)}</p>` : ''}
    </div>
    <p class="venue">${esc(c.display.venue)}${c.display.address ? ` · ${esc(c.display.address)}` : ''}</p>
  </div>`,
  `.story { height: 100%; background: linear-gradient(180deg, #0f2027, #2c5364); color: #fff; padding: 70px 40px; font-family: Helvetica, sans-serif; display: flex; flex-direction: column; justify-content: space-between; text-align: center; }
   .handle { font-size: 26px; opacity: 0.85; }
   h1 { font-size: 64px; margin-bottom: 30px; }
   .date { font-size: 38px; font-weight: bold; } .time { font-size: 28px; margin-top: 12px; }
   .venue { font-size: 24px; }`,
  600, 1060,
);

const market: Template = (c) => page(
  `<div class="poster">
    <h1>${esc(c.display.title)}</h1>
    <p class="tag">${esc(c.display.tagline)}</p>
    <div class="grid">
      <div><p class="label">When</p><p>${esc(c.display.dateText)}${c.display.timeText ? `<br>${esc(c.display.timeText)}` : ''}</p></div>
      <div><p class="label">Where</p><p>${esc(c.display.venue)}${c.display.address ? `<br>${esc(c.display.address)}` : ''}</p></div>
    </div>
    ${c.display.url ? `<p class="url">${esc(c.display.url)}</p>` : ''}
  </div>`,
  `.poster { height: 100%; background: #e8f0e3; color: #23403a; padding: 70px; font-family: 'Trebuchet MS', sans-serif; }
   h1 { font-size: 68px; margin-bottom: 16px; }
   .tag { font-size: 26px; margin-bottom: 60px; color: #4a6b52; }
   .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; font-size: 28px; line-height: 1.5; }
   .label { text-transform: uppercase; font-size: 18px; letter-spacing: 3px; color: #86a08a; margin-bottom: 10px; }
   .url { margin-top: 70px; font-size: 24px; }`,
);

const talk: Template = (c) => page(
  `<div class="poster">
    <p class="kicker">Talk & Q&A</p>
    <h1>${esc(c.display.title)}</h1>
    <p class="meta">${esc(c.display.dateText)}${c.display.timeText ? `, ${esc(c.display.timeText)}` : ''}</p>
    <p class="meta">${esc(c.display.venue)}${c.display.address ? `, ${esc(c.display.address)}` : ''}</p>
    <p class="tag">${esc(c.display.tagline)}</p>
    ${c.display.url ? `<p class="url">Register: ${esc(c.display.url)}</p>` : ''}
  </div>`,
  `.poster { height: 100%; background: #fff; color: #14213d; padding: 90px 70px; font-family: 'Times New Roman', serif; border: 24px solid #fca311; }
   .kicker { font-size: 22px; text-transform: uppercase; letter-spacing: 5px; margin-bottom: 30px; }
   h1 { font-size: 66px; line-height: 1.1; margin-bottom: 50px; }
   .meta { font-size: 30px; margin-bottom: 14px; }
   .tag { font-size: 24px; color: #666; margin-top: 40px; }
   .url { font-size: 24px; margin-top: 50px; }`,
);

const hardMode: Template = (c) => page(
  `<div class="poster">
    <h1>${esc(c.display.title)}</h1>
    <p class="date">${esc(c.display.dateText)}${c.display.timeText ? ` / ${esc(c.display.timeText)}` : ''}</p>
    <p class="venue">${esc(c.display.venue)}</p>
    ${c.display.handle ? `<p class="handle">${esc(c.display.handle)}</p>` : ''}
  </div>`,
  `.poster { height: 100%; background: #d9d4c5; color: #c3bda9; padding: 80px; font-family: Courier, monospace; }
   h1 { font-size: 58px; transform: rotate(-7deg); margin: 90px 0 70px; color: #b5ae96; }
   .date { font-size: 30px; transform: rotate(2deg); }
   .venue { font-size: 26px; margin-top: 60px; transform: rotate(-2deg); }
   .handle { font-size: 20px; margin-top: 90px; }`,
);

const menu: Template = () => page(
  `<div class="menu">
    <h1>Lunch Menu</h1>
    <div class="sec"><h2>Small plates</h2>
      <p>Burrata, blood orange, basil <span>9</span></p>
      <p>Crispy artichokes, aioli <span>8</span></p>
      <p>Sourdough & cultured butter <span>5</span></p></div>
    <div class="sec"><h2>Mains</h2>
      <p>Roast hake, brown shrimp butter <span>19</span></p>
      <p>Mushroom & ale pie, mash <span>16</span></p></div>
    <div class="sec"><h2>Pudding</h2>
      <p>Burnt basque cheesecake <span>8</span></p></div>
  </div>`,
  `.menu { height: 100%; background: #fbf7ef; color: #2a2a28; padding: 80px 90px; font-family: Georgia, serif; }
   h1 { font-size: 52px; text-align: center; margin-bottom: 60px; font-style: italic; }
   h2 { font-size: 26px; text-transform: uppercase; letter-spacing: 4px; margin: 40px 0 20px; }
   p { font-size: 26px; display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dotted #ccc; }`,
);

export const TEMPLATES: Record<string, Template> = {
  gallery, gig, 'club-night': clubNight, 'ig-post': igPost, 'ig-story': igStory,
  market, talk, 'hard-mode': hardMode, menu,
};
