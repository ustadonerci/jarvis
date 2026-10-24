// VoiceStudio (https://github.com/debpalash/VoiceStudio): bilgisayarda çalışan yerel ses klonlama/seslendirme
// uygulaması. Arka ucu varsayılan olarak http://localhost:3900 (VOICESTUDIO_URL ile değişir).
// - Jarvis'e ses dosyası gönderilince: ses temizlenir (gürültü, uğultu, seviye, baş/son sessizlik; en iyi ~25 sn),
//   VoiceStudio'da klon ses profili oluşturulur ve Jarvis'in sesi o profil olur.
// - Seslendirme OpenAI uyumlu /v1/audio/speech ile (voice = profil kimliği).
// - Kurulum: resmi GitHub sürümündeki Windows kurulum dosyası indirilir, SHA256SUMS ile doğrulanır ve kurulum
//   sihirbazı açılır (onay kartıyla). Model indirme de boyutu ve lisansı gösteren onay kartıyla yapılır.
//   İlk açılıştaki istatistik (analytics) onayına Jarvis cevap vermez; o kullanıcının kararıdır.
import { createHash } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { propose } from './approvals.js';
import { safePath } from './system.js';

export const VS_MODEL = 'voicestudio';
export const isVoiceStudio = (m: string) => m === VS_MODEL;
const base = () => (process.env.VOICESTUDIO_URL || 'http://localhost:3900').replace(/\/$/, '');
const WIN = process.platform === 'win32';

// ---------------------------------------------------------------- Durum

let up = false;
let lastCheck = 0;
/** Arka uç açık mı (30 sn önbellekli; senkron kullanım için son bilinen değer) */
export async function vsHealth(force = false): Promise<boolean> {
  if (!force && Date.now() - lastCheck < 30_000) return up;
  lastCheck = Date.now();
  try { up = (await fetch(`${base()}/health`, { signal: AbortSignal.timeout(2500) })).ok; } catch { up = false; }
  return up;
}
export const vsUp = () => up;
export function initVoiceStudio() {
  vsHealth(true);
  setInterval(() => vsHealth(true), 60_000).unref();
}

async function api<T = any>(p: string, init: RequestInit = {}, timeout = 30_000): Promise<T> {
  const r = await fetch(`${base()}${p}`, { ...init, signal: AbortSignal.timeout(timeout) }).catch(() => null);
  if (!r) throw new Error('VoiceStudio açık değil (masaüstündeki VoiceStudio uygulamasını açın ya da "VoiceStudio\'yu kur" deyin).');
  const ct = r.headers.get('content-type') ?? '';
  if (!r.ok) {
    const j: any = ct.includes('json') ? await r.json().catch(() => ({})) : {};
    const d = j?.detail ?? j?.error?.message ?? j?.error;
    throw new Error(`VoiceStudio ${r.status}: ${typeof d === 'string' ? d : JSON.stringify(d ?? '').slice(0, 200)}`);
  }
  return (ct.includes('json') ? r.json() : Buffer.from(await r.arrayBuffer())) as Promise<T>;
}

export async function vsProfiles(): Promise<{ id: string; name: string; kind?: string }[]> {
  if (!(await vsHealth())) return [];
  const list = await api<any[]>('/profiles').catch(() => []);
  return (Array.isArray(list) ? list : []).map(p => ({ id: String(p.id), name: String(p.name ?? p.id), kind: p.kind }));
}

// ---------------------------------------------------------------- Seslendirme

/** Metni seçili VoiceStudio profiliyle seslendirir (mp3). Motor VOICESTUDIO_ENGINE ile seçilebilir (boşsa etkin motor). */
export async function vsSpeak(text: string, voice: string, speed = 1): Promise<Buffer> {
  return api<Buffer>('/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(process.env.VOICESTUDIO_ENGINE ? { model: process.env.VOICESTUDIO_ENGINE } : {}),
      voice, input: text, response_format: 'mp3', speed: Math.min(1.3, Math.max(0.8, speed)), language: 'tr', denoise: true,
    }),
  }, 90_000);
}

// ---------------------------------------------------------------- Klonlama

function findFfmpeg(): string | null {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const w = spawnSync(WIN ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
  if (w.status === 0) return w.stdout.split(/\r?\n/)[0].trim();
  const g = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
  return WIN && fs.existsSync(g) ? g : null;
}

/**
 * Referans sesi temizler: tek kanal 24 kHz, uğultu (80 Hz altı) ve tıslama kesilir, FFT gürültü azaltma, baştaki ve
 * sondaki sessizlik atılır, seviye −16 LUFS, en fazla 25 sn. ffmpeg yoksa ses olduğu gibi gönderilir.
 */
export async function cleanReference(input: Buffer, ext: string): Promise<{ buf: Buffer; ext: string; temizlendi: boolean }> {
  const ff = findFfmpeg();
  if (!ff) return { buf: input, ext, temizlendi: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ses-'));
  const src = path.join(dir, `girdi${ext || '.bin'}`), out = path.join(dir, 'temiz.wav');
  fs.writeFileSync(src, input);
  const af = [
    'highpass=f=80', 'lowpass=f=11000', 'afftdn=nf=-25',
    // Baştaki sessizliği at; sondakini atmak için ters çevirip tekrar
    'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.2',
    'areverse', 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.3', 'areverse',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  ].join(',');
  try {
    await new Promise<void>((res, rej) => execFile(ff, ['-hide_banner', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '24000', '-af', af, '-t', '25', out],
      { timeout: 120_000, windowsHide: true }, err => (err ? rej(err) : res())));
    const buf = fs.readFileSync(out);
    return buf.length > 8000 ? { buf, ext: '.wav', temizlendi: true } : { buf: input, ext, temizlendi: false };
  } catch {
    return { buf: input, ext, temizlendi: false };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Ses dosyasından klon profil oluşturur */
export async function vsClone(input: Buffer, filename: string, name: string): Promise<{ id: string; name: string; temizlendi: boolean }> {
  if (!(await vsHealth(true))) throw new Error('VoiceStudio açık değil. Masaüstündeki VoiceStudio\'yu açın (kurulu değilse Jarvis\'e "VoiceStudio\'yu kur" deyin), sonra ses dosyasını tekrar gönderin.');
  const ext = (path.extname(filename) || '.webm').toLowerCase();
  const clean = await cleanReference(input, ext);
  const form = new FormData();
  form.append('name', name);
  form.append('kind', 'clone');
  form.append('language', 'tr');
  form.append('ref_audio', new Blob([new Uint8Array(clean.buf)]), `referans${clean.ext}`);
  const p = await api<any>('/profiles', { method: 'POST', body: form }, 120_000);
  return { id: String(p.id), name: String(p.name ?? name), temizlendi: clean.temizlendi };
}

// ---------------------------------------------------------------- Kurulum ve modeller

const RELEASES = 'https://api.github.com/repos/debpalash/VoiceStudio/releases/latest';

/** En son resmi sürümü indirir, SHA256SUMS ile doğrular ve kurulum sihirbazını açar */
async function installApp(): Promise<string> {
  if (!WIN) throw new Error('Otomatik kurulum yalnızca Windows için; diğer sistemlerde https://github.com/debpalash/VoiceStudio/releases adresinden kurun.');
  const rel: any = await (await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'jarvis' }, signal: AbortSignal.timeout(20_000) })).json();
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const assets: any[] = rel.assets ?? [];
  const exe = assets.find(a => new RegExp(`^VoiceStudio-Electron-.*-win-${arch}\\.exe$`).test(a.name)) ?? assets.find(a => /^VoiceStudio-Electron-.*-win-x64\.exe$/.test(a.name));
  if (!exe) throw new Error(`Sürüm ${rel.tag_name ?? ''} içinde Windows kurulum dosyası bulunamadı.`);
  const sums = assets.find(a => /^SHA256SUMS\.txt$/i.test(a.name));
  const dir = path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, exe.name);
  const r = await fetch(exe.browser_download_url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!r.ok) throw new Error(`İndirilemedi (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  const hash = createHash('sha256').update(buf).digest('hex');
  if (sums) {
    const txt = await (await fetch(sums.browser_download_url, { signal: AbortSignal.timeout(20_000) })).text();
    const want = txt.split(/\r?\n/).map(l => l.trim().split(/\s+\*?/)).find(([, n]) => n === exe.name)?.[0]?.toLowerCase();
    if (want && want !== hash) throw new Error('İndirilen dosyanın SHA256 imzası tutmuyor; kurulum iptal edildi.');
  }
  fs.writeFileSync(file, buf);
  spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  return `VoiceStudio ${rel.tag_name ?? ''} indirildi (${Math.round(buf.length / 1e6)} MB, SHA256 ${sums ? 'doğrulandı' : 'listesi yok'}) ve kurulum sihirbazı açıldı: ${file}. Sihirbazı tamamlayın; ilk açılışta Python ve araçları kendisi kurar (~5-10 GB). İstatistik paylaşımı sorusuna kendiniz karar verin.`;
}

const gb = (b?: number) => (b ? `${(b / 1024 ** 3).toFixed(1)} GB` : '?');

export const VOICESTUDIO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'voicestudio',
      description: "VoiceStudio (yerel ses klonlama uygulaması) ile çalışır. islem: durum (açık mı, ses profilleri), kur (Windows kurulum dosyasını indirip doğrular ve kurulumu açar; onay kartı), modeller (yüklü/yüklenebilir ses modelleri, boyut ve lisans), model_kur (repo_id ile; boyutu ve lisansı göstererek onay kartı), klonla (kullanıcı klasöründeki bir ses dosyasından klon ses; dosya ve ad), sesi_kullan (profil kimliğini Jarvis'in sesi yap). Kullanıcı Jarvis ekranından ses dosyası gönderirse klonlama kendiliğinden yapılır.",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['durum', 'kur', 'modeller', 'model_kur', 'klonla', 'sesi_kullan'] },
          repo_id: { type: 'string' }, dosya: { type: 'string' }, ad: { type: 'string' }, profil: { type: 'string' },
        },
        required: ['islem'],
      },
    },
  },
] as const;

export const isVoiceStudioTool = (n: string) => n === 'voicestudio';

/** Jarvis'in seçili sesini değiştiren işlev (index.ts kaydeder) */
let setVoice: (profileId: string) => void = () => {};
export const registerVoiceSetter = (fn: (profileId: string) => void) => { setVoice = fn; };

export async function runVoiceStudioTool(args: any): Promise<string> {
  const readHome = safePath;
  try {
    const islem = String(args.islem ?? 'durum');
    if (islem === 'kur') {
      if (await vsHealth(true)) return JSON.stringify({ sonuc: 'VoiceStudio zaten kurulu ve açık.' });
      return propose('uygulama', 'VoiceStudio kur (ses klonlama)', 'Kaynak: https://github.com/debpalash/VoiceStudio/releases/latest\nDosya: VoiceStudio-Electron-<sürüm>-win-x64.exe → İndirilenler', 'Resmi sürüm indirilir, SHA256SUMS ile doğrulanır ve kurulum sihirbazı açılır (yönetici izni gerekmez). Uygulama ilk açılışta Python ve araçlarını kendisi kurar; ~5-10 GB yer gerekir. MIT lisanslı açık kaynak.', installApp);
    }
    if (islem === 'durum') {
      const ok = await vsHealth(true);
      return JSON.stringify(ok ? { acik: true, adres: base(), profiller: await vsProfiles() } : { acik: false, not: 'VoiceStudio kapalı ya da kurulu değil. Kuruluysa uygulamayı açmasını, değilse "kur" işlemini öner.' });
    }
    if (islem === 'modeller') {
      const j = await api<any>('/models');
      const list = (j.models ?? []).filter((m: any) => m.supported !== false).slice(0, 40).map((m: any) => ({
        repo_id: m.repo_id, ad: m.name ?? m.label ?? m.repo_id, tur: m.type ?? m.kind, yuklu: m.installed, onerilen: m.curated || undefined,
        boyut: m.size_gb ? `${m.size_gb} GB` : m.size ?? (m.installed ? gb(m.size_on_disk_bytes) : undefined), lisans: m.license_info?.name ?? m.license_info?.id ?? m.license ?? undefined,
      }));
      return JSON.stringify({ bos_disk_gb: j.disk_free_gb, modeller: list });
    }
    if (islem === 'model_kur') {
      const id = String(args.repo_id ?? '').trim();
      const j = await api<any>('/models');
      const m = (j.models ?? []).find((x: any) => x.repo_id === id);
      if (!m) return JSON.stringify({ hata: 'Bu model VoiceStudio kataloğunda yok; önce modeller ile listele.' });
      if (m.installed) return JSON.stringify({ sonuc: `${id} zaten yüklü.` });
      const boyut = m.size_gb ? `${m.size_gb} GB` : m.size ?? 'bilinmiyor';
      const lisans = m.license_info?.name ?? m.license_info?.id ?? m.license ?? 'bilinmiyor';
      return propose('uygulama', `VoiceStudio modeli indir: ${m.name ?? id}`, `Model: ${id}\nBoyut: ${boyut}\nLisans: ${lisans}\nBoş disk: ${j.disk_free_gb ?? '?'} GB`, 'Model Hugging Face\'ten bu bilgisayara indirilir (internet ve disk kullanır). Lisansını onaylıyorsanız çalıştırın.',
        async () => { await api('/models/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo_id: id }) }); return `${id} indirilmeye başladı; VoiceStudio'da ilerlemesi görünür.`; });
    }
    if (islem === 'klonla') {
      const file = readHome(String(args.dosya ?? ''));
      const p = await vsClone(fs.readFileSync(file), file, String(args.ad ?? '').trim() || `Jarvis sesi ${new Date().toLocaleDateString('tr-TR')}`);
      setVoice(p.id);
      return JSON.stringify({ ok: true, profil: p, not: `Jarvis artık bu sesle konuşuyor${p.temizlendi ? ' (referans ses temizlendi)' : ''}.` });
    }
    if (islem === 'sesi_kullan') {
      const id = String(args.profil ?? '').trim();
      const list = await vsProfiles();
      const p = list.find(x => x.id === id) ?? list.find(x => x.name.toLocaleLowerCase('tr') === id.toLocaleLowerCase('tr'));
      if (!p) return JSON.stringify({ hata: 'Profil bulunamadı', profiller: list });
      setVoice(p.id);
      return JSON.stringify({ ok: true, ses: p.name });
    }
    return JSON.stringify({ hata: 'bilinmeyen işlem' });
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 300) });
  }
}
