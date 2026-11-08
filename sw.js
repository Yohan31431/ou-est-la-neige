// Hors connexion : la page elle-même (réseau d'abord), la carte et la police (mémoire d'abord)
const C = "neige-v10";
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
self.addEventListener("install", e => { e.waitUntil(caches.open(C).then(c => c.addAll(["./", "./index.html", "./icon.svg", "./icon-192.png", "./manifest.webmanifest"]))); self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C && k !== "neige-alerte").map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  if (u.origin === location.origin) {
    e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(m => m || caches.match("./"))));
  } else if (CDN.test(e.request.url)) {
    e.respondWith(caches.open(C).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok || r.type === "opaque") c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});

/* Alerte neige : Android réveille l'app installée de temps en temps ; on regarde Mes coins et on prévient si la neige arrive */
const AK = new URL("alerte.json", self.registration.scope).href;
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
async function checkSnow() {
  const box = await caches.open("neige-alerte");
  const r = await box.match(AK); if (!r) return;
  const cfg = await r.json(); if (!cfg.on || !cfg.favs || !cfg.favs.length) return;
  const seen = cfg.seen || {}, F = cfg.favs;
  const u = "https://api.open-meteo.com/v1/forecast?latitude=" + F.map(f => f.lat).join(",") + "&longitude=" + F.map(f => f.lon).join(",")
    + (F.every(f => f.alt != null) ? "&elevation=" + F.map(f => f.alt).join(",") : "") + "&current=snow_depth&daily=snowfall_sum&forecast_days=4&timezone=auto";
  let d = await (await fetch(u)).json(); if (!Array.isArray(d)) d = [d];
  const hits = [];
  d.forEach((x, i) => {
    const f = F[i], fall = x?.daily?.snowfall_sum || [], t = x?.daily?.time || [];
    const k = fall.findIndex(v => v >= cfg.min);
    if (k >= 0) { const key = f.lat + "," + f.lon + "@" + t[k]; if (!seen[key]) hits.push({ f, k, cm: Math.round(fall[k]), date: t[k], key }); }
    const dep = Math.round((x?.current?.snow_depth || 0) * 100), key0 = f.lat + "," + f.lon + "@sol";
    if (k < 0 && dep >= cfg.min && !seen[key0]) hits.push({ f, k: -1, cm: dep, key: key0 });
  });
  if (!hits.length) return;
  hits.sort((a, b) => a.k - b.k);
  const h = hits[0], when = h.k < 0 ? "" : h.k === 0 ? " aujourd'hui" : h.k === 1 ? " demain" : " " + DAYS[new Date(h.date + "T12:00:00").getDay()];
  const title = h.k < 0 ? `❄ ${h.cm} cm de neige à ${h.f.name}` : `❄ Neige à ${h.f.name}${when} : +${h.cm} cm`;
  const more = hits.slice(1, 3).map(x => x.f.name).filter(n => n !== h.f.name);
  await self.registration.showNotification(title, {
    body: more.length ? "Aussi : " + more.join(", ") + ". Touche pour voir." : "Touche pour voir la note et la route.",
    icon: "icon-192.png", badge: "icon-192.png", tag: "neige-" + h.key,
    data: { url: cfg.page + "?coin=" + h.f.lat + "," + h.f.lon + "&n=" + encodeURIComponent(h.f.name) + (h.f.alt ? "&a=" + h.f.alt : "") }
  });
  hits.forEach(x => seen[x.key] = Date.now());
  for (const k in seen) if (Date.now() - seen[k] > 12 * 86400e3) delete seen[k];
  await box.put(AK, new Response(JSON.stringify({ ...cfg, seen })));
}
self.addEventListener("periodicsync", e => { if (e.tag === "neige-alerte") e.waitUntil(checkSnow().catch(() => {})); });
self.addEventListener("message", e => { if (e.data === "neige-test") e.waitUntil(checkSnow().catch(() => {})); });
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    const w = ws.find(c => c.url.startsWith(self.registration.scope));
    if (w) return w.navigate(url).then(c => (c || w).focus());
    return clients.openWindow(url);
  }));
});
