// 오프라인 지원 서비스워커
// 은행 안이나 지하처럼 신호가 약한 곳에서도 앱이 열리게 한다.
//
// 방식: 캐시를 먼저 보여주고(즉시 열림) 뒤에서 항상 새로 받아 캐시를 갱신한다.
// 캐시만 쓰면 새 배포가 영영 안 보이고, 네트워크만 쓰면 오프라인에서 안 열린다.
// 배포할 때마다 CACHE 이름을 바꾸면 옛 캐시가 정리된다.
const CACHE = 'banca-v1';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  // 아이콘 하나가 없어도 설치가 통째로 실패하지 않도록 개별로 담는다.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
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

  // 우리 페이지 파일만 다룬다. 카카오 지도와 Apps Script 요청은 건드리지 않는다
  // (JSONP는 매번 콜백 이름이 달라 캐시해도 의미가 없고, 잘못 끼어들면 오히려 깨진다).
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  // 주소창으로 앱을 여는 경우: 쿼리(?v=..)가 붙어도 같은 화면으로 본다.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html', { ignoreSearch: true }).then(cached => {
        const net = fetch(req).then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put('./index.html', copy));
          }
          return res;
        }).catch(() => cached);
        return cached || net;
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => {
      const net = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
