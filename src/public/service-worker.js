self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {}
  const options = {
    body: data.body || 'New notification from VoltCore',
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    data: { link: data.link || '/' }
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'VoltCore', options)
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    clients.openWindow(event.notification.data.link || '/')
  )
})