// Medya işleme (ffmpeg): resim boyutlandırma/kırpma/filtre/biçim, ses temizleme (gürültü azaltma + ses seviyesi),
// video kesme/sıkıştırma/GIF/sesini çıkarma ve .srt altyazı gömme. Kaynak dosyaya dokunulmaz: sonuç
// İndirilenler\Jarvis-Medya altına yeni dosya olarak yazılır. Yalnızca kullanıcı klasörü içindeki dosyalar.
// ffmpeg yoksa Jarvis onu uygulama_yonet (winget Gyan.FFmpeg) ile onay kartıyla kurmayı önerir.
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safePath } from './system.js';

const OUT_DIR = path.join(os.homedir(), 'Downloads', 'Jarvis-Medya');
const WIN = process.platform === 'win32';

function findFfmpeg(): string | null {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const w = spawnSync(WIN ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
  if (w.status === 0) return w.stdout.split(/\r?\n/)[0].trim();
  const g = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
  return WIN && fs.existsSync(g) ? g : null;
}

const run = (exe: string, args: string[]) => new Promise<void>((resolve, reject) =>
  execFile(exe, args, { timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, _o, stderr) =>
    (err ? reject(new Error(String(stderr || err.message).split(/\r?\n/).filter(Boolean).slice(-3).join(' · ').slice(0, 300))) : resolve())));

const IMG = /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i, AUD = /\.(mp3|wav|m4a|aac|ogg|opus|flac|wma)$/i, VID = /\.(mp4|mov|mkv|avi|webm|wmv|m4v|3gp)$/i;
const TIME = /^\d{1,2}(:\d{1,2}){0,2}(\.\d+)?$/;

/** İşleme göre ffmpeg argümanları ve çıktı uzantısı */
function plan(islem: string, src: string, a: any): { args: string[]; ext: string } {
  const ext = path.extname(src).toLowerCase();
  const num = (v: unknown, lo: number, hi: number) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`Geçersiz değer: ${v}`); return Math.round(n); };
  switch (islem) {
    case 'boyutlandir': {
      if (!IMG.test(src) && !VID.test(src)) throw new Error('Boyutlandırma resim ya da video içindir');
      const w = num(a.genislik ?? -1, -1, 8000), h = num(a.yukseklik ?? -1, -1, 8000);
      if (w < 1 && h < 1) throw new Error('genislik ya da yukseklik gerekli');
      return { args: ['-vf', `scale=${w > 0 ? w : -2}:${h > 0 ? h : -2}`], ext };
    }
    case 'kirp': {
      if (!IMG.test(src) && !VID.test(src)) throw new Error('Kırpma resim ya da video içindir');
      if (a.oran) {
        const m = /^(\d+):(\d+)$/.exec(String(a.oran));
        if (!m) throw new Error('oran 1:1, 9:16 gibi olmalı');
        const [rw, rh] = [Number(m[1]), Number(m[2])];
        return { args: ['-vf', `crop='min(iw,ih*${rw}/${rh})':'min(ih,iw*${rh}/${rw})'`], ext };
      }
      const [w, h, x, y] = [num(a.genislik, 1, 8000), num(a.yukseklik, 1, 8000), num(a.x ?? 0, 0, 8000), num(a.y ?? 0, 0, 8000)];
      return { args: ['-vf', `crop=${w}:${h}:${x}:${y}`], ext };
    }
    case 'filtre': {
      if (!IMG.test(src) && !VID.test(src)) throw new Error('Filtre resim ya da video içindir');
      const f = ({ siyah_beyaz: 'hue=s=0', bulanik: 'gblur=sigma=6', keskin: 'unsharp=5:5:1.2', parlak: 'eq=brightness=0.08:contrast=1.05', karanlik: 'eq=brightness=-0.08', canli: 'eq=saturation=1.4', sepya: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131' } as Record<string, string>)[String(a.filtre)];
      if (!f) throw new Error('filtre: siyah_beyaz, bulanik, keskin, parlak, karanlik, canli, sepya');
      return { args: ['-vf', f], ext };
    }
    case 'donustur': {
      const to = String(a.bicim ?? '').toLowerCase().replace(/^\./, '');
      if (!/^(jpg|png|webp|mp3|wav|m4a|ogg|mp4|webm|mov|gif)$/.test(to)) throw new Error('bicim: jpg, png, webp, mp3, wav, m4a, ogg, mp4, webm, mov, gif');
      return { args: to === 'gif' ? ['-vf', 'fps=12,scale=480:-1:flags=lanczos'] : [], ext: `.${to}` };
    }
    case 'ses_temizle':
      if (!AUD.test(src) && !VID.test(src)) throw new Error('Ses temizleme ses ya da video içindir');
      // Uğultu (80 Hz altı) ve tıslama kesilir, FFT gürültü azaltma, ses seviyesi yayın standardına (−16 LUFS)
      return { args: ['-af', 'highpass=f=80,lowpass=f=12000,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11', ...(VID.test(src) ? ['-c:v', 'copy'] : [])], ext };
    case 'kes': {
      if (!AUD.test(src) && !VID.test(src)) throw new Error('Kesme ses ya da video içindir');
      const s = String(a.baslangic ?? '0'), e = String(a.bitis ?? '');
      if (!TIME.test(s) || (e && !TIME.test(e))) throw new Error('baslangic/bitis 00:01:30 ya da 90 gibi olmalı');
      return { args: ['-ss', s, ...(e ? ['-to', e] : []), '-c', 'copy'], ext };
    }
    case 'sikistir':
      if (!VID.test(src)) throw new Error('Sıkıştırma video içindir');
      return { args: ['-c:v', 'libx264', '-crf', String(num(a.kalite ?? 28, 18, 35)), '-preset', 'medium', '-c:a', 'aac', '-b:a', '128k'], ext: '.mp4' };
    case 'sesi_cikar':
      if (!VID.test(src)) throw new Error('Sesi çıkarma video içindir');
      return { args: ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'], ext: '.mp3' };
    case 'altyazi_ekle': {
      if (!VID.test(src)) throw new Error('Altyazı video içindir');
      const srt = safePath(String(a.altyazi ?? ''));
      if (!/\.(srt|ass|vtt)$/i.test(srt) || !fs.existsSync(srt)) throw new Error('altyazi: .srt dosyasının yolu gerekli');
      // subtitles filtresinde Windows sürücü harfindeki ":" kaçırılmalı
      const p = srt.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      return { args: ['-vf', `subtitles='${p}'`, '-c:a', 'copy'], ext: '.mp4' };
    }
    default:
      throw new Error(`Bilinmeyen işlem: ${islem}`);
  }
}

export async function processMedia(islem: string, dosya: string, a: any): Promise<{ cikti: string; islem: string }> {
  const ff = findFfmpeg();
  if (!ff) throw new Error('ffmpeg kurulu değil. Kullanıcıya söyle ve uygulama_yonet ile "Gyan.FFmpeg" kurulumunu öner (onay kartı açar).');
  const src = safePath(dosya);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error(`Dosya bulunamadı: ${dosya}`);
  const p = plan(islem, src, a);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.basename(src, path.extname(src)).replace(/[^\w.\-ğüşıöçĞÜŞİÖÇ ]+/g, '_').slice(0, 60);
  let out = path.join(OUT_DIR, `${base}-${islem}${p.ext}`);
  for (let i = 2; fs.existsSync(out); i++) out = path.join(OUT_DIR, `${base}-${islem}-${i}${p.ext}`);
  // -ss "kes" için girişten önce olmalı (hızlı arama); diğerleri çıkış seçeneği
  const args = islem === 'kes' ? ['-hide_banner', '-y', ...p.args.slice(0, p.args.indexOf('-c')), '-i', src, ...p.args.slice(p.args.indexOf('-c')), out]
    : ['-hide_banner', '-y', '-i', src, ...p.args, ...(IMG.test(out) ? ['-frames:v', '1'] : []), out];
  await run(ff, args);
  return { cikti: out, islem };
}

export const MEDIA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'medya_isle',
      description: "Bilgisayardaki resim/ses/video dosyasını işler (ffmpeg); kaynağa dokunmaz, sonucu İndirilenler\\\\Jarvis-Medya'ya yeni dosya olarak yazar. İşlemler: boyutlandir (genislik/yukseklik), kirp (oran '1:1','9:16' ya da genislik,yukseklik,x,y), filtre (siyah_beyaz, bulanik, keskin, parlak, karanlik, canli, sepya), donustur (bicim: jpg/png/webp/mp3/wav/mp4/gif…), ses_temizle (gürültü azaltma + ses seviyesi), kes (baslangic, bitis), sikistir (video; kalite 18-35), sesi_cikar (videodan mp3), altyazi_ekle (altyazi: .srt yolu). Dosya yolu kullanıcı klasörüne göre (ör. 'Desktop/video.mp4'); bilinmiyorsa önce dosya_listele.",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['boyutlandir', 'kirp', 'filtre', 'donustur', 'ses_temizle', 'kes', 'sikistir', 'sesi_cikar', 'altyazi_ekle'] },
          dosya: { type: 'string' },
          genislik: { type: 'number' }, yukseklik: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' },
          oran: { type: 'string' }, filtre: { type: 'string' }, bicim: { type: 'string' },
          baslangic: { type: 'string' }, bitis: { type: 'string' }, kalite: { type: 'number' }, altyazi: { type: 'string' },
        },
        required: ['islem', 'dosya'],
      },
    },
  },
] as const;

export const isMediaTool = (n: string) => n === 'medya_isle';

export async function runMediaTool(args: any, progress: (l: string) => void): Promise<string> {
  try {
    progress(`medya: ${args.islem}`);
    const r = await processMedia(String(args.islem ?? ''), String(args.dosya ?? ''), args);
    return JSON.stringify({ ok: true, ...r, not: 'Sonuç dosyasının yerini kullanıcıya söyle.' });
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 300) });
  }
}
