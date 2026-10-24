'use strict';
// Calendar files (.ics) -> events, and the events that fall in a window.
// Handles what school and work calendars actually contain: folded lines,
// all-day and timed events, floating / UTC / TZID times, DURATION, and the
// common repeat rules (DAILY, WEEKLY with BYDAY, MONTHLY, YEARLY, with
// INTERVAL, COUNT, UNTIL and EXDATE). Not a full RFC 5545 engine.

const DAY = 86400000;

/** Windows time-zone names Outlook writes -> IANA names. */
const WIN_TZ = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'UTC': 'UTC',
  'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo', 'AUS Eastern Standard Time': 'Australia/Sydney',
};

function unfold(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescapeText(s) {
  return String(s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** "DTSTART;TZID=X;VALUE=DATE:2026..." -> { name, params, value } */
function splitLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const [name, ...rest] = head.split(';');
  const params = {};
  for (const p of rest) { const eq = p.indexOf('='); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, ''); }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function tzOffsetMs(utcMs, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let off = tzOffsetMs(guess, tz);
  let utc = guess - off;
  off = tzOffsetMs(utc, tz);
  utc = guess - off;
  return utc;
}

/** @returns {{ms:number, allDay:boolean}|null} */
function parseDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] == null) return { ms: new Date(y, mo - 1, d).getTime(), allDay: true };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] || 0)];
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  const tzName = params && params.TZID ? (WIN_TZ[params.TZID] || params.TZID) : null;
  if (tzName) { try { return { ms: zonedToUtc(y, mo, d, h, mi, s, tzName), allDay: false }; } catch (_) { /* unknown zone: treat as local */ } }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
  if (!m) return 0;
  const ms = ((Number(m[2] || 0) * 7 + Number(m[3] || 0)) * 24 * 3600 + Number(m[4] || 0) * 3600 + Number(m[5] || 0) * 60 + Number(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

/**
 * @typedef {Object} CalEvent
 * @property {string} summary
 * @property {number} start  epoch ms
 * @property {number} end    epoch ms
 * @property {boolean} allDay
 * @property {string} location
 * @property {string} description
 * @property {Object|null} rrule
 * @property {number[]} exdates
 */

/** @param {string} text @returns {CalEvent[]} */
function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT/i.test(line)) { cur = { summary: '', start: null, end: null, allDay: false, location: '', description: '', rrule: null, exdates: [], duration: 0 }; continue; }
    if (/^END:VEVENT/i.test(line)) {
      if (cur && cur.start != null) {
        if (cur.end == null) cur.end = cur.start + (cur.duration || (cur.allDay ? DAY : 0));
        delete cur.duration;
        events.push(cur);
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const p = splitLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'SUMMARY': cur.summary = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'DESCRIPTION': cur.description = unescapeText(p.value).slice(0, 600); break;
      case 'DTSTART': { const d = parseDate(p.value, p.params); if (d) { cur.start = d.ms; cur.allDay = d.allDay; } break; }
      case 'DTEND': { const d = parseDate(p.value, p.params); if (d) cur.end = d.ms; break; }
      case 'DURATION': cur.duration = parseDuration(p.value); break;
      case 'EXDATE': for (const v of p.value.split(',')) { const d = parseDate(v, p.params); if (d) cur.exdates.push(d.ms); } break;
      case 'RRULE': {
        const r = {};
        for (const part of p.value.split(';')) { const [k, v] = part.split('='); if (k) r[k.toUpperCase()] = v; }
        cur.rrule = r;
        break;
      }
      default: break;
    }
  }
  return events;
}

const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Occurrences of one event that start inside [from, to). */
function occurrences(ev, from, to, limit = 60) {
  const length = Math.max(0, ev.end - ev.start);
  const out = [];
  const push = (startMs) => {
    if (ev.exdates.includes(startMs)) return;
    if (startMs + length > from && startMs < to) out.push({ ...ev, start: startMs, end: startMs + length, rrule: null });
  };
  if (!ev.rrule || !ev.rrule.FREQ) { push(ev.start); return out; }
  const r = ev.rrule;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? (parseDate(r.UNTIL, {}) || {}).ms : Infinity;
  const first = new Date(ev.start);
  let n = 0;
  const days = r.BYDAY ? r.BYDAY.split(',').map((d) => BYDAY[d.slice(-2)]).filter((d) => d != null) : null;
  const at = (date) => date.getTime();
  const guard = 5000;
  if (r.FREQ === 'DAILY') {
    for (let i = 0; i < guard && n < count; i += 1) {
      const d = new Date(first); d.setDate(first.getDate() + i * interval);
      if (at(d) > until || at(d) >= to) break;
      n += 1; push(at(d));
    }
  } else if (r.FREQ === 'WEEKLY') {
    const wanted = days && days.length ? days : [first.getDay()];
    const weekStart = new Date(first); weekStart.setDate(first.getDate() - first.getDay());
    for (let w = 0; w < guard && n < count; w += 1) {
      const base = new Date(weekStart); base.setDate(weekStart.getDate() + w * 7 * interval);
      let past = false;
      for (const wd of [...wanted].sort((a, b) => a - b)) {
        const d = new Date(base); d.setDate(base.getDate() + wd);
        d.setHours(first.getHours(), first.getMinutes(), first.getSeconds(), 0);
        if (at(d) < ev.start) continue;
        if (at(d) > until || at(d) >= to) { past = true; break; }
        if (n >= count) { past = true; break; }
        n += 1; push(at(d));
      }
      if (past) break;
    }
  } else if (r.FREQ === 'MONTHLY') {
    for (let i = 0; i < guard && n < count; i += 1) {
      const d = new Date(first); d.setMonth(first.getMonth() + i * interval);
      if (d.getDate() !== first.getDate()) continue;   // 31st in a 30-day month: skipped, as the spec says
      if (at(d) > until || at(d) >= to) break;
      n += 1; push(at(d));
    }
  } else if (r.FREQ === 'YEARLY') {
    for (let i = 0; i < 200 && n < count; i += 1) {
      const d = new Date(first); d.setFullYear(first.getFullYear() + i * interval);
      if (at(d) > until || at(d) >= to) break;
      n += 1; push(at(d));
    }
  } else push(ev.start);
  return out.slice(0, limit);
}

/** Events starting in the next `days` days, soonest first. */
function upcoming(events, now = Date.now(), days = 14, max = 20) {
  const from = now - 3 * 3600 * 1000;   // an event that started a moment ago is still "now"
  const to = now + days * DAY;
  const all = [];
  for (const ev of events) all.push(...occurrences(ev, from, to));
  return all.sort((a, b) => a.start - b.start).slice(0, max);
}

const pad = (n) => String(n).padStart(2, '0');
function formatEvent(ev) {
  const d = new Date(ev.start);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = ev.allDay ? 'all day' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${day}, ${time}: ${ev.summary || '(untitled)'}${ev.location ? ` @ ${ev.location}` : ''}`;
}

module.exports = { parseIcs, occurrences, upcoming, formatEvent, parseDate };
