// Dağıtım Günü – veri API'si (Cloudflare Worker + D1)
//
// Ortam değişkenleri / bağlamalar:
//   DB               D1 veritabanı
//   ADMIN_PASSWORD   (secret) admin paneli şifresi
//   OPTYMUS_USERNAME (secret) Optymus kullanıcı adı  ┐ önerilen: token otomatik
//   OPTYMUS_PASSWORD (secret) Optymus şifresi (OPTYMUS_PASS da olur) ┘ alınır ve yenilenir
//   OPTYMUS_TOKEN    (secret) (alternatif) elle verilen Bearer token; süresi dolunca çalışmaz
//   OPTYMUS_BASE     (ops.)   varsayılan https://api.optymus.tech
//   OPTYMUS_CLIENT_ID / OPTYMUS_SCOPE (ops.) varsayılan DijitalKurye_App / "DijitalKurye offline_access"
//   ALLOWED_ORIGINS  (ops.)   admin uçları için izinli origin listesi (virgülle). Boşsa "*".

// Token'ı veren (iss) ve Postman'de kullanılan sunucu api.optymus.tech'tir.
const OPTYMUS_DEFAULT_BASE = "https://api.optymus.tech";
const OPTYMUS_TOKEN_PATH = "/connect/token";
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
let schemaPending;
async function ensureSchema(db) {
  if(schemaReady)return;
  if(!schemaPending)schemaPending=initializeSchema(db).finally(()=>{schemaPending=null;});
  return schemaPending;
}
async function initializeSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS dagitim_yeni (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      il TEXT NOT NULL, ilce TEXT NOT NULL, mahalle TEXT NOT NULL,
      pazartesi INTEGER DEFAULT 0, sali INTEGER DEFAULT 0, carsamba INTEGER DEFAULT 0,
      persembe INTEGER DEFAULT 0, cuma INTEGER DEFAULT 0, cumartesi INTEGER DEFAULT 0, pazar INTEGER DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_deneme (ip TEXT NOT NULL, ts INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_admin_deneme ON admin_deneme(ip, ts)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS oneri_limit (ip TEXT NOT NULL, ts INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_oneri_limit ON oneri_limit(ip, ts)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS oneri_ekleri (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      oneri_id INTEGER NOT NULL REFERENCES oneriler(id) ON DELETE CASCADE,
      dosya_adi TEXT NOT NULL, mime TEXT NOT NULL,
      boyut INTEGER NOT NULL CHECK (boyut > 0 AND boyut <= 1048576),
      icerik BLOB NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_oneri_ekleri_oneri ON oneri_ekleri(oneri_id)`)
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
function numbersToDays(nums, allowIso = true) {
  const days = [0, 0, 0, 0, 0, 0, 0];
  const iso = allowIso && nums.includes(7) && !nums.includes(0);
  for (const n of nums) {
    if (!Number.isInteger(n)) continue;
    const idx = iso ? (n - 1) : ((n + 6) % 7);
    if (idx >= 0 && idx < 7) days[idx] = 1;
  }
  return days;
}

// Belgelenmiş biçim {days,errors} handleAdresGun'da doğrudan işlenir; bu çözümleyici
// yalnızca beklenmeyen bir biçim gelirse yedek olarak kullanılır.
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

// ---------------------------------------------------------------------------
// Optymus token yönetimi
// Kullanıcı adı/şifre tanımlıysa token /connect/token (OAuth2 password grant)
// ile alınır, bellekte tutulur ve süresi dolmadan yenilenir. Yoksa OPTYMUS_TOKEN kullanılır.
// ---------------------------------------------------------------------------

const optymusBase = env => String(env.OPTYMUS_BASE || OPTYMUS_DEFAULT_BASE).replace(/\/+$/, "");
const optymusPassword = env => env.OPTYMUS_PASSWORD || env.OPTYMUS_PASS;
const hasCredentials = env => !!(env.OPTYMUS_USERNAME && optymusPassword(env));
function optymusConfigured(env) { return hasCredentials(env) || !!env.OPTYMUS_TOKEN; }

function jwtExp(token) {
  try {
    const part = String(token).split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
    const exp = JSON.parse(atob(b64)).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
}

let tokenState = null; // { access, refresh, exp }
const TOKEN_SKEW_MS = 5 * 60 * 1000;

async function requestToken(env, params) {
  const body = new URLSearchParams({ client_id: env.OPTYMUS_CLIENT_ID || "DijitalKurye_App", ...params });
  if (env.OPTYMUS_CLIENT_SECRET) body.set("client_secret", env.OPTYMUS_CLIENT_SECRET);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OPTYMUS_TIMEOUT_MS);
  try {
    const r = await fetch(optymusBase(env) + OPTYMUS_TOKEN_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: body.toString(),
      signal: ctrl.signal
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      const e = new Error("Optymus token alınamadı: " + (j.error_description || j.error || ("HTTP " + r.status)));
      e.status = 502;
      e.authFailed = true;
      throw e;
    }
    const exp = jwtExp(j.access_token) || (Date.now() + Number(j.expires_in || 3600) * 1000);
    return { access: j.access_token, refresh: j.refresh_token || null, exp };
  } catch (e) {
    if (e.authFailed) throw e;
    const err = new Error(e?.name === "AbortError" ? "Optymus token servisi yanıt vermedi" : "Optymus token servisine bağlanılamadı");
    err.status = 504;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken(env, { force = false } = {}) {
  if (hasCredentials(env)) {
    if (!force && tokenState && tokenState.exp - TOKEN_SKEW_MS > Date.now()) return tokenState.access;
    if (tokenState?.refresh) {
      try {
        tokenState = await requestToken(env, { grant_type: "refresh_token", refresh_token: tokenState.refresh });
        return tokenState.access;
      } catch { /* yenileme başarısızsa şifreyle yeniden al */ }
    }
    tokenState = await requestToken(env, {
      grant_type: "password",
      scope: env.OPTYMUS_SCOPE || "DijitalKurye offline_access",
      username: env.OPTYMUS_USERNAME,
      password: optymusPassword(env)
    });
    return tokenState.access;
  }
  if (env.OPTYMUS_TOKEN) {
    const exp = jwtExp(env.OPTYMUS_TOKEN);
    if (exp && exp < Date.now()) {
      const e = new Error("OPTYMUS_TOKEN süresi dolmuş (" + new Date(exp).toISOString().slice(0, 10) + "). Yeni token ekleyin veya OPTYMUS_USERNAME/OPTYMUS_PASSWORD tanımlayın.");
      e.status = 503;
      throw e;
    }
    return env.OPTYMUS_TOKEN;
  }
  const e = new Error("Optymus kimlik bilgisi tanımlı değil (OPTYMUS_USERNAME/OPTYMUS_PASSWORD veya OPTYMUS_TOKEN)");
  e.status = 503;
  throw e;
}

function optymusStatus(env) {
  if (hasCredentials(env)) return { mod: "kullanici", tokenBitis: tokenState ? new Date(tokenState.exp).toISOString() : null };
  if (env.OPTYMUS_TOKEN) {
    const exp = jwtExp(env.OPTYMUS_TOKEN);
    return { mod: "token", tokenBitis: exp ? new Date(exp).toISOString() : null, suresiDoldu: !!(exp && exp < Date.now()) };
  }
  return { mod: null };
}

async function optymusWorkDays(env, fullAddress, retried = false) {
  const token = await getAccessToken(env, { force: retried });
  const url = optymusBase(env) + OPTYMUS_PATH + "?fullAddress=" + encodeURIComponent(fullAddress);
  const ctrl = new AbortController();

  const timer = setTimeout(() => ctrl.abort(), OPTYMUS_TIMEOUT_MS);
  let r, text;
  try {
    r = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + token,
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
  // Token sunucu tarafında iptal edildiyse bir kez yenileyip tekrar dene
  if (r.status === 401 && !retried && hasCredentials(env)) {
    tokenState = null;
    return optymusWorkDays(env, fullAddress, true);
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
      ok: false, kaynak: "optymus", upstreamStatus: res.status, adresHatasi: res.status === 404,
      error: res.status === 401 || res.status === 403
        ? "Optymus yetkilendirme hatası (token geçersiz veya süresi dolmuş)"
        : res.status === 404
          ? (msg || "Adres için hizmet bölgesi bulunamadı")
          : (msg || "Optymus HTTP " + res.status)
    };
    if (debug) out.raw = res.body;
    // 404 = adres bölge dışı → istemci bunu "bulunamadı" olarak göstermeli
    return json(out, res.status === 404 ? 422 : 502);
  }

  // Belgelenmiş yanıt: { days: [0..6] (0=Pazar), errors: [string] }
  // errors doluysa adrese randevu verilemez; Optymus bu durumda da HTTP 200 döner.
  const body = res.body && typeof res.body === "object" ? res.body : {};
  const errors = Array.isArray(body.errors) ? body.errors.map(e => String(e?.message || e)).filter(Boolean) : [];
  if (errors.length) {
    const out = { ok: false, kaynak: "optymus", adres, adresHatasi: true, error: errors.join(" • "), errors };
    if (debug) out.raw = res.body;
    return json(out, 422);
  }
  const days = Array.isArray(body.days) ? numbersToDays(body.days.map(Number).filter(n => n >= 0 && n <= 6), false)
                                        : extractDays(res.body);
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
  if (days && !days.some(Boolean)) { out.ok = false; out.adresHatasi = true; out.error = "Bu adres için hizmet günü tanımlı değil"; }
  if (debug) out.raw = res.body;

  if (out.ok && !debug) {
    const toCache = new Response(JSON.stringify(out), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + OPTYMUS_CACHE_TTL }
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));
  }
  return json(out, out.ok ? 200 : (out.adresHatasi ? 422 : 502));
}

// Küçük bildirim ekleri mevcut D1 içinde tutulur; yalnızca yetkili admin indirebilir.
const ATTACHMENT_MAX_COUNT=3,ATTACHMENT_MAX_BYTES=1024*1024;
const ATTACHMENT_TYPES={xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp'};
function inputError(message,status=400){const e=new Error(message);e.httpStatus=status;return e}
async function boundedBody(req,max){
 if(Number(req.headers.get('Content-Length'))>max)throw inputError('Gönderilen içerik çok büyük.',413);
 if(!req.body)return new Uint8Array();
 const reader=req.body.getReader(),chunks=[];let total=0;
 try{
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();throw inputError('Gönderilen içerik çok büyük.',413)}chunks.push(value)}
 }finally{reader.releaseLock()}
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}return bytes;
}
async function feedbackInput(req){
 const multipart=(req.headers.get('Content-Type')||'').toLowerCase().startsWith('multipart/form-data');
 const bytes=await boundedBody(req,multipart?4*1024*1024:64*1024);
 let body,files=[],diagnostics=[];
 try{
  if(multipart){
   const copy=new Request(req.url,{method:'POST',headers:req.headers,body:bytes});
   const form=await copy.formData(),payload=form.get('payload');
   if(typeof payload!=='string'||payload.length>20000)throw inputError('Bildirim bilgileri geçersiz.');
   body=JSON.parse(payload);files=form.getAll('attachments');diagnostics=form.getAll('diagnostics');
  }else body=JSON.parse(new TextDecoder().decode(bytes));
 }catch(e){if(e.httpStatus)throw e;throw inputError('Bildirim içeriği okunamadı.')}
 if(!body||typeof body!=='object'||Array.isArray(body))throw inputError('Bildirim bilgileri geçersiz.');
 if(files.length>ATTACHMENT_MAX_COUNT)throw inputError('En fazla 3 dosya ekleyebilirsiniz.',413);
 if(diagnostics.length>1)throw inputError('En fazla bir otomatik sorgu kaydı eklenebilir.');
 if(files.some(file=>file?.name==='sorgu-kaydi.txt'))throw inputError('Sorgu kaydı otomatik ek alanında gönderilmelidir.');
 if(diagnostics.length){
  const file=diagnostics[0];
  if(!file||typeof file==='string'||file.name!=='sorgu-kaydi.txt'||!file.size||file.size>64*1024)throw inputError('Otomatik sorgu kaydı geçersiz.');
 }
 return {body,files:[...files,...diagnostics]};
}
function isXlsx(bytes){
 // ZIP açmadan merkez dizinini doğrula; normal ZIP'i Excel diye kabul etme.
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(view.getUint32(i,true)===0x06054b50){end=i;break}}
 if(end<0)return false;
 const count=view.getUint16(end+10,true),start=view.getUint32(end+16,true),size=view.getUint32(end+12,true);
 if(start+size>end)return false;
 let at=start;const names=new Set();
 for(let i=0;i<count;i++){
  if(at+46>end||view.getUint32(at,true)!==0x02014b50)return false;
  const n=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),comment=view.getUint16(at+32,true);
  if(at+46+n+extra+comment>end)return false;
  names.add(new TextDecoder().decode(bytes.subarray(at+46,at+46+n)));at+=46+n+extra+comment;
 }
 return names.has('[Content_Types].xml')&&names.has('xl/workbook.xml');
}
async function validateAttachments(files){
 const out=[];
 for(const file of files){
  if(!file||typeof file==='string'||typeof file.arrayBuffer!=='function')throw inputError('Dosya eki geçersiz.');
  const name=String(file.name||'').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g,'');
  const ext=(name.split('.').pop()||'').toLowerCase(),diagnostic=name==='sorgu-kaydi.txt',mime=diagnostic?'text/plain;charset=utf-8':ATTACHMENT_TYPES[ext];
  if(!mime)throw inputError('Yalnızca Excel veya JPG, PNG, WEBP görseli ekleyebilirsiniz.');
  if(!file.size||file.size>ATTACHMENT_MAX_BYTES)throw inputError('Her dosya boş olmamalı ve en fazla 1 MB olmalıdır.',413);
  const data=await file.arrayBuffer(),bytes=new Uint8Array(data);
  const starts=values=>values.every((x,i)=>bytes[i]===x);
  if(diagnostic){
   if(bytes.length>64*1024)throw inputError('Otomatik sorgu kaydı çok büyük.',413);
   try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))throw new Error()}catch(_){throw inputError('Otomatik sorgu kaydı UTF-8 metin olmalıdır.')}
  }
  const valid=diagnostic?true:ext==='xlsx'?isXlsx(bytes):ext==='xls'?starts([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]):ext==='png'?starts([137,80,78,71,13,10,26,10]):ext==='webp'?starts([82,73,70,70])&&new TextDecoder().decode(bytes.subarray(8,12))==='WEBP':starts([255,216,255]);
  if(!valid)throw inputError('Dosya içeriği uzantısıyla eşleşmiyor veya dosya okunamıyor: '+name.slice(0,160));
  out.push({name:name.slice(0,-ext.length-1).slice(0,140)+'.'+ext,mime,size:bytes.length,data});
 }
 return out;
}

// ---------------------------------------------------------------------------
// Ana yönlendirici
// ---------------------------------------------------------------------------

const ROW_COLS = `il, ilce, mahalle, pazartesi, sali, carsamba, persembe, cuma, cumartesi, pazar`;

// ---------------------------------------------------------------------------
// Açık adresten mahalle bulma (ters eşleştirme)
// "Denizköşkler E-5 yanyol ... Avcılar, İstanbul" gibi uzun adreslerde her kelimenin
// kayıtta geçmesi beklenemez. Bunun yerine adresin İÇİNDE geçen ilçe ve mahalle adları aranır.
// ---------------------------------------------------------------------------

let geoCache = null; // { at, list: [{ il, ilce, ilK, ilceK }] }
const GEO_TTL_MS = 6 * 3600 * 1000;

async function geoList(db) {
  if (geoCache && Date.now() - geoCache.at < GEO_TTL_MS) return geoCache.list;
  const r = await db.prepare(`SELECT DISTINCT il, ilce FROM dagitim`).all();
  const list = (r.results || []).map(x => ({ il: x.il, ilce: x.ilce, ilK: trKey(x.il), ilceK: trKey(x.ilce) }));
  geoCache = { at: Date.now(), list };
  return list;
}

async function reverseAddressMatch(db, key, limit = 10) {
  const q = " " + key + " ";
  const has = k => !!k && q.includes(" " + k + " ");
  const list = await geoList(db);

  let areas = list.filter(x => has(x.ilceK));
  const withIl = areas.filter(x => has(x.ilK));
  if (withIl.length) areas = withIl;
  if (!areas.length) {
    // İlçe yazılmamışsa yalnızca il içinde ara (tek il eşleşirse)
    const iller = [...new Set(list.filter(x => has(x.ilK)).map(x => x.il))];
    if (iller.length !== 1) return [];
    areas = list.filter(x => x.il === iller[0]);
  }
  areas = areas.slice(0, 60);

  const hits = [];
  for (let i = 0; i < areas.length; i += 20) {
    const part = areas.slice(i, i + 20);
    const where = part.map(() => `(il = ? AND ilce = ?)`).join(" OR ");
    const r = await db.prepare(`SELECT ${ROW_COLS} FROM dagitim WHERE ${where} ORDER BY id DESC`)
      .bind(...part.flatMap(a => [a.il, a.ilce])).all();
    for (const row of r.results || []) {
      const mk = trKey(row.mahalle);
      if (mk.length >= 3 && has(mk)) hits.push({ row, score: mk.length + (q.indexOf(" " + mk + " ") < 40 ? 5 : 0) });
    }
  }
  const seen = new Set();
  return hits
    .sort((a, b) => b.score - a.score)
    .filter(h => { const k = h.row.il + "|" + h.row.ilce + "|" + h.row.mahalle; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, limit)
    .map(h => h.row);
}


// Legacy public plan reads only: no account, feedback or admin data is cached.
const PLAN_READ_PATHS = new Set(['/api/iller','/api/ilceler','/api/mahalleler','/api/mahalle','/api/ara']);
const planReadCaches = new WeakMap();
function planState(db) {
  let state=planReadCaches.get(db);
  if(!state){state={values:new Map(),pending:new Map(),generation:0,indexReady:false,indexPending:null};planReadCaches.set(db,state);}
  return state;
}
async function planLocationIndex(db) {
  const state=planState(db);
  if(state.indexReady)return;
  if(!state.indexPending)state.indexPending=db.prepare('CREATE INDEX IF NOT EXISTS idx_dagitim_location ON dagitim(il,ilce,mahalle,id DESC)').run()
    .then(()=>{state.indexReady=true;}).finally(()=>{state.indexPending=null;});
  return state.indexPending;
}
function clearPlanReads(db) {
  const state=planState(db);state.generation++;state.values.clear();state.pending.clear();
}
async function cachedPlanRead(req,env,u) {
  const state=planState(env.DB),key=u.pathname+'?'+u.searchParams.toString();
  const hit=state.values.get(key);
  if(hit&&hit.expires>Date.now())return hit.value;
  if(hit)state.values.delete(key);
  if(state.pending.has(key))return state.pending.get(key);
  // Bound both cached data and outstanding distinct queries. Over-capacity requests
  // still work without being retained. A cold/new Worker has its own bounded cache.
  if(key.length>2048||state.pending.size>=32)return legacyPlanRead(req,env,u);
  const generation=state.generation;
  const task=legacyPlanRead(req,env,u).then(value=>{
    const bytes=JSON.stringify(value).length;
    if(value.status===200&&bytes<=262144&&generation===state.generation){
      const ttl=u.pathname==='/api/ara'?60000:600000;
      state.values.delete(key);state.values.set(key,{value,expires:Date.now()+ttl});
      while(state.values.size>64)state.values.delete(state.values.keys().next().value);
    }
    return value;
  }).finally(()=>{if(state.pending.get(key)===task)state.pending.delete(key);});
  state.pending.set(key,task);return task;
}
async function legacyPlanRead(req,env,u) {
  const json=(data,status=200,extra={})=>({data,status,extra});
      // ---------------- İLLER ----------------
      if (u.pathname === "/api/iller" && req.method === "GET") {
        await planLocationIndex(env.DB);
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
        await planLocationIndex(env.DB);
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
        await planLocationIndex(env.DB);
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
        await planLocationIndex(env.DB);
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

        const toks = key.split(" ").filter(t => t.length >= 2);
        if (!toks.length) return json({ rows: [] });

        // Uzun / açık adres: önce adresin içinde geçen ilçe + mahalleyi bul.
        if (toks.length >= 4) {
          const rev = await reverseAddressMatch(env.DB, key);
          if (rev.length) return json({ q, rows: rev, eslesme: "adres" });
        }

        // Kısa sorgu: her kelime kayıtta geçmeli; mahalle adı tam/önek eşleşmesi önce.
        toks.splice(6);
        const where = toks.map(() => `arama LIKE ?`).join(" AND ");
        const binds = toks.map(t => `%${t}%`);
        const mahKey = trKeySql("mahalle");
        const first = toks[0];
        await planLocationIndex(env.DB);
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
        let rows = (r.results || []).map(({ skor, ...x }) => x);
        if (!rows.length && toks.length < 4) rows = await reverseAddressMatch(env.DB, key);
        return json({ q, rows });
      }

  return json({error:'Not found'},404);
}

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
        return json({ ok: db, db, optymus: optymusConfigured(env) }, db ? 200 : 503);
      }

      // Canlı sorgu ve arayüz özellikleri D1'dan bağımsızdır.
      if (u.pathname === "/api/capabilities" && req.method === "GET") {
        return json({ok:true,optymus:optymusConfigured(env),attachments:true,planSource:"static"},200,{"Cache-Control":"no-store"});
      }

      // ---------------- META ----------------
      if (u.pathname === "/api/meta" && req.method === "GET") {
        let meta=null;
        try { meta=await env.DB.prepare(`SELECT guncelleme_tarihi, kayit_sayisi FROM veri_bilgisi WHERE id = 1`).first(); } catch { /* Eski istemcilerde de D1 kesintisi canlı sorguyu kapatmasın. */ }
        return json({ ok: true, meta: meta || null, optymus: optymusConfigured(env), attachments: true }, 200, { "Cache-Control": "public, max-age=300" });
      }

      // ---------------- OPTYMUS: TAM ADRES → GÜNLER ----------------
      if (u.pathname === "/api/adres-gun" && req.method === "GET") {
        return await handleAdresGun(req, env, u, json, ctx);
      }

      if(req.method==='GET'&&PLAN_READ_PATHS.has(u.pathname)){
        const value=await cachedPlanRead(req,env,u);
        return json(value.data,value.status,value.extra);
      }

      // ---------------- ÖNERİ / TALEP GÖNDER ----------------
      if (u.pathname === "/api/oneri" && req.method === "POST") {
        await ensureSchema(env.DB);
        const {body,files} = await feedbackInput(req);
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

        const attachments=await validateAttachments(files);
        const tarih = new Date().toISOString();
        const res = await env.DB.batch([
          env.DB.prepare(`INSERT INTO oneriler (ad_soyad, gsm, email, aciklama, tarih, durum) VALUES (?, ?, ?, ?, ?, 'Yeni')`)
            .bind(adSoyad, gsm, email, aciklama, tarih),
          // D1 batch atomiktir; bu işlemde eklenen en son bildirim bütün eklerin sahibidir.
          ...attachments.map(file=>env.DB.prepare(`INSERT INTO oneri_ekleri (oneri_id,dosya_adi,mime,boyut,icerik)
            VALUES ((SELECT MAX(id) FROM oneriler),?,?,?,?)`).bind(file.name,file.mime,file.size,file.data)),
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
          return json({ ok: true, optymus: optymusConfigured(env), optymusDurum: optymusStatus(env) });
        }

        if (u.pathname === "/admin/oneriler" && req.method === "GET") {
          const r = await env.DB.prepare(`
            SELECT id, ad_soyad, gsm, email, aciklama, tarih, durum
            FROM oneriler ORDER BY id DESC LIMIT 500`).all();
          const attachments=await env.DB.prepare(`SELECT id,oneri_id,dosya_adi,mime,boyut FROM oneri_ekleri
            WHERE oneri_id IN (SELECT id FROM oneriler ORDER BY id DESC LIMIT 500) ORDER BY id`).all();
          const grouped=new Map();
          for(const file of attachments.results||[]){if(!grouped.has(file.oneri_id))grouped.set(file.oneri_id,[]);grouped.get(file.oneri_id).push(file)}
          return json({ ok: true, rows: (r.results||[]).map(row=>({...row,ekler:grouped.get(row.id)||[]})) });
        }

        if(u.pathname==='/admin/oneri-ek'&&req.method==='GET'){
          const id=Number(u.searchParams.get('id'));
          if(!Number.isSafeInteger(id)||id<1)return json({error:'Dosya kimliği geçersiz.'},400);
          const file=await env.DB.prepare(`SELECT dosya_adi,icerik FROM oneri_ekleri WHERE id=?`).bind(id).first();
          if(!file)return json({error:'Dosya bulunamadı.'},404);
          const name=encodeURIComponent(file.dosya_adi).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
          return new Response(Array.isArray(file.icerik)?new Uint8Array(file.icerik):file.icerik,{headers:{...cors,
            'Content-Type':'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+name,
            'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
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
          geoCache = null;
          clearPlanReads(env.DB);
          const m = await env.DB.prepare(`SELECT kayit_sayisi FROM veri_bilgisi WHERE id = 1`).first();
          return json({ ok: true, count: Number(m?.kayit_sayisi || 0), updated: now });
        }

        return json({ ok: false, error: "Not found" }, 404);
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: e.httpStatus ? String(e.message) : "Bu işlem şu anda tamamlanamıyor. Lütfen daha sonra yeniden deneyin." }, e.httpStatus || 503);
    }
  }
};

// Testler için dışa aktarım
export { extractDays, trKey, timingSafeEqual };
