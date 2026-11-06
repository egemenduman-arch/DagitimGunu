# Kayıtlı ziyaret planı

Kaynak: kullanıcı tarafından 6 Kasım 2026 tarihinde verilen `workZone (3).xlsx`, `data` sayfası. Ham Excel repoya eklenmez; yalnızca il/ilçe/mahalle ve haftanın yedi ziyaret günü aktarılır. Kaynak dosyanın SHA-256 özeti manifestte bulunur.

- Başlık dışında 59.627 satır, 81 il.
- Tam aynı il/ilçe/mahalle değerinde 6 tekrar; mevcut D1 içe aktarma kuralı gibi son satır geçerli. 59.621 benzersiz kayıt.
- Gün hücreleri yalnızca AÇIK/KAPALI olarak doğrulandı; boş veya bilinmeyen gün sessizce kapalı sayılmadı.
- Yakın yazımlı mahalleler birleştirilmez. Arama Türkçe karakter duyarsızdır; kayıt kimliği ve seçimde özgün adlar kullanılır.

Farklı gün içeren üç tekrarda dosyanın son satırındaki günler:

| İl | İlçe | Mahalle | Son satırın açık günleri |
|---|---|---|---|
| Antalya | Alanya | Büyükhasbahçe Mh. | Pazartesi–Cumartesi |
| Antalya | Alanya | Çakallar Mh. | Pazartesi |
| İstanbul | Arnavutköy | Mustafa Kemal Paşa Mh. | Pazartesi–Cuma |

`dagitim.json` manifesti ilin dosyasını ve kayıt sayısını tanımlar. İl dosyası satırı `[il,ilce,mahalle,[Pzt,Sal,Çar,Per,Cum,Cmt,Paz]]` biçimindedir. Manifest ve bütün il dosyaları aynı `updated` hazırlama zamanını taşır. Bu zaman kaynak planın yürürlük tarihi değildir.

Plan güncellemesi `veri-hazirla.html` ile hazırlanır; tüm JSON dosyaları aynı PR ile incelenip yayınlanır. Canlı servis öncelikli kalır, dosyadaki plan canlı teyit olarak sunulmaz.
