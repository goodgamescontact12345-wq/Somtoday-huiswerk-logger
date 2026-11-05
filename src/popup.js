import { formatDateTime } from './lib/util.js';

const $ = (id) => document.getElementById(id);

function send(message) {
  return chrome.runtime.sendMessage(message).catch((error) => ({ error: String(error) }));
}

function relative(ms) {
  if (!ms) return 'nog niet';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'net nu';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min geleden`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} uur geleden`;
  return formatDateTime(ms);
}

function setHint(text, isWarning = false) {
  const hint = $('hint');
  hint.textContent = text || '';
  hint.classList.toggle('warning', Boolean(isWarning));
}

async function refresh() {
  const state = await send({ type: 'getState' });
  if (!state || state.error) {
    $('status-line').textContent = 'Kon status niet laden.';
    return;
  }

  const { settings, stats, lastCapture } = state;
  $('opt-notify').checked = Boolean(settings.notify);
  $('opt-poll').value = String(settings.pollMinutes);
  $('opt-panel').checked = settings.panel !== false;

  $('stat-assignments').textContent = String(stats?.assignments ?? 0);
  $('stat-today').textContent = String(stats?.today ?? 0);
  $('stat-last').textContent = relative(lastCapture?.at);

  if (state.unseen > 0) {
    $('status-line').textContent = `${state.unseen} nieuwe wijziging${state.unseen === 1 ? '' : 'en'} sinds je laatste bezoek`;
    $('status-line').classList.add('accent');
  } else {
    $('status-line').textContent = lastCapture
      ? `Meekijken sinds ${formatDateTime(lastCapture.at)}`
      : 'Nog geen huiswerk vastgelegd';
    $('status-line').classList.remove('accent');
  }

  if (state.authStale) {
    setHint(
      'Je Somtoday-sessie is verlopen. Open Somtoday opnieuw en log in; daarna loopt het meekijken weer.',
      true,
    );
  } else if (!stats?.captures) {
    setHint('Open Somtoday in een tab; de logger vult zich dan automatisch.', true);
  } else {
    setHint('Alles blijft lokaal in deze browser. Exporteer zelf als je bewijs nodig hebt.');
  }
}

$('open-history').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/history.html') });
  window.close();
});

$('check-now').addEventListener('click', async () => {
  setHint('Bezig met controleren…');
  const result = await send({ type: 'recapture' });
  if (!result?.tabs) {
    setHint('Geen Somtoday-tab open. Open Somtoday en probeer opnieuw.', true);
    return;
  }
  setTimeout(async () => {
    await refresh();
    setHint(`Gecontroleerd in ${result.tabs} tab${result.tabs === 1 ? '' : 's'}.`);
  }, 1500);
});

$('opt-notify').addEventListener('change', (event) => {
  send({ type: 'settings:set', patch: { notify: event.target.checked } });
});

$('opt-poll').addEventListener('change', (event) => {
  send({ type: 'settings:set', patch: { pollMinutes: Number(event.target.value) } });
});

$('opt-panel').addEventListener('change', (event) => {
  send({ type: 'settings:set', patch: { panel: event.target.checked } });
});

refresh();
