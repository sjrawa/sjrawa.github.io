'use strict';
// ----- Password lock (published copy only) ------------------------------------------------------------------------
// Generated into the published abi-sw.js by scripts/publish-site.cjs; see scripts/site-lock.cjs for the design.
// Every file except LOCK.plain is published only encrypted as /x/<path>.bin. This part decrypts those files with the
// content key that the lock page (index.html) stored in IndexedDB. It runs before the original offline worker that
// follows below and reuses its helpers (canonicalPath, fromCache, offlineResponse, CACHE).
const LOCK = {"keyId":"5bceab2b96b21068","plain":["/README.md","/abi-sw.js","/api/offline/manifest","/icons/abi-192.png","/icons/abi-512.png","/manifest.webmanifest"]};
const LOCK_PLAIN = new Set(LOCK.plain);
const LOCK_TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json', png: 'image/png',
  svg: 'image/svg+xml', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
};
const lockNetwork = self.fetch.bind(self);
class LockError extends Error {}

function lockDatabase(mode, work) {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('sjrawa-abitur-lock', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('keys');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction('keys', mode);
      const request = work(transaction.objectStore('keys'));
      transaction.oncomplete = () => { db.close(); resolve(request && request.result); };
      transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

async function lockKey() {
  let saved;
  try { saved = await lockDatabase('readonly', store => store.get('content')); } catch { return null; }
  if (!saved || saved.keyId !== LOCK.keyId) return null;
  if (saved.key) return saved.key;
  if (saved.raw) return crypto.subtle.importKey('raw', saved.raw, {name: 'AES-GCM'}, false, ['decrypt']);
  return null;
}

// Relative path of the encrypted file for a request path, or null for files that are published as they are.
function lockedPath(pathname) {
  let path;
  try { path = canonicalPath(decodeURIComponent(pathname)); } catch { return null; }
  if (LOCK_PLAIN.has(path) || path.startsWith('/x/') || path.startsWith('/__sjrawa_offline__/') || path.includes('..')) return null;
  return path === '/' ? 'index.html' : path.slice(1);
}

async function lockOpen(request, relative) {
  const key = await lockKey();
  if (!key) throw new LockError('locked');
  const fresh = ['no-store', 'reload', 'no-cache'].includes(request.cache);
  // A copy from the HTTP cache may be older than the key (after a password change): retry once from the network.
  for (const cache of fresh ? ['no-cache'] : ['default', 'reload']) {
    const response = await lockNetwork(new Request(`/x/${encodeURI(relative)}.bin`, {cache, credentials: 'same-origin'}));
    if (!response.ok) return new Response(null, {status: response.status, statusText: response.statusText});
    const sealed = new Uint8Array(await response.arrayBuffer());
    let packed;
    try {
      packed = await crypto.subtle.decrypt({name: 'AES-GCM', iv: sealed.subarray(0, 12), additionalData: new TextEncoder().encode(relative)}, key, sealed.subarray(12));
    } catch { continue; }
    const body = await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const extension = (/\.([a-z0-9]+)$/i.exec(relative) || [])[1];
    const type = LOCK_TYPES[String(extension).toLowerCase()] || (relative.startsWith('api/') ? 'application/json; charset=utf-8' : 'application/octet-stream');
    return new Response(request.method === 'HEAD' ? null : body, {status: 200, headers: {
      'Content-Type': type, 'Content-Length': String(body.byteLength), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    }});
  }
  throw new LockError('key');
}

// The original worker below calls fetch(request) for files it has not downloaded; route those through decryption.
self.fetch = function lockedFetch(input, init) {
  const method = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const url = new URL(request.url);
    const relative = url.origin === self.location.origin ? lockedPath(url.pathname) : null;
    if (relative) return lockOpen(request, relative);
  }
  return lockNetwork(input, init);
};

async function lockPage() {
  try {
    const page = await lockNetwork(new Request('/index.html', {cache: 'no-cache', credentials: 'same-origin'}));
    if (page.ok) return new Response(await page.arrayBuffer(), {status: 200, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}});
  } catch { /* offline */ }
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sjrawa Abitur</title><p style="font:16px system-ui,sans-serif;margin:32px 16px">需要联网后输入密码，才能打开网站。</p>', {
    status: 503, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'},
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !['GET', 'HEAD'].includes(request.method)) return;
  const relative = lockedPath(url.pathname);
  const navigate = request.mode === 'navigate';
  // Plain files, and normal loads of encrypted files (cache first, then lockedFetch): the original worker below.
  if (!relative || (!navigate && !request.headers.has('x-sjrawa-fresh'))) return;
  event.stopImmediatePropagation();
  event.respondWith((async () => {
    // Fresh downloads for the offline copy: decrypted here, checked against the manifest by abi-offline.js.
    if (!navigate) return self.fetch(request).catch(() => new Response(null, {status: 503}));
    // Pages: the lock page until this device has the current key; then the same order as the original worker.
    if (!(await lockKey())) return lockPage();
    try { const cached = await fromCache(request, canonicalPath(url.pathname)); if (cached) return cached; } catch { /* go online */ }
    try { return await self.fetch(request); }
    catch (error) { return error instanceof LockError ? lockPage() : offlineResponse(request); }
  })());
});

// A device without the current key (never unlocked, locked, or the password was changed) keeps no decrypted copies.
self.addEventListener('activate', event => event.waitUntil((async () => {
  if (!(await lockKey())) await caches.delete(CACHE);
})()));

// The lock page asks which key this worker expects before it reloads into the site.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'sjrawa-lock-ping' && event.ports[0]) event.ports[0].postMessage({keyId: LOCK.keyId});
});
// ----- Original offline worker (dist/abi-sw.js) -------------------------------------------------------------------
const CACHE = 'sjrawa-abitur-offline-assets-v1';
const META = '/__sjrawa_offline__/index';
const PREFIX = '/sjrawa-abitur';

function canonicalPath(path) {
  if (path === PREFIX || path === `${PREFIX}/`) return '/';
  const unprefixed = path.startsWith(`${PREFIX}/`) ? path.slice(PREFIX.length) : path;
  return unprefixed === '/index.html' ? '/' : unprefixed;
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || (!match[1] && !match[2]) || size < 1) return null;
  const suffix = match[1] === '';
  const left = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const right = suffix || match[2] === '' ? size - 1 : Math.min(size - 1, Number(match[2]));
  return Number.isSafeInteger(left) && Number.isSafeInteger(right) && left <= right ? [left, right] : null;
}

async function fromCache(request, path) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(new URL(META, self.location.origin));
  if (!saved) return null;
  const entry = (await saved.json()).assets?.[path];
  if (!entry) return null;
  const cached = await cache.match(entry.key);
  if (!cached) return null;
  if (request.method === 'HEAD') return new Response(null, {headers:cached.headers});
  const range = request.headers.get('range');
  if (!range) return cached;
  const bounds = parseRange(range, entry.bytes);
  if (!bounds) return new Response(null, {status:416, headers:{'Content-Range':`bytes */${entry.bytes}`}});
  const [left, right] = bounds;
  const body = (await cached.blob()).slice(left, right + 1);
  return new Response(body, {status:206, headers:{
    'Content-Type':cached.headers.get('Content-Type') || 'application/octet-stream',
    'Content-Length':String(right - left + 1),
    'Content-Range':`bytes ${left}-${right}/${entry.bytes}`,
    'Accept-Ranges':'bytes',
  }});
}

function offlineResponse(request) {
  if (request.mode === 'navigate') {
    return new Response('<!doctype html><meta charset="utf-8"><title>sjrawa Abitur · 离线</title><h1>此页面尚未下载</h1><p>请在可以访问电脑网站时打开「数据与离线管理」，下载所需内容。</p>', {
      status:503, headers:{'Content-Type':'text/html; charset=utf-8'},
    });
  }
  return new Response('Resource not available offline', {status:503, headers:{'Content-Type':'text/plain; charset=utf-8'}});
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !['GET','HEAD'].includes(request.method) || request.headers.has('x-sjrawa-fresh')) return;
  const path = canonicalPath(url.pathname);
  const offlineApi = path === '/api/offline/reader' || /^\/api\/offline\/blob\/[a-f0-9]{64}$/.test(path);
  if (path.startsWith('/__sjrawa_offline__/') || path.startsWith('/api/') && !offlineApi) return;
  event.respondWith((async () => {
    try {
      const cached = await fromCache(request, path);
      if (cached) return cached;
    } catch { /* An unreadable cache must not prevent a normal online visit. */ }
    try { return await fetch(request); }
    catch { return offlineResponse(request); }
  })());
});
