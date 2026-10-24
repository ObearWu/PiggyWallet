/* 只快取網站外殼（HTML / CSS / JS / 圖示），讓沒網路時也打得開。
 * 一律「網路優先、失敗才用快取」：改版之後下一次開啟就是新版，
 * 不會卡在舊程式。帳本資料走後端 API（另一個網域），這裡完全不碰。 */
const CACHE = "piggywallet-shell-v1";
const SHELL = ["./", "index.html", "assets/style.css", "assets/app.js", "assets/icon.svg", "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
  );
});
