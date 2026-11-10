// Ekstre ayrıştırıcı testi (gerçek veri yok, örnek metin). Çalıştır: npm run test:ekstre
import assert from 'node:assert/strict';
import { weekStart } from './activity.js';
import { parseStatement, sameTransaction } from './ekstre.js';

const ORNEK = `EKSTRE BİLGİLERİ
Ekstre Borcu 1,417.63 TL
Son Ödeme Tarihi 25/09/2026
Kart Numarası 1234 56** **** 9999
Kart Limiti 65,000.00 TL
İşlem Tarihi İşlemler Tutar (TL) Kalan Tutar/Taksit
Önceki Dönemden Devreden Tutar 960.81
25/08/2026 ODEME ICIN TESEKKURLER +960.81
01/09/2026 MIGROS KADIKOY 1,200.00
02/09/2026 TEKNOSA TAKSIT 300.00 1,500.00 2/6
03/09/2026 MIGROS IADE +100.00
15/09/2026 AKDI KAR PAYI 15.33
15/09/2026 BSMV 2.30
Toplam 1,417.63`;

const r = parseStatement(ORNEK);
assert.equal(r.kart, '9999');
assert.equal(r.tutarli, true, 'devreden − ödeme + işlemler = toplam');
assert.equal(r.satirlar.length, 5, 'ödeme satırı harcama sayılmaz, üst bilgi satırları alınmaz');
assert.deepEqual(r.satirlar[0], { tarih: '2026-09-01', aciklama: 'MIGROS KADIKOY', tutar: 1200, tur: 'harcama', masraf: false });
assert.equal(r.satirlar[1].tutar, 300, 'taksit satırında ilk tutar alınır');
assert.equal(r.satirlar[2].tur, 'iade');
assert.equal(r.satirlar[3].masraf, true);
assert.equal(parseStatement(ORNEK.replace('MIGROS KADIKOY 1,200.00', 'okunamadi')).tutarli, false, 'eksik satır fark edilir');
assert.equal(parseStatement(ORNEK.replace(/\n/g, ' ')).tutarli, false, 'satırları kaybolmuş metin fark edilir');

const a = { tarih: '2026-10-20', tutar: 99.99, tur: 'harcama' };
assert.equal(sameTransaction(a, { ...a, tarih: '2026-10-22' }), true);
assert.equal(sameTransaction(a, { ...a, tarih: '2026-10-25' }), false);
assert.equal(sameTransaction(a, { ...a, tutar: 100 }), false);
assert.equal(sameTransaction(a, { ...a, tur: 'iade' }), false);
assert.equal(sameTransaction({ ...a, kart: '1111' }, { ...a, kart: '2222' }), false, 'farklı kart aynı işlem değildir');

assert.equal(weekStart('2026-11-05'), '2026-11-02', 'hafta pazartesi başlar');
assert.equal(weekStart('2026-11-08'), '2026-11-02', 'pazar aynı haftadadır');
assert.equal(weekStart('2026-11-02'), '2026-11-02');
console.log('✅ ekstre testi geçti');
