/* ホーム画面に追加できるようにするための最小のService Worker。
   通信には一切介入しない(キャッシュしない・横取りしない)ので、古い画面が残ることも、APIが壊れることもない。 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
