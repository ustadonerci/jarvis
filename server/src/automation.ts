// Otomasyon (hepsi onay kartıyla):
// - n8n / Make / Zapier webhook'ları: Ayarlar → Yetenekler'den adıyla eklenir; Jarvis veriyle tetikler. Sosyal medya
//   paylaşımı gibi API'si karmaşık işler n8n'de kurulur, Jarvis yalnızca içeriği hazırlayıp gönderir.
// - Telegram kanalına paylaşım (bot kanalda yönetici olmalı).
// - Kendi kodunu düzeltme: Jarvis kendi kaynak kodunu okur ve değişiklik önerir; kullanıcı farkı görüp onaylarsa
//   uygulanır (önce yedek alınır). npm run dev altında sunucu kendiliğinden yeniden başlar.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Router } from 'express';
import { adminOnly, restartServer } from './keys.js';
import { propose } from './approvals.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SRC, '..', '..');
const DATA = path.join(SRC, '..', 'data');
const HOOK_FILE = path.join(DATA, 'webhooklar.json');
const BACKUP = path.join(DATA, 'kod-yedek');

export interface Webhook { id: string; ad: string; url: string; aciklama: string }
const hooks = (): Webhook[] => { try { return JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8')); } catch { return []; } };
const saveHooks = (l: Webhook[]) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(HOOK_FILE, JSON.stringify(l, null, 2)); };
const norm = (s: string) => s.toLocaleLowerCase('tr').trim();
const findHook = (ad: string) => hooks().find(h => norm(h.ad) === norm(ad)) ?? hooks().find(h => norm(h.ad).includes(norm(ad)));

async function postHook(h: Webhook, veri: unknown): Promise<string> {
  const r = await fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(veri ?? {}), signal: AbortSignal.timeout(60_000) });
  const text = (await r.text()).slice(0, 4000);
  if (!r.ok) throw new Error(`${h.ad}: ${r.status} ${text}`);
  return text || `${h.ad} tetiklendi (${r.status})`;
}

async function telegramChannel(metin: string, gorsel?: string): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN, kanal = process.env.TELEGRAM_KANAL;
  if (!token || !kanal) throw new Error('TELEGRAM_BOT_TOKEN ve TELEGRAM_KANAL gerekli (Ayarlar → API anahtarları)');
  const method = gorsel ? 'sendPhoto' : 'sendMessage';
  const body = gorsel ? { chat_id: kanal, photo: gorsel, caption: metin.slice(0, 1024) } : { chat_id: kanal, text: metin };
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || `Telegram ${r.status}`);
  return `Telegram kanalında yayınlandı (mesaj ${j.result?.message_id})`;
}

// ---------------------------------------------------------------- Kendi kodu

/** Jarvis'in okuyup düzenleyebileceği yerler; .env, data, node_modules, derleme çıktıları hariç */
const CODE_DIRS = ['server/src', 'web/src', 'scripts', 'docs'];
const CODE_FILES = ['README.md', 'server/package.json', 'web/package.json', 'web/vite.config.ts', 'web/index.html'];
function codePath(rel: string): string {
  const clean = rel.replace(/\\/g, '/').replace(/^\.?\//, '');
  const full = path.resolve(ROOT, clean);
  const r = path.relative(ROOT, full).split(path.sep).join('/');
  if (r.startsWith('..') || !(CODE_FILES.includes(r) || CODE_DIRS.some(d => r === d || r.startsWith(d + '/')))) {
    throw new Error(`Yalnızca şu yerler: ${[...CODE_DIRS, ...CODE_FILES].join(', ')}`);
  }
  if (/(^|\/)(\.env|node_modules|dist)(\/|$)/.test(r)) throw new Error('Bu dosya okunamaz/düzenlenemez.');
  return full;
}
function listCode(): string[] {
  const out: string[] = [...CODE_FILES.filter(f => fs.existsSync(path.join(ROOT, f)))];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const r = `${d}/${e.name}`;
      if (e.isDirectory()) walk(r); else if (/\.(ts|tsx|mjs|js|css|md|json|html)$/.test(e.name)) out.push(r);
    }
  };
  CODE_DIRS.filter(d => fs.existsSync(path.join(ROOT, d))).forEach(walk);
  return out;
}
const count = (s: string, sub: string) => (sub ? s.split(sub).length - 1 : 0);
const lines = (s: string) => s.replace(/\n$/, '').split('\n');
const diff = (a: string, b: string) => [...lines(a).map(l => `- ${l}`), ...lines(b).map(l => `+ ${l}`)].join('\n');

// ---------------------------------------------------------------- Araçlar

export const AUTOMATION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'is_akisi_tetikle',
      description: "Kullanıcının eklediği bir n8n/Make/Zapier webhook iş akışını veriyle tetikler (sosyal medyada paylaşım, tabloya satır ekleme, bildirim vb.). Onay kartı açar. Mevcut webhook'lar sistem prompt'undaki listede.",
      parameters: {
        type: 'object',
        properties: {
          ad: { type: 'string', description: 'Webhook adı' },
          veri: { type: 'object', description: 'İş akışına gönderilecek JSON (ör. {"platform":"instagram","metin":"…","gorsel_url":"…"})' },
          aciklama: { type: 'string', description: 'Ne olacağı, sade Türkçe' },
        },
        required: ['ad', 'veri'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_kanal_paylas',
      description: "Kullanıcının Telegram kanalında gönderi paylaşır (isteğe bağlı görselle). Onay kartı açar; kart metni birebir gösterir.",
      parameters: { type: 'object', properties: { metin: { type: 'string' }, gorsel_url: { type: 'string' } }, required: ['metin'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kendi_kodunu_oku',
      description: "Jarvis'in kendi kaynak kodunu okur. dosya boşsa dosya listesini verir. Bir hatanın kök nedenini bulmak ya da yeni bir özelliği nereye ekleyeceğini görmek için.",
      parameters: { type: 'object', properties: { dosya: { type: 'string', description: 'Ör. "server/src/tools.ts"' }, ara: { type: 'string', description: 'Dosyada aranacak metin (yalnızca o bölgeyi getirir)' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kendi_kodunu_duzenle',
      description: "Jarvis'in kendi kodunda bir değişiklik ÖNERİR: 'eski' metin dosyada tam olarak BİR kez geçmeli ve 'yeni' ile değiştirilir. Ekranda farkı gösteren onay kartı açılır; onaylanırsa önce yedek alınır, sonra uygulanır. Önce kendi_kodunu_oku ile dosyayı oku.",
      parameters: {
        type: 'object',
        properties: {
          dosya: { type: 'string' },
          eski: { type: 'string', description: 'Değiştirilecek metin, dosyadaki gibi birebir (girintiler dahil)' },
          yeni: { type: 'string' },
          aciklama: { type: 'string', description: 'Neden: hangi hatayı düzeltiyor / ne ekliyor' },
        },
        required: ['dosya', 'eski', 'yeni', 'aciklama'],
      },
    },
  },
] as const;

export const isAutomationTool = (n: string) => AUTOMATION_TOOLS.some(t => t.function.name === n);

export function webhooksForPrompt(): string {
  const l = hooks();
  return l.length ? l.map(h => `- ${h.ad}: ${h.aciklama || '(açıklama yok)'}`).join('\n') : '(Eklenmiş webhook yok.)';
}

export async function runAutomationTool(name: string, args: any, progress: (l: string) => void): Promise<string> {
  try {
    if (name === 'is_akisi_tetikle') {
      const h = findHook(String(args.ad ?? ''));
      if (!h) return JSON.stringify({ hata: `"${args.ad}" adında webhook yok`, mevcut: hooks().map(x => x.ad) });
      const veri = args.veri ?? {};
      return propose('webhook', `İş akışı: ${h.ad}`, JSON.stringify(veri, null, 2), `${args.aciklama ?? h.aciklama}\nAdres: ${new URL(h.url).host}`, () => postHook(h, veri));
    }
    if (name === 'telegram_kanal_paylas') {
      const metin = String(args.metin ?? '').trim();
      if (!metin) return JSON.stringify({ hata: 'metin boş' });
      const gorsel = /^https:\/\//.test(String(args.gorsel_url ?? '')) ? String(args.gorsel_url) : undefined;
      return propose('paylasim', `Telegram kanalı: ${process.env.TELEGRAM_KANAL || '(kanal ayarlı değil)'}`, `${metin}${gorsel ? `\n\n[görsel] ${gorsel}` : ''}`, 'Bu gönderi kanalda herkese açık yayınlanacak.', () => telegramChannel(metin, gorsel));
    }
    if (name === 'kendi_kodunu_oku') {
      if (!args.dosya) return JSON.stringify({ dosyalar: listCode() });
      const f = codePath(String(args.dosya));
      const text = fs.readFileSync(f, 'utf8');
      progress(`kod okunuyor: ${args.dosya}`);
      if (args.ara) {
        const lines = text.split('\n');
        const hits = lines.map((l, i) => (l.includes(String(args.ara)) ? i : -1)).filter(i => i >= 0).slice(0, 5);
        if (!hits.length) return JSON.stringify({ hata: `"${args.ara}" bulunamadı`, satir_sayisi: lines.length });
        return JSON.stringify({ dosya: args.dosya, bolumler: hits.map(i => ({ satir: i + 1, metin: lines.slice(Math.max(0, i - 15), i + 25).join('\n') })) });
      }
      return JSON.stringify({ dosya: args.dosya, satir_sayisi: text.split('\n').length, metin: text.slice(0, 40_000), kesildi: text.length > 40_000 || undefined });
    }
    if (name === 'kendi_kodunu_duzenle') {
      const rel = String(args.dosya ?? '');
      const f = codePath(rel);
      const eski = String(args.eski ?? ''), yeni = String(args.yeni ?? '');
      const text = fs.readFileSync(f, 'utf8');
      const n = count(text, eski);
      if (n !== 1) return JSON.stringify({ hata: n === 0 ? "'eski' metin dosyada yok; önce kendi_kodunu_oku ile birebir kopyala" : `'eski' metin ${n} kez geçiyor; daha uzun ve benzersiz bir parça seç` });
      return propose('kod', `Kod: ${rel}`, diff(eski, yeni), String(args.aciklama ?? ''), async () => {
        const now = fs.readFileSync(f, 'utf8');
        if (count(now, eski) !== 1) throw new Error('Dosya öneriden sonra değişmiş; uygulanmadı.');
        fs.mkdirSync(BACKUP, { recursive: true });
        const yedek = path.join(BACKUP, `${new Date().toISOString().replace(/[:.]/g, '-')}__${rel.replace(/[\\/]/g, '__')}`);
        fs.writeFileSync(yedek, now);
        fs.writeFileSync(f, now.replace(eski, () => yeni));
        console.log(`[kod] ${rel} güncellendi (yedek: ${path.basename(yedek)})`);
        // Sunucu kodu değiştiyse yeni kodla açılsın (npm run dev altında); arayüz dosyalarını Vite kendisi yeniler
        const restarting = rel.startsWith('server/') && restartServer();
        return `${rel} güncellendi. Yedek: server/data/kod-yedek/${path.basename(yedek)}.${restarting ? ' Jarvis birkaç saniye içinde yeniden başlıyor.' : rel.startsWith('server/') ? ' Değişikliğin geçerli olması için Jarvis\'i yeniden başlatın.' : ''}`;
      });
    }
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 300) });
  }
  return JSON.stringify({ hata: 'bilinmeyen araç' });
}

// ---------------------------------------------------------------- HTTP (Ayarlar → Yetenekler → Webhook)

export function automationRouter(): Router {
  const r = express.Router();
  r.use('/api/webhook', adminOnly);
  r.get('/api/webhook', (_req, res) => res.json({ webhooklar: hooks().map(h => ({ ...h, url: h.url.replace(/(\/\/[^/]+\/).*/, '$1…') })) }));
  r.post('/api/webhook', (req, res) => {
    const ad = String(req.body?.ad ?? '').trim().slice(0, 60), url = String(req.body?.url ?? '').trim();
    if (!ad || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Ad ve http(s):// ile başlayan adres gerekli' });
    const l = hooks().filter(h => norm(h.ad) !== norm(ad));
    l.push({ id: randomUUID().slice(0, 8), ad, url, aciklama: String(req.body?.aciklama ?? '').trim().slice(0, 300) });
    saveHooks(l);
    res.json({ ok: true });
  });
  r.delete('/api/webhook/:id', (req, res) => { saveHooks(hooks().filter(h => h.id !== req.params.id)); res.json({ ok: true }); });
  return r;
}
