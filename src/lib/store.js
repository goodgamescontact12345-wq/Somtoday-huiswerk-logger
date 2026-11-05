// IndexedDB-opslag. Bewust geen chrome.storage.local: de geschiedenis groeit
// (elke wijziging is een record) en moet volledig doorzoekbaar blijven.

import { startOfToday } from './util.js';

const DB_NAME = 'somtoday-huiswerk-logger';
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('assignments')) {
        db.createObjectStore('assignments', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        store.createIndex('byTime', 'at');
        store.createIndex('byKey', 'key');
      }
      if (!db.objectStoreNames.contains('captures')) {
        const store = db.createObjectStore('captures', { keyPath: 'id', autoIncrement: true });
        store.createIndex('byTime', 'at');
      }
      if (!db.objectStoreNames.contains('endpoints')) {
        db.createObjectStore('endpoints', { keyPath: 'endpointKey' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database is geblokkeerd door een ander tabblad.'));
  });
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transactie afgebroken.'));
  });
}

// ---------------------------------------------------------------- assignments

export async function getAssignment(key) {
  const db = await openDb();
  return requestToPromise(db.transaction('assignments').objectStore('assignments').get(key));
}

export async function allAssignments() {
  const db = await openDb();
  return requestToPromise(db.transaction('assignments').objectStore('assignments').getAll());
}

export async function putAssignment(assignment) {
  const db = await openDb();
  const tx = db.transaction('assignments', 'readwrite');
  tx.objectStore('assignments').put(assignment);
  await txDone(tx);
}

// --------------------------------------------------------------------- events

export async function putEvents(events) {
  if (!events.length) return [];
  const db = await openDb();
  const tx = db.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  const ids = events.map((event) => requestToPromise(store.add(event)));
  await txDone(tx);
  return Promise.all(ids);
}

/**
 * Nieuwste wijzigingen eerst.
 * @param {{limit?: number, since?: number, key?: string}} options
 */
export async function recentEvents(options = {}) {
  const limit = options.limit ?? 300;
  const since = options.since ?? 0;
  const db = await openDb();
  const index = db.transaction('events').objectStore('events').index('byTime');
  const out = [];

  await new Promise((resolve, reject) => {
    const request = index.openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || out.length >= limit) return resolve();
      const value = cursor.value;
      if (since && value.at < since) return resolve();
      if (options.key && value.key !== options.key) {
        cursor.continue();
        return;
      }
      out.push(value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });

  return out;
}

export async function eventsForKey(key, limit = 100) {
  const db = await openDb();
  const index = db.transaction('events').objectStore('events').index('byKey');
  const out = [];
  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(key), 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || out.length >= limit) return resolve();
      out.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  return out;
}

// ------------------------------------------------------------------- captures

export async function addCapture(capture) {
  const db = await openDb();
  const tx = db.transaction('captures', 'readwrite');
  const id = requestToPromise(tx.objectStore('captures').add(capture));
  await txDone(tx);
  return id;
}

export async function recentCaptures(limit = 100) {
  const db = await openDb();
  const index = db.transaction('captures').objectStore('captures').index('byTime');
  const out = [];
  await new Promise((resolve, reject) => {
    const request = index.openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || out.length >= limit) return resolve();
      out.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  return out;
}

export async function lastCaptureAt() {
  const [capture] = await recentCaptures(1);
  return capture?.at ?? 0;
}

// ------------------------------------------------------------------ endpoints

export async function getEndpointState(endpointKey) {
  const db = await openDb();
  return requestToPromise(db.transaction('endpoints').objectStore('endpoints').get(endpointKey));
}

export async function putEndpointState(state) {
  const db = await openDb();
  const tx = db.transaction('endpoints', 'readwrite');
  tx.objectStore('endpoints').put(state);
  await txDone(tx);
}

export async function allEndpointStates() {
  const db = await openDb();
  return requestToPromise(db.transaction('endpoints').objectStore('endpoints').getAll());
}

// ------------------------------------------------------------------ meta/stats

export async function counts() {
  const db = await openDb();
  const tx = db.transaction(['assignments', 'events', 'captures']);
  const assignments = requestToPromise(tx.objectStore('assignments').count());
  const events = requestToPromise(tx.objectStore('events').count());
  const captures = requestToPromise(tx.objectStore('captures').count());
  const today = requestToPromise(
    tx.objectStore('events').index('byTime').count(IDBKeyRange.lowerBound(startOfToday())),
  );
  const [a, e, c, t] = await Promise.all([assignments, events, captures, today]);
  return { assignments: a, events: e, captures: c, today: t };
}

// ------------------------------------------------------------------ onderhoud

export async function prune(options = {}) {
  const retentionDays = options.retentionDays ?? 180;
  const maxCaptures = options.maxCaptures ?? 400;
  const cutoff = Date.now() - retentionDays * 86400000;
  const db = await openDb();

  const tx = db.transaction(['events', 'captures', 'assignments'], 'readwrite');

  const eventIndex = tx.objectStore('events').index('byTime');
  eventIndex.openCursor(IDBKeyRange.upperBound(cutoff)).onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };

  const captureIndex = tx.objectStore('captures').index('byTime');
  let seen = 0;
  captureIndex.openCursor(null, 'prev').onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) return;
    seen += 1;
    if (seen > maxCaptures) cursor.delete();
    cursor.continue();
  };

  tx.objectStore('assignments').openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) return;
    if ((cursor.value.lastSeen || 0) < cutoff) cursor.delete();
    cursor.continue();
  };

  await txDone(tx);
}

export async function exportAll() {
  const db = await openDb();
  const tx = db.transaction(['assignments', 'events', 'captures', 'endpoints']);
  const [assignments, events, captures, endpoints] = await Promise.all([
    requestToPromise(tx.objectStore('assignments').getAll()),
    requestToPromise(tx.objectStore('events').getAll()),
    requestToPromise(tx.objectStore('captures').getAll()),
    requestToPromise(tx.objectStore('endpoints').getAll()),
  ]);
  return { exportedAt: Date.now(), assignments, events, captures, endpoints };
}

export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction(['assignments', 'events', 'captures', 'endpoints', 'meta'], 'readwrite');
  for (const name of ['assignments', 'events', 'captures', 'endpoints', 'meta']) {
    tx.objectStore(name).clear();
  }
  await txDone(tx);
}
