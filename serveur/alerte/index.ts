// Alerte « neige près de chez toi » : petit serveur (Supabase) de l'app « Où est la neige ? ».
// L'app s'abonne ici ; toutes les 3 h un minuteur appelle « check » : on regarde la météo des lieux surveillés
// et on envoie une notification au téléphone si la neige arrive. Les clés d'envoi restent dans la base (schéma privé « neige »).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";
import webpush from "npm:web-push@3.6.7";
import { decide, hello, weather, type Msg, type Pt } from "./logic.ts";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 10 });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-max-age": "86400" };
const out = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
const PUSH_HOST = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
const KINDS = new Set(["home", "ski", "col", "top", "nat"]);
const num = (v: unknown, lo: number, hi: number, def: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

let CONF: Record<string, string> | null = null;
async function config() {
  if (CONF && CONF.vapid_pub) return CONF;
  const load = async () => Object.fromEntries((await sql`select key, value from neige.config`).map(r => [r.key, r.value]));
  let c = await load();
  if (!c.vapid_pub) { // première fois : le serveur fabrique lui-même ses clés d'envoi
    const k = webpush.generateVAPIDKeys();
    await sql`insert into neige.config (key, value) values ('vapid_pub', ${k.publicKey}), ('vapid_priv', ${k.privateKey}) on conflict (key) do nothing`;
    c = await load();
  }
  return CONF = c;
}

async function send(s: { endpoint: string; p256dh: string; auth: string }, msg: Msg): Promise<number> {
  const c = await config();
  try {
    const r = await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg),
      { vapidDetails: { subject: "https://yohan31431.github.io/ou-est-la-neige/", publicKey: c.vapid_pub, privateKey: c.vapid_priv }, TTL: 12 * 3600, urgency: "normal" });
    return r.statusCode;
  } catch (e) { console.error("push", (e as any)?.statusCode, (e as any)?.body || (e as any)?.message); return (e as any)?.statusCode || 0; }
}
const gone = (code: number) => code === 404 || code === 410;

function cleanPoints(v: unknown): Pt[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 60).map((p: any) => ({ n: String(p?.n ?? "").slice(0, 60), la: Number(p?.la), lo: Number(p?.lo), a: num(p?.a, 0, 5000, 0), m: num(p?.m, 0, 900, 0), k: KINDS.has(p?.k) ? p.k : "nat", f: p?.f ? num(p.f, 0, 30, 0) : undefined }))
    .filter(p => Number.isFinite(p.la) && Number.isFinite(p.lo) && Math.abs(p.la) <= 90 && Math.abs(p.lo) <= 180);
}

async function checkAll() {
  const subs = await sql`select * from neige.subs order by checked_at nulls first limit 300`;
  let sent = 0, checked = 0;
  for (const s of subs) {
    try {
      const pts = cleanPoints(s.points); if (!pts.length) continue;
      const r = decide(await weather(pts), s.min_cm, s.state, Date.now());
      checked++;
      if (r.msg) {
        const code = await send(s, r.msg);
        if (gone(code)) { await sql`delete from neige.subs where id = ${s.id}`; continue; }
        if (code >= 200 && code < 300) { sent++; await sql`update neige.subs set state = ${sql.json(r.st)}, checked_at = now(), notified_at = now(), fails = 0 where id = ${s.id}`; }
        else await sql`update neige.subs set checked_at = now(), fails = fails + 1 where id = ${s.id}`; // on réessaiera au prochain contrôle
      } else await sql`update neige.subs set state = ${sql.json(r.st)}, checked_at = now() where id = ${s.id}`;
    } catch (e) { console.error("check", s.id, (e as any)?.message); }
  }
  return { subs: subs.length, checked, sent };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    if (req.method === "GET") return out({ key: (await config()).vapid_pub });
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object") return out({ error: "demande illisible" }, 400);

    if (b.op === "check") {
      if (req.headers.get("x-cron") !== (await config()).cron) return out({ error: "interdit" }, 403);
      return out(await checkAll());
    }

    const ep = String(b.sub?.endpoint || b.endpoint || "");
    try { const u = new URL(ep); if (u.protocol !== "https:" || !PUSH_HOST.test(u.hostname)) throw 0; } catch { return out({ error: "abonnement inconnu" }, 400); }

    if (b.op === "unsub") { await sql`delete from neige.subs where endpoint = ${ep}`; return out({ ok: true }); }

    if (b.op === "test") {
      const [s] = await sql`select * from neige.subs where endpoint = ${ep}`;
      if (!s) return out({ error: "pas abonné" }, 404);
      const code = await send(s, { title: "❄ Essai réussi", body: "Les alertes neige arrivent bien sur ce téléphone.", url: "https://yohan31431.github.io/ou-est-la-neige/", tag: "neige-test" });
      if (gone(code)) await sql`delete from neige.subs where id = ${s.id}`;
      return out({ ok: code >= 200 && code < 300, status: code });
    }

    if (b.op === "sub") {
      const p256dh = String(b.sub?.keys?.p256dh || ""), auth = String(b.sub?.keys?.auth || "");
      const lat = Number(b.lat), lon = Number(b.lon);
      if (!p256dh || !auth || p256dh.length > 200 || auth.length > 100 || !Number.isFinite(lat) || !Number.isFinite(lon)) return out({ error: "abonnement incomplet" }, 400);
      const pts = cleanPoints(b.points), label = String(b.label || "").slice(0, 60), min = Math.round(num(b.min, 1, 50, 3)), reach = Math.round(num(b.reach, 15, 600, 150));
      const [old] = await sql`select id from neige.subs where endpoint = ${ep}`;
      if (!old) { const [{ n }] = await sql`select count(*)::int as n from neige.subs`; if (n >= 300) return out({ error: "complet" }, 429); }
      const first = !old || !!b.hello;
      const [s] = await sql`insert into neige.subs (endpoint, p256dh, auth, lat, lon, label, min_cm, reach, points)
        values (${ep}, ${p256dh}, ${auth}, ${lat}, ${lon}, ${label}, ${min}, ${reach}, ${sql.json(pts)})
        on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, lat = excluded.lat, lon = excluded.lon, label = excluded.label,
          min_cm = excluded.min_cm, reach = excluded.reach, points = excluded.points, updated_at = now(), fails = 0
        returning *`;
      if (!first) return out({ ok: true, n: pts.length });
      let W: Awaited<ReturnType<typeof weather>> = [];
      try { W = await weather(pts); } catch (e) { console.error("meteo", (e as any)?.message); }
      const h = hello(W, min, reach, label, pts.filter(p => p.k !== "home").length, Date.now());
      const code = await send(s, h.msg);
      if (gone(code)) { await sql`delete from neige.subs where id = ${s.id}`; return out({ ok: false, status: code }); }
      await sql`update neige.subs set state = ${sql.json(h.st)}, checked_at = now(), notified_at = now() where id = ${s.id}`;
      return out({ ok: code >= 200 && code < 300, status: code, n: pts.length });
    }
    return out({ error: "op inconnue" }, 400);
  } catch (e) {
    console.error(e);
    return out({ error: "panne" }, 500);
  }
});
