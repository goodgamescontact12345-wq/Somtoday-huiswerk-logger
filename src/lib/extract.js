// Herkent huiswerk-items in een willekeurige Somtoday REST-payload.
//
// Waarom heuristiek: Somtoday heeft geen publieke, stabiele huiswerk-API. Elk
// schooljaar en elke instelling kan het antwoord er net anders uit laten zien en
// endpoints verschuiven. Daarom kijken we niet naar één vast endpoint, maar
// scoren we elk object in de payload op huiswerk-kenmerken (titel + deadline +
// vak-hint). Dat werkt ook als het endpoint in de toekomst verandert.
//
// De ruwe payload blijft altijd bewaard (`raw`), zodat de geschiedenis nooit
// informatie verliest die wij niet als veld kennen.

import { hashString, normalizeSpace, parseLooseDate } from './util.js';

const HINT_RE = /huiswerk|studiewijzer|opdracht|inlever|taak|toets|proefwerk|opgave|werkstuk/i;
const STRICT_DATE_RE = /deadline|inlever|uiterlijk|einddatum|eind_datum|sluitingsdatum|vervalt|due/i;
const LOOSE_DATE_RE = /^(datum|lesdatum|begindatum|startdatum|gepland|geplandop|datumtijd|afspraakdatum)$/i;
const CONTENT_RE = /^(titel|titeltekst|titel_tekst|omschrijving|inhoud|tekst|naam|beschrijving|opdracht|opmerking|notitie)$/i;
const VAK_RE = /^(vak|vaknaam|vak_naam|vakcode|vakgroep)$/i;
const ID_RE = /^(id|uuid|koppelid|koppel_id|identifier|sleutel|externalid)$/i;
const DOCENT_RE = /^(docent|docentnaam|docenten|leerkracht|leerkrachten|docentnamen)$/i;
const BIJLAGE_RE = /^(bijlagen|bijlage|materiaal|materialen|bestanden|attachments|documenten)$/i;
const TYPE_RE = /^(soort|type|opdrachtsoort|huiswerksoort|categorie)$/i;
const INLEVER_RE = /^(inleverbaar|inleveren|moetinleveren|verplicht|inleverplichtig)$/i;

const MAX_DEPTH = 12;
const MAX_NODES = 25000;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Zoekt in een object de eerste sleutel/waarde waarvan de sleutel aan `re` voldoet. */
function findByKeyRe(obj, re) {
  for (const key of Object.keys(obj)) {
    if (re.test(key)) {
      const value = obj[key];
      if (value === undefined) continue;
      return { key, value };
    }
  }
  return null;
}

function hasUsableDate(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length >= 3;
  if (typeof value === 'number') return parseLooseDate(value) !== null;
  if (typeof value !== 'string') return false;
  return parseLooseDate(value) !== null;
}

function stringOf(value) {
  if (typeof value === 'string') return normalizeSpace(value);
  if (typeof value === 'number') return String(value);
  if (isPlainObject(value)) {
    const inner = findByKeyRe(value, /^(naam|name|titel|omschrijving|label)$/i);
    if (inner && typeof inner.value === 'string') return normalizeSpace(inner.value);
  }
  if (Array.isArray(value)) {
    return normalizeSpace(
      value
        .map((item) => stringOf(item))
        .filter(Boolean)
        .join(', '),
    );
  }
  return '';
}

function countAttachments(value) {
  if (!value) return 0;
  if (Array.isArray(value)) return value.length;
  return 1;
}

/** Scoort hoe waarschijnlijk het is dat dit object een huiswerk-item is. */
export function scoreCandidate(obj, context) {
  const keyText = Object.keys(obj).join(' ').toLowerCase();
  const contextText = String(context || '').toLowerCase();

  let score = 0;
  let hasHint = false;
  let hasStrictDate = false;
  let hasLooseDate = false;

  if (HINT_RE.test(keyText) || HINT_RE.test(contextText)) {
    score += 2;
    hasHint = true;
  }

  const strictDate = findByKeyRe(obj, STRICT_DATE_RE);
  if (strictDate && hasUsableDate(strictDate.value)) {
    score += 2;
    hasStrictDate = true;
  } else {
    const looseDate = findByKeyRe(obj, LOOSE_DATE_RE);
    if (looseDate && hasUsableDate(looseDate.value)) {
      score += hasHint ? 1 : 0;
      hasLooseDate = true;
    }
  }

  const content = findByKeyRe(obj, CONTENT_RE);
  const hasContent = Boolean(content) && stringOf(content.value).length > 0;
  if (hasContent) score += 2;

  if (findByKeyRe(obj, VAK_RE)) score += 1;
  if (findByKeyRe(obj, BIJLAGE_RE)) score += 1;

  // Een les/afspraak heeft een begintijd en eindtijd maar geen deadline.
  const looksLikeLesson =
    Boolean(findByKeyRe(obj, /^(begintijd|eindtijd|starttijd)$/i)) && !hasStrictDate;
  if (looksLikeLesson) score -= 2;

  return {
    score,
    hasHint,
    hasStrictDate,
    hasLooseDate,
    hasContent,
    isHomework: score >= 4 && hasContent && (hasStrictDate || (hasLooseDate && hasHint)),
  };
}

function pickValue(obj, re) {
  const hit = findByKeyRe(obj, re);
  return hit ? hit.value : undefined;
}

function buildKey(obj, vak, titel, omschrijving) {
  const idHit = findByKeyRe(obj, ID_RE);
  if (idHit && idHit.value != null && idHit.value !== '') {
    const raw = stringOf(idHit.value);
    if (raw) return { key: `id:${raw}`, identity: 'id' };
  }
  // Geen id: gebruik de minst veranderlijke velden. Titel/omschrijving wijzigen
  // vaak, dus die nemen we alleen mee als er niets anders is.
  const basis = [vak, titel].filter(Boolean).join('|') || omschrijving.slice(0, 120);
  return { key: `sig:${hashString(basis.toLowerCase())}`, identity: 'signature' };
}

/** Zet een gevonden object om naar een canoniek record. */
export function normalizeCandidate(obj, path, endpointKey) {
  const vakValue = pickValue(obj, VAK_RE);
  const vak =
    typeof vakValue === 'string' ? normalizeSpace(vakValue) : stringOf(vakValue);
  const titel = stringOf(pickValue(obj, /^(titel|titeltekst|titel_tekst|naam|title)$/i));
  const omschrijving = stringOf(
    pickValue(obj, /^(omschrijving|inhoud|tekst|beschrijving|opdracht|opmerking|notitie)$/i),
  );

  const deadlineRaw =
    pickValue(obj, STRICT_DATE_RE) ?? pickValue(obj, LOOSE_DATE_RE) ?? null;
  const deadline = stringOf(deadlineRaw);
  const deadlineIso = parseLooseDate(deadlineRaw);

  const docent = stringOf(pickValue(obj, DOCENT_RE));
  const soort = stringOf(pickValue(obj, TYPE_RE));
  const inleverValue = pickValue(obj, INLEVER_RE);
  const inleveren =
    typeof inleverValue === 'boolean'
      ? inleverValue
      : /^(ja|true|1)$/i.test(stringOf(inleverValue));

  const { key, identity } = buildKey(obj, vak, titel, omschrijving);

  return {
    key,
    identity,
    endpointKey,
    path,
    fields: {
      titel,
      vak,
      omschrijving,
      deadline,
      deadlineIso: deadlineIso ?? null,
      docent,
      soort,
      inleveren,
      bijlagen: countAttachments(pickValue(obj, BIJLAGE_RE)),
    },
    raw: obj,
  };
}

/** Normaliseert een URL tot een stabiele endpoint-sleutel (zonder cache-busters). */
export function endpointKeyOf(url) {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()]
      .filter(([name]) => !/^(_|t|ts|timestamp|cachebust|nocache|rnd|random)$/i.test(name))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`);
    return `${u.pathname}${params.length ? `?${params.join('&')}` : ''}`;
  } catch {
    return String(url || '').split('?')[0];
  }
}

function contextString(path) {
  return path.filter((part) => typeof part === 'string').join('.');
}

/**
 * Loopt de payload door en levert alle huiswerk-items op.
 * @returns {{endpointKey: string, records: Array<object>}}
 */
export function extractFromPayload(body, url) {
  const endpointKey = endpointKeyOf(url);
  const urlContext = String(url || '');
  const records = [];
  const seen = new Set();

  const stack = [{ node: body, path: [], depth: 0 }];
  let visited = 0;

  while (stack.length && visited < MAX_NODES) {
    const { node, path, depth } = stack.pop();
    visited += 1;

    if (depth > MAX_DEPTH) continue;

    if (Array.isArray(node)) {
      // Achterstevoren pushen zodat de stack-pop de documentvolgorde aanhoudt.
      for (let i = node.length - 1; i >= 0; i--) {
        stack.push({ node: node[i], path: [...path, i], depth: depth + 1 });
      }
      continue;
    }

    if (!isPlainObject(node)) continue;

    const context = `${contextString(path)} ${urlContext}`;
    const verdict = scoreCandidate(node, context);
    if (verdict.isHomework) {
      const record = normalizeCandidate(node, contextString(path), endpointKey);
      if (!seen.has(record.key)) {
        seen.add(record.key);
        records.push(record);
      }
    }

    const entries = Object.entries(node);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, value] = entries[i];
      if (typeof value === 'object' && value !== null) {
        stack.push({ node: value, path: [...path, key], depth: depth + 1 });
      }
    }
  }

  return { endpointKey, records };
}
