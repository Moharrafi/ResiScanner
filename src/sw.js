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
                const mediaFiles = formData.getAll('media'); // 'media' matches the manifest key

                if (mediaFiles && mediaFiles.length > 0) {
                    const file = mediaFiles[0];
                    const cache = await caches.open('share-target');
                    // Store the file specifically to be picked up
                    await cache.put('shared-file', new Response(file));
                }

                // Redirect to the app with a query param
                return Response.redirect('/?shared=true', 303);
            })()
        );
    }
});
