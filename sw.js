const CACHE = 'spok-v7';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png',
  './audio/k1-1.mp3','./audio/k1-2.mp3','./audio/k1-3.mp3','./audio/k10-1.mp3','./audio/k10-2.mp3','./audio/k10-3.mp3','./audio/k11-1.mp3','./audio/k11-2.mp3','./audio/k11-3.mp3','./audio/k12-1.mp3','./audio/k12-2.mp3','./audio/k12-3.mp3','./audio/k2-1.mp3','./audio/k2-2.mp3','./audio/k2-3.mp3','./audio/k2-4.mp3','./audio/k3-1.mp3','./audio/k3-2.mp3','./audio/k3-3.mp3','./audio/k4-1.mp3','./audio/k4-2.mp3','./audio/k4-3.mp3','./audio/k5-1.mp3','./audio/k5-2.mp3','./audio/k5-3.mp3','./audio/k6-1.mp3','./audio/k6-2.mp3','./audio/k6-3.mp3','./audio/k7-1.mp3','./audio/k7-2.mp3','./audio/k7-3.mp3','./audio/k8-1.mp3','./audio/k8-2.mp3','./audio/k8-3.mp3','./audio/k9-1.mp3','./audio/k9-2.mp3','./audio/k9-3.mp3','./audio/ki1.mp3','./audio/ki10.mp3','./audio/ki11.mp3','./audio/ki12.mp3','./audio/ki2.mp3','./audio/ki3.mp3','./audio/ki4.mp3','./audio/ki5.mp3','./audio/ki6.mp3','./audio/ki7.mp3','./audio/ki8.mp3','./audio/ki9.mp3','./audio/kt1.mp3','./audio/kt10.mp3','./audio/kt11.mp3','./audio/kt12.mp3','./audio/kt2.mp3','./audio/kt3.mp3','./audio/kt4.mp3','./audio/kt5.mp3','./audio/kt6.mp3','./audio/kt7.mp3','./audio/kt8.mp3','./audio/kt9.mp3','./audio/l1-1.mp3','./audio/l1-2.mp3','./audio/l1-3.mp3','./audio/l10-1.mp3','./audio/l10-2.mp3','./audio/l10-3.mp3','./audio/l11-1.mp3','./audio/l11-2.mp3','./audio/l11-3.mp3','./audio/l12-1.mp3','./audio/l12-2.mp3','./audio/l12-3.mp3','./audio/l13-1.mp3','./audio/l13-2.mp3','./audio/l13-3.mp3','./audio/l14-1.mp3','./audio/l14-2.mp3','./audio/l14-3.mp3','./audio/l15-1.mp3','./audio/l15-2.mp3','./audio/l15-3.mp3','./audio/l16-1.mp3','./audio/l16-2.mp3','./audio/l16-3.mp3','./audio/l17-1.mp3','./audio/l17-2.mp3','./audio/l17-3.mp3','./audio/l18-1.mp3','./audio/l18-2.mp3','./audio/l18-3.mp3','./audio/l19-1.mp3','./audio/l19-2.mp3','./audio/l19-3.mp3','./audio/l2-1.mp3','./audio/l2-2.mp3','./audio/l2-3.mp3','./audio/l20-1.mp3','./audio/l20-2.mp3','./audio/l20-3.mp3','./audio/l21-1.mp3','./audio/l21-2.mp3','./audio/l21-3.mp3','./audio/l22-1.mp3','./audio/l22-2.mp3','./audio/l22-3.mp3','./audio/l23-1.mp3','./audio/l23-2.mp3','./audio/l23-3.mp3','./audio/l24-1.mp3','./audio/l24-2.mp3','./audio/l24-3.mp3','./audio/l25-1.mp3','./audio/l25-2.mp3','./audio/l25-3.mp3','./audio/l26-1.mp3','./audio/l26-2.mp3','./audio/l26-3.mp3','./audio/l27-1.mp3','./audio/l27-2.mp3','./audio/l27-3.mp3','./audio/l28-1.mp3','./audio/l28-2.mp3','./audio/l28-3.mp3','./audio/l29-1.mp3','./audio/l29-2.mp3','./audio/l29-3.mp3','./audio/l3-1.mp3','./audio/l3-2.mp3','./audio/l3-3.mp3','./audio/l4-1.mp3','./audio/l4-2.mp3','./audio/l4-3.mp3','./audio/l5-1.mp3','./audio/l5-2.mp3','./audio/l5-3.mp3','./audio/l6-1.mp3','./audio/l6-2.mp3','./audio/l6-3.mp3','./audio/l7-1.mp3','./audio/l7-2.mp3','./audio/l7-3.mp3','./audio/l8-1.mp3','./audio/l8-2.mp3','./audio/l8-3.mp3','./audio/l9-1.mp3','./audio/l9-2.mp3','./audio/l9-3.mp3','./audio/w1.mp3','./audio/w2.mp3','./audio/w3.mp3','./audio/w4.mp3','./audio/w5.mp3','./audio/w6.mp3','./audio/w7.mp3'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Safari asks for audio with Range headers; answer those with a 206 slice of the cached file.
async function rangeResponse(req, res) {
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
  end = Math.min(end, size - 1);
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !isFont) return;

  if (req.headers.has('range')) {
    e.respondWith((async () => {
      const cached = await caches.match(url.pathname.replace(/^.*\/audio\//, './audio/')) || await caches.match(req.url);
      if (cached) return rangeResponse(req, cached);
      return fetch(req);
    })());
    return;
  }

  // Pages: network first so updates arrive quickly; cache when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res;
    }).catch(() => caches.match('./index.html').then(r => r || caches.match('./'))));
    return;
  }

  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});
