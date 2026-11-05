// İnternetsiz Türkçe ses (Piper, rhasspy/piper 2023.11.14-2, MIT): bilgisayarda çalışır, anahtar/kredi/internet
// gerektirmez. Ses modeli tr_TR-dfki-medium (Hugging Face rhasspy/piper-voices). İndirilen dosyalar SHA256 ile doğrulanır;
// kurulum onay kartıyla yapılır. Asıl ses sağlayıcıları (Abacus.AI, OpenAI, Gemini) çalışmazsa Jarvis bu sesle konuşur;
// "önce internetsiz ses" açılırsa her zaman bu ses kullanılır.
// Ayrıca Jarvis'in ses dosyaları (örnek kayıtlar ve söylediği cümleler) İndirilenler\Jarvis-Sesler'e kopyalanabilir.
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Router } from 'express';
import { propose } from './approvals.js';
import { adminOnly } from './keys.js';
import { recordVersion } from './versions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const DIR = path.join(DATA, 'piper');
const WIN = process.platform === 'win32';
const EXE = path.join(DIR, 'piper', WIN ? 'piper.exe' : 'piper');
const MODEL = path.join(DIR, 'tr_TR-dfki-medium.onnx');
const CFG = path.join(DATA, 'piper-ayar.json');

const ARCHIVE = WIN
  ? { url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip', sha: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea' }
  : { url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz', sha: '' };
const VOICE = {
  url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx',
  sha: '2844717f524ab965d3fe86e60562cbb601d3e456836efcc2196cc3a14112a8fb',
  json: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx.json',
};

let cfg: { oncelik: boolean } = (() => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return { oncelik: false }; } })();
const saveCfg = () => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(cfg)); };

export const piperReady = () => fs.existsSync(EXE) && fs.existsSync(MODEL) && fs.existsSync(`${MODEL}.json`);
/** Kullanıcı "önce internetsiz ses" dediyse */
export const piperFirst = () => cfg.oncelik && piperReady();
export const setPiperFirst = (on: boolean) => { cfg.oncelik = on; saveCfg(); };
/** "Sesi ilk ayara döndür": index.ts kaydeder (seçili sesi .env varsayılanına alır) */
let voiceReset: () => string = () => 'kullanılamıyor';
export const onVoiceReset = (fn: () => string) => { voiceReset = fn; };
let voicePick: (ses?: string, hiz?: number) => string = () => 'kullanılamıyor';
export const onVoicePick = (fn: (ses?: string, hiz?: number) => string) => { voicePick = fn; };

async function download(url: string, sha: string): Promise<Buffer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!r.ok) throw new Error(`indirilemedi (${r.status}): ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha && createHash('sha256').update(buf).digest('hex') !== sha) throw new Error('indirilen dosyanın SHA256 imzası tutmuyor; kurulum iptal edildi');
  return buf;
}
const run = (cmd: string, args: string[]) => new Promise<void>((res, rej) => execFile(cmd, args, { timeout: 5 * 60_000, windowsHide: true }, e => (e ? rej(e) : res())));

async function install(): Promise<string> {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(EXE)) {
    const arc = await download(ARCHIVE.url, ARCHIVE.sha);
    const f = path.join(DIR, WIN ? 'piper.zip' : 'piper.tgz');
    fs.writeFileSync(f, arc);
    if (WIN) await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${f.replace(/'/g, "''")}' -DestinationPath '${DIR.replace(/'/g, "''")}' -Force`]);
    else await run('tar', ['xzf', f, '-C', DIR]);
    fs.rmSync(f, { force: true });
  }
  if (!fs.existsSync(MODEL)) fs.writeFileSync(MODEL, await download(VOICE.url, VOICE.sha));
  if (!fs.existsSync(`${MODEL}.json`)) fs.writeFileSync(`${MODEL}.json`, await download(VOICE.json, ''));
  // Deneme: kısa bir cümle
  await piperSpeak('Merhaba efendim, internetsiz sesim hazır.');
  recordVersion('Piper', { tur: 'arac', surum: '2023.11.14-2', kaynak: 'https://github.com/rhasspy/piper', lisans: 'MIT' });
  return 'İnternetsiz Türkçe ses kuruldu ve denendi (Piper, tr_TR-dfki). Asıl ses sağlayıcıları çalışmazsa Jarvis bu sesle konuşur.';
}

/** Metni internetsiz sese çevirir (WAV) */
export function piperSpeak(text: string, speed = 1.08): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!piperReady()) return reject(new Error('internetsiz ses kurulu değil'));
    const out = path.join(os.tmpdir(), `jarvis-piper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    const p = spawn(EXE, ['--model', MODEL, '--output_file', out, '--length_scale', (1 / Math.min(1.3, Math.max(0.8, speed))).toFixed(2)], { cwd: path.dirname(EXE), windowsHide: true });
    const t = setTimeout(() => { p.kill(); reject(new Error('internetsiz ses 30 sn içinde bitmedi')); }, 30_000);
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-300); });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      try {
        if (code !== 0 || !fs.existsSync(out)) return reject(new Error(`piper hata (${code}): ${err.split('\n').filter(Boolean).pop() ?? ''}`));
        const buf = fs.readFileSync(out);
        resolve(buf);
      } finally { fs.rmSync(out, { force: true }); }
    });
    p.stdin.end(text.replace(/\s+/g, ' ').trim() + '\n', 'utf8');
  });
}

/** Jarvis'in ses dosyalarını İndirilenler\Jarvis-Sesler'e kopyalar: örnek kayıtlar + söylediği cümlelerin önbelleği */
export function exportVoices(): { klasor: string; ornek: number; konusma: number } {
  const dest = path.join(os.homedir(), 'Downloads', 'Jarvis-Sesler');
  fs.mkdirSync(path.join(dest, 'ornek-kayitlar'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'soyledikleri'), { recursive: true });
  let ornek = 0, konusma = 0;
  const samples = path.join(HERE, '..', '..', 'ses-ornekleri');
  if (fs.existsSync(samples)) for (const f of fs.readdirSync(samples).filter(f => /\.(wav|mp3)$/i.test(f))) { fs.copyFileSync(path.join(samples, f), path.join(dest, 'ornek-kayitlar', f)); ornek++; }
  const cache = path.join(DATA, 'tts');
  if (fs.existsSync(cache)) {
    const files = fs.readdirSync(cache).filter(f => /\.(wav|mp3)$/i.test(f)).map(f => ({ f, t: fs.statSync(path.join(cache, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    files.forEach(({ f, t }, i) => {
      const d = new Date(t);
      const name = `${String(i + 1).padStart(3, '0')}_${d.toISOString().slice(0, 10)}${path.extname(f)}`;
      fs.copyFileSync(path.join(cache, f), path.join(dest, 'soyledikleri', name));
      konusma++;
    });
  }
  return { klasor: dest, ornek, konusma };
}

// ---------------------------------------------------------------- HTTP ve model aracı

const kurOneri = () => propose('uygulama', 'İnternetsiz Türkçe ses kur (Piper)',
  `Program: ${ARCHIVE.url}\nSes modeli: ${VOICE.url} (≈63 MB)\nKurulacağı yer: ${DIR}`,
  'Resmî sürümler indirilir, SHA256 ile doğrulanır ve Jarvis klasörüne açılır (≈90 MB). Anahtar, kredi ya da internet gerektirmeden Türkçe konuşur. MIT lisanslı açık kaynak.',
  install);

export function piperRouter(): Router {
  const r = express.Router();
  r.use('/api/internetsiz-ses', adminOnly);
  r.get('/api/internetsiz-ses', (_req, res) => res.json({ kurulu: piperReady(), oncelik: cfg.oncelik }));
  r.post('/api/internetsiz-ses/kur', (_req, res) => res.json(piperReady() ? { kurulu: true } : JSON.parse(kurOneri())));
  r.post('/api/internetsiz-ses/oncelik', (req, res) => { cfg.oncelik = req.body?.ac === true; saveCfg(); res.json({ kurulu: piperReady(), oncelik: cfg.oncelik }); });
  r.post('/api/internetsiz-ses/kaydet', (_req, res) => { try { res.json(exportVoices()); } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); } });
  return r;
}

export const PIPER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'internetsiz_ses',
      description: "Jarvis'in sesi. ses_sec: Jarvis'in kendi 3 sesinden birine geçer (ses: onyx | echo | fable; 'sesini echo yap', 'fable sesine geç') ve/veya okuma hızını değiştirir (hiz; 'daha hızlı/yavaş oku'). İnternetsiz Türkçe ses (Piper) ve Jarvis'in ses dosyaları. durum; kur (bilgisayara indirip kurar, onay kartı; 'sesleri bilgisayara indir', 'internetsiz ses kur'); oncelik (ac: true → Jarvis her zaman internetsiz sesle konuşur, false → yalnız diğerleri çalışmazsa); kaydet (Jarvis'in örnek kayıtlarını ve söylediği cümlelerin ses dosyalarını İndirilenler\\Jarvis-Sesler'e kopyalar); ilk_ayar ('ses ayarlarını ilk haline getir', 'eski sesine dön'): seçili ses ilk kurulumdaki varsayılana döner, internetsiz-önce kapanır; kurulu sesler (Piper, XTTS, kendi ses kaydı) silinmez.",
      parameters: { type: 'object', properties: { islem: { type: 'string', enum: ['durum', 'kur', 'oncelik', 'kaydet', 'ilk_ayar', 'ses_sec'] }, ac: { type: 'boolean' }, ses: { type: 'string', enum: ['onyx', 'echo', 'fable'] }, hiz: { type: 'number', description: 'okuma hızı 0.9–1.3 (ör. "daha hızlı oku" → mevcut + 0.1)' } }, required: ['islem'] },
    },
  },
] as const;
export const isPiperTool = (n: string) => n === 'internetsiz_ses';
export async function runPiperTool(a: any): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  try {
    if (a.islem === 'kur') return piperReady() ? j({ kurulu: true, not: 'Zaten kurulu.' }) : kurOneri();
    if (a.islem === 'oncelik') { cfg.oncelik = a.ac === true; saveCfg(); return j({ ok: true, oncelik: cfg.oncelik, kurulu: piperReady() }); }
    if (a.islem === 'ses_sec') return j({ ok: true, ses: voicePick(a.ses, typeof a.hiz === 'number' ? a.hiz : undefined) });
    if (a.islem === 'ilk_ayar') return j({ ok: true, ses: voiceReset(), not: 'Kurulu sesler silinmedi; Ayarlar → Ses listesinden yine seçilebilir.' });
    if (a.islem === 'kaydet') return j({ ok: true, ...exportVoices(), not: 'Klasörün yerini ve kaç dosya kopyalandığını söyle.' });
    return j({ kurulu: piperReady(), oncelik: cfg.oncelik });
  } catch (e: any) {
    return j({ hata: String(e?.message || e).slice(0, 200) });
  }
}
