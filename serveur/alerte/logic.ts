// Alerte « neige près de chez toi » : la partie qui réfléchit (météo des lieux surveillés, puis « faut-il prévenir ? »).
// Aucun secret ici. Même calcul de neige au sol que dans l'app (stock + chutes − fonte).

export type Pt = { n: string; la: number; lo: number; a: number; m: number; k?: string; f?: number };
export type Wx = Pt & { depth: number; snowing: boolean; fall: number[]; est: number[]; dates: string[] };
export type Msg = { title: string; body: string; url: string; tag: string };

export const PAGE = "https://yohan31431.github.io/ou-est-la-neige/";
const OM = "https://api.open-meteo.com/v1/forecast";
const SNOW = new Set([71, 73, 75, 77, 85, 86]);
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const P = 3; // jours passés relus : la neige tombée récemment compte
const keep = (t: number | null) => t == null ? .8 : t <= 0 ? .97 : t <= 3 ? .85 : t <= 6 ? .65 : t <= 10 ? .4 : .15;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const dur = (m: number) => { m = Math.max(1, Math.round(m)); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0"); };
const km = (k: number) => (k < 10 ? (Math.round(k * 10) / 10).toLocaleString("fr-FR") : String(Math.round(k))) + " km";
export const thick = (cm: number) => cm >= 20 ? "Épaisse" : cm >= 5 ? "Bonne pour une balade" : "Fine couche";
const dayWord = (iso: string, d: number) => d === 0 ? "aujourd'hui" : d === 1 ? "demain" : DAYS[new Date(iso + "T12:00:00Z").getUTCDay()];

// lit la réponse d'Open-Meteo pour un lieu
export function read(p: Pt, x: any): Wx | null {
  const D = x && x.daily; if (!D || !D.time) return null;
  const fallAll: number[] = (D.snowfall_sum || []).map((v: number | null) => v || 0);
  const tmaxAll: (number | null)[] = (D.temperature_2m_max || []).map((v: number | null) => v == null ? null : v);
  let recent = 0; for (let k = 0; k < P; k++) recent = recent * keep(tmaxAll[k]) + fallAll[k];
  const depth = Math.max(Math.round(((x.current && x.current.snow_depth) || 0) * 100), Math.floor(recent));
  const fall = fallAll.slice(P), tmax = tmaxAll.slice(P), hs: (number | null)[] = (x.hourly && x.hourly.snow_depth) || [];
  let pack = depth;
  const est = fall.map((f, i) => {
    const v = hs.slice((i + P) * 4, (i + P) * 4 + 4).filter(n => n != null) as number[];
    pack = pack * keep(tmax[i]) + f;
    return Math.round(Math.max(pack, v.length ? Math.max(...v) * 100 : 0, i === 0 ? depth : 0));
  });
  return { ...p, depth, snowing: SNOW.has(x.current && x.current.weather_code), fall, est, dates: D.time.slice(P) };
}

export async function weather(pts: Pt[]): Promise<Wx[]> {
  const res: Wx[] = [];
  for (let i = 0; i < pts.length; i += 50) {
    const ch = pts.slice(i, i + 50);
    const u = OM + "?latitude=" + ch.map(p => p.la.toFixed(3)).join(",") + "&longitude=" + ch.map(p => p.lo.toFixed(3)).join(",") + "&elevation=" + ch.map(p => Math.round(p.a)).join(",")
      + "&current=snow_depth,weather_code&daily=snowfall_sum,temperature_2m_max&hourly=snow_depth&temporal_resolution=hourly_6&past_days=" + P + "&forecast_days=5&timezone=auto";
    let r = await fetch(u);
    if (!r.ok) { await sleep(4000); r = await fetch(u); }
    if (!r.ok) throw new Error("meteo " + r.status);
    let d = await r.json(); if (!Array.isArray(d)) d = [d];
    d.forEach((x: any, k: number) => { const w = ch[k] && read(ch[k], x); if (w) res.push(w); });
  }
  return res;
}

type Hit = { p: Wx; d: number; cm: number; now: boolean; fd: number; fcm: number; rank: number };
const keyOf = (p: Pt) => p.la.toFixed(3) + "," + p.lo.toFixed(3);

// les lieux où il y a (ou va y avoir, d'ici 3 jours) assez de neige, du plus intéressant au moins intéressant
export function hitsOf(W: Wx[], minCm: number): Hit[] {
  const hits: Hit[] = [];
  for (const p of W) {
    const min = p.k === "home" ? 1 : minCm;
    let d = -1, cm = 0;
    if (p.depth >= min) { d = 0; cm = p.depth; }
    else for (let i = 0; i < Math.min(4, p.est.length); i++) if (p.est[i] >= min) { d = i; cm = p.est[i]; break; }
    if (d < 0) continue;
    let fd = -1; for (let i = 0; i < Math.min(3, p.fall.length); i++) if (p.fall[i] >= 5) { fd = i; break; }
    hits.push({ p, d, cm, now: p.depth >= min, fd, fcm: fd >= 0 ? Math.round(p.fall[fd]) : 0, rank: p.m + d * 25 });
  }
  return hits.sort((a, b) => a.rank - b.rank);
}

const urlOf = (p: Pt) => p.k === "home" ? PAGE : PAGE + "?coin=" + p.la.toFixed(4) + "," + p.lo.toFixed(4) + "&n=" + encodeURIComponent(p.n) + "&a=" + Math.round(p.a);
const also = (hits: Hit[], skip: Hit) => { const o = [...new Set(hits.filter(h => h !== skip && h.p.k !== "home" && h.p.n && h.p.n !== skip.p.n).map(h => h.p.n))].slice(0, 2); return o.length ? " Aussi : " + o.join(", ") + "." : ""; };
const road = (p: Pt) => "à " + dur(p.m) + " de route" + (p.f ? " + " + km(p.f) + " à pied" : "");

function msgNear(h: Hit, hits: Hit[]): Msg {
  const p = h.p, when = h.now ? "" : " " + dayWord(p.dates[h.d], h.d);
  if (p.k === "home") return { title: h.now ? "❄ Il y a de la neige chez toi" : "❄ Neige chez toi" + when, body: (h.now ? h.cm + " cm au sol." : "Environ " + h.cm + " cm prévus.") + also(hits, h), url: PAGE, tag: "neige-home" };
  return { title: "❄ Neige près de chez toi" + when, body: `${p.n} : ${h.now ? h.cm + " cm au sol" : "environ " + h.cm + " cm"}, ${road(p)}. ${thick(h.cm)}.` + also(hits, h), url: urlOf(p), tag: "neige-" + keyOf(p) };
}
function msgFresh(h: Hit, hits: Hit[]): Msg {
  const p = h.p;
  return { title: `❄ Neige fraîche ${dayWord(p.dates[h.fd], h.fd)} : +${h.fcm} cm`, body: (p.k === "home" ? "Chez toi." : `${p.n}, ${road(p)}.`) + also(hits, h), url: urlOf(p), tag: "neige-f-" + keyOf(p) };
}

// Faut-il prévenir ? On prévient quand la neige arrive près de chez toi, quand elle arrive encore plus près,
// ou quand il va retomber au moins 5 cm. Jamais deux fois la même chose, jamais plus d'une fois toutes les 6 h.
export function decide(W: Wx[], minCm: number, state: any, now: number): { st: any; msg: Msg | null; best: Hit | null; hits: Hit[] } {
  const hits = hitsOf(W, minCm), st = { ...(state || {}) };
  st.told = Object.fromEntries(Object.entries(st.told || {}).filter(([, t]) => now - (t as number) < 7 * 86400e3));
  if (!hits.length) {
    st.none = (st.none || 0) + 1;
    if (st.none >= 4) st.best = null; // plus de neige depuis 4 contrôles : la prochaine sera une nouvelle
    return { st, msg: null, best: null, hits };
  }
  st.none = 0;
  const best = hits[0], k = keyOf(best.p);
  if (st.at && now - st.at < 6 * 3600e3) return { st, msg: null, best, hits };
  const freshMax = hits.filter(h => h.fd >= 0).map(h => h.p.dates[h.fd]).sort().pop();
  let msg: Msg | null = null;
  const closer = !st.best || best.p.m < st.best.m - 20;
  if (closer && !(st.told[k] && now - st.told[k] < 48 * 3600e3)) {
    msg = msgNear(best, hits);
    st.told[k] = now;
    if (freshMax && freshMax > (st.fresh || "")) st.fresh = freshMax;
  } else {
    const f = hits.filter(h => h.fd >= 0 && h.p.dates[h.fd] > (st.fresh || "")).sort((a, b) => a.p.m - b.p.m)[0];
    if (f) { msg = msgFresh(f, hits); st.fresh = freshMax; }
  }
  st.best = { k, m: best.p.m, n: best.p.n };
  if (msg) st.at = now;
  return { st, msg, best, hits };
}

// le message envoyé quand on active l'alerte : il prouve que ça marche et dit où en est la neige
export function hello(W: Wx[], minCm: number, reach: number, label: string, count: number, now: number): { st: any; msg: Msg } {
  const hits = hitsOf(W, minCm), best = hits[0], st: any = { told: {}, none: 0, at: now };
  let tail = "Pas de neige pour l'instant : je te préviens dès qu'elle arrive.";
  if (best) {
    const p = best.p, when = best.now ? "au sol" : dayWord(p.dates[best.d], best.d);
    tail = p.k === "home" ? `Neige chez toi : ${best.cm} cm ${when}.` : `Le plus proche : ${p.n}, ${best.cm} cm ${when}, ${road(p)}.`;
    st.best = { k: keyOf(p), m: p.m, n: p.n }; st.told[keyOf(p)] = now;
    const fm = hits.filter(h => h.fd >= 0).map(h => h.p.dates[h.fd]).sort().pop(); if (fm) st.fresh = fm;
  }
  return { st, msg: { title: "❄ Alerte neige activée", body: `Je surveille ${count} lieu${count > 1 ? "x" : ""} à moins de ${dur(reach)} de ${label || "chez toi"}. ` + tail, url: best && best.p.k !== "home" ? urlOf(best.p) : PAGE, tag: "neige-on" } };
}
