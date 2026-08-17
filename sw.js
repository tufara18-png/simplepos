const CACHE='simplepos-v16';
const ASSETS=['/','/index.html','/app-v2.js','/local-first.js','/local-cache-fallback.js','/bridge-ui.js','/business-suite.js','/fixed-expenses.js','/payment-hook.js','/mev-runtime.js','/ui-shell.js','/pivots.js','/demo-mode.js','/styles.css','/business-suite.css','/config.js','/manifest.webmanifest'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>{e.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))]))});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy)).catch(()=>{});return r}).catch(()=>caches.match(e.request).then(r=>r||(e.request.mode==='navigate'?caches.match('/index.html'):undefined))))});
