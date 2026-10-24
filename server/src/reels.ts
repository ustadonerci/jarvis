// Reels / Shorts / TikTok videosu (dikey 1080x1920, 30 fps, ffmpeg). Model senaryoyu sahnelere böler; her sahnede
// ekranda büyük yazı, arka plan (kullanıcının resmi/videosu, yoksa yapay zekayla üretilen temsili görsel, o da yoksa
// koyu zemin) ve Jarvis'in seçili sesiyle seslendirme olur. Sahneler birleştirilir, istenirse altına müzik kısık sesle
// eklenir. Sonuç İndirilenler\Jarvis-Medya\reels-*.mp4. Paylaşma yok: video yalnızca dosyaya yazılır.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateImage, IMG_DIR } from './imagegen.js';
import { OUT_DIR, findFfmpeg, run } from './media.js';
import { safePath } from './system.js';
import { synthesize, type VoiceSel } from './tts.js';

const W = 1080, H = 1920, FPS = 30;
const IMG = /\.(jpe?g|png|webp|bmp)$/i, VID = /\.(mp4|mov|mkv|webm|m4v)$/i, AUD = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;

let voice: () => VoiceSel | null = () => null;
export const registerReelsVoice = (fn: () => VoiceSel) => { voice = fn; };

/** ffmpeg filtre içinde dosya yolu: Windows'ta "C:" iki noktası ve tırnak kaçırılır */
const fpath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

function fontFile(): string | null {
  const c = process.platform === 'win32'
    ? ['C:\\Windows\\Fonts\\arialbd.ttf', 'C:\\Windows\\Fonts\\segoeuib.ttf', 'C:\\Windows\\Fonts\\arial.ttf']
    : ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'];
  return c.find(f => fs.existsSync(f)) ?? null;
}

/** Ekrana sığsın diye yazıyı ~20 karakterlik satırlara böler (en çok 6 satır) */
export function wrap(text: string, n = 20): string {
  const lines: string[] = [];
  let cur = '';
  // Emoji yazı tipinde yok (kutu çıkar): ekrandan çıkarılır
  for (const w of text.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s+/g, ' ').trim().split(' ')) {
    if (cur && (cur + ' ' + w).length > n) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 6).join('\n');
}

/** Ses dosyasının süresi (ffmpeg -i çıktısındaki "Duration:" satırından; ffprobe gerekmez) */
const duration = (ff: string, file: string) => new Promise<number>(resolve =>
  execFile(ff, ['-hide_banner', '-i', file], { windowsHide: true }, (_e, _o, stderr) => {
    const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr));
    resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
  }));

export interface Scene { metin: string; seslendirme?: string; gorsel?: string; gorsel_istemi?: string; sure?: number }

async function background(s: Scene, i: number, uret: boolean, log: (l: string) => void): Promise<{ kind: 'img' | 'vid' | 'renk'; file?: string }> {
  if (s.gorsel) {
    const f = safePath(s.gorsel);
    if (!fs.existsSync(f)) throw new Error(`Sahne ${i + 1}: dosya bulunamadı: ${s.gorsel}`);
    if (IMG.test(f)) return { kind: 'img', file: f };
    if (VID.test(f)) return { kind: 'vid', file: f };
    throw new Error(`Sahne ${i + 1}: görsel resim ya da video olmalı`);
  }
  if (uret) {
    log(`sahne ${i + 1}: görsel üretiliyor`);
    const p = await generateImage(s.gorsel_istemi || s.metin).catch(() => null);
    const f = p ? path.join(IMG_DIR, path.basename(p.url)) : '';
    if (f && fs.existsSync(f)) return { kind: 'img', file: f };
  }
  return { kind: 'renk' };
}

/** Tek sahneyi aynı biçimde (h264 + aac 44.1k stereo) üretir; böylece birleştirme yeniden kodlamadan yapılır */
async function renderScene(ff: string, tmp: string, s: Scene, i: number, o: { seslendir: boolean; uret: boolean; log: (l: string) => void }): Promise<string> {
  const bg = await background(s, i, o.uret, o.log);
  let voiceFile = '';
  const sel = voice();
  const say = (s.seslendirme ?? s.metin).trim();
  if (o.seslendir && sel && say) {
    o.log(`sahne ${i + 1}: seslendiriliyor`);
    const sp = await synthesize(say, sel, `reels ${i + 1}`).catch(() => null);
    if (sp) fs.writeFileSync(voiceFile = path.join(tmp, `ses${i}.${sp.mime === 'audio/wav' ? 'wav' : 'mp3'}`), sp.buf);
  }
  const vlen = voiceFile ? await duration(ff, voiceFile) : 0;
  // Verilen süre; seslendirme daha uzunsa sesin sonuna kadar
  const dur = Math.min(20, Math.max(1.5, Number(s.sure) || (vlen ? 0 : 3), vlen ? vlen + 0.4 : 0));
  const frames = Math.round(dur * FPS);

  const input: string[] = bg.kind === 'img' ? ['-i', bg.file!]
    : bg.kind === 'vid' ? ['-stream_loop', '-1', '-i', bg.file!]
    : ['-f', 'lavfi', '-i', `color=c=0x0b1626:s=${W}x${H}:r=${FPS}:d=${dur}`];
  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  // Resimde yavaş yakınlaşma (Ken Burns); titrememesi için önce 2 kat büyütülür
  const bgf = bg.kind === 'img'
    ? `${cover},scale=${W * 2}:${H * 2},zoompan=z='min(zoom+0.0007,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`
    : `${cover},fps=${FPS}`;
  const txt = path.join(tmp, `yazi${i}.txt`);
  fs.writeFileSync(txt, wrap(s.metin), 'utf8');
  const font = fontFile();
  const draw = `drawtext=${font ? `fontfile='${fpath(font)}':` : ''}textfile='${fpath(txt)}':fontcolor=white:fontsize=78:line_spacing=20:borderw=7:bordercolor=black@0.85:x=(w-tw)/2:y=h*0.64-th/2`;
  const vf = `[0:v]${bgf},eq=brightness=-0.06,${draw},fade=t=in:st=0:d=0.25,format=yuv420p[v]`;
  const audioIn = voiceFile ? ['-i', voiceFile] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
  const out = path.join(tmp, `sahne${i}.mp4`);
  await run(ff, ['-hide_banner', '-y', ...input, ...audioIn, '-filter_complex', `${vf};[1:a]aresample=44100,apad[a]`,
    '-map', '[v]', '-map', '[a]', '-t', dur.toFixed(2), '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', out]);
  return out;
}

export async function makeReels(a: { baslik?: string; sahneler: Scene[]; muzik?: string; seslendirme?: boolean; gorsel_uret?: boolean }, log: (l: string) => void) {
  const ff = findFfmpeg();
  if (!ff) throw new Error('ffmpeg kurulu değil. Kullanıcıya söyle ve uygulama_yonet ile "Gyan.FFmpeg" kurulumunu öner (onay kartı açar).');
  const scenes = (Array.isArray(a.sahneler) ? a.sahneler : []).filter(s => s && String(s.metin ?? '').trim()).slice(0, 12);
  if (!scenes.length) throw new Error('En az bir sahne (metin) gerekli');
  const music = a.muzik ? safePath(a.muzik) : '';
  if (music && (!fs.existsSync(music) || !AUD.test(music))) throw new Error(`Müzik dosyası bulunamadı ya da ses dosyası değil: ${a.muzik}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-reels-'));
  try {
    const parts: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      log(`reels: sahne ${i + 1}/${scenes.length}`);
      parts.push(await renderScene(ff, tmp, { ...scenes[i], metin: String(scenes[i].metin) }, i, { seslendir: a.seslendirme !== false, uret: a.gorsel_uret !== false, log }));
    }
    const list = path.join(tmp, 'liste.txt');
    fs.writeFileSync(list, parts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const base = `reels-${String(a.baslik || 'video').toLocaleLowerCase('tr').replace(/[^\wğüşıöç]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video'}`;
    let out = path.join(OUT_DIR, `${base}.mp4`);
    for (let i = 2; fs.existsSync(out); i++) out = path.join(OUT_DIR, `${base}-${i}.mp4`);
    log('reels: sahneler birleştiriliyor');
    if (!music) await run(ff, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
    else {
      const joined = path.join(tmp, 'birlesik.mp4');
      await run(ff, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
      // Müzik konuşmanın altında kısık; video bitince müzik de biter
      await run(ff, ['-hide_banner', '-y', '-i', joined, '-stream_loop', '-1', '-i', music, '-filter_complex',
        '[1:a]aresample=44100,volume=0.13[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]',
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
    }
    const sure = await duration(ff, out);
    return { cikti: out, sahne: scenes.length, sure_sn: Math.round(sure * 10) / 10, seslendirme: a.seslendirme !== false && !!voice() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export const REELS_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'reels_yap',
      description: "Dikey (9:16, 1080x1920) Reels / Shorts / TikTok videosu üretir: her sahnede ekranda büyük yazı, arka plan (kullanıcının resmi/videosu ya da yapay zekayla üretilen görsel) ve Jarvis'in sesiyle seslendirme; istenirse alta müzik. Önce konuyu 4-8 kısa sahneye böl: ilk sahne dikkat çeken bir kanca, son sahne çağrı (takip et, yorum yaz…). metin ekranda görünen kısa yazıdır (en çok ~12 kelime); seslendirme söylenecek cümledir. Sonuç İndirilenler\\\\Jarvis-Medya'ya yazılır; paylaşılmaz.",
      parameters: {
        type: 'object',
        properties: {
          baslik: { type: 'string', description: 'Dosya adı için kısa başlık' },
          sahneler: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                metin: { type: 'string', description: 'Ekrandaki yazı (kısa)' },
                seslendirme: { type: 'string', description: 'Seslendirilecek cümle (yoksa metin okunur)' },
                gorsel: { type: 'string', description: "Kullanıcının resim/video dosyası, kullanıcı klasörüne göre (ör. 'Downloads/Jarvis-Gelen/foto.jpg')" },
                gorsel_istemi: { type: 'string', description: 'Görsel üretilecekse İngilizce kısa tarif (gerçek kişi değil)' },
                sure: { type: 'number', description: 'Saniye (seslendirme varsa sesin süresine göre ayarlanır)' },
              },
              required: ['metin'],
            },
          },
          muzik: { type: 'string', description: 'Arka plan müziği dosyası (mp3/wav), isteğe bağlı' },
          seslendirme: { type: 'boolean', description: 'Varsayılan true' },
          gorsel_uret: { type: 'boolean', description: 'Görseli olmayan sahnelere yapay zekayla görsel üret (varsayılan true)' },
        },
        required: ['sahneler'],
      },
    },
  },
] as const;

export const isReelsTool = (n: string) => n === 'reels_yap';

export async function runReelsTool(args: any, progress: (l: string) => void): Promise<string> {
  try {
    const r = await makeReels(args ?? {}, progress);
    progress(`reels hazır: ${path.basename(r.cikti)}`);
    return JSON.stringify({ ok: true, ...r, not: 'Videonun yerini ve süresini söyle. Paylaşmak isterse kendisi yükler (ya da otomasyon/paylaşım aracı onay kartıyla).' });
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 300) });
  }
}
