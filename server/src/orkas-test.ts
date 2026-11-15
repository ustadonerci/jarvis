// Orkas'tan uyarlanan özelliklerin saf mantık testleri (ağ yok, mesaj gönderilmez, data/ yazılmaz). Çalıştır: npm run test:orkas
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bol, kelimePuani } from './belgeler.js';
import { dersleriAyikla } from './dersler.js';
import { komut } from './kodajani.js';
import { bosAd } from './ofis.js';
import { sonrakiZaman } from './otomasyon.js';
import { htmlDenetle } from './seo.js';

// Otomasyon zamanı (yerel saat). 2026-11-12 perşembe 10:30
const t = new Date(2026, 10, 12, 10, 30);
const iso = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
assert.equal(iso(sonrakiZaman({ siklik: 'gunluk', saat: '08:00' }, t)), '2026-11-13 8:00'); // bugünkü geçti → yarın
assert.equal(iso(sonrakiZaman({ siklik: 'gunluk', saat: '11:00' }, t)), '2026-11-12 11:00');
assert.equal(iso(sonrakiZaman({ siklik: 'saatlik', saat: '00:15' }, t)), '2026-11-12 11:15');
assert.equal(iso(sonrakiZaman({ siklik: 'saatlik', saat: '00:45' }, t)), '2026-11-12 10:45');
assert.equal(iso(sonrakiZaman({ siklik: 'haftalik', saat: '09:00', gun: 1 }, t)), '2026-11-16 9:00'); // pazartesi
assert.equal(iso(sonrakiZaman({ siklik: 'haftalik', saat: '11:00', gun: 4 }, t)), '2026-11-12 11:00'); // bugün perşembe, saat gelmedi
assert.equal(iso(sonrakiZaman({ siklik: 'haftalik', saat: '09:00', gun: 4 }, t)), '2026-11-19 9:00'); // geçti → gelecek hafta
assert.equal(iso(sonrakiZaman({ siklik: 'haftalik', saat: '09:00', gun: 7 }, t)), '2026-11-15 9:00'); // pazar
assert.equal(iso(sonrakiZaman({ siklik: 'aylik', saat: '09:00', gun: 1 }, t)), '2026-12-1 9:00');
assert.equal(iso(sonrakiZaman({ siklik: 'aylik', saat: '09:00', gun: 20 }, t)), '2026-11-20 9:00');

// Belge parçalama ve kelime araması
const uzun = Array.from({ length: 400 }, (_, i) => `kelime${i}`).join(' ');
const p = bol(uzun);
assert.ok(p.length >= 3 && p.every(x => x.length <= 900));
assert.ok(p[1].includes(p[0].split(' ').at(-1)!), 'parçalar örtüşmeli');
assert.deepEqual(bol('  '), []);
const puan = kelimePuani('kira depozito', [{ metin: 'Depozito iki aylık kira bedelidir.' }, { metin: 'Aidat yöneticiye ödenir.' }, { metin: 'Kira her ayın 5inde.' }]);
assert.ok(puan[0] > puan[2] && puan[2] > puan[1]);
// Türkçe ek ve soru kelimeleri: 'aidatı kim öder' → 'Aidat' eşleşir; 'hava nasıl' hiçbirini tutmaz
const k2 = kelimePuani('aidatı kim öder', [{ metin: 'Aidat kiracıya aittir.' }, { metin: 'Depozito 40.000 TL.' }]);
assert.ok(k2[0] > 0 && k2[1] === 0);
assert.deepEqual(kelimePuani('bugün hava nasıl', [{ metin: 'Depozito iki aylık kira bedeli kadar.' }]), [0]);

// Dersler: yalnız JSON dizi, en fazla 3, gizli bilgi yok
assert.deepEqual(dersleriAyikla('[]'), []);
assert.deepEqual(dersleriAyikla('bozuk'), []);
assert.deepEqual(dersleriAyikla('```json\n["Kullanıcı kısa cevap istiyor", "IBAN TR12 kaydet", "kısa", "Döviz sorularında yalnız rakamı söyle", "Hava sorusunda şehir sorma", "Dördüncü geçerli ders burada"]\n```'),
  ['Kullanıcı kısa cevap istiyor', 'Döviz sorularında yalnız rakamı söyle', 'Hava sorusunda şehir sorma']);

// SEO ölçümü
const iyi = `<html lang="tr"><head><title>Ankara'da Ev Temizliği | Güvenilir ve Hızlı Hizmet</title>
<meta name="description" content="Ankara'da sigortalı ekiplerle ev temizliği. Aynı gün randevu, şeffaf fiyat ve memnuniyet garantisiyle hizmetinizdeyiz.">
<link rel="canonical" href="https://ornek.com/"><meta property="og:title" content="x"><meta property="og:description" content="x"><meta property="og:image" content="x">
<script type="application/ld+json">{"@type":"LocalBusiness"}</script></head><body><h1>Ev temizliği</h1><img src="a.jpg" alt="ekip">${'metin '.repeat(400)}</body></html>`;
assert.deepEqual(htmlDenetle(iyi).sorunlar, []);
assert.deepEqual(htmlDenetle(iyi).jsonld, ['LocalBusiness']);
const kotu = htmlDenetle('<html><head><meta name="robots" content="noindex"></head><body><h1>a</h1><h1>b</h1><img src="x"></body></html>');
for (const s of ['Sayfa başlığı (title) yok', 'Meta açıklama yok', '2 tane H1 var (1 önerilir)', 'Canonical bağlantı yok', 'Sayfa noindex: arama motorlarında görünmez', '<html lang> yok', '1/1 görselde alt metni yok']) assert.ok(kotu.sorunlar.includes(s), s);

// Office: var olan dosyanın üzerine yazılmaz, yasak karakterler temizlenir
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofis-'));
assert.equal(path.basename(bosAd(dir, 'Rapor: Kasım/2026', 'docx')), 'Rapor Kasım 2026.docx');
fs.writeFileSync(path.join(dir, 'Rapor.docx'), '');
assert.equal(path.basename(bosAd(dir, 'Rapor', 'docx')), 'Rapor (2).docx');
fs.rmSync(dir, { recursive: true });

// Kod ajanı: görev tek argüman (kabuk yok), güvenli kipler
const c = komut('claude', 'C:\\proje', 'README yaz; rm -rf / && echo x');
assert.deepEqual(c, { exe: 'claude', args: ['-p', 'README yaz; rm -rf / && echo x', '--permission-mode', 'acceptEdits', '--output-format', 'text'] });
const x = komut('codex', 'C:\\proje', 'test');
assert.ok(x.args.includes('workspace-write') && !x.args.some(a => /dangerously|full-access/.test(a)));

console.log('orkas testleri geçti');
process.exit(0);
