// Koppelt een Somtoday-pagina aan een vastgelegd huiswerk-item.
//
// Dit is bewust een aparte, pure module: het is het zwakste punt van de
// in-page weergave (we kennen Somtoday's DOM niet en die verandert), dus het
// moet los te testen en los bij te stellen zijn.
//
// Strategie, van sterk naar zwak:
//   1. een id in de URL dat overeenkomt met een opgeslagen `id:<...>`-sleutel;
//   2. de volledige titel die letterlijk in de paginatekst staat;
//   3. een groot deel van de titelwoorden, plus het vak;
//   4. een groot deel van de omschrijving.
// Onder de drempel tonen we niets: een verkeerd item tonen is erger dan geen
// paneel tonen.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID_RE = /^\d{4,}$/;
const LONG_ID_RE = /^[A-Za-z0-9_-]{16,}$/;

/** Alle URL-segmenten en querywaarden die op een Somtoday-id lijken. */
export function idCandidatesFromUrl(url) {
  const out = [];
  try {
    const parsed = new URL(String(url || ''));
    for (const part of parsed.pathname.split('/')) {
      const clean = part.replace(/\.(html?|aspx|php)$/i, '');
      if (!clean) continue;
      if (UUID_RE.test(clean) || NUMERIC_ID_RE.test(clean) || LONG_ID_RE.test(clean)) out.push(clean);
    }
    for (const [, value] of parsed.searchParams) {
      if (NUMERIC_ID_RE.test(value) || UUID_RE.test(value)) out.push(value);
    }
  } catch {
    /* ongeldige url */
  }
  return out;
}

export function normalizeForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function wordHits(needle, haystack, minLength) {
  const words = needle.split(' ').filter((word) => word.length >= minLength);
  if (!words.length) return 0;
  const hits = words.filter((word) => haystack.includes(word)).length;
  return hits / words.length;
}

/**
 * Hoe zeker is het dat deze pagina over dit item gaat?
 * @returns {number} 0 = nee, 100+ = id-match, 60+ = titel staat er letterlijk
 */
export function scoreAssignment(assignment, page) {
  const fields = assignment?.fields || {};
  const idSet = new Set(idCandidatesFromUrl(page?.url));
  const text = normalizeForMatch(page?.text);
  if (!text) return 0;

  let score = 0;

  const key = String(assignment?.key || '');
  if (key.startsWith('id:') && idSet.has(key.slice(3))) score += 100;

  const titel = normalizeForMatch(fields.titel);
  const vak = normalizeForMatch(fields.vak);
  const omschrijving = normalizeForMatch(fields.omschrijving);

  if (titel.length >= 6) {
    if (text.includes(titel)) {
      score += 60 + Math.min(20, Math.floor(titel.length / 4));
    } else {
      const ratio = wordHits(titel, text, 4);
      if (ratio >= 0.75) score += 35 + Math.round(10 * ratio);
    }
  }

  if (vak && text.includes(vak)) score += 8;

  if (omschrijving.length >= 20) {
    const ratio = wordHits(omschrijving.split(' ').slice(0, 14).join(' '), text, 5);
    if (ratio >= 0.6) score += 12;
  }

  return score;
}

export const MATCH_THRESHOLD = 40;

/** Beste kandidaten voor deze pagina, hoogste score eerst. */
export function rankAssignments(assignments, page, limit = 5) {
  return (assignments || [])
    .map((assignment) => ({ assignment, score: scoreAssignment(assignment, page) }))
    .filter((candidate) => candidate.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
