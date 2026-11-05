// Presentatie-laag: hoe een wijziging aan de gebruiker wordt uitgelegd.
// Gedeeld door de service worker (notificaties) en de geschiedenispagina.

import { formatDateTime, formatDate, formatTime, parseLooseDate, truncate } from './util.js';

export const TYPE_LABEL = {
  added: 'Nieuw',
  changed: 'Gewijzigd',
  removed: 'Verdwenen',
};

export const TYPE_HINT = {
  added: 'Stond nog niet eerder in Somtoday.',
  changed: 'Een docent heeft dit item aangepast.',
  removed: 'Stond eerder wel in Somtoday, nu niet meer.',
};

// Volgorde is belangrijk: 'inleverbaar' is iets anders dan 'inleverdatum'.
const FULL_PATH_MAP = [
  [/(^|\.)vak/i, 'Vak'],
  [/docent|leerkracht/i, 'Docent'],
  [/bijlage|materiaal|bestand|attachment|document/i, 'Bijlage'],
  [/(^|\.)(inleverbaar|inleveren|verplicht|inleverplichtig)/i, 'Inleveren'],
  [/deadline|inlever|uiterlijk|einddatum|sluitingsdatum|(^|\.)due$/i, 'Deadline'],
  [/omschrijving|inhoud|beschrijving|notitie|opmerking|(^|\.)tekst$/i, 'Omschrijving'],
  [/titel/i, 'Titel'],
  [/lokaal|ruimte/i, 'Lokaal'],
  [/lesuur|periode|duur/i, 'Lesuur'],
  [/soort|categorie|(^|\.)type$/i, 'Soort'],
  [/datum|tijd|start|eind/i, 'Datum'],
];

/** Laatste betekenisvolle pad-segment, bijv. `bijlagen[2].naam` -> `naam`. */
function lastSegment(path) {
  const cleaned = String(path || '').replace(/\[\d+\]/g, '');
  const parts = cleaned.split('.');
  return parts[parts.length - 1] || cleaned || 'waarde';
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;

export function fieldLabel(path) {
  const full = String(path || '');
  for (const [re, label] of FULL_PATH_MAP) {
    if (re.test(full)) return label;
  }
  const segment = lastSegment(full);
  if (/^(naam|name|title)$/i.test(segment)) return 'Titel';
  return segment
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Maakt van een ruwe veldwaarde iets leesbaars. */
export function formatValue(path, value) {
  if (value == null || value === '') return '(leeg)';
  if (value === true) return 'ja';
  if (value === false) return 'nee';
  const text = String(value);
  if (ISO_DATE_RE.test(text)) {
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) return formatDateTime(ms);
  }
  const label = fieldLabel(path);
  if (label === 'Bijlage' && /^\d+$/.test(text)) {
    return `${text} ${Number(text) === 1 ? 'bijlage' : 'bijlagen'}`;
  }
  return truncate(text, 160);
}

export function changeSummary(change) {
  return `${fieldLabel(change.path)}: ${formatValue(change.path, change.from)} → ${formatValue(
    change.path,
    change.to,
  )}`;
}

export function recordTitle(record) {
  const fields = record?.fields || record || {};
  return fields.titel || fields.omschrijving?.slice(0, 80) || 'Huiswerk zonder titel';
}

export function recordVak(record) {
  const fields = record?.fields || record || {};
  return fields.vak || '';
}

export function deadlineText(record) {
  const fields = record?.fields || record || {};
  const ms = fields.deadlineIso;
  if (ms) return `deadline ${formatDate(ms)} ${formatTime(ms)}`;
  if (fields.deadline) return `deadline ${truncate(fields.deadline, 24)}`;
  return '';
}

// Somtoday stuurt soms zelf een aanmaakdatum mee. Dat is de enige bron die
// dichter bij "wanneer heeft de docent dit neergezet" komt dan onze eigen
// eerste meting, dus die tonen we erbij als hij bestaat.
const CREATED_KEY_RE =
  /^(aangemaaktop|aangemaakt|aangemaakt_op|createdat|createdon|created|geplaatstop|geplaatst|toegevoegdop|toegevoegd|publicatiedatum|datumgeplaatst|gepubliceerdop)$/i;

export function somtodayCreatedAt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  for (const [key, value] of Object.entries(raw)) {
    if (!CREATED_KEY_RE.test(key)) continue;
    const ms = parseLooseDate(value);
    if (ms) return ms;
  }
  return null;
}

/** Eén regel voor in een notificatie. */
export function notificationLine(event) {
  const title = recordTitle(event);
  const vak = recordVak(event);
  const prefix = vak ? `${vak} · ` : '';
  if (event.type === 'added') return `${prefix}${title} (nieuw)`;
  if (event.type === 'removed') return `${prefix}${title} (verdwenen)`;
  const first = event.changes?.[0];
  const extra = (event.changes?.length || 0) - 1;
  const detail = first ? changeSummary(first) : 'aangepast';
  return `${prefix}${title} — ${detail}${extra > 0 ? ` (+${extra})` : ''}`;
}
