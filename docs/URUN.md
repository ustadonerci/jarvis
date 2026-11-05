# Jarvis'i ürün olarak sunma

Bu belge, talimatın 4. bölümünün Jarvis'teki karşılığını anlatır. Hukuki metinler (sözleşme, KVKK aydınlatma metni) **avukatla netleştirilmelidir**; burada yalnızca teknik ve ticari çerçeve var.

## 1. Temiz çekirdek sürüm

```
npm run temiz-surum            # → ../jarvis-temiz-<tarih>/
```

- Kişisel veri, `.env` (API anahtarları), hafıza, ses örnekleri ve yerel notlar kopyaya **girmez**.
- Betik kopyayı anahtar kalıplarına karşı tarar; şüpheli bir şey bulursa hata koduyla durur.
- Bağımlılıkların lisanslarını da tarar ve `TEMIZ-SURUM-RAPORU.txt` dosyasına yazar.

### ⚠️ Bilinen lisans uyarısı

`libsignal` (GPL-3.0), WhatsApp Web bağlantısı (Baileys) üzerinden gelir. Bu yüzden ticari sürümde iki seçenek var:

1. WhatsApp Web modülünü kapatıp **Meta WhatsApp Cloud API**'ye geçmek. Ban riski de bu yüzden önerilir.
2. Bu kısmın lisans durumunu avukatla netleştirmek.

## 2. Müşteri başına ayrı kurulum (Docker)

Her müşteri ayrı bir kapsayıcıda çalışır, veriler birbirine karışmaz.

1. Temiz sürüm klasörünü müşterinin sunucusuna kopyalayın.
2. `musteri.env` dosyasına müşterinin **kendi** anahtarlarını yazın. Şablon `server/.env.example` dosyasında.
3. Kurulumu başlatın:
   ```
   docker compose up -d
   ```
   Arayüz `http://sunucu:8787` adresinde açılır.
4. Müşterinin verileri `./musteri-veri` klasöründe durur.

n8n için müşteri başına ayrı kurulum yapılabilir (VPS + Docker/Coolify). Jarvis'te `N8N_URL` ve `N8N_API_KEY` o müşterinin n8n'ini gösterir.

## 3. Paketler (öneri)

| Paket | İçerik |
|---|---|
| Temel | E-posta düzenleme ve özet, takvim, günlük rapor |
| Orta | Temel + WhatsApp/Telegram, satış danışmanı, sosyal medya (Reels, altyazı, onaylı paylaşım) |
| Üst | Bütün ajanlar: finans/borsa, araştırma, otomasyon kurulumu (n8n şablonları), uzun hafıza |

**Yapay zekâ maliyeti** iki şekilde karşılanabilir:
- fiyata dahil edilir, ya da
- müşteri kendi API anahtarını girer.

Ollama kuruluysa basit işler ücretsiz olarak yerel modelde yapılır.

## 4. Tek seferlik satış ve bakım

- **Tek seferlik satış:**
  - Kurulum müşterinin cihazına ya da sunucusuna yapılır.
  - İlk 3 ay hata düzeltmeleri ücretsizdir.
  - Müşteri kendi API anahtarını kullanır.
  - Kaynak kod değil, kullanım lisansı verilir. Kaynak kodun tamamı istenirse fiyat belirgin şekilde yükselir.
- **Bakım paketi (aylık ya da yıllık):**
  - Ücret: satış fiyatının yaklaşık %15-20'si.
  - Kapsam: güvenlik güncellemeleri, hata düzeltmeleri, küçük eklemeler.
  - Yılda belirli bir geliştirme saati dahildir (örnek: 10 saat).
  - Büyük modüller ayrıca fiyatlandırılır.

## 5. Yeni özellik talebi

Jarvis'e "**şu müşterinin özellik talebini değerlendir**" deyip linki ya da açıklamayı verin. Süreç şöyle işler:

1. Jarvis tahmini süreyi (saat), kullanılacak repo/aracı ve zorluğu çıkarır.
2. Teklif önce **size** onay kartıyla gelir. Onaylarsanız müşteriye WhatsApp'tan gider.
3. Küçük işler bakım saatinden düşülür, büyük işler ayrı teklifle yapılır.

## 6. Lisans kuralı

- Kütüphanedeki repolar `kutuphane denetle` ile taranır. MIT, Apache, BSD ve ISC lisansları uygundur.
- AGPL, GPL ve "ticari kullanım yasak" lisanslar işaretlenir; bunlar ticari üründe kullanılmaz.
- Yıldız sayısı güvenlik garantisi değildir; her güncelleme yedek alınarak ve onayla yapılır.
