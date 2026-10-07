const CACHE_NAME = 'bitacora-shell-v43';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
  '/assets/field-grass.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo se cachea con GET. Todo lo demás (POST/PUT, etc.) pasa directo a la red.
  if (req.method !== 'GET') return;

  // NUNCA interceptar los datos del usuario (Supabase) ni las funciones serverless:
  // si el service worker devolviera una copia vieja, la app mostraría datos desactualizados
  // y los cambios recién cargados "desaparecerían" al reabrir.
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in') ||
      url.hostname.includes('jsonbin.io') || url.pathname.startsWith('/.netlify/functions/')) {
    return;
  }

  // La página principal: red primero (así cada deploy se aplica al instante); sin red, copia guardada.
  const isPage = req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sw.js';
  if (isPage && url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      }).catch(() => caches.match(req).then((c) => c || caches.match('/index.html') || caches.match('/')))
    );
    return;
  }

  // Resto de archivos estáticos (íconos, librerías, fuentes): cache primero, actualizando en segundo plano.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'Nutrym';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.openWindow(url));
});
