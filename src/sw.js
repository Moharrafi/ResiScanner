import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

self.skipWaiting();
clientsClaim();

cleanupOutdatedCaches();

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.method === 'POST' && url.pathname === '/share-target') {
        event.respondWith(
            (async () => {
                const formData = await event.request.formData();
                const mediaFiles = formData.getAll('media');

                if (mediaFiles && mediaFiles.length > 0) {
                    const cache = await caches.open('share-target');

                    // Store all shared files, indexed by position
                    // Clear old shared files first to avoid stale data
                    await cache.delete('shared-file-count');
                    const keys = await cache.keys();
                    for (const key of keys) {
                        const keyUrl = new URL(key.url);
                        if (keyUrl.pathname.startsWith('/shared-file')) {
                            await cache.delete(key);
                        }
                    }

                    // Store each file with index
                    for (let i = 0; i < mediaFiles.length; i++) {
                        await cache.put(`/shared-file-${i}`, new Response(mediaFiles[i]));
                    }
                    // Store count so app knows how many to retrieve
                    await cache.put('/shared-file-count', new Response(String(mediaFiles.length)));
                }

                return Response.redirect('/?shared=true', 303);
            })()
        );
    }
});
