# Dijital Kurye – Dağıtım Günü Sorgulama

Mahalle veya açık adrese göre en erken dağıtım gününü gösteren PWA.

| Dosya | Açıklama |
|---|---|
| `index.html` | Son kullanıcı sorgu ekranı |
| `admin.html` | Dağıtım verisi yükleme + öneri/talep yönetimi |
| `dijitalkurye_logo.svg`, `icons/` | Figma Design System'den alınan logo ve "dk" uygulama ikonları |
| `fonts/` | Kurumsal font Biennale için yer (bkz. `fonts/README.md`) |
| `service-worker.js` | Yalnızca uygulama kabuğunu önbelleğe alır (API verisini almaz) |
| `worker/dagitimveri/` | Veri API'si (Cloudflare Worker + D1) |
| `worker/dagitimuyari/` | Operasyon uyarıları + MGM hava durumu worker'ı |

## Worker dağıtımı

```bash
cd worker/dagitimveri
npx wrangler deploy
```

Gizli değişkenler (repoya yazılmaz):

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put OPTYMUS_USERNAME
npx wrangler secret put OPTYMUS_PASSWORD
```

İlk istekte worker, `dagitim` tablosuna Türkçe karakter duyarsız arama için
`arama` sütununu ve gerekli yardımcı tabloları (`admin_deneme`, `oneri_limit`)
kendiliğinden ekler.

## API uçları (`dagitimveri`)

| Uç | Açıklama |
|---|---|
| `GET /api/iller`, `/api/ilceler?il=`, `/api/mahalleler?il=&ilce=` | Filtre listeleri |
| `GET /api/mahalle?il=&ilce=&mahalle=` | Tek mahallenin günleri |
| `GET /api/ara?q=` | Türkçe karakter duyarsız mahalle/adres araması |
| `GET /api/adres-gun?adres=` | Optymus üzerinden tam adrese göre çalışma günleri |
| `GET /api/meta` | Son güncelleme tarihi, kayıt sayısı |
| `POST /api/oneri` | Öneri / talep kaydı (IP başına saatte 5) |
| `POST /admin/*` | `X-Admin-Password` ile; 15 dk'da 10 hatalı denemede kilitlenir |

## Optymus – adrese göre çalışma günleri

Kaynak: `docs/optymus-work-days.postman_collection.json`

- `GET https://api.optymus.tech/api/app/work-zone/work-days-by-full-address?fullAddress=...`
  (dokümanda `api.optymus.pro` geçiyor; token'ı veren sunucu `api.optymus.tech`. Gerekirse `OPTYMUS_BASE` ile değiştirilir.)
- `Authorization: Bearer <token>` — token worker tarafından
  `POST /connect/token` (grant_type=password, client_id=DijitalKurye_App, scope=DijitalKurye offline_access)
  ile `OPTYMUS_USERNAME` / `OPTYMUS_PASSWORD` secret'larından otomatik alınır ve yenilenir.
  Alternatif: sabit `OPTYMUS_TOKEN` (30 günde dolar).
- Yanıt: `{"days":[1,4],"errors":[]}` — `days`: 0=Pazar … 6=Cumartesi
- `errors` doluysa adrese randevu verilemez (Optymus yine HTTP 200 döner);
  worker bunu `422 {ok:false, adresHatasi:true, error}` olarak iletir.
- Rezervasyon en erken **ertesi gün** olabilir; ekranda gösterilen
  `ReservationDate` (YYYY-MM-DD) iş emrinde kullanılır.

## Güvenlik ve gizlilik notları

- **Google Analytics** yalnızca kullanıcı çerez bandında "Kabul et" derse yüklenir
  (tercih `localStorage` içinde `dk_cerez_onay` anahtarında tutulur; alt kısımdaki
  "Çerez tercihleri" ile değiştirilebilir).
- **admin.html** bir İçerik Güvenliği Politikası (CSP) ile yalnızca dağıtım API'sine
  bağlanabilir. API adresi değişirse CSP'deki `connect-src` de güncellenmelidir.
- **SheetJS bütünlük kontrolü (SRI):** dosyanın hash'i şu komutla alınıp `admin.html`'deki
  `<script>` etiketine `integrity="sha384-..." crossorigin="anonymous"` olarak eklenebilir:

  ```bash
  curl -s https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js | openssl dgst -sha384 -binary | openssl base64 -A
  ```
