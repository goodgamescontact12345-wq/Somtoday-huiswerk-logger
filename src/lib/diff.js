// Field-level diff tussen twee ruwe Somtoday-objecten.
//
// We diffen de *ruwe* payload en niet alleen onze canonieke velden: Somtoday
// verandert soms dingen die wij niet kennen (een bijlage erbij, een aangepaste
// omschrijving, een docent die wisselt). Door de ruwe payload te vergelijken
// mist de logger niets, ook niet als het formaat verschuift.

import { truncate } from './util.js';

// Velden die Somtoday zelf bij elk antwoord bijwerkt of die alleen verwijzingen
// bevatten. Zonder negeren zou elke pagina-load een "wijziging" opleveren.
const IGNORED_KEYS = [
  /^_?links$/i,
  /^href$/i,
  /^self$/i,
  /^id$/i,
  /^uuid$/i,
  /^koppel_?id$/i,
  /^laatst_?gewijzigd(op)?$/i,
  /^gewijzigd_?op$/i,
  /^updated(_?at|_?on)?$/i,
  /^created(_?at|_?on)?$/i,
  /^aangemaakt_?op$/i,
  /^versie$/i,
  /^version$/i,
  /^etag$/i,
  /^_meta$/i,
  /^meta$/i,
  /^sort(ing)?$/i,
  /^totaal_?aantal$/i,
  /^total_?count$/i,
];

function isIgnored(key) {
  return IGNORED_KEYS.some((re) => re.test(key));
}

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}

function summarize(value) {
  const kind = kindOf(value);
  if (kind === 'null' || kind === 'undefined') return '';
  if (typeof value === 'string') return truncate(value, 800);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return truncate(JSON.stringify(value), 800);
  } catch {
    return String(value);
  }
}

function looseEqual(a, b) {
  return summarize(a) === summarize(b);
}

function isPrimitiveArray(value) {
  return Array.isArray(value) && value.every((item) => kindOf(item) !== 'object' && kindOf(item) !== 'array');
}

function walk(prev, next, path, out, opts, depth) {
  if (out.length >= opts.max) return;
  if (depth > opts.maxDepth) return;

  const ka = kindOf(prev);
  const kb = kindOf(next);

  if (ka !== kb) {
    if (!(ka === 'undefined' && kb === 'null')) {
      out.push({ path: path || '(object)', from: summarize(prev), to: summarize(next) });
    }
    return;
  }

  if (ka === 'array') {
    const pa = prev || [];
    const pb = next || [];
    if (isPrimitiveArray(pa) && isPrimitiveArray(pb)) {
      if (!looseEqual(pa, pb)) {
        out.push({ path: path || '(lijst)', from: summarize(pa), to: summarize(pb) });
      }
      return;
    }
    const length = Math.max(pa.length, pb.length);
    for (let i = 0; i < length && out.length < opts.max; i++) {
      walk(pa[i], pb[i], `${path}[${i}]`, out, opts, depth + 1);
    }
    return;
  }

  if (ka === 'object') {
    const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
    for (const key of keys) {
      if (out.length >= opts.max) return;
      if (isIgnored(key)) continue;
      const childPath = path ? `${path}.${key}` : key;
      const before = prev ? prev[key] : undefined;
      const after = next ? next[key] : undefined;
      if (kindOf(before) === 'undefined' && kindOf(after) === 'undefined') continue;
      if (
        (kindOf(before) === 'object' || kindOf(before) === 'array') ||
        (kindOf(after) === 'object' || kindOf(after) === 'array')
      ) {
        walk(before, after, childPath, out, opts, depth + 1);
        continue;
      }
      if (!looseEqual(before, after)) {
        out.push({ path: childPath, from: summarize(before), to: summarize(after) });
      }
    }
    return;
  }

  if (!looseEqual(prev, next)) {
    out.push({ path: path || '(waarde)', from: summarize(prev), to: summarize(next) });
  }
}

/**
 * @returns {Array<{path: string, from: string, to: string}>} leeg = niets gewijzigd
 */
export function diffRaw(prev, next, options = {}) {
  const out = [];
  walk(prev, next, '', out, { max: options.max ?? 40, maxDepth: options.maxDepth ?? 8 }, 0);
  return out;
}
