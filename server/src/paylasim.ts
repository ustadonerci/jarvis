// Sosyal medya: tarz rehberi (style_guide.md) ve videoyu YouTube/Instagram'a paylaşma (talimat Bölüm 1 · 6).
// - Tarz rehberi Belgeler\Jarvis\style_guide.md'dedir (kullanıcı elle de düzenleyebilir); her Reels'ten önce okunur.
// - Paylaşım n8n üzerinden: Ayarlar → Yetenekler'de "youtube" / "instagram" adlı webhook'lar (n8n'de YouTube
//   Upload ve Instagram Graph düğümleri). Paylaşmadan önce önizleme (dosya, süre, başlık, açıklama) onay kartında
//   gösterilir; kullanıcı onaylamadan hiçbir şey gönderilmez.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { propose } from './approvals.js';
import { findHook } from './automation.js';
import { logActivity } from './activity.js';
import { OUT_DIR } from './media.js';

const GUIDE = path.join(os.homedir(), 'Documents', 'Jarvis', 'style_guide.md');
const DEFAULT_GUIDE = `# Jarvis tarz rehberi (Reels / Shorts)

Bu dosyayı istediğiniz gibi düzenleyin; Jarvis her videodan önce okur.

## Konular
- GitHub repo tanıtımı · kitap tanıtımı · yapay zekâ ve yeni teknolojiler

## Giriş cümlesi kalıbı (ilk 2 saniye)
- "Bunu bilmeyen çok şey kaçırıyor: …"
- "GitHub'da X yıldız almış bir araç: …"
- "Bu kitabı 30 saniyede anlatıyorum."

## Süre ve yapı
- 30–45 saniye, 5–7 sahne
- 1. sahne kanca, son sahne çağrı ("takip et", "yoruma yaz")

## Ton
- Samimi, enerjik, sade Türkçe; teknik terimi bir cümleyle açıkla

## Altyazı
- Kelime kelime, söylenen kelime sarı; ekranda en çok 3 kelime

## Beğenilen örnek videolar (en fazla 10)
`;

export function readGuide(): string {
  try { return fs.readFileSync(GUIDE, 'utf8'); } catch {
    fs.mkdirSync(path.dirname(GUIDE), { recursive: true });
    fs.writeFileSync(GUIDE, DEFAULT_GUIDE, 'utf8');
    return DEFAULT_GUIDE;
  }
}

function videoPath(p: string): string {
  const raw = String(p ?? '').trim();
  const cands = [raw, path.join(OUT_DIR, raw), path.join(os.homedir(), raw)];
  const f = cands.find(c => c && fs.existsSync(c) && fs.statSync(c).isFile());
  if (!f || !/\.(mp4|mov|webm|m4v)$/i.test(f)) throw new Error(`Video bulunamadı: ${raw} (İndirilenler\\Jarvis-Medya'daki dosya adını verin)`);
  return f;
}

export const PAYLASIM_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'tarz_rehberi',
      description: "Sosyal medya tarz rehberi (style_guide.md: giriş cümlesi kalıbı, süre, ton, altyazı, beğenilen örnek videolar). oku: Reels/Shorts hazırlamadan ÖNCE oku ve uy. ornek_ekle (url): beğenilen örnek videoyu ekler (en çok 10). guncelle (icerik): rehberin tamamını yeniden yazar (kullanıcı isterse).",
      parameters: { type: 'object', properties: { islem: { type: 'string', enum: ['oku', 'ornek_ekle', 'guncelle'] }, url: { type: 'string' }, not: { type: 'string', description: 'örnek video için kısa not (neden beğenildi)' }, icerik: { type: 'string' } }, required: ['islem'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'paylas_video',
      description: "Hazır videoyu YouTube ve/veya Instagram'a paylaşır (n8n webhook'u üzerinden). Önce ÖNİZLEME onay kartı açılır (dosya, başlık, açıklama, etiketler); kullanıcı onaylamadan paylaşılmaz. dosya: İndirilenler\\\\Jarvis-Medya'daki video adı ya da yolu.",
      parameters: { type: 'object', properties: { dosya: { type: 'string' }, platform: { type: 'string', enum: ['youtube', 'instagram', 'hepsi'] }, baslik: { type: 'string' }, aciklama: { type: 'string' }, etiketler: { type: 'array', items: { type: 'string' } } }, required: ['dosya', 'platform', 'baslik'] },
    },
  },
] as const;
export const isPaylasimTool = (n: string) => n === 'tarz_rehberi' || n === 'paylas_video';

export async function runPaylasimTool(name: string, a: any): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  try {
    if (name === 'tarz_rehberi') {
      const g = readGuide();
      if (a.islem === 'guncelle' && String(a.icerik ?? '').trim()) { fs.writeFileSync(GUIDE, String(a.icerik).slice(0, 20_000), 'utf8'); return j({ ok: true, dosya: GUIDE }); }
      if (a.islem === 'ornek_ekle') {
        const url = String(a.url ?? '').trim();
        if (!/^https?:\/\//.test(url)) return j({ hata: 'Geçerli bir video linki verin' });
        const n = (g.split('## Beğenilen örnek videolar')[1] ?? '').split('\n').filter(l => l.startsWith('- ')).length;
        if (n >= 10) return j({ hata: 'Rehberde zaten 10 örnek var; önce birini çıkarın (guncelle).' });
        fs.appendFileSync(GUIDE, `- ${url}${a.not ? ` — ${String(a.not).slice(0, 200)}` : ''}\n`, 'utf8');
        return j({ ok: true, ornek_sayisi: n + 1, not: 'İstersen linki link_oku ile açıp girişini, süresini ve tonunu rehbere not et.' });
      }
      return j({ dosya: GUIDE, rehber: g.slice(0, 8000), not: 'Bu rehbere uy; kullanıcıya rehberi okuduğunu ayrıca söylemene gerek yok.' });
    }
    // paylas_video
    const file = videoPath(a.dosya);
    const platforms = a.platform === 'hepsi' ? ['youtube', 'instagram'] : [String(a.platform)];
    const hooks = platforms.map(p => ({ p, h: findHook(p) ?? findHook(`${p} paylaş`) }));
    const eksik = hooks.filter(x => !x.h).map(x => x.p);
    if (eksik.length) return j({ hata: `${eksik.join(' ve ')} için paylaşım bağlantısı (n8n webhook) yok.`, nasil: "n8n'de bir iş akışı kurun: Webhook düğümü (POST, dosya alanı 'video') → YouTube 'Upload a video' ya da Instagram (Graph API) düğümü. Webhook adresini Jarvis → Ayarlar → Yetenekler → Webhook'lara 'youtube' / 'instagram' adıyla ekleyin. Hesap girişini n8n'de kendiniz yaparsınız; şifre Jarvis'e verilmez." });
    const mb = (fs.statSync(file).size / 1048576).toFixed(1);
    const etiket = (Array.isArray(a.etiketler) ? a.etiketler : []).map((t: string) => `#${String(t).replace(/^#/, '')}`).join(' ');
    return propose('paylasim', `Paylaş: ${platforms.join(' + ')} · ${String(a.baslik).slice(0, 60)}`,
      `ÖNİZLEME\nDosya: ${file} (${mb} MB)\nPlatform: ${platforms.join(', ')}\nBaşlık: ${a.baslik}\nAçıklama:\n${a.aciklama ?? ''}\n${etiket}`,
      'Onaylarsanız video n8n üzerinden yayınlanır. Yayınlamadan önce videoyu dosyadan izleyebilirsiniz.',
      async () => {
        const out: string[] = [];
        for (const { p, h } of hooks) {
          const fd = new FormData();
          fd.append('video', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), path.basename(file));
          fd.append('platform', p); fd.append('baslik', String(a.baslik)); fd.append('aciklama', `${a.aciklama ?? ''}\n${etiket}`.trim());
          const r = await fetch(h!.url, { method: 'POST', body: fd, signal: AbortSignal.timeout(10 * 60_000) });
          out.push(`${p}: ${r.ok ? 'gönderildi' : `hata ${r.status}`}`);
        }
        logActivity('paylasim', `Video paylaşıldı: ${path.basename(file)} · ${out.join(', ')}`);
        return out.join(' · ');
      });
  } catch (e: any) { return j({ hata: String(e?.message || e).slice(0, 300) }); }
}
