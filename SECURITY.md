# Güvenlik notu

Bu servis, furkansenyuz.com'daki sohbet kutusunun arkasında Gemini API'sine aracılık eder.

Korumalar (2026-10-08):
- `/chat` yalnızca izinli `Origin` başlığıyla çağrılabilir (CORS + sunucu tarafı kontrol). Varsayılan izinli kaynaklar: furkansenyuz.com, www.furkansenyuz.com, furkansenyuz.github.io.
- IP başına 15 dakikada 20 istek; günlük toplam 300 istek tavanı (env ile değiştirilebilir).
- Mesaj 1.000 karakter, cevap 600 token, resim 2 MB ve yalnızca JPEG/PNG/WebP ile sınırlı; gövde 20 KB.
- Kullanım kaydında IP adresi veya mesaj içeriği tutulmaz; yalnızca tarih, model, durum.
- Sağlık uç noktası model listesini açıklamaz.

Anahtar yönetimi:
- `GEMINI_API_KEY` yalnızca barındırma ortamının gizli değişkenlerinde durur; repoya girmez.
- Bu sertleştirmeden önce anahtar açık bir uç noktanın arkasındaydı: **anahtar yenilenmeli** (Google AI Studio → API keys → eski anahtarı sil, yenisini oluştur, barındırma ortamına yaz, yeniden dağıt).

Bilinen sınır: `Origin` başlığı taklit edilebilir; bu kontrol tarayıcı tabanlı kötüye kullanımı ve rastgele botları durdurur, kararlı bir saldırganı değil. Asıl sınır günlük tavandır.
