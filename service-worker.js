/* Web Push displays generic messages only. Never read private letter content here. */
self.addEventListener('push', event => {
  const scope = self.registration.scope;
  const destination = new URL('./#/notifications', scope).href;
  const options = {
    body: 'Abre Nuestro Rincón para leerla.',
    icon: new URL('./assets/icons/mark.svg', scope).href,
    badge: new URL('./assets/icons/mark.svg', scope).href,
    tag: 'nuestro-rincon-new-letter',
    renotify: false,
    data: { destination }
  };
  event.waitUntil(self.registration.showNotification('Tienes una nueva carta', options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const scope = self.registration.scope;
  const destination = new URL('./#/notifications', scope);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      const current = new URL(client.url);
      if (current.origin !== destination.origin || !current.pathname.startsWith(new URL(scope).pathname)) continue;
      if (typeof client.navigate === 'function') await client.navigate(destination.href);
      await client.focus();
      return;
    }
    await self.clients.openWindow(destination.href);
  })());
});
