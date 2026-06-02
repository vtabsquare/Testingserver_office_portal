/**
 * Service Worker for FaceAuth Push Notifications
 * This enables notifications even when the browser is minimized
 */

const FACEAUTH_VERIFY_URL = 'https://biometrics.vtabsquare.com/external-verify';

// Listen for push events (for future server-side push)
self.addEventListener('push', (event) => {
    console.log('[SW-FACEAUTH] Push event received');
    
    const data = event.data ? event.data.json() : {};
    const title = data.title || '🔔 Face Verification Alert';
    const options = {
        body: data.body || 'Please verify your face',
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        tag: data.tag || 'faceauth-alert',
        requireInteraction: true,
        vibrate: [200, 100, 200],
        data: {
            url: data.url || '/',
            status: data.status
        }
    };
    
    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
    console.log('[SW-FACEAUTH] Notification clicked');
    event.notification.close();
    
    const urlToOpen = event.notification.data?.url || '/';
    
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((windowClients) => {
                // Check if there's already a window open
                for (const client of windowClients) {
                    if (
                        client.url.includes('localhost:3000')
                        || client.url.includes('officeportal.vtabsquare.com')
                        || client.url.includes('officehub360.vtabsquare.com')
                        || client.url.includes('index.html')
                    ) {
                        client.focus();
                        return client;
                    }
                }
                // If no window open, open a new one
                return clients.openWindow(urlToOpen);
            })
    );
});

// Listen for messages from the main thread
self.addEventListener('message', (event) => {
    console.log('[SW-FACEAUTH] Message received:', event.data);
    
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        const { title, body, tag, status } = event.data;
        
        self.registration.showNotification(title, {
            body,
            icon: '/favicon.ico',
            badge: '/favicon.ico',
            tag: tag || 'faceauth-alert',
            requireInteraction: status === 'overdue' || status === 'missed',
            vibrate: [200, 100, 200],
            data: {
                url: '/',
                status
            }
        });
    }
});

// Install event
self.addEventListener('install', (event) => {
    console.log('[SW-FACEAUTH] Service Worker installed');
    self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
    console.log('[SW-FACEAUTH] Service Worker activated');
    event.waitUntil(clients.claim());
});
