self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'FemmaDexDrive', body: event.data?.text() || 'New dispatch request.' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'FemmaDexDrive', { body: data.body || 'New dispatch request.', icon: '/images/Logo-mark.png', badge: '/images/Logo-mark.png', data: data.url || '/rider' }));
});
self.addEventListener('notificationclick', event => { event.notification.close(); event.waitUntil(clients.openWindow(event.notification.data || '/rider')); });
