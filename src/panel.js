// Toont op een Somtoday-huiswerkpagina de eerdere versies van dat item.
//
// Dit script heeft bewust geen imports: de achtergrond stuurt kant-en-klare
// weergavedata (met al geformatteerde labels), zodat dit bestand alleen hoeft
// te renderen. Alles zit in een shadow DOM, dus Somtoday's CSS kan het paneel
// niet raken en andersom. De enige uitzondering is de regel die in Somtoday's
// eigen huiswerkblok wordt gezet: die staat bewust in de licht-DOM, met inline
// styles, zodat hij op de plek van het huiswerk zelf staat.

(() => {
  const HOST_ID = 'somtoday-huiswerk-logger-panel';
  const SHOW_ID = 'somtoday-huiswerk-logger-show';
  const NOTE_ATTR = 'data-shl-note';
  const MAX_PAGE_TEXT = 20000;
  const MAX_VERSIONS = 6;
  const DEBOUNCE_MS = 1200;
  const HIDDEN_KEY = 'panelHidden';
  const CHECKED_KEY = 'panelChecked';

  const SEND = (message) => chrome.runtime.sendMessage(message).catch(() => null);

  let settings = { panel: true };
  let hidden = false;
  let checked = {};
  let currentKey = null;
  let candidates = [];
  let lastSignature = '';
  let lastHistory = null;
  let busy = false;
  let debounceTimer = null;

  // Tekst van de regel in Somtoday's eigen blok. Wordt uit de paginatekst
  // gefilterd voordat we matchen, anders verandert onze eigen toevoeging de
  // paginasignatuur en zou het paneel zichzelf blijven verversen.
  let noteText = '';

  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    );

  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const capitalize = (value) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : '');

  const ICON_HISTORY =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h9M4 11h9M4 16h6"/><path d="M16.5 20a4.5 4.5 0 1 1 1.9-8.6"/><path d="M18.5 9v4h-3.5"/></svg>';
  const ICON_HUISWERK =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M9 3v18"/><path d="M12.5 8h3.5M12.5 12h3.5"/></svg>';
  const ICON_CALENDAR =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  const ICON_CLOCK =
    '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>';

  function hostElement() {
    return document.getElementById(HOST_ID);
  }

  function showElement() {
    return document.getElementById(SHOW_ID);
  }

  function removePanel() {
    hostElement()?.remove();
  }

  function removeShowButton() {
    showElement()?.remove();
  }

  function ensureShadow() {
    let host = hostElement();
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      // De drawer hangt aan de rechterrand en is full-height; de host zelf is
      // nul breed zodat hij geen klikken van de pagina afvangt.
      host.style.cssText =
        'position:fixed;top:0;right:0;bottom:0;width:0;z-index:2147483000;pointer-events:none;';
      (document.body || document.documentElement).appendChild(host);
    }
    if (!host.shadowRoot) host.attachShadow({ mode: 'open' });
    return host.shadowRoot;
  }

  function ensureShowShadow() {
    let host = showElement();
    if (!host) {
      host = document.createElement('div');
      host.id = SHOW_ID;
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;';
      (document.body || document.documentElement).appendChild(host);
    }
    if (!host.shadowRoot) host.attachShadow({ mode: 'open' });
    return host.shadowRoot;
  }

  function pageText() {
    const main = document.querySelector('main, [role="main"], #content, .content');
    const text = main?.innerText || document.body?.innerText || '';
    return text.replace(/[ \t]+/g, ' ').slice(0, MAX_PAGE_TEXT);
  }

  // ------------------------------------------------------------------ renderen

  const STYLE = `
    :host { all: initial; }
    .drawer {
      position: absolute; top: 0; right: 0; bottom: 0;
      width: min(410px, 94vw); display: flex; flex-direction: column;
      pointer-events: auto;
      background: #232631; color: #e7eaf3;
      border-left: 1px solid #343a49; border-top-left-radius: 12px;
      box-shadow: -18px 0 48px rgba(0,0,0,.45);
      font: 13px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
      overflow: hidden;
    }
    .head {
      display: flex; align-items: center; gap: 9px;
      padding: 13px 12px 13px 15px;
      background: #1c1f29; border-bottom: 1px solid #343a49;
      color: #cfd5e4;
    }
    .head-title { flex: 1; font-size: 15px; font-weight: 650; color: #fff;
      letter-spacing: .01em; }
    .icon {
      background: transparent; border: 0; color: #aab2c6; cursor: pointer;
      font: inherit; font-size: 17px; line-height: 1; padding: 3px 7px;
      border-radius: 7px; flex: none;
    }
    .icon:hover { background: #2d3240; color: #fff; }
    .body { padding: 14px 14px 18px; overflow-y: auto; flex: 1; }
    .section { margin: 0 0 10px; font-size: 15px; font-weight: 650; color: #fff; }
    .sub { margin: -6px 0 12px; font-size: 12px; color: #9aa2b6; }
    .entry {
      border: 1px solid #343a49; border-radius: 10px;
      padding: 10px 11px 11px; margin-bottom: 10px; background: #272b37;
    }
    .entry.is-old {
      border-color: #8d3a46; background: rgba(193, 74, 88, .09);
    }
    .entry.is-current { border-color: #3c4354; }
    .line { display: flex; align-items: center; gap: 8px; font-size: 13px;
      color: #dfe4ef; min-height: 22px; }
    .line + .line { margin-top: 4px; }
    .line svg { color: #aab2c6; flex: none; }
    .line-title { flex: 1; font-weight: 650; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .line-text { flex: 1; min-width: 0; }
    .tag { margin-left: auto; font-size: 11px; color: #9aa2b6;
      font-variant-numeric: tabular-nums; flex: none; }
    .check { margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; color: #aab2c6; cursor: pointer; flex: none; }
    .check input { accent-color: #5865f2; width: 14px; height: 14px; margin: 0;
      cursor: pointer; }
    .block { margin-top: 9px; background: #2c3140; border: 1px solid #363c4c;
      border-radius: 8px; padding: 9px 10px; }
    .is-old .block { background: rgba(193, 74, 88, .10); border-color: #7d3542; }
    .block-title { margin: 0; font-weight: 650; font-size: 13px; color: #fff; }
    .block-text { margin: 3px 0 0; font-size: 12.5px; color: #c6cddd;
      white-space: pre-wrap; overflow-wrap: anywhere; }
    .block-text.is-empty { color: #8d95a8; font-style: italic; }
    .changes { list-style: none; margin: 8px 0 0; padding: 0; font-size: 12px;
      color: #c6cddd; display: flex; flex-direction: column; gap: 3px; }
    .changes .label { color: #9aa2b6; }
    .old-value { color: #ff9b93; text-decoration: line-through; }
    .new-value { color: #7ee787; }
    .banner { background: rgba(248,81,73,.14); color: #ff9b93; border-radius: 8px;
      padding: 7px 9px; font-size: 12px; margin: 0 0 10px; }
    .meta { font-size: 12px; color: #9aa2b6; margin: 0 0 4px; }
    .meta b { color: #e7eaf3; font-weight: 600; }
    .picker { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px;
      color: #9aa2b6; margin: 0 0 10px; }
    .picker select { background: #2c3140; color: #e7eaf3; border: 1px solid #3c4354;
      border-radius: 7px; padding: 5px 6px; font: inherit; font-size: 12px; }
    .open { width: 100%; margin-top: 4px; background: #5865f2; color: #fff;
      border: 0; border-radius: 8px; padding: 8px; font: inherit; font-weight: 600;
      font-size: 12.5px; cursor: pointer; }
    .open:hover { background: #6a76f5; }
    .foot { margin: 9px 0 0; font-size: 11px; color: #7b8299; }
  `;

  const SHOW_STYLE = `
    :host { all: initial; }
    .pill {
      display: inline-flex; align-items: center; gap: 8px;
      background: #1c1f29; color: #e7eaf3; border: 1px solid #3c4354;
      border-radius: 999px; padding: 8px 14px 8px 11px; cursor: pointer;
      font: 600 12.5px/1 "Segoe UI", system-ui, -apple-system, sans-serif;
      box-shadow: 0 10px 24px rgba(0,0,0,.45);
    }
    .pill:hover { background: #262b37; border-color: #4b5468; }
    .pill svg { color: #8f9ab5; }
    .count { background: #5865f2; color: #fff; border-radius: 999px;
      padding: 1px 7px; font-size: 11px; }
  `;

  function changeList(changes) {
    const items = (changes || [])
      .map(
        (change) =>
          `<li><span class="label">${esc(change.label)}:</span> <span class="old-value">${esc(
            change.from,
          )}</span> → <span class="new-value">${esc(change.to)}</span></li>`,
      )
      .join('');
    return items ? `<ul class="changes">${items}</ul>` : '';
  }

  function descriptionBlock(text, fallback) {
    const body = text
      ? `<p class="block-text">${esc(text)}</p>`
      : `<p class="block-text is-empty">${esc(fallback || 'Geen omschrijving.')}</p>`;
    return `<div class="block">
      <p class="block-title">Omschrijving</p>
      ${body}
    </div>`;
  }

  function currentCard(history) {
    const isChecked = Boolean(checked[history.key]);
    const dateLabel = history.dateLabel || capitalize(history.deadline || '') || 'Geen datum';
    return `<div class="entry is-current">
      <div class="line">
        ${ICON_HUISWERK}
        <span class="line-title">${esc(history.title)}</span>
        <label class="check">Afvinken
          <input type="checkbox" data-act="check"${isChecked ? ' checked' : ''}>
        </label>
      </div>
      <div class="line">
        ${ICON_CALENDAR}
        <span class="line-text">${esc(dateLabel)}</span>
        <span class="tag">nu</span>
      </div>
      ${descriptionBlock(history.omschrijving, 'Somtoday geeft hier geen omschrijving.')}
      ${
        history.goneAt
          ? '<p class="banner" style="margin:9px 0 0">Dit item staat niet meer in Somtoday.</p>'
          : ''
      }
    </div>`;
  }

  function versionCard(version) {
    const dateLabel = version.dateLabel || 'Geen datum';
    const changes = version.changes || [];
    return `<div class="entry is-old">
      <div class="line">
        ${ICON_HUISWERK}
        <span class="line-text">${esc(version.typeLabel)}</span>
        <span class="tag">${esc(version.atLabel)}</span>
      </div>
      <div class="line">
        ${ICON_CALENDAR}
        <span class="line-text">${esc(dateLabel)}</span>
      </div>
      ${descriptionBlock(version.om, version.note || 'Geen omschrijving bewaard.')}
      ${changeList(changes)}
    </div>`;
  }

  function render(history) {
    const root = ensureShadow();
    const versions = history.versions || [];
    const shown = versions.slice(0, MAX_VERSIONS);
    const hiddenCount = versions.length - shown.length;
    const changeCount = history.changeCount || 0;

    const options = candidates
      .map(
        (candidate) =>
          `<option value="${esc(candidate.key)}"${
            candidate.key === currentKey ? ' selected' : ''
          }>${esc(candidate.vak ? `${candidate.vak} — ${candidate.title}` : candidate.title)}</option>`,
      )
      .join('');

    root.innerHTML = `<style>${STYLE}</style>
      <aside class="drawer" role="complementary" aria-label="Huiswerkgeschiedenis">
        <div class="head">
          ${ICON_HISTORY}
          <span class="head-title">geschiedenis</span>
          <button class="icon" data-act="hide" title="Verbergen" aria-label="Verbergen">×</button>
        </div>
        <div class="body">
          <p class="section">huiswerk</p>
          ${
            candidates.length > 1
              ? `<label class="picker">Item op deze pagina<select>${options}</select></label>`
              : ''
          }
          ${currentCard(history)}
          <p class="meta">Voor het eerst gezien: <b>${esc(history.firstSeenLabel)}</b></p>
          ${
            history.somtodayCreatedAtLabel
              ? `<p class="meta">Somtoday meldt aangemaakt: <b>${esc(
                  history.somtodayCreatedAtLabel,
                )}</b></p>`
              : ''
          }
          <p class="meta">${
            changeCount === 0
              ? 'Geen wijzigingen sinds de eerste vastlegging.'
              : `${changeCount} wijziging${changeCount === 1 ? '' : 'en'} vastgelegd.`
          }</p>
          ${shown.map(versionCard).join('')}
          ${
            hiddenCount > 0
              ? `<p class="meta">+${hiddenCount} oudere versie${
                  hiddenCount === 1 ? '' : 's'
                } in de volledige geschiedenis.</p>`
              : ''
          }
          <button class="open" data-act="open">Volledige geschiedenis</button>
          <p class="foot">“Voor het eerst gezien” is het moment waarop de logger dit item zag, niet per se wanneer de docent het neerzette.</p>
        </div>
      </aside>`;

    root.querySelectorAll('[data-act]').forEach((node) => {
      if (node.dataset.act === 'hide') {
        node.addEventListener('click', () => {
          setHidden(true).catch(() => {});
        });
        return;
      }
      if (node.dataset.act === 'open') {
        node.addEventListener('click', () => SEND({ type: 'open-history' }));
        return;
      }
      if (node.dataset.act === 'check') {
        node.addEventListener('change', (event) => {
          setChecked(history.key, event.target.checked).catch(() => {});
        });
      }
    });

    root.querySelector('.picker select')?.addEventListener('change', async (event) => {
      currentKey = event.target.value;
      const next = await SEND({ type: 'item-history', key: currentKey });
      if (next?.found) {
        lastHistory = next;
        injectNote(next);
        render(next);
      }
    });
  }

  function renderShowButton(history) {
    const root = ensureShowShadow();
    const count = history?.changeCount || 0;
    root.innerHTML = `<style>${SHOW_STYLE}</style>
      <button class="pill" data-act="show" title="Geschiedenis weer laten zien">
        ${ICON_HISTORY}
        <span>Laat zien</span>
        ${count > 0 ? `<span class="count">${count}</span>` : ''}
      </button>`;
    root.querySelector('[data-act="show"]')?.addEventListener('click', () => {
      setHidden(false).catch(() => {});
    });
  }

  // ------------------------------------------- regel in Somtoday's eigen blok

  function buildNoteText(history) {
    const parts = [`Toegevoegd op ${history.firstSeenLabel}`];
    if (history.somtodayCreatedAtLabel) parts.push(`Somtoday meldt ${history.somtodayCreatedAtLabel}`);
    if (history.changeCount > 0) {
      parts.push(`${history.changeCount} wijziging${history.changeCount === 1 ? '' : 'en'}`);
    }
    // Non-breaking spatie na de punt, anders breekt Somtoday's blok af tussen
    // "·" en het aantal en ziet de regel er slordig uit.
    return parts.join(' ·\u00a0');
  }

  const BLOCK_TAGS = new Set([
    'P',
    'DIV',
    'LI',
    'SECTION',
    'ARTICLE',
    'DD',
    'TD',
    'TR',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'FORM',
  ]);

  /** Dichtstbijzijnde blok-achtige ouder, zodat we geen inline-span openbreken. */
  function blockAncestor(element) {
    let node = element;
    while (node && node !== document.body) {
      if (BLOCK_TAGS.has(node.tagName)) return node;
      node = node.parentElement;
    }
    return element;
  }

  function textNodes() {
    const out = [];
    if (!document.body) return out;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest(`[${NOTE_ATTR}]`)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node = walker.nextNode();
    while (node) {
      out.push(node);
      node = walker.nextNode();
    }
    return out;
  }

  // Somtoday toont het detailpaneel rechts. Bij meerdere treffers (lijst + detail)
  // kiezen we daarom het meest rechtse zichtbare blok.
  function findAnchor(history) {
    const needles = [];
    const omschrijving = norm(history.omschrijving);
    const titel = norm(history.title);
    if (omschrijving.length >= 20) needles.push(omschrijving);
    if (titel.length >= 6) needles.push(titel);
    needles.push('omschrijving');

    const nodes = textNodes();

    for (const needle of needles) {
      let best = null;
      for (const node of nodes) {
        const text = norm(node.nodeValue);
        if (!text) continue;

        let hit = false;
        if (needle.length <= 25) {
          hit = text === needle;
        } else {
          hit =
            text === needle ||
            text.includes(needle) ||
            (needle.includes(text) && text.length >= needle.length * 0.6);
        }
        if (!hit) continue;

        const element = node.parentElement;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const rank = rect.left + rect.width;
        if (!best || rank > best.rank) best = { element, rank };
      }
      if (best) {
        const block = blockAncestor(best.element);
        if (block && block !== document.body) return block;
      }
    }
    return null;
  }

  function clearNote() {
    document.querySelectorAll(`[${NOTE_ATTR}]`).forEach((node) => node.remove());
    noteText = '';
  }

  function injectNote(history) {
    const text = buildNoteText(history);
    // Eerst opruimen: bij elke verversing kan het blok opnieuw gerenderd zijn.
    clearNote();
    if (!text) return;

    const anchor = findAnchor(history);
    if (!anchor) return;

    const note = document.createElement('div');
    note.setAttribute(NOTE_ATTR, '1');
    note.title =
      'Vastgelegd door Somtoday Huiswerk Logger. Dit is het moment waarop de logger het item voor het eerst zag, niet per se de officiële plaatsingsdatum.';
    note.style.cssText =
      'display:flex;align-items:center;gap:6px;margin:8px 0 2px;font:inherit;font-size:12.5px;line-height:1.4;color:#8b93a7;';
    note.innerHTML = `${ICON_CLOCK}<span></span>`;
    const label = note.querySelector('span');
    if (label) label.textContent = text;

    anchor.insertAdjacentElement('afterend', note);
    noteText = text;
  }

  // ------------------------------------------------------------ verbergen tonen

  async function setHidden(value) {
    hidden = value === true;
    try {
      await chrome.storage.local.set({ [HIDDEN_KEY]: hidden });
    } catch {
      /* valt terug op de huidige sessie */
    }
    lastSignature = '';
    await evaluate(true);
  }

  async function setChecked(key, value) {
    if (!key) return;
    if (value) checked[key] = Date.now();
    else delete checked[key];
    try {
      await chrome.storage.local.set({ [CHECKED_KEY]: checked });
    } catch {
      /* afvinken is een gemak, geen vereiste */
    }
    if (lastHistory) render(lastHistory);
  }

  // ------------------------------------------------------------------ bepalen

  async function evaluate(force = false) {
    if (busy) return;
    if (!settings.panel) {
      removePanel();
      removeShowButton();
      clearNote();
      return;
    }

    const url = location.href;
    let text = pageText();
    if (noteText) text = text.split(noteText).join('');

    if (text.length < 40) {
      removePanel();
      removeShowButton();
      return;
    }

    // Dezelfde pagina met dezelfde tekst betekent: niets veranderd. Zonder deze
    // guard zou elke DOM-mutatie op Somtoday een nieuwe match-aanvraag doen.
    const signature = `${url}|${text.length}|${hidden ? 'hidden' : 'shown'}`;
    if (!force && signature === lastSignature) return;

    busy = true;
    try {
      lastSignature = signature;
      const match = await SEND({ type: 'match-page', url, text });
      const list = match?.candidates || [];
      if (!list.length) {
        currentKey = null;
        removePanel();
        removeShowButton();
        clearNote();
        return;
      }

      candidates = list;
      if (!list.some((candidate) => candidate.key === currentKey)) currentKey = list[0].key;

      const history = await SEND({ type: 'item-history', key: currentKey });
      if (!history?.found) {
        removePanel();
        removeShowButton();
        clearNote();
        return;
      }

      lastHistory = history;
      injectNote(history);

      if (hidden) {
        removePanel();
        renderShowButton(history);
      } else {
        removeShowButton();
        render(history);
      }
    } finally {
      busy = false;
    }
  }

  function schedule(force = false) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      evaluate(force).catch(() => {});
    }, DEBOUNCE_MS);
  }

  // --------------------------------------------------------------------- start

  (async () => {
    try {
      const [synced, local] = await Promise.all([
        chrome.storage.sync.get('settings'),
        chrome.storage.local.get([HIDDEN_KEY, CHECKED_KEY]),
      ]);
      settings = { panel: true, ...(synced?.settings || {}) };
      hidden = local?.[HIDDEN_KEY] === true;
      checked = local?.[CHECKED_KEY] || {};
    } catch {
      /* standaard: paneel zichtbaar, niets afgevinkt */
    }
    schedule(true);
  })();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      settings = { panel: true, ...(changes.settings.newValue || {}) };
      schedule(true);
      return;
    }
    if (area === 'local' && changes[CHECKED_KEY]) {
      checked = changes[CHECKED_KEY].newValue || {};
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'data-updated') schedule(true);
    return false;
  });

  // Somtoday is een SPA: de URL verandert zonder page load.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    currentKey = null;
    candidates = [];
    lastSignature = '';
    schedule(true);
  }, 1000);

  window.addEventListener('popstate', () => schedule(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(true);
  });

  if (document.body) {
    new MutationObserver(() => schedule()).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => schedule()).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      schedule(true);
    });
  }
})();
