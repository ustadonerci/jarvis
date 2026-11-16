// Dosya okuyucu testleri (ağ yok, mesaj gönderilmez). Çalıştır: npm run test:dosya
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { dosyaIstegi, dosyaOku, epubMetin, htmlMetin, turBul, zipAc } from './dosyaoku.js';

// Tür içerikten anlaşılır (ad yanlış/eksik olsa da)
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
assert.equal(turBul(JPG, 'belge'), 'jpeg');
assert.equal(turBul(PNG), 'png');
assert.equal(turBul(GIF, 'x.jpg'), 'gif');
assert.equal(turBul(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
assert.equal(turBul(Buffer.from('%PDF-1.7\n')), 'pdf');
assert.equal(turBul(Buffer.from('\0\0\0\x18ftypheic'), ''), 'heic');
assert.equal(turBul(Buffer.from('\0\0\0\x18ftypisom'), '', 'video/mp4'), 'video');
assert.equal(turBul(Buffer.from('merhaba dünya')), 'metin');
assert.equal(turBul(Buffer.from([0, 1, 2, 3, 0, 5])), 'ikili');

// En küçük ZIP: biri sıkıştırılmamış, biri deflate
function zip(dosyalar: [string, string, boolean][]): Buffer {
  const yerel: Buffer[] = [], dizin: Buffer[] = [];
  let off = 0;
  for (const [ad, icerik, sik] of dosyalar) {
    const ham = Buffer.from(icerik), veri = sik ? deflateRawSync(ham) : ham, n = Buffer.from(ad);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(sik ? 8 : 0, 8); h.writeUInt32LE(veri.length, 18); h.writeUInt32LE(ham.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(sik ? 8 : 0, 10); c.writeUInt32LE(veri.length, 20); c.writeUInt32LE(ham.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    yerel.push(h, n, veri); dizin.push(c, n);
    off += 30 + n.length + veri.length;
  }
  const d = Buffer.concat(dizin), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(dosyalar.length, 8); e.writeUInt16LE(dosyalar.length, 10); e.writeUInt32LE(d.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...yerel, d, e]);
}
const z = zipAc(zip([['a.txt', 'düz', false], ['b.txt', 'sıkıştırılmış metin '.repeat(20), true]]));
assert.equal(z.get('a.txt')!().toString(), 'düz');
assert.equal(z.get('b.txt')!().toString(), 'sıkıştırılmış metin '.repeat(20));

// EPUB: spine sırası (manifest sırası değil), URL kodlu Türkçe dosya adı, HTML temizliği
const epub = zip([
  ['mimetype', 'application/epub+zip', false],
  ['META-INF/container.xml', '<rootfile full-path="OEBPS/content.opf"/>', true],
  ['OEBPS/content.opf', '<manifest><item id="c2" href="b%C3%B6l%C3%BCm2.xhtml"/><item id="c1" href="bolum1.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine>', true],
  ['OEBPS/bolum1.xhtml', '<html><head><style>p{}</style></head><body><h1>Birinci</h1><p>Kahraman &amp; dostu.</p></body></html>', true],
  ['OEBPS/bölüm2.xhtml', '<html><body><p>Son&#33;</p></body></html>', true],
]);
assert.equal(turBul(epub), 'epub');
assert.equal(epubMetin(epub), 'Birinci\nKahraman & dostu.\n\nSon!');
assert.equal(htmlMetin('<script>kötü()</script><p>A&nbsp;&lt;b&gt;</p>'), 'A <b>');

const ic = await dosyaOku(epub, 'kitap.epub');
assert.ok('tur' in ic && ic.tur === 'metin' && ic.metin.includes('Kahraman & dostu.'));
const resim = await dosyaOku(JPG, 'foto');
assert.ok('tur' in resim && resim.tur === 'resim' && resim.dataUrl.startsWith('data:image/jpeg;base64,'));
assert.ok('hata' in (await dosyaOku(Buffer.from([0, 1, 2, 0]), 'x.bin')));
assert.ok('hata' in (await dosyaOku(Buffer.from('   '), 'bos.txt')));

// Uzun metin kesilir; istek metni içerik ve kullanıcı notunu taşır
const uzun = await dosyaOku(Buffer.from('a'.repeat(40_000)), 'uzun.txt');
assert.ok('tur' in uzun && uzun.tur === 'metin' && uzun.metin.length === 30_000 && uzun.kesildi);
const ist = dosyaIstegi({ tur: 'metin', metin: 'içerik' }, 'not.txt', 'kim imzalamış?');
assert.ok(ist.metin.includes('\n<<<\niçerik\n>>>\n') && ist.metin.endsWith('kim imzalamış?') && !ist.resim);
assert.equal(dosyaIstegi({ tur: 'resim', dataUrl: 'data:image/png;base64,AA' }, 'f.png', '').resim, 'data:image/png;base64,AA');
assert.ok(dosyaIstegi({ hata: 'bozuk' }, 'x', '').metin.includes('bozuk'));
console.log('dosya okuma testleri geçti');
process.exit(0);
