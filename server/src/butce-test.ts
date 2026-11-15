// Bütçe Bekçisi eşik, kategori ve mükerrer testleri (dosyaya yazmaz, mesaj göndermez). Çalıştır: npm run test:butce
import assert from 'node:assert/strict';
import { katOf, seviye, tekil } from './butce.js';
import type { Expense } from './expenses.js';

// Eşikler: 2.000 TL ve üstü limitlerde kalan ≤ 2.000 bilgi, ≤ 1.000 dikkat, < 0 kritik
assert.equal(seviye(16_000, 13_000), 0);
assert.equal(seviye(16_000, 14_000), 1);
assert.equal(seviye(16_000, 15_000), 2);
assert.equal(seviye(16_000, 16_000), 2); // kalan 0: henüz aşılmadı
assert.equal(seviye(16_000, 16_001), 3);
// 2.000 TL'den küçük limitlerde %75 ve %90
assert.equal(seviye(1_500, 1_100), 0);
assert.equal(seviye(1_500, 1_125), 1);
assert.equal(seviye(1_500, 1_350), 2);
assert.equal(seviye(1_500, 1_600), 3);

// Kategori: işyeri kuralı, gider kategorisinden eşleme, öğrenilen, emin değilse null
const e = (isyeri: string, kategori = 'Diğer') => ({ isyeri, kategori });
assert.equal(katOf(e('MIGROS KADIKOY'), {}), 'Mutfak ve Market');
assert.equal(katOf(e('SHELL MASLAK'), {}), 'Ulaşım');
assert.equal(katOf(e('NETFLIX.COM', 'Fatura / Abonelik'), {}), 'Kişisel Keyif');
assert.equal(katOf(e('TURKCELL ODEME', 'Fatura / Abonelik'), {}), 'Faturalar');
assert.equal(katOf(e('X EVENT', 'Eğlence'), {}), 'Kişisel Keyif');
assert.equal(katOf(e('TRENDYOL', 'Online alışveriş'), {}), null);
assert.equal(katOf(e('TRENDYOL 123', 'Online alışveriş'), { trendyol: 'Mutfak ve Market' }), 'Mutfak ve Market');

// Mükerrer: aynı tutar + işyeri + gün, 10 dk'dan az fark → bir kez
const x = (id: string, saat: string, tutar = 650, isyeri = 'MIGROS'): Expense => ({ id, tarih: '2026-11-14', saat, isyeri, kategori: 'Market', tutar, para: 'TRY', kart: '', banka: '', tur: 'harcama', kaynak: '' });
assert.equal(tekil([x('a', '10:00'), x('b', '10:07')]).length, 1);
assert.equal(tekil([x('a', '10:00'), x('b', '10:12')]).length, 2);
assert.equal(tekil([x('a', '10:00'), x('b', '10:03', 700)]).length, 2);
assert.equal(tekil([x('a', ''), x('b', '')]).length, 2); // saat yoksa birleştirilmez
console.log('bütçe testleri geçti');
process.exit(0);
