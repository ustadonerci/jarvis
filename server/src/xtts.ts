// İnternetsiz çok sesli Türkçe seslendirme: Coqui XTTS-v2 (coqui-tts paketi, Python). Kurulum onay kartıyla: Jarvis
// kendi sanal ortamını (data/xtts/venv) kurar, coqui-tts'i yükler; model ilk açılışta indirilir (~1,8 GB, Coqui Public
// Model License — ticari olmayan kullanım; kartta yazar, kullanıcı onaylayınca kabul edilmiş sayılır).
// Sesler: XTTS'in hazır stüdyo sesleri (gerçek kişi taklidi değil) ve kullanıcının KENDİ sesi (kısa bir kayıttan).
// Başkasının sesi eklenmez: kendi ses eklerken kullanıcı bunun kendi sesi olduğunu onaylar.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Router } from 'express';
import { propose } from './approvals.js';
import { adminOnly } from './keys.js';
import { cleanReference } from './voicestudio.js';
import { recordVersion } from './versions.js';

export const XTTS_MODEL = 'xtts';
export const isXtts = (m: string) => m === XTTS_MODEL;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'data', 'xtts');
const VENV = path.join(DIR, 'venv');
const VOICES = path.join(DIR, 'sesler');
const SCRIPT = path.join(HERE, '..', 'xtts', 'xtts_server.py');
const WIN = process.platform === 'win32';
const VPY = path.join(VENV, WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python');
const PORT = Number(process.env.XTTS_PORT || 3911);
const BASE = `http://127.0.0.1:${PORT}`;
const MARK = path.join(DIR, 'kuruldu');

export const xttsInstalled = () => fs.existsSync(MARK) && fs.existsSync(VPY);
let up = false;
export const xttsUp = () => up;
let proc: ChildProcess | null = null;
let starting: Promise<boolean> | null = null;
let lastLog = '';

function systemPython(): string[] | null {
  for (const c of WIN ? [['py', '-3.11'], ['py', '-3.12'], ['py', '-3.10'], ['py', '-3'], ['python']] : [['python3'], ['python']]) {
    const r = spawnSync(c[0], [...c.slice(1), '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (r.status === 0 && /Python 3\.(1[0-3])\b/.test(`${r.stdout}${r.stderr}`)) return c;
  }
  return null;
}
const run = (cmd: string, args: string[], ms: number) => new Promise<string>((res, rej) => {
  const p = spawn(cmd, args, { windowsHide: true });
  let out = '';
  const t = setTimeout(() => { p.kill(); rej(new Error(`zaman aşımı: ${args.slice(0, 3).join(' ')}`)); }, ms);
  p.stdout.on('data', d => { out = (out + d).slice(-2000); });
  p.stderr.on('data', d => { out = (out + d).slice(-2000); });
  p.on('error', e => { clearTimeout(t); rej(e); });
  p.on('close', code => { clearTimeout(t); code === 0 ? res(out) : rej(new Error(out.split('\n').filter(Boolean).slice(-3).join(' · ') || `çıkış ${code}`)); });
});

async function health(): Promise<boolean> {
  try { up = (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { up = false; }
  return up;
}

/** Sunucuyu başlatır; ilk açılışta model indirildiği için uzun sürebilir (en çok 20 dk) */
export function startXtts(): Promise<boolean> {
  if (!xttsInstalled()) return Promise.resolve(false);
  starting ??= (async () => {
    if (await health()) return true;
    if (!proc) {
      fs.mkdirSync(VOICES, { recursive: true });
      proc = spawn(VPY, [SCRIPT, '--port', String(PORT), '--voices', VOICES], { windowsHide: true, env: { ...process.env, COQUI_TOS_AGREED: '1', PYTHONIOENCODING: 'utf-8' } });
      proc.stdout?.on('data', d => { lastLog = String(d).trim().slice(-300); });
      proc.stderr?.on('data', d => { lastLog = String(d).trim().slice(-300); });
      proc.on('exit', () => { proc = null; up = false; });
    }
    for (let i = 0; i < 240; i++) { // 20 dk
      if (await health()) { console.log('[xtts] hazır'); return true; }
      if (!proc) break;
      await new Promise(r => setTimeout(r, 5000));
    }
    return false;
  })().finally(() => { starting = null; });
  return starting;
}

async function install(): Promise<string> {
  const py = systemPython();
  if (!py) throw new Error('Python 3.10–3.13 bulunamadı. Jarvis\'e "Python kur" deyin (ya da python.org\'dan 3.11 kurun), sonra tekrar deneyin.');
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(VPY)) await run(py[0], [...py.slice(1), '-m', 'venv', VENV], 5 * 60_000);
  await run(VPY, ['-m', 'pip', 'install', '--upgrade', 'pip'], 10 * 60_000);
  await run(VPY, ['-m', 'pip', 'install', 'coqui-tts'], 60 * 60_000);
  fs.writeFileSync(MARK, new Date().toISOString());
  const ver = (await run(VPY, ['-m', 'pip', 'show', 'coqui-tts'], 60_000).catch(() => '')).match(/Version:\s*(\S+)/)?.[1] ?? '?';
  recordVersion('coqui-tts (XTTS)', { tur: 'arac', surum: ver, kaynak: 'https://pypi.org/project/coqui-tts/', lisans: 'MPL-2.0 (model: Coqui Public Model License)' });
  const ok = await startXtts();
  if (!ok) throw new Error(`XTTS kuruldu ama açılamadı: ${lastLog}`);
  return 'XTTS kuruldu ve açıldı. Ayarlar → Ses listesinde "XTTS" sesleri görünür; kendi sesinizi Ayarlar → XTTS bölümünden ekleyebilirsiniz.';
}

export const kurOneri = () => propose('uygulama', 'XTTS kur (internetsiz çok sesli Türkçe ses)',
  `Python sanal ortamı: ${VENV}\nPaket: coqui-tts (PyPI)\nModel: XTTS-v2 (~1,8 GB, ilk açılışta indirilir)\nToplam yer: ~3-4 GB`,
  'Onaylarsanız XTTS bilgisayara kurulur ve Coqui Public Model License (yalnız ticari olmayan kullanım) kabul edilmiş olur. İnternetsiz çalışır; ekran kartı yoksa her cümle birkaç saniye sürer. Kurulum 10-30 dk sürebilir.',
  install);

export async function xttsVoices(): Promise<{ hazir: string[]; kendi: string[] }> {
  if (!up) return { hazir: [], kendi: [] };
  try { return await (await fetch(`${BASE}/speakers`, { signal: AbortSignal.timeout(5000) })).json(); } catch { return { hazir: [], kendi: [] }; }
}

export async function xttsSpeak(text: string, voice: string, speed = 1): Promise<Buffer> {
  if (!up && !(await startXtts())) throw new Error('XTTS açık değil');
  const r = await fetch(`${BASE}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice, speed }), signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`XTTS ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Kullanıcının KENDİ sesi: kayıt temizlenir (ffmpeg varsa), wav olarak saklanır; ses adı "kendi:<ad>" */
export async function addOwnVoice(buf: Buffer, filename: string, name: string): Promise<string> {
  const ad = name.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40) || 'Benim sesim';
  const c = await cleanReference(buf, (path.extname(filename) || '.webm').toLowerCase());
  if (c.ext !== '.wav') throw new Error('Ses kaydı WAV\'a çevrilemedi: ffmpeg gerekli (Jarvis\'e "ffmpeg kur" deyin) ya da WAV dosyası gönderin.');
  fs.mkdirSync(VOICES, { recursive: true });
  fs.writeFileSync(path.join(VOICES, `${ad}.wav`), c.buf);
  return `kendi:${ad}`;
}

export function initXtts() {
  if (xttsInstalled()) startXtts().then(ok => console.log(ok ? '[xtts] açıldı' : `[xtts] açılamadı: ${lastLog}`)).catch(() => {});
}

// ---------------------------------------------------------------- HTTP

export function xttsRouter(onOwnVoice: (voice: string) => void): Router {
  const r = express.Router();
  r.use('/api/xtts', adminOnly);
  r.get('/api/xtts', async (_req, res) => res.json({ kurulu: xttsInstalled(), acik: up, sesler: await xttsVoices(), son: lastLog }));
  r.post('/api/xtts/kur', (_req, res) => res.json(xttsInstalled() ? { kurulu: true } : JSON.parse(kurOneri())));
  r.post('/api/xtts/kendi-ses', express.raw({ type: ['audio/*', 'video/*', 'application/octet-stream'], limit: '60mb' }), async (req, res) => {
    // Yalnız kendi sesi: istemci "bu benim sesim" onayını gönderir
    if (req.query.benim !== '1') return res.status(400).json({ error: 'Yalnızca kendi sesinizi ekleyebilirsiniz; "Bu benim sesim" onayı gerekli.' });
    try {
      if (!up && !(await startXtts())) throw new Error('XTTS açık değil (önce kurun)');
      const voice = await addOwnVoice(req.body as Buffer, String(req.query.dosya ?? 'kayit.webm'), String(req.query.ad ?? 'Benim sesim'));
      onOwnVoice(voice);
      res.json({ ok: true, voice });
    } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
  });
  return r;
}

// ---------------------------------------------------------------- Model aracı

export const XTTS_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'xtts',
      description: "XTTS: internetsiz, çok sesli Türkçe seslendirme (hazır yapay sesler + kullanıcının kendi sesi). durum: kurulu/açık mı, hangi sesler var; kur: bilgisayara kurar (onay kartı, ~3-4 GB, Python gerekir). Ses seçimi Ayarlar → Ses listesinden; kendi ses kaydı Ayarlar → XTTS bölümünden eklenir.",
      parameters: { type: 'object', properties: { islem: { type: 'string', enum: ['durum', 'kur'] } }, required: ['islem'] },
    },
  },
] as const;
export const isXttsTool = (n: string) => n === 'xtts';
export async function runXttsTool(a: any): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  try {
    if (a.islem === 'kur') return xttsInstalled() ? j({ kurulu: true, acik: up }) : kurOneri();
    return j({ kurulu: xttsInstalled(), acik: up, sesler: await xttsVoices(), son_kayit: lastLog || undefined });
  } catch (e: any) { return j({ hata: String(e?.message || e).slice(0, 200) }); }
}
