// Dağıtım Günü – veri API'si (Cloudflare Worker + D1)
//
// Ortam değişkenleri / bağlamalar:
//   DB               D1 veritabanı
//   ADMIN_PASSWORD   (secret) admin paneli şifresi
//   OPTYMUS_TOKEN    (secret) api.optymus.pro Bearer token'ı
//   OPTYMUS_BASE     (ops.)   varsayılan https://api.optymus.pro
//   ALLOWED_ORIGINS  (ops.)   admin uçları için izinli origin listesi (virgülle). Boşsa "*".

const OPTYMUS_DEFAULT_BASE = "https://api.optymus.pro";
const OPTYMUS_PATH = "/api/app/work-zone/work-days-by-full-address";
const OPTYMUS_TIMEOUT_MS = 10000;
const OPTYMUS_CACHE_TTL = 3600; // sn

const ADMIN_MAX_FAIL = 10;          // pencere içinde izin verilen hatalı deneme
const ADMIN_FAIL_WINDOW_MIN = 15;
const ONERI_MAX_PER_HOUR = 5;

const DAY_KEYS = ["pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi", "pazar"];

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function corsHeaders(req, env, admin) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  let allow = "*";
  if (admin && allowed.length) allow = allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Admin-Password",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function makeJson(cors) {
  return (data, status = 200, extra = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", ...extra }
    });
}

// Türkçe karakter duyarsız arama anahtarı. SQL tarafındaki trKeySql() ile aynı sonucu üretmeli.
function trKey(v = "") {
  return String(v)
    .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
    .replace(/Ş/g, "s").replace(/ş/g, "s")
    .replace(/Ğ/g, "g").replace(/ğ/g, "g")
    .replace(/Ü/g, "u").replace(/ü/g, "u")
    .replace(/Ö/g, "o").replace(/ö/g, "o")
    .replace(/Ç/g, "c").replace(/ç/g, "c")
    .replace(/Â/g, "a").replace(/â/g, "a").replace(/Î/g, "i").replace(/î/g, "i").replace(/Û/g, "u").replace(/û/g, "u")
    .toLowerCase()
    .replace(/\b(mahallesi|mahalle|mah|mh|koyu|köyü)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// SQLite'ın lower() fonksiyonu yalnızca ASCII çevirir; Türkçe harfleri elle değiştiriyoruz.
function trKeySql(col) {
  const pairs = [["İ", "i"], ["I", "i"], ["ı", "i"], ["Ş", "s"], ["ş", "s"], ["Ğ", "g"], ["ğ", "g"],
    ["Ü", "u"], ["ü", "u"], ["Ö", "o"], ["ö", "o"], ["Ç", "c"], ["ç", "c"], ["Â", "a"], ["â", "a"],
    ["Î", "i"], ["î", "i"], ["Û", "u"], ["û", "u"]];
  let e = col;
  for (const [a, b] of pairs) e = `replace(${e},'${a}','${b}')`;
  return `lower(${e})`;
}
const ARAMA_EXPR = trKeySql(`il || ' ' || ilce || ' ' || mahalle`);

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function clientIp(req) {
  return req.headers.get("CF-Connecting-IP") || "0.0.0.0";
}

// ---------------------------------------------------------------------------
// Şema
// ---------------------------------------------------------------------------

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS dagitim_yeni (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      il TEXT NOT NULL, ilce TEXT NOT NULL, mahalle TEXT NOT NULL,
      pazartesi INTEGER DEFAULT 0, sali INTEGER DEFAULT 0, carsamba INTEGER DEFAULT 0,
      persembe INTEGER DEFAULT 0, cuma INTEGER DEFAULT 0, cumartesi INTEGER DEFAULT 0, pazar INTEGER DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_deneme (ip TEXT NOT NULL, ts INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_admin_deneme ON admin_deneme(ip, ts)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS oneri_limit (ip TEXT NOT NULL, ts INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_oneri_limit ON oneri_limit(ip, ts)`)
  ]);
  // Arama anahtarı sütunu (Türkçe karakter duyarsız arama için)
  try {
    await db.prepare(`ALTER TABLE dagitim ADD COLUMN arama TEXT`).run();
  } catch (e) { /* zaten var */ }
  const eksik = await db.prepare(`SELECT COUNT(*) AS n FROM dagitim WHERE arama IS NULL`).first();
  if (Number(eksik?.n || 0) > 0) {
    await db.prepare(`UPDATE dagitim SET arama = ${ARAMA_EXPR} WHERE arama IS NULL`).run();
  }
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_dagitim_arama ON dagitim(arama)`).run();
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Admin yetkilendirme + deneme sınırı
// ---------------------------------------------------------------------------

async function adminAuth(req, env) {
  if (!env.ADMIN_PASSWORD) return { ok: false, status: 503, error: "Admin şifresi tanımlı değil" };
  const ip = clientIp(req);
  const since = Date.now() - ADMIN_FAIL_WINDOW_MIN * 60000;
  const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM admin_deneme WHERE ip = ? AND ts > ?`).bind(ip, since).first();
  if (Number(c?.n || 0) >= ADMIN_MAX_FAIL) {
    return { ok: false, status: 429, error: `Çok fazla hatalı deneme. ${ADMIN_FAIL_WINDOW_MIN} dakika sonra tekrar deneyin.` };
  }
  const p = req.headers.get("X-Admin-Password") || "";
  if (!timingSafeEqual(p, env.ADMIN_PASSWORD)) {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO admin_deneme (ip, ts) VALUES (?, ?)`).bind(ip, Date.now()),
      env.DB.prepare(`DELETE FROM admin_deneme WHERE ts < ?`).bind(since)
    ]);
    return { ok: false, status: 401, error: "Yetkisiz" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Optymus – tam adrese göre çalışma günleri
// ---------------------------------------------------------------------------

const DAY_NAME_MAP = {
  monday: 0, mon: 0, pazartesi: 0, pzt: 0,
  tuesday: 1, tue: 1, tues: 1, sali: 1, sal: 1,
  wednesday: 2, wed: 2, carsamba: 2, crs: 2, car: 2,
  thursday: 3, thu: 3, thur: 3, thurs: 3, persembe: 3, prs: 3, per: 3,
  friday: 4, fri: 4, cuma: 4, cum: 4,
  saturday: 5, sat: 5, cumartesi: 5, cts: 5, cmt: 5,
  sunday: 6, sun: 6, pazar: 6, pzr: 6, paz: 6
};

function dayIndexFromName(v) {
  const k = trKey(v).replace(/\s+/g, "");
  return k in DAY_NAME_MAP ? DAY_NAME_MAP[k] : -1;
}

function truthy(v) {
  if (v === true || v === 1) return true;
  if (typeof v === "string") return ["1", "true", "evet", "yes", "var", "acik", "aktif", "x"].includes(trKey(v));
  return false;
}

// .NET DayOfWeek: 0=Pazar..6=Cumartesi. ISO: 1=Pazartesi..7=Pazar.
// Listede 7 varsa ISO, aksi halde .NET kabul edilir.
function numbersToDays(nums) {
  const days = [0, 0, 0, 0, 0, 0, 0];
  const iso = nums.includes(7) && !nums.includes(0);
  for (const n of nums) {
    if (!Number.isInteger(n)) continue;
    const idx = iso ? (n - 1) : ((n + 6) % 7);
    if (idx >= 0 && idx < 7) days[idx] = 1;
  }
  return days;
}

// Yanıt şeması kesin bilinmediğinden olası biçimleri tolere eden çözümleyici.
// Desteklenen örnekler:
//   [1,2,3] / ["Monday","Friday"] / ["Pazartesi"]
//   {monday:true, tuesday:false,...} / {pazartesi:1,...}
//   [{dayOfWeek:1,isActive:true}, {day:"Monday"}]
//   {workDays:[...]} / {result:{...}} / {items:[...]} / {data:...}
function extractDays(payload, depth = 0) {
  if (payload == null || depth > 5) return null;

  if (typeof payload === "string") {
    const s = payload.trim();
    if (s.startsWith("[") || s.startsWith("{")) {
      try { return extractDays(JSON.parse(s), depth + 1); } catch { /* düz metin */ }
    }
    const parts = s.split(/[,;|/]+/).map(x => x.trim()).filter(Boolean);
    const idx = parts.map(dayIndexFromName).filter(i => i >= 0);
    if (idx.length) { const d = [0, 0, 0, 0, 0, 0, 0]; idx.forEach(i => d[i] = 1); return d; }
    return null;
  }

  if (Array.isArray(payload)) {
    if (!payload.length) return [0, 0, 0, 0, 0, 0, 0];
    if (payload.every(x => typeof x === "number")) return numbersToDays(payload);
    if (payload.every(x => typeof x === "string")) {
      const nums = payload.filter(x => /^\d+$/.test(x.trim())).map(Number);
      if (nums.length === payload.length) return numbersToDays(nums);
      const idx = payload.map(dayIndexFromName).filter(i => i >= 0);
      if (idx.length) { const d = [0, 0, 0, 0, 0, 0, 0]; idx.forEach(i => d[i] = 1); return d; }
      return null;
    }
    if (payload.every(x => x && typeof x === "object")) {
      // Gün nesneleri listesi mi?
      const dayKeys = ["dayOfWeek", "day", "dayName", "weekDay", "weekday", "gun", "name", "value"];
      const activeKeys = ["isActive", "active", "isWorkDay", "isWorkingDay", "enabled", "isEnabled", "selected", "aktif"];
      const nums = [], idx = [];
      let found = false;
      for (const o of payload) {
        // Gün değeri gerçekten bir gün olarak çözümlenebilen ilk anahtar
        let v = null, isNum = false;
        for (const k of dayKeys) {
          if (!(k in o)) continue;
          const x = o[k];
          if (typeof x === "number" || /^\d+$/.test(String(x))) { v = Number(x); isNum = true; break; }
          if (typeof x === "string" && dayIndexFromName(x) >= 0) { v = dayIndexFromName(x); break; }
        }
        if (v === null) continue;
        found = true;
        const ak = activeKeys.find(k => k in o);
        if (ak && !truthy(o[ak])) continue;
        if (isNum) nums.push(v); else idx.push(v);
      }
      if (found) {
        const d = nums.length ? numbersToDays(nums) : [0, 0, 0, 0, 0, 0, 0];
        idx.forEach(i => d[i] = 1);
        return d;
      }
      // Birden fazla bölge döndüyse ilk çözümlenebileni al
      for (const o of payload) { const r = extractDays(o, depth + 1); if (r) return r; }
    }
    return null;
  }

  if (typeof payload === "object") {
    // Gün adı anahtarlı nesne: {monday:true,...}
    const keys = Object.keys(payload);
    const dayKeyed = keys.filter(k => dayIndexFromName(k) >= 0);
    if (dayKeyed.length >= 5) {
      const d = [0, 0, 0, 0, 0, 0, 0];
      dayKeyed.forEach(k => { if (truthy(payload[k])) d[dayIndexFromName(k)] = 1; });
      return d;
    }
    const prefer = ["workDays", "workdays", "work_days", "days", "calismaGunleri", "dagitimGunleri", "gunler",
      "result", "data", "items", "value", "workZone", "zone"];
    for (const k of prefer) {
      if (k in payload) { const r = extractDays(payload[k], depth + 1); if (r) return r; }
    }
    for (const k of keys) {
      if (prefer.includes(k)) continue;
      const v = payload[k];
      if (v && typeof v === "object") { const r = extractDays(v, depth + 1); if (r) return r; }
    }
  }
  return null;
}

function pickZoneInfo(payload) {
  const find = (o, keys, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 4) return null;
    for (const k of keys) if (o[k] != null && typeof o[k] !== "object") return o[k];
    for (const v of Object.values(o)) { const r = find(v, keys, depth + 1); if (r != null) return r; }
    return null;
  };
  return {
    bolge: find(payload, ["workZoneName", "zoneName", "name", "bolge"]),
    il: find(payload, ["city", "cityName", "il", "province"]),
    ilce: find(payload, ["district", "districtName", "town", "ilce"]),
    mahalle: find(payload, ["neighborhood", "neighbourhood", "neighborhoodName", "mahalle"])
  };
}

async function optymusWorkDays(env, fullAddress) {
  if (!env.OPTYMUS_TOKEN) {
    const e = new Error("Optymus token tanımlı değil (OPTYMUS_TOKEN)");
    e.status = 503;
    throw e;
  }
  const base = String(env.OPTYMUS_BASE || OPTYMUS_DEFAULT_BASE).replace(/\/+$/, "");
  const url = base + OPTYMUS_PATH + "?fullAddress=" + encodeURIComponent(fullAddress);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OPTYMUS_TIMEOUT_MS);
  let r, text;
  try {
    r = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + env.OPTYMUS_TOKEN,
        "Accept": "application/json"
      },
      signal: ctrl.signal
    });
    text = await r.text();
  } catch (e) {
    const err = new Error(e?.name === "AbortError" ? "Optymus yanıt vermedi (zaman aşımı)" : "Optymus bağlantı hatası");
    err.status = 504;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

async function handleAdresGun(req, env, u, json, ctx) {
  const adres = (u.searchParams.get("adres") || u.searchParams.get("fullAddress") || "").trim();
  if (adres.length < 5) return json({ ok: false, error: "Adres en az 5 karakter olmalı" }, 400);
  if (adres.length > 400) return json({ ok: false, error: "Adres çok uzun" }, 400);

  const debug = u.searchParams.get("debug") === "1";
  if (debug) {
    await ensureSchema(env.DB);
    const a = await adminAuth(req, env);
    if (!a.ok) return json({ ok: false, error: a.error }, a.status);
  }

  // Aynı adres için kısa süreli önbellek (Optymus'a gereksiz yük bindirmemek için)
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/adres-gun?k=" + encodeURIComponent(trKey(adres)));
  if (!debug) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const j = await hit.json();
      return json({ ...j, cache: true });
    }
  }

  let res;
  try {
    res = await optymusWorkDays(env, adres);
  } catch (e) {
    return json({ ok: false, kaynak: "optymus", error: e.message }, e.status || 502);
  }

  if (!res.ok) {
    const msg = (res.body && typeof res.body === "object" && (res.body.error?.message || res.body.message || res.body.title)) || null;
    const out = {
      ok: false, kaynak: "optymus", upstreamStatus: res.status,
      error: res.status === 401 || res.status === 403
        ? "Optymus yetkilendirme hatası (token geçersiz veya süresi dolmuş)"
        : res.status === 404
          ? (msg || "Adres için hizmet bölgesi bulunamadı")
          : (msg || "Optymus HTTP " + res.status)
    };
    if (debug) out.raw = res.body;
    // 404 = adres bölge dışı → istemci bunu "bulunamadı" olarak göstermeli
    return json(out, res.status === 404 ? 404 : 502);
  }

  const days = extractDays(res.body);
  const info = pickZoneInfo(res.body);
  const out = {
    ok: !!days,
    kaynak: "optymus",
    adres,
    days: days || null,
    ...info,
    checkedAt: new Date().toISOString()
  };
  if (!days) out.error = "Optymus yanıtı çözümlenemedi";
  if (debug) out.raw = res.body;

  if (days && !debug) {
    const toCache = new Response(JSON.stringify(out), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + OPTYMUS_CACHE_TTL }
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));
  }
  return json(out, days ? 200 : 502);
}

// ---------------------------------------------------------------------------
// Ana yönlendirici
// ---------------------------------------------------------------------------

const ROW_COLS = `il, ilce, mahalle, pazartesi, sali, carsamba, persembe, cuma, cumartesi, pazar`;

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    const isAdmin = u.pathname.startsWith("/admin/") || u.searchParams.get("debug") === "1";
    const cors = corsHeaders(req, env, isAdmin);
    const json = makeJson(cors);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      // ---------------- HEALTH ----------------
      if (u.pathname === "/health") {
        let db = false;
        try { await env.DB.prepare("SELECT 1").first(); db = true; } catch { }
        return json({ ok: db, db, optymus: !!env.OPTYMUS_TOKEN }, db ? 200 : 503);
      }

      // ---------------- META ----------------
      if (u.pathname === "/api/meta" && req.method === "GET") {
        const meta = await env.DB.prepare(`SELECT guncelleme_tarihi, kayit_sayisi FROM veri_bilgisi WHERE id = 1`).first();
        return json({ ok: true, meta: meta || null, optymus: !!env.OPTYMUS_TOKEN }, 200, { "Cache-Control": "public, max-age=300" });
      }

      // ---------------- OPTYMUS: TAM ADRES → GÜNLER ----------------
      if (u.pathname === "/api/adres-gun" && req.method === "GET") {
        return await handleAdresGun(req, env, u, json, ctx);
      }

      // ---------------- İLLER ----------------
      if (u.pathname === "/api/iller" && req.method === "GET") {
        const r = await env.DB.prepare(`
          SELECT DISTINCT il FROM dagitim
          WHERE il IS NOT NULL AND TRIM(il) <> ''
          ORDER BY il COLLATE NOCASE`).all();
        return json({ rows: (r.results || []).map(x => x.il) }, 200, { "Cache-Control": "public, max-age=600" });
      }

      // ---------------- İLÇELER ----------------
      if (u.pathname === "/api/ilceler" && req.method === "GET") {
        const il = (u.searchParams.get("il") || "").trim();
        if (!il) return json({ error: "il gerekli" }, 400);
        const r = await env.DB.prepare(`
          SELECT DISTINCT ilce FROM dagitim
          WHERE il = ? AND ilce IS NOT NULL AND TRIM(ilce) <> ''
          ORDER BY ilce COLLATE NOCASE`).bind(il).all();
        return json({ il, rows: (r.results || []).map(x => x.ilce) }, 200, { "Cache-Control": "public, max-age=600" });
      }

      // ---------------- MAHALLELER ----------------
      if (u.pathname === "/api/mahalleler" && req.method === "GET") {
        const il = (u.searchParams.get("il") || "").trim();
        const ilce = (u.searchParams.get("ilce") || "").trim();
        if (!il || !ilce) return json({ error: "il ve ilce gerekli" }, 400);
        const r = await env.DB.prepare(`
          SELECT DISTINCT mahalle FROM dagitim
          WHERE il = ? AND ilce = ?
          ORDER BY mahalle COLLATE NOCASE`).bind(il, ilce).all();
        return json({ il, ilce, rows: (r.results || []).map(x => x.mahalle) }, 200, { "Cache-Control": "public, max-age=600" });
      }

      // ---------------- TEK MAHALLE ----------------
      if (u.pathname === "/api/mahalle" && req.method === "GET") {
        const il = (u.searchParams.get("il") || "").trim();
        const ilce = (u.searchParams.get("ilce") || "").trim();
        const mahalle = (u.searchParams.get("mahalle") || "").trim();
        if (!il || !ilce || !mahalle) return json({ error: "il, ilce ve mahalle gerekli" }, 400);
        // Tekrarlı kayıtlarda en son yükleneni döndür
        const row = await env.DB.prepare(`
          SELECT ${ROW_COLS} FROM dagitim
          WHERE il = ? AND ilce = ? AND mahalle = ?
          ORDER BY id DESC LIMIT 1`).bind(il, ilce, mahalle).first();
        if (!row) return json({ error: "Mahalle bulunamadı" }, 404);
        return json({ row });
      }

      // ---------------- ADRES / MAHALLE ARAMA ----------------
      if (u.pathname === "/api/ara" && req.method === "GET") {
        const q = (u.searchParams.get("q") || "").trim();
        const key = trKey(q);
        if (key.length < 3) return json({ rows: [] });
        await ensureSchema(env.DB);

        // Her kelime anahtar içinde geçmeli; sıralama: mahalle adı tam/önek eşleşmesi önce.
        const toks = key.split(" ").filter(t => t.length >= 2).slice(0, 6);
        if (!toks.length) return json({ rows: [] });
        const where = toks.map(() => `arama LIKE ?`).join(" AND ");
        const binds = toks.map(t => `%${t}%`);
        const mahKey = trKeySql("mahalle");
        const first = toks[0];
        const r = await env.DB.prepare(`
          SELECT ${ROW_COLS},
            CASE
              WHEN ${mahKey} = ? THEN 0
              WHEN ${mahKey} LIKE ? THEN 1
              WHEN ${mahKey} LIKE ? THEN 2
              ELSE 3
            END AS skor
          FROM dagitim
          WHERE ${where}
          GROUP BY il, ilce, mahalle
          ORDER BY skor, length(mahalle), il, ilce, mahalle
          LIMIT 30`).bind(key, first + "%", "%" + first + "%", ...binds).all();
        const rows = (r.results || []).map(({ skor, ...x }) => x);
        return json({ q, rows });
      }

      // ---------------- ÖNERİ / TALEP GÖNDER ----------------
      if (u.pathname === "/api/oneri" && req.method === "POST") {
        await ensureSchema(env.DB);
        const body = await req.json().catch(() => ({}));
        // Bot tuzağı: görünmez alan doluysa sessizce kabul et
        if (String(body.website || "").trim()) return json({ ok: true });

        const adSoyad = String(body.ad_soyad || body.name || "").trim();
        const gsm = String(body.gsm || body.phone || "").trim();
        const email = String(body.email || "").trim();
        const aciklama = String(body.aciklama || body.message || "").trim();

        if (!adSoyad || !gsm || !email || !aciklama) return json({ ok: false, error: "Tüm alanları doldurun." }, 400);
        if (adSoyad.length > 120) return json({ ok: false, error: "Ad soyad çok uzun." }, 400);
        if (gsm.length > 30) return json({ ok: false, error: "GSM bilgisi geçersiz." }, 400);
        if (email.length > 180) return json({ ok: false, error: "E-posta adresi çok uzun." }, 400);
        if (aciklama.length > 3000) return json({ ok: false, error: "Açıklama en fazla 3000 karakter olabilir." }, 400);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "Geçerli bir e-posta adresi girin." }, 400);
        const gsmDigits = gsm.replace(/\D/g, "");
        if (gsmDigits.length < 10 || gsmDigits.length > 13) return json({ ok: false, error: "Geçerli bir GSM numarası girin." }, 400);

        const ip = clientIp(req);
        const hourAgo = Date.now() - 3600000;
        const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM oneri_limit WHERE ip = ? AND ts > ?`).bind(ip, hourAgo).first();
        if (Number(c?.n || 0) >= ONERI_MAX_PER_HOUR) {
          return json({ ok: false, error: "Çok fazla gönderim yaptınız. Lütfen daha sonra tekrar deneyin." }, 429);
        }

        const tarih = new Date().toISOString();
        const res = await env.DB.batch([
          env.DB.prepare(`INSERT INTO oneriler (ad_soyad, gsm, email, aciklama, tarih, durum) VALUES (?, ?, ?, ?, ?, 'Yeni')`)
            .bind(adSoyad, gsm, email, aciklama, tarih),
          env.DB.prepare(`INSERT INTO oneri_limit (ip, ts) VALUES (?, ?)`).bind(ip, Date.now()),
          env.DB.prepare(`DELETE FROM oneri_limit WHERE ts < ?`).bind(hourAgo)
        ]);
        return json({ ok: true, id: res[0]?.meta?.last_row_id || null, message: "Öneri / talebiniz alınmıştır." });
      }

      // =================== ADMIN ===================
      if (u.pathname.startsWith("/admin/")) {
        await ensureSchema(env.DB);
        const a = await adminAuth(req, env);
        if (!a.ok) return json({ ok: false, error: a.error }, a.status);

        if (u.pathname === "/admin/check" && req.method === "POST") {
          return json({ ok: true, optymus: !!env.OPTYMUS_TOKEN });
        }

        if (u.pathname === "/admin/oneriler" && req.method === "GET") {
          const r = await env.DB.prepare(`
            SELECT id, ad_soyad, gsm, email, aciklama, tarih, durum
            FROM oneriler ORDER BY id DESC LIMIT 500`).all();
          return json({ ok: true, rows: r.results || [] });
        }

        if (u.pathname === "/admin/oneri-durum" && req.method === "POST") {
          const body = await req.json().catch(() => ({}));
          const id = Number(body.id);
          const durum = String(body.durum || "").trim();
          if (!Number.isInteger(id) || id < 1 || !["Yeni", "İnceleniyor", "Tamamlandı"].includes(durum)) {
            return json({ ok: false, error: "Geçersiz kayıt veya durum." }, 400);
          }
          await env.DB.prepare(`UPDATE oneriler SET durum = ? WHERE id = ?`).bind(durum, id).run();
          return json({ ok: true });
        }

        if (u.pathname === "/admin/start" && req.method === "POST") {
          await env.DB.prepare(`DELETE FROM dagitim_yeni`).run();
          return json({ ok: true });
        }

        if (u.pathname === "/admin/chunk" && req.method === "POST") {
          const body = await req.json().catch(() => ({}));
          const rows = Array.isArray(body.rows) ? body.rows : [];
          if (!rows.length || rows.length > 250) return json({ ok: false, error: "Parça 1-250 kayıt olmalı" }, 400);
          const bit = v => (Number(v) === 1 ? 1 : 0);
          const valid = rows.filter(r => Array.isArray(r) && r[0] && r[1] && r[2] && Array.isArray(r[3]) && r[3].length === 7);
          if (valid.length !== rows.length) return json({ ok: false, error: "Geçersiz satır biçimi" }, 400);
          const stmts = valid.map(r => env.DB.prepare(`
            INSERT INTO dagitim_yeni (il, ilce, mahalle, pazartesi, sali, carsamba, persembe, cuma, cumartesi, pazar)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
            String(r[0]).trim().slice(0, 80), String(r[1]).trim().slice(0, 80), String(r[2]).trim().slice(0, 160),
            ...r[3].map(bit)));
          await env.DB.batch(stmts);
          return json({ ok: true, inserted: valid.length });
        }

        if (u.pathname === "/admin/finish" && req.method === "POST") {
          const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM dagitim_yeni`).first();
          if (Number(c?.n || 0) < 1) return json({ ok: false, error: "Yüklenecek kayıt bulunamadı" }, 400);
          const now = new Date().toISOString();
          // Tekrarlı il/ilçe/mahalle satırlarından yalnızca sonuncusu alınır.
          await env.DB.batch([
            env.DB.prepare(`DELETE FROM dagitim`),
            env.DB.prepare(`
              INSERT INTO dagitim (${ROW_COLS}, arama)
              SELECT ${ROW_COLS}, ${ARAMA_EXPR}
              FROM dagitim_yeni
              WHERE id IN (SELECT MAX(id) FROM dagitim_yeni GROUP BY il, ilce, mahalle)
              ORDER BY id`),
            env.DB.prepare(`
              INSERT INTO veri_bilgisi (id, guncelleme_tarihi, kayit_sayisi)
              VALUES (1, ?, (SELECT COUNT(*) FROM dagitim))
              ON CONFLICT(id) DO UPDATE SET
                guncelleme_tarihi = excluded.guncelleme_tarihi,
                kayit_sayisi = excluded.kayit_sayisi`).bind(now),
            env.DB.prepare(`DELETE FROM dagitim_yeni`)
          ]);
          const m = await env.DB.prepare(`SELECT kayit_sayisi FROM veri_bilgisi WHERE id = 1`).first();
          return json({ ok: true, count: Number(m?.kayit_sayisi || 0), updated: now });
        }

        return json({ ok: false, error: "Not found" }, 404);
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }
};

// Testler için dışa aktarım
export { extractDays, trKey, timingSafeEqual };
