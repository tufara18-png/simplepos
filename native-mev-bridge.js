// Thin wrapper around the Android MevKeystore plugin (see android/app/src/main/java/ca/simplepos/app/MevKeystorePlugin.kt).
// No enrolment screen calls this yet — the real "certificats" request to Revenu Québec still
// needs the partner authorization code, dossier number and JSON envelope work first. This is
// wired in now so that screen has something to call instead of inventing crypto in JS.
// No-ops with a clear error everywhere except the Android wrapper.

function mevPlugin() {
  return window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.MevKeystore : null;
}

function mevProtocolPlugin() {
  return window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.MevProtocol : null;
}

function unavailable() {
  return Promise.reject(new Error('Module de certificat MEV disponible seulement dans l’appli Android'));
}

window.SimplePOSMev = {
  isAndroidNative: () => !!mevPlugin(),

  hasKey(alias) {
    const p = mevPlugin();
    return p ? p.hasKey({ alias }) : unavailable();
  },

  generateKeyPair(alias) {
    const p = mevPlugin();
    return p ? p.generateKeyPair({ alias }) : unavailable();
  },

  // cn/o/ou/sn/gn come from Revenu Québec after partner enrolment (SW-73 tableaux 10/11) —
  // never invent or default these from the app.
  createOperatorCsr({ alias, cn, o, ou, sn, gn, l, s, c }) {
    const p = mevPlugin();
    return p ? p.createOperatorCsr({ alias, cn, o, ou, sn, gn, l, s, c }) : unavailable();
  },

  sign(alias, text) {
    const p = mevPlugin();
    return p ? p.sign({ alias, text }) : unavailable();
  },

  deleteKey(alias) {
    const p = mevPlugin();
    return p ? p.deleteKey({ alias }) : unavailable();
  },

  // Sends the request directly from the device (native HTTP, not the WebView's fetch) --
  // required both because Revenu Québec's API has no CORS headers (a WebView fetch would
  // never get past the browser's own cross-origin check) and because Deno's fetch was
  // confirmed live to drop the IDVERSI header en route to this exact endpoint.
  sendRequest({ url, headers, body }) {
    const p = mevProtocolPlugin();
    return p ? p.sendRequest({ url, headers, body }) : unavailable();
  },
};
