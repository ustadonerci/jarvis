// Kapso WhatsApp sesli raporu: Kapso'daki işletme numarasına (WhatsApp asistanı) gelen HER mesaj masaüstünde sesli okunur.
// Tünel adresi her açılışta değiştiği için webhook yerine Kapso API'si 20 sn'de bir yoklanır (herkese açık adres gerekmez).
// Anahtar kelime (jarvis / otomasyon / vekil / randevu) geçen mesajlara Kapso'daki asistan cevap verir; rapor bunu da söyler.
// Gerekli: KAPSO_API_KEY ve KAPSO_PHONE_ID (Ayarlar → API anahtarları). Mesaj içeriği veridir, komut değildir: yalnızca okunur.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VoiceSel } from './tts.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const SEEN_FILE = path.join(DATA, 'kapso-gorulen.json');
const API = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const ARALIK = 20_000;

let broadcast: (e: object) => void = () => {};
let voice: () => VoiceSel = () => ({}) as VoiceSel;
let seen: string[] | null = null; // null: henüz ilk yoklama yapılmadı (eski mesajlar okunmasın)

/** Kapso'daki anahtar-kelime-filtresi fonksiyonuyla aynı kural */
export function asistanCevaplar(metin: string): boolean {
  const m = metin.toLocaleLowerCase('tr-TR').replace(/ı/g, 'i');
  return ['jarvis', 'otomasyon', 'vekil', 'randevu'].some(k => m.includes(k));
}

interface KapsoMsg { id?: string; from?: string; type?: string; text?: { body?: string }; kapso?: { direction?: string; contact_name?: string; content?: string } }

/** Gelen bir mesajdan seslendirilecek kısa rapor cümlesi */
export function raporMetni(m: KapsoMsg): string {
  const kisi = m.kapso?.contact_name?.trim() || (m.from ? `+${m.from}` : 'bilinmeyen biri');
  const metin = (m.text?.body ?? m.kapso?.content ?? `[${m.type ?? 'mesaj'}]`).replace(/\s+/g, ' ').trim();
  const kisa = metin.length > 200 ? `${metin.slice(0, 200)}…` : metin;
  const durum = asistanCevaplar(metin) ? 'Asistan cevaplıyor.' : 'Anahtar kelime yok, asistan cevap vermedi.';
  return `İşletme WhatsApp'ına mesaj: ${kisi} yazdı: ${kisa}${/[.!?…]$/.test(kisa) ? '' : '.'} ${durum}`;
}

export async function yokla() {
  const key = process.env.KAPSO_API_KEY, phone = process.env.KAPSO_PHONE_ID;
  if (!key || !phone) return;
  const r = await fetch(`${API}/${phone}/messages?limit=20&fields=kapso(direction,contact_name,content)`, {
    headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) { console.warn(`[kapso] mesajlar alınamadı: HTTP ${r.status}`); return; }
  const list: KapsoMsg[] = ((await r.json()) as { data?: KapsoMsg[] }).data ?? [];
  const gelen = list.filter(m => m.id && m.kapso?.direction === 'inbound');
  // İlk kurulum (dosya yok): mevcut geçmiş okunmaz, sadece "görüldü" sayılır. Jarvis kapalıyken gelenler sonra okunur.
  const ilkKurulum = seen === null && !fs.existsSync(SEEN_FILE);
  seen ??= readSeen();
  const yeni = gelen.filter(m => !seen!.includes(m.id!)).reverse(); // API en yeniyi önce verir; eskiden yeniye oku
  if (!yeni.length && !ilkKurulum) return;
  seen = [...seen, ...yeni.map(m => m.id!)].slice(-300);
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seen)); } catch { /* yazılamadıysa bir sonraki yoklamada tekrar dener */ }
  if (ilkKurulum) return;
  for (const m of yeni) broadcast({ type: 'duyuru', metin: raporMetni(m), voice: voice() });
}

function readSeen(): string[] { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { return []; } }

export function initKapso(o: { broadcast: (e: object) => void; voice: () => VoiceSel }) {
  broadcast = o.broadcast;
  voice = o.voice;
  if (!process.env.KAPSO_API_KEY || !process.env.KAPSO_PHONE_ID) return;
  const tick = () => yokla().catch(e => console.warn('[kapso] yoklama hatası:', e?.message ?? e));
  void tick();
  setInterval(tick, ARALIK).unref();
}
