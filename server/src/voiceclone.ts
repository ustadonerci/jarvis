// Jarvis'in kayıtlı seslerinin klonları: ses-ornekleri klasöründeki örnek kayıtlardan (echo, fable, onyx…) yerel
// VoiceStudio'da (ücretsiz, bilgisayarda) ve/veya ElevenLabs'te (anahtar ve klonlamaya izin veren plan gerekir) klon ses
// oluşturulur. Asıl ses sağlayıcısı (Abacus.AI / OpenAI / Gemini) çalışmazsa aynı ses bu klondan üretilir; böylece Jarvis
// hangi yapay zekâ modeli çalışırsa çalışsın aynı sesle konuşur. Klonlanan sesler Jarvis'in kendi yapay zekâ sesleridir.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELEVEN_KEY } from './eleven.js';
import { vsClone, vsHealth } from './voicestudio.js';
import express, { type Router } from 'express';
import { adminOnly } from './keys.js';
import type { VoiceSel } from './tts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, '..', '..', 'ses-ornekleri');
const FILE = path.join(HERE, '..', 'data', 'ses-klonlari.json');

export interface Clones { [voice: string]: { voicestudio?: string; elevenlabs?: string; at: string } }
let clones: Clones = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } })();
const save = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(clones, null, 1)); };
export const cloneFor = (voice: string) => clones[voice.toLowerCase()];

/** ses-ornekleri: <tür>__<model>__<ses>.wav → ses adına göre dosyalar (uzun "ornek" kaydı önce) */
export function sampleVoices(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!fs.existsSync(SAMPLES)) return out;
  for (const f of fs.readdirSync(SAMPLES).filter(f => /\.(wav|mp3)$/i.test(f))) {
    const v = f.replace(/\.(wav|mp3)$/i, '').split('__').pop()!.toLowerCase();
    (out[v] ??= []).push(path.join(SAMPLES, f));
  }
  for (const v of Object.keys(out)) out[v].sort((a, b) => Number(/ornek/.test(path.basename(b))) - Number(/ornek/.test(path.basename(a))));
  return out;
}

async function elevenClone(name: string, files: string[]): Promise<string> {
  const form = new FormData();
  form.append('name', name);
  form.append('description', 'Jarvis sesi (Jarvis örnek kayıtlarından klon)');
  form.append('remove_background_noise', 'false');
  for (const f of files) form.append('files', new Blob([new Uint8Array(fs.readFileSync(f))], { type: 'audio/wav' }), path.basename(f));
  const r = await fetch('https://api.elevenlabs.io/v1/voices/add', { method: 'POST', headers: { 'xi-api-key': ELEVEN_KEY }, body: form, signal: AbortSignal.timeout(120_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.voice_id) {
    const msg = String(j?.detail?.message ?? j?.detail ?? '').slice(0, 160);
    throw new Error(r.status === 401 || /can_not_use_instant_voice_cloning|subscription|plan/i.test(msg) ? `ElevenLabs klonlamaya izin vermedi (planınız ses klonlamayı içermiyor olabilir): ${msg}` : `ElevenLabs ${r.status}: ${msg}`);
  }
  return String(j.voice_id);
}

/** Bütün örnek sesleri kullanılabilir motorlarda klonlar; zaten klonlananlar atlanır (yeniden: tekrar true) */
export async function cloneAll(tekrar = false, progress: (l: string) => void = () => {}) {
  const voices = sampleVoices();
  const vsOk = await vsHealth(true).catch(() => false);
  const sonuc: { ses: string; voicestudio?: string; elevenlabs?: string }[] = [];
  for (const [v, files] of Object.entries(voices)) {
    const c = (clones[v] ??= { at: new Date().toISOString() });
    const row: (typeof sonuc)[number] = { ses: v };
    if (vsOk) {
      if (c.voicestudio && !tekrar) row.voicestudio = 'zaten var';
      else {
        progress(`${v}: VoiceStudio'da klonlanıyor`);
        try { c.voicestudio = (await vsClone(fs.readFileSync(files[0]), path.basename(files[0]), `Jarvis ${v}`)).id; row.voicestudio = 'klonlandı'; }
        catch (e: any) { row.voicestudio = `olmadı: ${String(e?.message || e).slice(0, 100)}`; }
      }
    } else row.voicestudio = 'VoiceStudio kapalı/kurulu değil';
    if (ELEVEN_KEY) {
      if (c.elevenlabs && !tekrar) row.elevenlabs = 'zaten var';
      else {
        progress(`${v}: ElevenLabs'te klonlanıyor`);
        try { c.elevenlabs = await elevenClone(`Jarvis ${v}`, files.slice(0, 3)); row.elevenlabs = 'klonlandı'; }
        catch (e: any) { row.elevenlabs = `olmadı: ${String(e?.message || e).slice(0, 120)}`; }
      }
    } else row.elevenlabs = 'ElevenLabs anahtarı yok';
    c.at = new Date().toISOString();
    sonuc.push(row);
  }
  save();
  return { sesler: Object.keys(voices), sonuc };
}

// ---------------------------------------------------------------- Model aracı ve HTTP


let currentVoice: () => VoiceSel = () => ({ model: '', voice: 'onyx', speed: 1.08 });
export const registerCurrentVoice = (fn: () => VoiceSel) => { currentVoice = fn; };

async function runTest() {
  const { testVoices } = await import('./tts.js');
  const sel = currentVoice();
  return { secili_ses: `${sel.model} · ${sel.voice}`, sonuc: await testVoices(sel) };
}

export function voiceCloneRouter(): Router {
  const r = express.Router();
  r.use('/api/ses-bakim', adminOnly);
  r.post('/api/ses-bakim/test', async (_req, res) => { try { res.json(await runTest()); } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); } });
  r.post('/api/ses-bakim/klonla', async (req, res) => { try { res.json(await cloneAll(req.body?.tekrar === true)); } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); } });
  return r;
}

export const VOICECLONE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ses_bakim',
      description: "Jarvis'in sesinin bakımı. test: seçili sesi bütün ses motorlarıyla (Abacus.AI, OpenAI, Gemini, VoiceStudio/ElevenLabs klonları) ayrı ayrı dener, hangisinin çalıştığını söyler ('ses yok', 'sesi test et'). klonla: Jarvis'in kayıtlı seslerini (ses-ornekleri: onyx, echo, fable…) VoiceStudio'da ve ElevenLabs'te klonlar; asıl sağlayıcı çalışmazsa aynı ses klondan üretilir ('sesleri klonla').",
      parameters: { type: 'object', properties: { islem: { type: 'string', enum: ['test', 'klonla'] }, tekrar: { type: 'boolean' } }, required: ['islem'] },
    },
  },
] as const;
export const isVoiceCloneTool = (n: string) => n === 'ses_bakim';
export async function runVoiceCloneTool(a: any, progress: (l: string) => void): Promise<string> {
  try {
    if (a.islem === 'klonla') { progress('sesler klonlanıyor'); return JSON.stringify({ ...(await cloneAll(a.tekrar === true, progress)), not: 'Her ses için hangi motorda klonlandığını söyle. VoiceStudio kapalıysa açmasını; ElevenLabs planı izin vermiyorsa bunu söyle. Sonra test öner.' }); }
    progress('ses motorları deneniyor');
    return JSON.stringify({ ...(await runTest()), not: 'Çalışan ve çalışmayan motorları nedenleriyle kısaca söyle. Hiçbiri çalışmıyorsa: OpenAI kredisi, Gemini anahtarı, VoiceStudio ya da Ayarlar → Ses\'ten tarayıcı sesi öner.' });
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 200) });
  }
}
