// Uygulama kabuğu önbelleği.
// - Sayfa (HTML): önce ağ, ağ yoksa önbellek → yeni sürümler hemen görünür.
// - Aynı origin'deki statik dosyalar: önbellek, arkada güncelle.
// - Başka origin'ler (API, MGM, analytics): HİÇ önbelleğe alınmaz → dağıtım verisi hep güncel.
const CACHE = 'dagitim-gunu-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './dijitalkurye_logo_seffaf.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API ve 3. taraf istekleri tarayıcıya bırak
  if (url.pathname.endsWith('/admin.html')) return; // admin paneli önbelleğe alınmaz

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(resp => {
          if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); }
          return resp;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(resp => {
        if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return resp;
      });
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net;
    })
  );
});
