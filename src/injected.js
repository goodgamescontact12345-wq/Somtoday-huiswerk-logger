// Dit script draait in de MAIN world van de Somtoday-pagina, dus met dezelfde
// rechten en sessie als de app zelf. We lezen alleen antwoorden mee die de app
// toch al ophaalt; we loggen niet in en bewaren geen tokens.
//
// Het equivalent van wat Vencord's MessageLogger doet: de client zijn eigen
// data laten praten in plaats van een API nabouwen.

(() => {
  const CHANNEL = 'shl-v1';
  const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
  const REPLAY_MAX_AGE = 6 * 60 * 60 * 1000;
  const REPLAY_LIMIT = 40;

  if (window.__shlNetworkHook) return;
  try {
    Object.defineProperty(window, '__shlNetworkHook', { value: true, enumerable: false });
  } catch {
    window.__shlNetworkHook = true;
  }

  const interesting = /\/rest\/|\/api\/|graphql/i;
  const boring = /token|oauth|authorize|login|aanmelden|wachtwoord|password|sessie|session|telemetry|analytics|logboek/i;

  /** url -> laatste keer gezien; alleen GET's, want die zijn veilig te herhalen. */
  const replayable = new Map();

  // Somtoday authenticieert zijn REST-verkeer met een Bearer-token dat de app
  // zelf in het geheugen houdt (POST /oauth2/token), niet met een cookie. Om
  // eerder gedane GET's te kunnen herhalen moeten we dat token meenemen.
  // Het blijft in dit tabblad in het geheugen: we slaan het nooit op.
  let authHeader = '';

  function rememberAuth(headers) {
    if (!headers) return;
    try {
      const value = new Headers(headers).get('authorization');
      if (value) authHeader = value;
    } catch {
      /* geen leesbare headers */
    }
  }

  const post = (message) => {
    try {
      window.postMessage({ __shl: CHANNEL, ...message }, location.origin);
    } catch {
      /* pagina mag dit blokkeren; dan loggen we niets */
    }
  };

  function toUrl(input) {
    try {
      const raw = typeof input === 'string' ? input : input?.url ?? String(input);
      const url = new URL(raw, location.href);
      // Somtoday's data staat op de schoolinstelling zelf, maar sommige
      // onderdelen komen van een ander somtoday.nl-subdomein. Beide horen bij
      // dezelfde site en vallen binnen de host_permissions van de extensie.
      if (!/(^|\.)somtoday\.nl$/i.test(url.hostname)) return null;
      if (!interesting.test(url.pathname)) return null;
      if (boring.test(url.pathname + url.search)) return null;
      return url;
    } catch {
      return null;
    }
  }

  function isJsonText(text) {
    if (typeof text !== 'string' || !text) return false;
    if (text.length > MAX_CAPTURE_BYTES) return false;
    const head = text.replace(/^\uFEFF/, '').trimStart().charAt(0);
    return head === '{' || head === '[';
  }

  function emit(url, text, method) {
    if (!isJsonText(text)) return;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    post({ type: 'payload', url, body, method, at: Date.now() });
  }

  function remember(url, method) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return;
    replayable.set(url, Date.now());
    if (replayable.size > 200) {
      const oldest = [...replayable.entries()].sort((a, b) => a[1] - b[1]).slice(0, 50);
      for (const [key] of oldest) replayable.delete(key);
    }
  }

  // ------------------------------------------------------------------ fetch

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(...args) {
      const promise = nativeFetch.apply(this, args);
      try {
        const request = args[0];
        const method = (
          args[1]?.method ||
          (typeof request === 'object' && request?.method) ||
          'GET'
        ).toUpperCase();
        if (args[1]?.headers) rememberAuth(args[1].headers);
        if (typeof request === 'object' && request?.headers) rememberAuth(request.headers);
        promise
          .then((response) => {
            const url = toUrl(typeof request === 'string' ? request : request?.url ?? response.url);
            if (!url) return;
            const contentType = response.headers.get('content-type') || '';
            if (!/json/i.test(contentType)) return;
            remember(url.href, method);
            response
              .clone()
              .text()
              .then((text) => emit(url.href, text, method))
              .catch(() => {});
          })
          .catch(() => {});
      } catch {
        /* nooit de app stukmaken */
      }
      return promise;
    };
  }

  // -------------------------------------------------------- XMLHttpRequest

  const xhrProto = window.XMLHttpRequest?.prototype;
  if (xhrProto) {
    const nativeOpen = xhrProto.open;
    const nativeSend = xhrProto.send;
    const nativeSetHeader = xhrProto.setRequestHeader;

    if (typeof nativeSetHeader === 'function') {
      xhrProto.setRequestHeader = function patchedSetHeader(name, value) {
        try {
          if (String(name).toLowerCase() === 'authorization') authHeader = String(value);
        } catch {
          /* ignore */
        }
        return nativeSetHeader.call(this, name, value);
      };
    }

    xhrProto.open = function patchedOpen(method, url, ...rest) {
      try {
        this.__shlRequest = { method: String(method || 'GET').toUpperCase(), url };
      } catch {
        /* ignore */
      }
      return nativeOpen.call(this, method, url, ...rest);
    };

    xhrProto.send = function patchedSend(...args) {
      try {
        if (!this.__shlListener) {
          this.__shlListener = true;
          this.addEventListener('load', () => {
            try {
              const info = this.__shlRequest;
              if (!info) return;
              const url = toUrl(info.url);
              if (!url) return;
              const contentType = this.getResponseHeader('content-type') || '';
              if (!/json/i.test(contentType)) return;
              remember(url.href, info.method);
              emit(url.href, this.responseText, info.method);
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* ignore */
      }
      return nativeSend.apply(this, args);
    };
  }

  // -------------------------------------------------------------- hercontrole

  /** Herhaalt eerder gedane GET's zodat we ook zonder page-refresh kunnen checken. */
  async function replay() {
    const now = Date.now();
    const urls = [...replayable.entries()]
      .filter(([, at]) => now - at < REPLAY_MAX_AGE)
      .sort((a, b) => a[1] - b[1])
      .map(([url]) => url)
      .slice(-REPLAY_LIMIT);

    if (!urls.length) {
      post({ type: 'replay-empty', at: now });
      return;
    }

    post({ type: 'replay-start', count: urls.length, at: now });

    const headers = { Accept: 'application/json' };
    if (authHeader) headers.Authorization = authHeader;

    let succeeded = 0;
    let unauthorized = 0;

    for (const url of urls) {
      try {
        const response = await nativeFetch.call(window, url, {
          credentials: 'include',
          cache: 'no-store',
          headers,
        });
        if (response.status === 401 || response.status === 403) {
          unauthorized += 1;
          continue;
        }
        if (!response.ok) continue;
        const contentType = response.headers.get('content-type') || '';
        if (!/json/i.test(contentType)) continue;
        emit(url, await response.text(), 'GET');
        succeeded += 1;
      } catch {
        /* één mislukte replay mag de rest niet stoppen */
      }
    }

    if (!succeeded && unauthorized) post({ type: 'replay-auth', ok: false, at: Date.now() });
    post({ type: 'replay-done', count: urls.length, succeeded, at: Date.now() });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.__shl !== CHANNEL) return;
    if (data.type === 'request' || data.type === 'hello') {
      // 'hello' betekent: pagina is net geladen, de app doet zijn eigen requests.
      if (data.type === 'request') replay();
    }
  });
})();
