// Tekrarlayan otomasyonlar ve defter işlerini ilerletme (Orkas'tan uyarlandı; kod alınmadı):
// - Otomasyon: "her sabah 8'de borsa özetini Telegram'a at", "her pazartesi 9'da haftalık plan". Saatlik, günlük,
//   haftalık, aylık. Vakti gelince görev Jarvis'in ana beynine Telegram'dan yazılmış gibi verilir (remote.ts): cevap
//   Telegram'a gelir; onay isteyen işlemler yine onay kartıyla bekler. Jarvis kapalıyken kaçan çalışma 12 saat içinde
//   açılınca yapılır, daha eskisi atlanır.
// - Defter işleri: deftere "Jarvis yapsın" diye eklenen işler (ajan: true) 08:00-22:00 arasında sırayla yapılır;
//   sonuç Patron'un incelemesine Telegram'dan gider, iş "bitti" sayılmaz (Patron onaylar).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from './activity.js';
import { ajanRaporu, siradakiAjanIsi } from './defter.js';
import { notifyOwner } from './messaging.js';
import { handleRemote } from './remote.js';

type Siklik = 'saatlik' | 'gunluk' | 'haftalik' | 'aylik';
interface Oto { id: string; ad: string; gorev: string; siklik: Siklik; saat: string; gun?: number; aktif: boolean; son?: string; sonraki: string }

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'otomasyonlar.json');
let list: Oto[] = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } })();
const save = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 1)); };
const KACAN = 12 * 3600_000;
const GUNLER = ['', 'pazartesi', 'salı', 'çarşamba', 'perşembe', 'cuma', 'cumartesi', 'pazar'];

/** Bir sonraki çalışma zamanı (yerel saat). gun: haftalıkta 1=pazartesi … 7=pazar, aylıkta ayın günü (en fazla 28). */
export function sonrakiZaman(o: Pick<Oto, 'siklik' | 'saat' | 'gun'>, from = new Date()): Date {
  const [h, m] = o.saat.split(':').map(Number);
  const d = new Date(from);
  d.setSeconds(0, 0);
  if (o.siklik === 'saatlik') {
    d.setMinutes(m);
    if (d <= from) d.setHours(d.getHours() + 1);
    return d;
  }
  d.setHours(h, m);
  if (o.siklik === 'gunluk') { if (d <= from) d.setDate(d.getDate() + 1); return d; }
  if (o.siklik === 'haftalik') {
    const hedef = (o.gun ?? 1) % 7; // JS: 0=pazar
    d.setDate(d.getDate() + ((hedef - d.getDay() + 7) % 7));
    if (d <= from) d.setDate(d.getDate() + 7);
    return d;
  }
  d.setDate(Math.min(o.gun ?? 1, 28));
  if (d <= from) d.setMonth(d.getMonth() + 1);
  return d;
}

const tarif = (o: Oto) => `${o.siklik === 'saatlik' ? `her saat :${o.saat.slice(3)}'de` : o.siklik === 'gunluk' ? `her gün ${o.saat}` : o.siklik === 'haftalik' ? `her ${GUNLER[o.gun ?? 1]} ${o.saat}` : `her ayın ${o.gun ?? 1}'i ${o.saat}`}`;
const fmt = (iso: string) => new Date(iso).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

/** Görevi Jarvis'in ana beynine verir; cevabı Telegram'a gönderir ve döndürür */
async function calistir(baslik: string, gorev: string): Promise<string> {
  let cevap = '';
  await handleRemote('telegram', `${baslik}\n${gorev}`, async t => { cevap += t; return notifyOwner(t, 'telegram'); });
  return cevap;
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = new Date();
    for (const o of list.filter(x => x.aktif && Date.parse(x.sonraki) <= now.getTime())) {
      const gec = now.getTime() - Date.parse(o.sonraki) > KACAN;
      o.son = now.toISOString();
      o.sonraki = sonrakiZaman(o, now).toISOString();
      save();
      if (gec) { logActivity('otomasyon', `"${o.ad}" 12 saatten fazla kaçtığı için atlandı`); continue; }
      logActivity('otomasyon', `"${o.ad}" çalıştı`);
      await calistir(`⏰ Otomasyon "${o.ad}" (${tarif(o)}). Bu görevi şimdi yap ve sonucu kısaca yaz:`, o.gorev);
    }
    // Defterde Jarvis'e verilmiş işler: gündüz, sırayla, her seferinde bir tane
    const h = now.getHours();
    const is = h >= 8 && h < 22 ? siradakiAjanIsi() : undefined;
    if (is) {
      const rapor = await calistir('📋 Defterdeki işi yap. Gönderme, silme, paylaşma ya da para gerektiren adımlar için onay kartı aç, kendin yapma. Sonunda ne yaptığını ve incelemem gerekenleri kısa rapor et:', is.metin);
      ajanRaporu(is.id, rapor || '(cevap gelmedi)');
      await notifyOwner(`📋 "${is.metin}" işi incelemeni bekliyor. Uygunsa "defterdeki ${is.metin.slice(0, 40)} işi bitti" de.`, 'telegram').catch(() => []);
      logActivity('otomasyon', `Defter işi yapıldı, incelemede: ${is.metin.slice(0, 80)}`);
    }
  } finally {
    busy = false;
  }
}

export function initOtomasyon() {
  setInterval(() => tick().catch(e => console.warn(`[otomasyon] ${String(e?.message || e).slice(0, 160)}`)), 60_000).unref();
}

export const OTOMASYON_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'otomasyon',
      description: "Tekrarlayan otomasyonlar: 'her sabah 8'de borsa özetini at', 'her pazartesi 9'da haftalık planımı çıkar', 'her saat başı e-postalara bak', 'her ayın 1'inde kira hatırlat'. Vakti gelince görev sana verilir, cevap Telegram'dan gider. islem: ekle (ad, gorev: o an yapılacak işin tam tarifi, siklik: saatlik|gunluk|haftalik|aylik, saat: 'HH:MM' (saatlikte dakika için '00:15'), gun: haftalıkta 1=pazartesi…7=pazar, aylıkta ayın günü 1-28), liste, sil (id ya da ad), durdur, baslat, simdi (hemen bir kez çalıştırır). Tek seferlik hatırlatma için bana_gonder kullan.",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['ekle', 'liste', 'sil', 'durdur', 'baslat', 'simdi'] },
          ad: { type: 'string' }, gorev: { type: 'string' },
          siklik: { type: 'string', enum: ['saatlik', 'gunluk', 'haftalik', 'aylik'] },
          saat: { type: 'string' }, gun: { type: 'number' }, id: { type: 'string' },
        },
        required: ['islem'],
      },
    },
  },
] as const;
export const isOtomasyonTool = (n: string) => n === 'otomasyon';

export async function runOtomasyonTool(a: any): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  const goster = () => list.map(o => ({ id: o.id, ad: o.ad, ne_zaman: tarif(o), gorev: o.gorev, aktif: o.aktif, sonraki: o.aktif ? fmt(o.sonraki) : 'durduruldu', son: o.son ? fmt(o.son) : undefined }));
  if (a.islem === 'liste') return j({ otomasyonlar: goster() });
  if (a.islem === 'ekle') {
    const ad = String(a.ad ?? '').trim().slice(0, 60), gorev = String(a.gorev ?? '').trim().slice(0, 1500);
    const siklik = a.siklik as Siklik;
    const hm = /^(\d{1,2})[:.](\d{2})$/.exec(String(a.saat ?? '09:00').trim());
    if (!ad || !gorev || !['saatlik', 'gunluk', 'haftalik', 'aylik'].includes(siklik) || !hm || Number(hm[1]) > 23 || Number(hm[2]) > 59) return j({ hata: 'ad, gorev, siklik ve geçerli saat (HH:MM) gerekli' });
    const gun = siklik === 'haftalik' ? Math.min(7, Math.max(1, Math.round(Number(a.gun) || 1))) : siklik === 'aylik' ? Math.min(28, Math.max(1, Math.round(Number(a.gun) || 1))) : undefined;
    const o: Oto = { id: randomUUID().slice(0, 6), ad, gorev, siklik, saat: `${hm[1].padStart(2, '0')}:${hm[2]}`, gun, aktif: true, sonraki: '' };
    o.sonraki = sonrakiZaman(o).toISOString();
    list.push(o); save();
    return j({ ok: true, id: o.id, ad, ne_zaman: tarif(o), ilk_calisma: fmt(o.sonraki), not: 'Jarvis açık ve bilgisayar uyanıkken çalışır.' });
  }
  const q = String(a.id ?? a.ad ?? '').trim().toLocaleLowerCase('tr');
  const o = list.find(x => x.id === q) ?? list.find(x => q && x.ad.toLocaleLowerCase('tr').includes(q));
  if (!o) return j({ hata: 'Otomasyon bulunamadı', otomasyonlar: goster() });
  if (a.islem === 'sil') { list = list.filter(x => x !== o); save(); return j({ ok: true, silindi: o.ad }); }
  if (a.islem === 'durdur' || a.islem === 'baslat') {
    o.aktif = a.islem === 'baslat';
    if (o.aktif) o.sonraki = sonrakiZaman(o).toISOString();
    save();
    return j({ ok: true, ad: o.ad, aktif: o.aktif });
  }
  // simdi: sohbet kilidini beklememek için arka planda
  setTimeout(() => { calistir(`⏰ Otomasyon "${o.ad}" (elle çalıştırıldı):`, o.gorev).catch(() => {}); }, 3000);
  return j({ ok: true, not: `"${o.ad}" birkaç saniye içinde çalışacak; sonucu Telegram'a gelecek.` });
}
