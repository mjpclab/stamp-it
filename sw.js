/* Service Worker：装机后完全离线可用，联网时自动跟进新版。
   路径一律相对于本文件，所以站点挂在任何子目录（含 GitHub Pages 的 /stamp-it/）都能用。 */

const CACHE = 'stampit-v1';

// 装机即预缓存的全部资源，缺一不可离线
const PRECACHE = [
  './',
  './index.html',
  './index.css',
  './index.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// 导航请求：优先网络（保证能拿到新版），断网时回落缓存的首页
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(req)) || (await cache.match('./index.html')) || Response.error();
  }
}

// 静态资源：先给缓存立刻渲染，后台顺手更新，下次打开就是新版
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const fetching = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await fetching) || Response.error();
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(req.mode === 'navigate' ? networkFirst(req) : staleWhileRevalidate(req));
});
