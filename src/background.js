// Achtergrondservice: hier wordt alles wat de pagina ophaalt genormaliseerd,
// vergeleken met de vorige stand en opgeslagen. Eén schrijver, dus geen race
// conditions tussen tabbladen.

import { extractFromPayload } from './lib/extract.js';
import { diffRaw } from './lib/diff.js';
import {
  TYPE_LABEL,
  deadlineText,
  fieldLabel,
  formatValue,
  notificationLine,
  recordTitle,
  recordVak,
  somtodayCreatedAt,
} from './lib/describe.js';
import { rankAssignments } from './lib/match.js';
import { formatDateTime, formatDayHeading, hashString } from './lib/util.js';
import * as store from './lib/store.js';

const SETTINGS_KEY = 'settings';
const LOCAL_KEY = 'local';
const ALARM = 'shl-poll';
const SOMTODAY_URL = /^https:\/\/[^/]+\.somtoday\.nl\//i;

const DEFAULT_SETTINGS = {
  notify: true,
  pollMinutes: 15,
  retentionDays: 180,
};

// -------------------------------------------------------------- instellingen

async function getSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored?.[SETTINGS_KEY] || {}) };
}

async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  await syncAlarm(next);
  return next;
}

async function getLocal() {
  const stored = await chrome.storage.local.get(LOCAL_KEY);
  return { unseen: 0, lastPageOpen: 0, ...(stored?.[LOCAL_KEY] || {}) };
}

async function setLocal(patch) {
  const next = { ...(await getLocal()), ...patch };
  await chrome.storage.local.set({ [LOCAL_KEY]: next });
  return next;
}

async function syncAlarm(settings) {
  await chrome.alarms.clear(ALARM);
  if (settings.pollMinutes > 0) {
    chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, settings.pollMinutes) });
  }
}

async function updateBadge(unseen) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#5865f2' });
    await chrome.action.setBadgeText({
      text: unseen > 0 ? (unseen > 99 ? '99+' : String(unseen)) : '',
    });
  } catch {
    /* badge is cosmetisch */
  }
}

// --------------------------------------------------------------- notificaties

let pendingNotify = [];
let notifyTimer = null;

function scheduleNotification(events) {
  pendingNotify.push(...events);
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    flushNotification().catch(() => {});
  }, 800);
}

async function flushNotification() {
  notifyTimer = null;
  const events = pendingNotify.splice(0);
  if (!events.length) return;

  const settings = await getSettings();
  if (!settings.notify) return;

  const lines = events.slice(0, 4).map(notificationLine);
  if (events.length > 4) lines.push(`…en ${events.length - 4} meer`);

  try {
    await chrome.notifications.create(`shl-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/128.png'),
      title: events.length === 1 ? 'Huiswerk gewijzigd' : `${events.length} huiswerkwijzigingen`,
      message: lines.join('\n'),
      contextMessage: 'Somtoday Huiswerk Logger',
      priority: 1,
    });
  } catch {
    /* geen notificatierechten: de geschiedenis is er nog steeds */
  }
}

chrome.notifications?.onClicked.addListener(() => {
  openHistory().catch(() => {});
});

async function openHistory() {
  const url = chrome.runtime.getURL('src/history.html');
  // Client-side filteren: de url-filter van tabs.query valt buiten onze
  // host_permissions voor chrome-extension://-pagina's.
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url === url);
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

// -------------------------------------------------------------------- ingest

function makeEvent({ type, fields, key, at, url, endpointKey, initial, changes, previousFields }) {
  return {
    at,
    type,
    key,
    endpointKey,
    url,
    initial: Boolean(initial),
    changes: changes || [],
    title: recordTitle({ fields }),
    vak: recordVak({ fields }),
    fields,
    previousFields: previousFields || null,
    deadlineIso: fields?.deadlineIso ?? null,
  };
}

async function ingest({ url, body, method, at }) {
  const receivedAt = Number(at) || Date.now();
  const { endpointKey, records } = extractFromPayload(body, url);
  if (!records.length) return { ok: true, records: 0, endpointKey };

  const previous = (await store.getEndpointState(endpointKey)) || {
    endpointKey,
    url,
    keys: [],
    maxKeys: 0,
    at: 0,
    captures: 0,
  };
  const isFirstCapture = !previous.at;
  const prevKeys = new Set(previous.keys || []);
  const nowKeys = new Set(records.map((record) => record.key));

  const events = [];
  let added = 0;
  let changed = 0;
  let removed = 0;

  for (const record of records) {
    const existing = await store.getAssignment(record.key);

    if (!existing) {
      added += 1;
      events.push(
        makeEvent({
          type: 'added',
          fields: record.fields,
          key: record.key,
          at: receivedAt,
          url,
          endpointKey,
          initial: isFirstCapture,
          changes: [],
        }),
      );
    } else {
      const changes = diffRaw(existing.raw, record.raw);
      if (changes.length) {
        changed += 1;
        events.push(
          makeEvent({
            type: 'changed',
            fields: record.fields,
            key: record.key,
            at: receivedAt,
            url,
            endpointKey,
            initial: false,
            changes,
            previousFields: existing.fields || null,
          }),
        );
      }
    }

    await store.putAssignment({
      key: record.key,
      endpointKey,
      path: record.path,
      identity: record.identity,
      fields: record.fields,
      raw: record.raw,
      firstSeen: existing?.firstSeen ?? receivedAt,
      lastSeen: receivedAt,
      goneAt: null,
    });
  }

  // "Verdwenen" alleen als deze ophaalactie compleet lijkt. Bij paginering is
  // een kleinere set immers geen verwijdering maar pagina 1 van 2.
  if (previous.maxKeys > 0 && nowKeys.size >= previous.maxKeys) {
    for (const key of prevKeys) {
      if (nowKeys.has(key)) continue;
      const existing = await store.getAssignment(key);
      if (!existing) continue;
      removed += 1;
      events.push(
        makeEvent({
          type: 'removed',
          fields: existing.fields,
          key,
          at: receivedAt,
          url,
          endpointKey,
          initial: false,
          changes: [],
        }),
      );
      await store.putAssignment({ ...existing, goneAt: receivedAt });
    }
  }

  if (events.length) await store.putEvents(events);

  await store.putEndpointState({
    endpointKey,
    url,
    method: method || 'GET',
    keys: [...nowKeys],
    maxKeys: Math.max(previous.maxKeys || 0, nowKeys.size),
    payloadHash: hashString(JSON.stringify(body)),
    captures: (previous.captures || 0) + 1,
    at: receivedAt,
  });

  await store.addCapture({
    at: receivedAt,
    url,
    endpointKey,
    records: records.length,
    added,
    changed,
    removed,
    first: isFirstCapture,
  });

  // Een geslaagde ophaalactie betekent dat de sessie weer werkt.
  const local = await getLocal();
  if (local.authStale) await setLocal({ authStale: false });

  // De allereerste keer dat we een endpoint zien is een inventarisatie, geen
  // wijziging: daar hoort geen melding bij.
  const notifyWorthy = events.filter((event) => !event.initial);
  if (notifyWorthy.length) {
    const unseen = (await getLocal()).unseen || 0;
    const total = unseen + notifyWorthy.length;
    await setLocal({ unseen: total });
    await updateBadge(total);
    scheduleNotification(notifyWorthy);
  }

  if (events.length) await notifyTabs();

  return { ok: true, records: records.length, added, changed, removed, endpointKey };
}

// ------------------------------------------------------------------- polling

async function requestCapture() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://*.somtoday.nl/*' });
  } catch {
    return 0;
  }
  let count = 0;
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'recapture' });
      count += 1;
    } catch {
      /* tab heeft nog geen content script */
    }
  }
  return count;
}

// --------------------------------------------------- in-page versieweergave

async function matchPage(message) {
  const assignments = await store.allAssignments();
  const ranked = rankAssignments(assignments, { url: message.url, text: message.text });
  return {
    candidates: ranked.map(({ assignment, score }) => ({
      key: assignment.key,
      score,
      title: recordTitle(assignment),
      vak: recordVak(assignment),
      firstSeen: assignment.firstSeen || 0,
      goneAt: assignment.goneAt || null,
    })),
  };
}

/** "woensdag 11 november" met hoofdletter, zoals Somtoday het zelf toont. */
function dayLabelOf(ms) {
  if (!ms) return '';
  const text = formatDayHeading(ms);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

async function itemHistory(key) {
  if (!key) return { found: false };
  const assignment = await store.getAssignment(key);
  if (!assignment) return { found: false };

  const events = await store.eventsForKey(key, 100);
  const created = somtodayCreatedAt(assignment.raw);
  // Alleen tonen als het niet na onze eigen eerste meting ligt: anders is het
  // een ander soort "created"-veld dan we denken.
  const usableCreated =
    created && created <= (assignment.firstSeen || Number.POSITIVE_INFINITY) ? created : null;

  const versions = events.map((event) => ({
    at: event.at,
    atLabel: formatDateTime(event.at),
    type: event.type,
    typeLabel: TYPE_LABEL[event.type] || event.type,
    note:
      event.type === 'added'
        ? 'Voor het eerst vastgelegd door de logger.'
        : event.type === 'removed'
          ? 'Daarna niet meer in Somtoday gevonden.'
          : '',
    // De stand van dat moment, zodat het paneel elke versie als een eigen
    // huiswerkblok kan tonen (datum + omschrijving), zoals Somtoday dat doet.
    dateLabel: dayLabelOf(event.fields?.deadlineIso),
    om: (event.fields?.omschrijving || '').trim(),
    changes: (event.changes || []).map((change) => ({
      label: fieldLabel(change.path),
      from: formatValue(change.path, change.from),
      to: formatValue(change.path, change.to),
    })),
  }));

  return {
    found: true,
    key,
    title: recordTitle(assignment),
    vak: recordVak(assignment),
    deadline: deadlineText(assignment) || '',
    dateLabel: dayLabelOf(assignment.fields?.deadlineIso),
    omschrijving: (assignment.fields?.omschrijving || '').trim(),
    firstSeen: assignment.firstSeen || 0,
    firstSeenLabel: formatDateTime(assignment.firstSeen),
    lastSeenLabel: formatDateTime(assignment.lastSeen),
    goneAt: assignment.goneAt || null,
    somtodayCreatedAt: usableCreated,
    somtodayCreatedAtLabel: usableCreated ? formatDateTime(usableCreated) : null,
    versions,
    changeCount: versions.filter((version) => version.type === 'changed').length,
  };
}

/** Laat open Somtoday-tabs weten dat er nieuwe data is, zodat panelen verversen. */
async function notifyTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.somtoday.nl/*' });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'data-updated' }).catch(() => {});
    }
  } catch {
    /* geen tabs bereikbaar */
  }
}

async function buildState() {
  const [settings, local, stats, captures] = await Promise.all([
    getSettings(),
    getLocal(),
    store.counts(),
    store.recentCaptures(1),
  ]);
  return {
    settings,
    unseen: local.unseen || 0,
    lastPageOpen: local.lastPageOpen || 0,
    authStale: Boolean(local.authStale),
    stats,
    lastCapture: captures[0] || null,
  };
}

// ------------------------------------------------------------------ berichten

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'payload': {
      const tabUrl = sender?.tab?.url || '';
      if (!SOMTODAY_URL.test(tabUrl)) return { error: 'genegeerd: geen Somtoday-tab' };
      if (!message.url || !message.body) return { error: 'lege payload' };
      return ingest(message);
    }
    case 'page-open':
      await setLocal({ lastPageOpen: Date.now() });
      return { ok: true };
    case 'replay-empty':
      return { ok: true };
    case 'replay-auth':
      await setLocal({ authStale: message.ok !== true });
      return { ok: true };
    case 'match-page': {
      const tabUrl = sender?.tab?.url || '';
      if (!SOMTODAY_URL.test(tabUrl)) return { candidates: [] };
      if (!message.text) return { candidates: [] };
      return matchPage({ url: message.url || tabUrl, text: String(message.text).slice(0, 20000) });
    }
    case 'item-history':
      return itemHistory(message.key);
    case 'open-history':
      await openHistory();
      return { ok: true };
    case 'getState':
      return buildState();
    case 'markSeen':
      await setLocal({ unseen: 0 });
      await updateBadge(0);
      return { ok: true };
    case 'recapture': {
      const tabs = await requestCapture();
      return { ok: true, tabs };
    }
    case 'settings:set':
      return { ok: true, settings: await saveSettings(message.patch || {}) };
    case 'clear':
      await store.clearAll();
      await setLocal({ unseen: 0 });
      await updateBadge(0);
      return { ok: true };
    case 'prune':
      await store.prune(await getSettings());
      return { ok: true };
    default:
      return { error: `onbekend bericht: ${message?.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => {
      try {
        sendResponse(result);
      } catch {
        /* poort al gesloten */
      }
    })
    .catch((error) => {
      console.error('[huiswerk-logger]', error);
      try {
        sendResponse({ error: String(error?.message || error) });
      } catch {
        /* poort al gesloten */
      }
    });
  return true;
});

// ------------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    const settings = await getSettings();
    await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
    await syncAlarm(settings);
  })().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    const settings = await getSettings();
    await syncAlarm(settings);
    await store.prune(settings);
  })().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  requestCapture().catch(() => {});
});
