// Kleine, dependency-vrije helpers die in de service worker én in de
// extensiepagina's (popup, geschiedenis) gebruikt worden.

/** Stabiele korte hash (cyrb53). Deterministisch, dus bruikbaar als sleutel. */
export function hashString(str) {
  const s = String(str);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function normalizeSpace(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(value, max = 240) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ONLY = /^\d{1,2}:\d{2}(:\d{2})?$/;

/**
 * Somtoday levert datums in verschillende vormen aan (ISO-string, `yyyy-mm-dd`,
 * epoch in ms/seconden, of een array [y, m, d, h, m]). We willen ze alleen
 * gebruiken voor sortering en weergave, nooit als bewijs van de wijziging zelf:
 * de ruwe payload blijft altijd leidend in de diff.
 */
export function parseLooseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  if (Array.isArray(value)) {
    const [y, mo = 1, d = 1, h = 0, mi = 0, s = 0] = value;
    if (typeof y !== 'number') return null;
    const date = new Date(y, mo - 1, d, h, mi, s);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (DATE_ONLY.test(text)) {
    const [, y, mo, d] = text.match(DATE_ONLY);
    return new Date(Number(y), Number(mo) - 1, Number(d), 23, 59).getTime();
  }
  if (TIME_ONLY.test(text)) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

const dateTimeFormatter = new Intl.DateTimeFormat('nl-NL', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const dateFormatter = new Intl.DateTimeFormat('nl-NL', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat('nl-NL', {
  hour: '2-digit',
  minute: '2-digit',
});

const dayHeadingFormatter = new Intl.DateTimeFormat('nl-NL', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

export function formatDateTime(ms) {
  if (!ms) return '—';
  return dateTimeFormatter.format(new Date(ms)).replace(',', '');
}

export function formatDate(ms) {
  if (!ms) return '—';
  return dateFormatter.format(new Date(ms));
}

export function formatTime(ms) {
  if (!ms) return '—';
  return timeFormatter.format(new Date(ms));
}

export function formatDayHeading(ms) {
  return dayHeadingFormatter.format(new Date(ms));
}

export function startOfToday(now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
