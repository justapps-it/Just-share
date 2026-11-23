/// <reference lib="webworker" />
// Offline: the whole app (including the WebAssembly decoders) is cached, so
// the camera mode works with no connection at all. Also receives files
// shared from other apps (PWA share target).
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: { url: string; revision: string | null }[] };

self.skipWaiting();
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share-target') return;
  event.respondWith(
    (async () => {
      try {
        const form = await event.request.formData();
        const cache = await caches.open('justshare-incoming-share');
        let n = 0;
        for (const v of form.getAll('files')) {
          if (!(v instanceof File)) continue;
          await cache.put(`/incoming/${Date.now()}-${n++}`, new Response(v, { headers: { 'content-type': v.type || 'application/octet-stream', 'x-name': encodeURIComponent(v.name) } }));
        }
      } catch {
        /* ignore */
      }
      return Response.redirect('/?share=1', 303);
    })(),
  );
});

registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/share-target/] }));
