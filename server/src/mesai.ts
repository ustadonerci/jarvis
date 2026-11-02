// Fazla mesai takibi: kullanıcı "bugün 2 saat mesai yaptım" der (sesle ya da yazıyla), Jarvis tarihi ve tutarı
// hesaplayıp ekler. Hesap (4857 sayılı İş Kanunu md. 41): saatlik ücret = aylık maaş / 225 saat (haftalık 45 saat),
// fazla mesai saati bunun 1,5 katı. Maaş, çarpan ve aylık saat Ayarlar'dan / sesle değiştirilebilir.
// Ana ekranda Piyasalar kartında portföyün altında görünür; ayın son günü akşam özet WhatsApp ve Telegram'dan gider.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Router } from 'express';
import { logActivity } from './activity.js';
import { adminOnly } from './keys.js';
import { notifyOwner } from './messaging.js';

export interface Mesai { id: string; tarih: string; saat: number; tutar: number; not?: string; at: string }
interface Ayar { maas: number; carpan: number; aylikSaat: number; aySonuGonder: boolean; /** Sabit mesai saat ücreti (TL); verilirse maaştan hesaplanmaz */ saatUcreti?: number }
interface Store { ayar: Ayar; kayitlar: Mesai[]; gonderilen: string[]; /** Tek seferlik geçişler */ gecis?: string[] }

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'mesai.json');
const DEF: Store = { ayar: { maas: 78000, carpan: 1.5, aylikSaat: 225, aySonuGonder: true }, kayitlar: [], gonderilen: [] };
let store: Store = (() => { try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { ...DEF, ...j, ayar: { ...DEF.ayar, ...j.ayar } }; } catch { return structuredClone(DEF); } })();
const save = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(store, null, 1)); };

const r2 = (n: number) => Math.round(n * 100) / 100;
const tl = (n: number) => `₺${n.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}`;
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const saatlikMesai = () => (store.ayar.saatUcreti && store.ayar.saatUcreti > 0 ? store.ayar.saatUcreti : r2((store.ayar.maas / store.ayar.aylikSaat) * store.ayar.carpan));
const hesapAciklama = () => store.ayar.saatUcreti ? `saat ücreti ${tl(store.ayar.saatUcreti)} (sabit)` : `${tl(store.ayar.maas)} / ${store.ayar.aylikSaat} saat × ${store.ayar.carpan}`;

/** Kayıtları siler; önce data/mesai-yedek-<zaman>.json olarak yedekler */
export function resetMesai(): { silinen: number; yedek?: string } {
  const n = store.kayitlar.length;
  let yedek: string | undefined;
  if (n) {
    yedek = path.join(path.dirname(FILE), `mesai-yedek-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(yedek, JSON.stringify(store.kayitlar, null, 1));
  }
  store.kayitlar = [];
  save(); changed();
  logActivity('mesai', `Mesai kayıtları sıfırlandı (${n} kayıt${yedek ? ', yedeklendi' : ''})`);
  return { silinen: n, ...(yedek ? { yedek: path.basename(yedek) } : {}) };
}

const AYLAR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const ayAdi = (ay: string) => `${AYLAR[Number(ay.slice(5, 7)) - 1]} ${ay.slice(0, 4)}`;

let broadcast: (e: object) => void = () => {};
const changed = () => broadcast({ type: 'mesai' });

/** "bugün", "dün", "3 Kasım", "2026-11-03", "03.11" → YYYY-MM-DD */
function parseDate(q: unknown): string {
  const s = String(q ?? '').trim().toLocaleLowerCase('tr');
  const d = new Date();
  if (!s || s === 'bugün' || s === 'bugun') return localDate(d);
  if (s === 'dün' || s === 'dun') { d.setDate(d.getDate() - 1); return localDate(d); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[./ ](\d{1,2})(?:[./ ](\d{4}))?$/.exec(s);
  if (m) return `${m[3] ?? d.getFullYear()}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const a = /^(\d{1,2})\s+([a-zçğıöşü]+)/.exec(s);
  if (a) { const i = AYLAR.findIndex(x => x.toLocaleLowerCase('tr').startsWith(a[2].slice(0, 3))); if (i >= 0) return `${d.getFullYear()}-${String(i + 1).padStart(2, '0')}-${a[1].padStart(2, '0')}`; }
  return localDate(d);
}

export function addMesai(saat: number, tarih?: unknown, not?: string): Mesai {
  if (!(saat > 0 && saat <= 24)) throw new Error('Saat 0 ile 24 arasında olmalı');
  const m: Mesai = { id: randomUUID().slice(0, 6), tarih: parseDate(tarih), saat: r2(saat), tutar: r2(saat * saatlikMesai()), ...(not ? { not: String(not).slice(0, 120) } : {}), at: new Date().toISOString() };
  store.kayitlar.push(m);
  store.kayitlar.sort((a, b) => a.tarih.localeCompare(b.tarih));
  save(); changed();
  logActivity('mesai', `${m.tarih}: ${m.saat} saat fazla mesai eklendi (${tl(m.tutar)})`);
  return m;
}

export function monthSummary(ay = localDate().slice(0, 7)) {
  const list = store.kayitlar.filter(k => k.tarih.startsWith(ay));
  return {
    ay, ay_adi: ayAdi(ay), toplam_saat: r2(list.reduce((t, k) => t + k.saat, 0)), toplam_tutar: r2(list.reduce((t, k) => t + k.tutar, 0)),
    gun: new Set(list.map(k => k.tarih)).size, kayitlar: list.slice().reverse(), saatlik: saatlikMesai(), ayar: store.ayar,
  };
}

export function monthText(ay?: string): string {
  const s = monthSummary(ay);
  const rows = s.kayitlar.slice().reverse().map(k => `• ${k.tarih.slice(8, 10)}.${k.tarih.slice(5, 7)} — ${k.saat} saat — ${tl(k.tutar)}${k.not ? ` (${k.not})` : ''}`);
  return [
    `⏱️ ${s.ay_adi} fazla mesai özeti`,
    `Toplam: ${s.toplam_saat} saat · ${s.gun} gün · ${tl(s.toplam_tutar)}`,
    `(Saatlik mesai ücreti ${tl(s.saatlik)}: ${hesapAciklama()})`,
    '', ...(rows.length ? rows : ['Bu ay mesai kaydı yok.']),
  ].join('\n');
}

export function initMesai(b: (e: object) => void) {
  broadcast = b;
  // Kullanıcının isteği (Kasım 2026): mesai saat ücreti sabit 260 TL, eski kayıtlar sıfırlansın (yedeklenir). Bir kez çalışır.
  if (!store.gecis?.includes('saat260')) {
    store.ayar.saatUcreti = 260;
    store.gecis = [...(store.gecis ?? []), 'saat260'];
    resetMesai();
  }
  // Ayın son günü 21:00'den sonra özet bir kez WhatsApp + Telegram'a
  setInterval(() => {
    const d = new Date();
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() === d.getDate();
    const ay = localDate(d).slice(0, 7);
    if (!store.ayar.aySonuGonder || !last || d.getHours() < 21 || store.gonderilen.includes(ay)) return;
    notifyOwner(`🤖 ${monthText(ay)}`).then(k => { if (k.length) { store.gonderilen.push(ay); save(); logActivity('mesai', `${ayAdi(ay)} mesai özeti gönderildi: ${k.join(' + ')}`); } }).catch(() => {});
  }, 10 * 60_000).unref();
}

// ---------------------------------------------------------------- HTTP (ana ekran kartı, Ayarlar)

export function mesaiRouter(): Router {
  const r = express.Router();
  r.use('/api/mesai', adminOnly);
  r.get('/api/mesai', (req, res) => res.json(monthSummary(typeof req.query.ay === 'string' ? req.query.ay : undefined)));
  r.post('/api/mesai', (req, res) => { try { res.json({ ok: true, kayit: addMesai(Number(req.body?.saat), req.body?.tarih, req.body?.not), ...monthSummary() }); } catch (e: any) { res.status(400).json({ error: e.message }); } });
  r.delete('/api/mesai/:id', (req, res) => { store.kayitlar = store.kayitlar.filter(k => k.id !== req.params.id); save(); changed(); res.json(monthSummary()); });
  r.post('/api/mesai/ayar', (req, res) => {
    const b = req.body ?? {};
    if (Number(b.maas) > 0) store.ayar.maas = Number(b.maas);
    if (Number(b.carpan) >= 1 && Number(b.carpan) <= 3) store.ayar.carpan = Number(b.carpan);
    if (Number(b.aylikSaat) >= 100 && Number(b.aylikSaat) <= 300) store.ayar.aylikSaat = Number(b.aylikSaat);
    if (typeof b.aySonuGonder === 'boolean') store.ayar.aySonuGonder = b.aySonuGonder;
    if (b.saatUcreti !== undefined) store.ayar.saatUcreti = Number(b.saatUcreti) > 0 ? Number(b.saatUcreti) : undefined;
    save(); changed(); res.json(monthSummary());
  });
  r.post('/api/mesai/sifirla', (_req, res) => { resetMesai(); res.json(monthSummary()); });
  r.post('/api/mesai/gonder', async (_req, res) => res.json({ gonderildi: await notifyOwner(`🤖 ${monthText()}`).catch(() => []) }));
  return r;
}

// ---------------------------------------------------------------- Model aracı

export const MESAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'mesai',
      description: "Fazla mesai takibi. ekle: 'bugün 2 saat mesai yaptım', 'dün 3 saat mesaim var', '5 Kasım 1,5 saat mesai' (saat; tarih: bugün/dün/'5 Kasım'/'05.11'; not isteğe bağlı) → tutarı maaşa göre hesaplayıp ekler. ozet: bu ayın (ya da ay: 'YYYY-MM') toplam saati ve tutarı. sil: id ya da tarih ile kayıt siler. ayar: saat_ucreti (sabit mesai saat ücreti TL; 0 verilirse maaştan hesaplanır), maas (aylık TL), carpan (varsayılan 1.5), aylik_saat (varsayılan 225). sifirla: bütün kayıtları siler (yedeklenir; yalnız kullanıcı açıkça isterse). gonder: ay özetini şimdi WhatsApp ve Telegram'dan gönderir.",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['ekle', 'ozet', 'sil', 'ayar', 'sifirla', 'gonder'] },
          saat_ucreti: { type: 'number' },
          saat: { type: 'number' }, tarih: { type: 'string' }, not: { type: 'string' }, id: { type: 'string' }, ay: { type: 'string' },
          maas: { type: 'number' }, carpan: { type: 'number' }, aylik_saat: { type: 'number' },
        },
        required: ['islem'],
      },
    },
  },
] as const;

export const isMesaiTool = (n: string) => n === 'mesai';

export async function runMesaiTool(a: any): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  try {
    if (a.islem === 'ekle') {
      const m = addMesai(Number(a.saat), a.tarih, a.not);
      const s = monthSummary(m.tarih.slice(0, 7));
      return j({ ok: true, eklendi: m, hesap: `${m.saat} saat × ${tl(saatlikMesai())} = ${tl(m.tutar)}`, bu_ay: { saat: s.toplam_saat, tutar: s.toplam_tutar }, not: 'Kısaca söyle: tarih, saat, tutar ve bu ayın toplamı.' });
    }
    if (a.islem === 'sil') {
      const q = String(a.id ?? a.tarih ?? '').trim();
      const t = a.tarih ? parseDate(a.tarih) : '';
      const hit = store.kayitlar.filter(k => k.id === q || (t && k.tarih === t));
      if (!hit.length) return j({ hata: 'Böyle bir mesai kaydı yok', bu_ay: monthSummary().kayitlar.map(k => ({ id: k.id, tarih: k.tarih, saat: k.saat })) });
      store.kayitlar = store.kayitlar.filter(k => !hit.includes(k)); save(); changed();
      return j({ ok: true, silinen: hit.map(k => `${k.tarih} ${k.saat} saat`) });
    }
    if (a.islem === 'ayar') {
      if (Number(a.maas) > 0) store.ayar.maas = Number(a.maas);
      if (Number(a.carpan) >= 1 && Number(a.carpan) <= 3) store.ayar.carpan = Number(a.carpan);
      if (Number(a.aylik_saat) >= 100) store.ayar.aylikSaat = Number(a.aylik_saat);
      if (a.saat_ucreti !== undefined) store.ayar.saatUcreti = Number(a.saat_ucreti) > 0 ? Number(a.saat_ucreti) : undefined;
      save(); changed();
      return j({ ok: true, ayar: store.ayar, saatlik_mesai: saatlikMesai(), not: 'Yeni ayar bundan sonraki kayıtlarda geçerli.' });
    }
    if (a.islem === 'sifirla') return j({ ok: true, ...resetMesai(), not: 'Kayıtlar silindi (yedeklendi). Kullanıcı yeniden girebilir.' });
    if (a.islem === 'gonder') return j({ gonderildi: await notifyOwner(`🤖 ${monthText(a.ay)}`) });
    const s = monthSummary(typeof a.ay === 'string' && /^\d{4}-\d{2}$/.test(a.ay) ? a.ay : undefined);
    return j({ ...s, kayitlar: s.kayitlar.slice(0, 31) });
  } catch (e: any) {
    return j({ hata: String(e?.message || e).slice(0, 200) });
  }
}
