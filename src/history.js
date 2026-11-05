import * as store from './lib/store.js';
import {
  TYPE_HINT,
  TYPE_LABEL,
  changeSummary,
  deadlineText,
  fieldLabel,
  formatValue,
} from './lib/describe.js';
import {
  escapeHtml as esc,
  formatDate,
  formatDateTime,
  formatDayHeading,
  formatTime,
  truncate,
} from './lib/util.js';

const el = (id) => document.getElementById(id);

const state = {
  events: [],
  selectedId: null,
  view: 'events',
  filter: { q: '', type: 'all', days: 0, initial: false },
};

function send(message) {
  return chrome.runtime.sendMessage(message).catch(() => null);
}

// ------------------------------------------------------------------ filtering

function matches(event) {
  const { q, type, days, initial } = state.filter;
  if (!initial && event.initial) return false;
  if (type !== 'all' && event.type !== type) return false;
  if (days === 1 && event.at < new Date().setHours(0, 0, 0, 0)) return false;
  if (days > 1 && event.at < Date.now() - days * 86400000) return false;
  if (q) {
    const haystack = [
      event.title,
      event.vak,
      event.fields?.omschrijving,
      event.fields?.docent,
      ...(event.changes || []).map((change) => `${change.path} ${change.from} ${change.to}`),
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(q.toLowerCase())) return false;
  }
  return true;
}

// ------------------------------------------------------------------- overzicht

function eventItem(event) {
  const active = event.id === state.selectedId ? ' is-active' : '';
  const changes = (event.changes || [])
    .slice(0, 2)
    .map((change) => `<div class="event-change">${esc(changeSummary(change))}</div>`)
    .join('');
  const rest = (event.changes?.length || 0) - 2;
  const more = rest > 0 ? `<div class="event-change muted">+${rest} meer</div>` : '';
  const deadline = deadlineText(event);

  return `<li class="event${active}" data-id="${event.id}" tabindex="0">
    <div class="event-top">
      <span class="badge badge-${esc(event.type)}">${esc(TYPE_LABEL[event.type] || event.type)}</span>
      <span class="event-time">${esc(formatTime(event.at))}</span>
    </div>
    <div class="event-title">${esc(event.title)}</div>
    <div class="event-meta">${esc(event.vak || 'onbekend vak')}${
      deadline ? ` · ${esc(deadline)}` : ''
    }</div>
    ${changes}${more}
  </li>`;
}

function renderList() {
  const events = state.events.filter(matches);
  const list = el('event-list');
  el('filter-count').textContent = `${events.length} van ${state.events.length}`;

  if (!state.events.length) {
    list.innerHTML = `<li class="empty-state">
      <strong>Nog niets vastgelegd.</strong>
      <p>Open Somtoday in een tab. Zodra de app je huiswerk laadt, verschijnt hier de eerste vastlegging en daarna elke wijziging.</p>
    </li>`;
    return;
  }

  if (!events.length) {
    list.innerHTML = `<li class="empty-state"><strong>Geen resultaten.</strong><p>Pas je filters aan of zet “Toon eerste vastlegging” aan.</p></li>`;
    return;
  }

  const html = [];
  let day = '';
  for (const event of events) {
    const heading = formatDayHeading(event.at);
    if (heading !== day) {
      day = heading;
      html.push(`<li class="day-heading">${esc(heading)}</li>`);
    }
    html.push(eventItem(event));
  }
  list.innerHTML = html.join('');
}

// --------------------------------------------------------------------- detail

function changesTable(event) {
  if (!event.changes?.length) {
    return `<p class="muted">${esc(TYPE_HINT[event.type] || '')}</p>`;
  }
  const rows = event.changes
    .map(
      (change) => `<tr>
        <th scope="row">${esc(fieldLabel(change.path))}</th>
        <td class="before">${change.from === '' ? '<em>(leeg)</em>' : esc(formatValue(change.path, change.from))}</td>
        <td class="after">${change.to === '' ? '<em>(leeg)</em>' : esc(formatValue(change.path, change.to))}</td>
      </tr>`,
    )
    .join('');
  return `<table class="diff">
    <thead><tr><th>Veld</th><th>Was</th><th>Werd</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function evidenceText(event, timeline, assignment) {
  const lines = [
    'Somtoday Huiswerk Logger — vastlegging',
    '',
    `Vak: ${event.vak || 'onbekend'}`,
    `Item: ${event.title}`,
    deadlineText(event)
      ? `Deadline: ${deadlineText(event).replace(/^deadline /, '')}`
      : null,
    assignment?.firstSeen ? `Eerste vastlegging: ${formatDateTime(assignment.firstSeen)}` : null,
    `Vastgelegd op: ${formatDateTime(event.at)}`,
    `Soort wijziging: ${TYPE_LABEL[event.type] || event.type}`,
  ];

  if (event.changes?.length) {
    lines.push('', 'Wat is er veranderd:');
    for (const change of event.changes) {
      lines.push(`- ${fieldLabel(change.path)}: "${change.from}" -> "${change.to}"`);
    }
  }

  if (timeline.length > 1) {
    lines.push('', 'Tijdlijn:');
    for (const item of timeline) {
      const detail = item.changes?.length ? changeSummary(item.changes[0]) : TYPE_HINT[item.type] || '';
      lines.push(`- ${formatDateTime(item.at)} — ${TYPE_LABEL[item.type] || item.type}: ${detail}`);
    }
  }

  if (event.url) lines.push('', `Bron: ${event.url}`);
  lines.push(
    '',
    'Let op: de tijdstempels komen van het apparaat waarop de logger meeliep, niet van Somtoday zelf. Gebruik dit als onderbouwing, niet als juridisch bewijs.',
  );
  return lines.filter((line) => line !== null).join('\n');
}

async function renderDetail(event) {
  const detail = el('event-detail');
  const [timeline, assignment] = await Promise.all([
    store.eventsForKey(event.key, 50),
    store.getAssignment(event.key),
  ]);

  const raw = assignment?.raw ?? event.fields;
  const timelineHtml = timeline
    .map((item) => {
      const badge = `<span class="badge badge-${esc(item.type)}">${esc(TYPE_LABEL[item.type] || item.type)}</span>`;
      const text = item.changes?.length
        ? item.changes.map((change) => esc(changeSummary(change))).join('<br />')
        : esc(TYPE_HINT[item.type] || '');
      return `<li><span class="timeline-time">${esc(formatDateTime(item.at))}</span>${badge}<span class="timeline-text">${text}</span></li>`;
    })
    .join('');

  detail.innerHTML = `<header class="detail-header">
      <span class="badge badge-${esc(event.type)}">${esc(TYPE_LABEL[event.type] || event.type)}</span>
      <h2>${esc(event.title)}</h2>
      <p class="muted">${esc(event.vak || 'onbekend vak')}${
        deadlineText(event) ? ` · ${esc(deadlineText(event))}` : ''
      }</p>
      <p class="muted small-text">Vastgelegd op ${esc(formatDateTime(event.at))}</p>
    </header>

    <section class="card">
      <h3>Wat is er veranderd</h3>
      ${changesTable(event)}
    </section>

    <section class="card">
      <h3>Tijdlijn van dit item</h3>
      <ol class="timeline">${timelineHtml || '<li class="muted">Nog geen eerdere momenten.</li>'}</ol>
    </section>

    <section class="card">
      <h3>Bewijs</h3>
      <p class="muted small-text">Kopieer dit als je aan een docent of mentor wilt laten zien dat huiswerk op het laatste moment is aangepast.</p>
      <button id="copy-evidence">Kopieer als tekst</button>
      <details class="raw">
        <summary>Ruwe Somtoday-gegevens (huidige versie)</summary>
        <pre>${esc(JSON.stringify(raw, null, 2))}</pre>
      </details>
    </section>`;

  el('copy-evidence').addEventListener('click', async () => {
    const button = el('copy-evidence');
    try {
      await navigator.clipboard.writeText(evidenceText(event, timeline, assignment));
      button.textContent = 'Gekopieerd';
      setTimeout(() => {
        button.textContent = 'Kopieer als tekst';
      }, 1800);
    } catch {
      button.textContent = 'Kopiëren mislukt';
    }
  });
}

// ------------------------------------------------------------------- diagnose

async function renderDiagnose() {
  const view = el('view-diagnose');
  const [captures, endpoints, assignments] = await Promise.all([
    store.recentCaptures(40),
    store.allEndpointStates(),
    store.allAssignments(),
  ]);

  const endpointRows = endpoints
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .map(
      (endpoint) => `<tr>
        <td><code>${esc(truncate(endpoint.endpointKey, 90))}</code></td>
        <td>${(endpoint.keys || []).length}</td>
        <td>${endpoint.maxKeys || 0}</td>
        <td>${endpoint.captures || 0}</td>
        <td>${esc(formatDateTime(endpoint.at))}</td>
      </tr>`,
    )
    .join('');

  const captureRows = captures
    .map(
      (capture) => `<tr>
        <td>${esc(formatDateTime(capture.at))}</td>
        <td><code>${esc(truncate(capture.endpointKey || capture.url, 70))}</code></td>
        <td>${capture.records}</td>
        <td>${capture.added}</td>
        <td>${capture.changed}</td>
        <td>${capture.removed}</td>
      </tr>`,
    )
    .join('');

  const itemRows = assignments
    .slice()
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, 200)
    .map(
      (item) => `<tr>
        <td>${esc(truncate(item.fields?.titel || '(geen titel)', 60))}</td>
        <td>${esc(item.fields?.vak || '')}</td>
        <td>${esc(item.identity === 'id' ? 'id' : 'signatuur')}</td>
        <td>${esc(formatDate(item.firstSeen))}</td>
        <td>${esc(formatDate(item.deadlineIso || null))}</td>
      </tr>`,
    )
    .join('');

  const problemHint =
    captures.length > 0 && assignments.length === 0
      ? `<p class="warning">Er worden wel ophaalacties gezien, maar nog geen huiswerk herkend. Het antwoordformaat wijkt dan af van wat de logger kent — noteer de endpointnaam hierboven bij een melding.</p>`
      : '';

  view.innerHTML = `
    <div class="card">
      <h3>Hoe de logger werkt</h3>
      <p class="muted">De extensie leest mee met de verzoeken die Somtoday zelf doet, herkent daarin huiswerk-items en vergelijkt ze met de vorige stand. Niets wordt naar buiten gestuurd.</p>
      ${problemHint}
    </div>

    <div class="card">
      <h3>Endpoints die huiswerk opleveren</h3>
      <table class="grid">
        <thead><tr><th>Endpoint</th><th>Items nu</th><th>Max ooit</th><th>Ophaalacties</th><th>Laatst</th></tr></thead>
        <tbody>${endpointRows || '<tr><td colspan="5" class="muted">Nog geen.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card">
      <h3>Recente ophaalacties</h3>
      <table class="grid">
        <thead><tr><th>Tijd</th><th>Endpoint</th><th>Items</th><th>+</th><th>~</th><th>−</th></tr></thead>
        <tbody>${captureRows || '<tr><td colspan="6" class="muted">Nog geen.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card">
      <h3>Vastgelegde items</h3>
      <table class="grid">
        <thead><tr><th>Titel</th><th>Vak</th><th>Sleutel</th><th>Eerst gezien</th><th>Deadline</th></tr></thead>
        <tbody>${itemRows || '<tr><td colspan="5" class="muted">Nog geen.</td></tr>'}</tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------- laden

async function load() {
  state.events = await store.recentEvents({ limit: 1000 });
  const stats = await store.counts();
  el('subtitle').textContent = `${stats.assignments} items · ${stats.events} gebeurtenissen · ${stats.captures} ophaalacties`;
  renderList();

  if (state.selectedId != null) {
    const selected = state.events.find((event) => event.id === state.selectedId);
    if (selected) await renderDetail(selected);
  }
  if (state.view === 'diagnose') await renderDiagnose();

  await send({ type: 'markSeen' });
}

function select(id) {
  state.selectedId = Number(id);
  renderList();
  const event = state.events.find((item) => item.id === state.selectedId);
  if (event) renderDetail(event);
  document.querySelectorAll('.event').forEach((node) => {
    node.classList.toggle('is-active', Number(node.dataset.id) === state.selectedId);
  });
}

// -------------------------------------------------------------------- events

el('event-list').addEventListener('click', (event) => {
  const item = event.target.closest('.event');
  if (item) select(item.dataset.id);
});

el('event-list').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const item = event.target.closest('.event');
  if (item) {
    event.preventDefault();
    select(item.dataset.id);
  }
});

el('filter-q').addEventListener('input', (event) => {
  state.filter.q = event.target.value;
  renderList();
});

el('filter-type').addEventListener('change', (event) => {
  state.filter.type = event.target.value;
  renderList();
});

el('filter-period').addEventListener('change', (event) => {
  state.filter.days = Number(event.target.value);
  renderList();
});

el('filter-initial').addEventListener('change', (event) => {
  state.filter.initial = event.target.checked;
  renderList();
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.view = tab.dataset.view;
    document.querySelectorAll('.tab').forEach((node) => {
      node.classList.toggle('is-active', node === tab);
    });
    el('view-events').classList.toggle('hidden', state.view !== 'events');
    el('view-diagnose').classList.toggle('hidden', state.view !== 'diagnose');
    if (state.view === 'diagnose') renderDiagnose();
  });
});

el('btn-refresh').addEventListener('click', () => {
  load().catch(() => {});
  send({ type: 'recapture' });
});

el('btn-export').addEventListener('click', async () => {
  const data = await store.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `somtoday-huiswerk-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

el('btn-clear').addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Alle vastgelegde huiswerk en geschiedenis wissen? Dit kan niet ongedaan worden gemaakt.',
  );
  if (!confirmed) return;
  await store.clearAll();
  await send({ type: 'clear' });
  state.events = [];
  state.selectedId = null;
  el('event-detail').innerHTML = '<p class="empty">Kies links een wijziging om de details te zien.</p>';
  await load();
});

load().catch((error) => {
  el('subtitle').textContent = `Laden mislukt: ${error?.message || error}`;
});
