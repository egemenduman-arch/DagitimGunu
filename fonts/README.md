# Kurumsal font: Biennale

Dijital Kurye Design System (Figma → Foundations / Typography) Biennale fontunu kullanır.
Biennale lisanslı bir fonttur; dosyaları repoda yoktur.

Şu an sayfalar:
- Cihazda Biennale **kuruluysa** onu kullanır (ağ isteği yapmaz),
- değilse yedek font **Plus Jakarta Sans** (Google Fonts) ile görünür.

## Web font eklemek

1. Lisanslı dosyaları bu klasöre koyun: `Biennale-Regular.woff2`, `Biennale-Medium.woff2`,
   `Biennale-SemiBold.woff2`, `Biennale-Bold.woff2`.
2. `index.html` ve `admin.html` içindeki her `@font-face` satırının `src` kısmının sonuna
   ilgili dosyayı ekleyin, örneğin:

   ```css
   src:local("Biennale Regular"),local("Biennale-Regular"),url(fonts/Biennale-Regular.woff2) format("woff2")
   ```

Dosyalar eklenmeden `url(...)` yazılırsa tarayıcı konsolunda 404 uyarısı çıkar.
