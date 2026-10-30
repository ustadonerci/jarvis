// Kullanıcıya mesaj: Jarvis, kullanıcının KENDİSİNE Telegram (Jarvis botu) ve WhatsApp ("Kendime mesaj" sohbeti)
// üzerinden yazar. Hemen ya da zamanlı ("yarın 9'da hatırlat", "30 dk sonra yaz"). Zamanlı mesajlar diskte tutulur;
// Jarvis kapalıyken vakti geçenler açılınca gönderilir. Başkalarına mesaj mesaj_gonder ile (onaylı) yapılır.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from './activity.js';
import { notifyOwner, ownerChannels } from './messaging.js';

type Kanal = 'telegram' | 'whatsapp' | 'hepsi';
interface Planned { id: string; metin: string; platform: Kanal; zaman: string; olusturma: string }

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'zamanli-mesajlar.json');
let list: Planned[] = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } })();
const save = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 1)); };

const fmt = (iso: string) => new Date(iso).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

async function send(metin: string, platform: Kanal) {
  const text = metin.startsWith('🤖') ? metin : `🤖 ${metin}`;
  const giden = await notifyOwner(text, platform);
  const ch = ownerChannels();
  const eksik = (['telegram', 'whatsapp'] as const).filter(k => (platform === 'hepsi' || platform === k) && !giden.some(g => g.toLowerCase() === k)).map(k => ({ kanal: k, neden: ch[k] === true ? 'gönderilemedi' : ch[k] }));
  return { giden, eksik };
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    for (const p of list.filter(x => Date.parse(x.zaman) <= now)) {
      const r = await send(p.metin, p.platform).catch(() => ({ giden: [] as string[], eksik: [] }));
      // Hiçbir kanaldan gidemediyse (bağlantı yok) 5 dk sonra tekrar denenir; 1 günü geçen bırakılır
      if (!r.giden.length && now - Date.parse(p.zaman) < 24 * 3600_000) continue;
      list = list.filter(x => x.id !== p.id);
      save();
      logActivity('mesaj', `Zamanlı mesaj ${r.giden.join(' + ') || 'GÖNDERİLEMEDİ'}: ${p.metin.slice(0, 80)}`);
    }
  } finally {
    busy = false;
  }
}

export function initOwnerMsg() {
  setInterval(() => tick().catch(() => {}), 30_000).unref();
  setTimeout(() => tick().catch(() => {}), 15_000).unref();
}

/** "2026-10-31T09:00", "09:00" / "9.30" (bugün; geçtiyse yarın), dakika_sonra */
function when(a: any): Date | null {
  if (Number(a.dakika_sonra) > 0) return new Date(Date.now() + Number(a.dakika_sonra) * 60_000);
  const z = String(a.zaman ?? '').trim();
  if (!z) return null;
  const hm = /^(\d{1,2})[:.](\d{2})$/.exec(z);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }
  const d = new Date(z);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const OWNERMSG_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bana_gonder',
      description: "Kullanıcının KENDİSİNE Telegram'dan (Jarvis botu) ve/veya WhatsApp'tan (kendine mesaj sohbeti) mesaj gönderir: 'bunu bana Telegram'dan at', 'listeyi WhatsApp'ıma gönder', 'yarın 9'da bana hatırlat', '30 dk sonra yaz'. islem: gonder (zaman ya da dakika_sonra verilirse zamanlanır), liste (bekleyen zamanlı mesajlar), iptal (id ya da metinden parça). Onay gerekmez: yalnız kullanıcının kendisine gider.",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['gonder', 'liste', 'iptal'] },
          metin: { type: 'string', description: 'Gönderilecek mesaj (hatırlatmada ne hatırlatılacağı)' },
          platform: { type: 'string', enum: ['telegram', 'whatsapp', 'hepsi'], description: 'Varsayılan hepsi' },
          zaman: { type: 'string', description: "Yerel saatle '09:00' (bugün, geçtiyse yarın) ya da '2026-10-31T09:00'" },
          dakika_sonra: { type: 'number' },
          id: { type: 'string' },
        },
        required: ['islem'],
      },
    },
  },
] as const;

export const isOwnerMsgTool = (n: string) => n === 'bana_gonder';

export async function runOwnerMsgTool(a: any, progress: (l: string) => void): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  const platform: Kanal = a.platform === 'telegram' || a.platform === 'whatsapp' ? a.platform : 'hepsi';
  try {
    if (a.islem === 'liste') return j({ bekleyen: list.map(p => ({ id: p.id, zaman: fmt(p.zaman), platform: p.platform, metin: p.metin })), kanallar: ownerChannels() });
    if (a.islem === 'iptal') {
      const q = String(a.id ?? a.metin ?? '').trim().toLocaleLowerCase('tr');
      const hit = list.filter(p => p.id === q || (q && p.metin.toLocaleLowerCase('tr').includes(q)));
      if (!hit.length) return j({ hata: 'Bekleyen böyle bir mesaj yok', bekleyen: list.map(p => ({ id: p.id, zaman: fmt(p.zaman), metin: p.metin })) });
      list = list.filter(p => !hit.includes(p)); save();
      return j({ ok: true, iptal: hit.map(p => p.metin) });
    }
    const metin = String(a.metin ?? '').trim().slice(0, 12_000);
    if (!metin) return j({ hata: 'Mesaj metni boş' });
    const ch = ownerChannels();
    const hazir = (platform === 'hepsi' ? [ch.telegram, ch.whatsapp] : [ch[platform]]).some(x => x === true);
    const d = when(a);
    if (d) {
      if (d.getTime() - Date.now() > 366 * 24 * 3600_000) return j({ hata: 'En fazla 1 yıl sonrasına zamanlanabilir' });
      const p: Planned = { id: randomUUID().slice(0, 6), metin, platform, zaman: d.toISOString(), olusturma: new Date().toISOString() };
      list.push(p); save();
      return j({ ok: true, zamanlandi: fmt(p.zaman), id: p.id, platform, uyari: hazir ? undefined : 'Şu an hiçbir kanal hazır değil; vakti gelince bağlantı varsa gider.', kanallar: ch });
    }
    progress('mesaj gönderiliyor');
    const r = await send(metin, platform);
    if (!r.giden.length) return j({ hata: 'Mesaj gönderilemedi', eksik: r.eksik, not: 'Kullanıcıya eksik kurulumu (Telegram anahtarı/eşleşme ya da WhatsApp QR) Ayarlar → Mesajlaşma\'dan yapmasını söyle.' });
    return j({ ok: true, gonderildi: r.giden, eksik: r.eksik.length ? r.eksik : undefined });
  } catch (e: any) {
    return j({ hata: String(e?.message || e).slice(0, 300) });
  }
}
