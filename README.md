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
- Canlı sorguda en erken teslimat hesabı **ertesi günden** başlar.
  Ekranda “En erken teslimat” gösterilir; teknik tarih alanı kullanıcıya gösterilmez.


## Hata bildirimine dosya ekleri

- İsteğe bağlı en fazla **3 dosya**; dosya başına **1 MiB (1.048.576 bayt)**.
- Excel `.xlsx` / `.xls` ve JPG, PNG, WEBP desteklenir. Dosya sayısı, boyutu ve dosya imzası sunucuda da kontrol edilir. XLSX için çalışma kitabı ZIP dizini doğrulanır.
- Küçük ekler mevcut D1 veritabanının `oneri_ekleri` tablosunda BLOB olarak tutulur. R2/bucket veya yeni binding gerekmez. Mevcut depolama kotası kullanılır. Daha büyük dosya desteği ayrı nesne depolama tasarımı gerektirir; D1 tek satır/BLOB sınırı 2 MB'dir: https://developers.cloudflare.com/d1/platform/limits/
- Bildirim, ekler ve hız kaydı aynı D1 batch işleminde kaydedilir; bir hata tümünü geri alır. Ekler diğer bildirimlerle karışmaması için bu atomik işlemde eklenen kayıtla ilişkilendirilir.
- `POST /api/oneri`: dosyasız eski JSON biçimi korunur. Ekli gönderim `multipart/form-data` kullanır: `payload` JSON metni ve her dosya için bir `attachments` alanı.
- `/admin/oneriler` yanıtında yalnızca ek metaverisi (`ekler`) yer alır. Dosya içeriği `GET /admin/oneri-ek?id=...` ile mevcut `X-Admin-Password` yetkisi üzerinden indirilir. İndirme `attachment`, `no-store`, `nosniff` başlıklarıyla döner; dosyalar herkese açık URL'den sunulmaz.

### Yayına hazırlık ve sırası

1. Kullanıcı onayından sonra veri Worker'ının yeni sürümü yayınlanır. Mevcut `ensureSchema`, `oneri_ekleri` tablosunu veri kaybı olmadan oluşturur; bildirim tablosu değiştirilmez.
2. Yerel testlerden sonra izinli ortamda dosyasız bildirim, ekli bildirim ve yetkili indirme doğrulanır. Gerçek kullanıcı verisi yerine test kaydı kullanılır.
3. Frontend/admin PR'ı onayla birleştirilir; GitHub Pages yayını tetiklenir. Ön yüz dosya alanını yalnızca `/api/meta` yanıtındaki `attachments: true` özelliğini gördüğünde açar. Böylece eski Worker ile yeni ön yüz dosyasız çalışmaya devam eder. Meta yanıtı en fazla 5 dakika önbellekte kalabilir.

Bu geliştirme kapsamında canlı Worker, veritabanı veya Pages yayını değiştirilmez. Worker yayını ve frontend merge/yayın için ayrı açık onay gerekir.

### Yerel doğrulama

```bash
cd worker/dagitimveri
npm ci
npm test
```

Testler Miniflare ve geçici yerel D1 kullanır; canlı servislere veya veritabanına bağlanmaz. Eski JSON, Excel/görsel birlikte gönderim, yetkisiz indirme, dosya sınırları, dosya imzaları, batch geri alma ve eşzamanlı bildirimler kapsanır. Test Excel'i `tests/fixtures/sample.xlsx.base64` içinde küçük bir OOXML çalışma kitabıdır.
