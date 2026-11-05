// Brug tussen de pagina (MAIN world) en de extensie (service worker).
// Bewust klein: alle logica zit in de achtergrondservice, zodat er maar één
// plek is die schrijft en diff't.

(() => {
  const CHANNEL = 'shl-v1';
  const REFRESH_MS = 10 * 60 * 1000;

  function send(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* extensie is herladen of verwijderd */
    }
  }

  function askForCapture() {
    window.postMessage({ __shl: CHANNEL, type: 'request' }, location.origin);
  }

  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.__shl !== CHANNEL) return;

      if (data.type === 'payload') {
        send({ type: 'payload', url: data.url, body: data.body, method: data.method, at: data.at });
        return;
      }
      if (data.type === 'replay-empty') {
        send({ type: 'replay-empty', url: location.href });
        return;
      }
      if (data.type === 'replay-auth') {
        send({ type: 'replay-auth', ok: data.ok === true });
      }
    },
    false,
  );

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'recapture') {
      askForCapture();
      sendResponse({ ok: true, url: location.href });
    }
    return false;
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') askForCapture();
  });

  setInterval(() => {
    if (document.visibilityState === 'visible') askForCapture();
  }, REFRESH_MS);

  send({ type: 'page-open', url: location.href });
  // De app start zijn eigen requests kort na het laden; na een seconde nog eens
  // kijken vangt het geval op dat de eerste laag endpoints al klaar was.
  setTimeout(askForCapture, 1500);
})();
