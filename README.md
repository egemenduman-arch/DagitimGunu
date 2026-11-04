# Dijital Kurye – Dağıtım Günü Sorgulama

Mahalle veya açık adrese göre en erken dağıtım gününü gösteren PWA.

| Dosya | Açıklama |
|---|---|
| `index.html` | Son kullanıcı sorgu ekranı |
| `admin.html` | Dağıtım verisi yükleme + öneri/talep yönetimi |
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
npx wrangler secret put OPTYMUS_TOKEN
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
