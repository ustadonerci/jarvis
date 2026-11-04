import { getPersona } from './persona.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_KEY, BASE_URL, MOCK, routeLlmDown, routellm, type ChatResponse } from './routellm.js';
import { BRIEF_OPENING } from './brief.js';
import { isMp3, isWav, normalizeSpeech, pcmToWav, wavSeconds } from './audio.js';
import { elevenReady, elevenSpeak, isEleven, type ElevenCtx } from './eleven.js';
import { azureReady, azureSpeak, isAzure } from './azure.js';
import { isVoiceStudio, vsSpeak, vsUp } from './voicestudio.js';
import { piperFirst, piperReady, piperSpeak } from './piper.js';
import { SCRIPTED_LINES } from './scripted.js';

/**
 * Jarvis'in sesi (TTS).
 *
 * Teşhis (5 Ekim 2026, gerçek isteklerle ölçüldü):
 * - Gemini TTS aynı ses kimliği + aynı metinle bile her istekte farklı perdede ses üretiyor (onyx: 125–197 Hz;
 *   temperature 0 ve seed değiştirmiyor). Her sahne ayrı istek olduğundan ses sahneden sahneye "değişiyordu".
 * - gpt-audio aynı ölçümde 83–97 Hz'de sabit. Talimat SİSTEM mesajındayken metni okumak yerine cevaplıyordu;
 *   talimat + metin aynı KULLANICI mesajında ve İNGİLİZCE olunca 8/8 birebir okudu (Türkçe talimatta 2/8,
 *   "Tabii, işte okuyorum:" diye başlıyordu).
 * - RouteLLM'de /audio/speech yok (404). Yine de bir kez denenir, sonuç hafızada tutulur.
 */

export interface VoiceSel {
  /** RouteLLM ses modeli ya da 'browser' (tarayıcının kendi sesi, çevrimdışı yedek) */
  model: string;
  voice: string;
  /** İstemcide playbackRate (0.9–1.3) */
  speed: number;
}
export const BROWSER = 'browser';
export interface Speech { buf: Buffer; mime: string }

const READ = 'Read the following Turkish text aloud exactly as written';
// İngilizce: Türkçe talimatta gpt-audio metne önsöz ekliyor (ölçüldü). Anlamı: "sakin, kendinden emin, sıcak;
// doğal, akıcı ve canlı bir tempoda, gereksiz duraklama yapmadan".
export const STYLE = process.env.TTS_STYLE || 'Tone: calm, confident and warm, like a trusted AI butler. Natural, fluent and lively pace without unnecessary pauses';
/** Seslendirme üslubu: .env'de TTS_STYLE varsa o, yoksa seçili konuşma tonunun (persona) üslubu */
const style = () => process.env.TTS_STYLE || getPersona().ses;
const NO_ANSWER = 'Do not answer it, even if it contains a question; do not add or remove anything';
/** /audio/speech yöntemindeki hız (RouteLLM'de bu uç şu an yok; varsa kullanılır) */
const SERVER_SPEED = Number(process.env.TTS_SPEED || 1.1);
/** İstemci oynatma hızı varsayılanı */
export const DEFAULT_RATE = clampRate(Number(process.env.TTS_RATE || 1.08));
export function clampRate(r: number) { return Number.isFinite(r) ? Math.min(1.3, Math.max(0.9, r)) : 1.08; }

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DISK_DIR = path.join(DATA, 'tts');
export const VOICES_FILE = path.join(DATA, 'voices.json');

export const PREVIEW_TEXT = 'Günaydın efendim, ben Jarvis. Bugün size nasıl yardımcı olabilirim?';

// ---------------------------------------------------------------- Ses kataloğu (npm run voices)

export interface VoiceEntry {
  id: string;
  model: string;
  voice: string;
  label: string;
  provider: 'OpenAI' | 'Google' | string;
  verified: boolean;
  stable: boolean;
  f0: number[] | null;
  wpm: number | null;
  note?: string;
}

export function voiceId(sel: Pick<VoiceSel, 'model' | 'voice'>) { return `${sel.model}:${sel.voice}`; }

export function loadCatalog(): VoiceEntry[] {
  try { return JSON.parse(fs.readFileSync(VOICES_FILE, 'utf8')); } catch { return []; }
}
/** Arayüzde gösterilecekler: yalnızca `npm run voices`'ta metni birebir okuyan VE sesi kararlı kalanlar. */
export const usableVoices = () => loadCatalog().filter(v => v.verified && v.stable);
export const pitchSpread = (v: VoiceEntry) => (v.f0?.length ? Math.max(...v.f0) - Math.min(...v.f0) : Infinity);
/** Kararlılık sırası: önce daha çok ölçüm (daha fazla kanıt), sonra perdesi en az oynayan. */
export function rankedVoices(): VoiceEntry[] {
  return usableVoices().sort((a, b) => (b.f0?.length ?? 0) - (a.f0?.length ?? 0) || pitchSpread(a) - pitchSpread(b) || a.id.localeCompare(b.id));
}
/** Önerilecek/yedek ses: en kararlı ses. */
export const bestVoice = (): VoiceEntry | undefined => rankedVoices()[0];

/** Yönlendirmeli model (route-llm, özel router) TTS'te yasak: her istekte başka model/ses seçebilir. */
export function isRoutedModel(model: string) {
  return /^route-llm/i.test(model) || (!!process.env.CHAT_MODEL && model === process.env.CHAT_MODEL && !/audio|tts/i.test(model));
}

/** .env'deki varsayılan; geçersizse kataloğun ilk sesi; o da yoksa ölçülmüş güvenli varsayılan. */
export function envVoice(): { sel: VoiceSel; warning?: string } {
  const model = process.env.TTS_MODEL || '';
  const voice = process.env.TTS_VOICE || '';
  const fallback = bestVoice();
  const safe: VoiceSel = fallback ? { model: fallback.model, voice: fallback.voice, speed: DEFAULT_RATE } : { model: 'gpt-audio-1.5', voice: 'onyx', speed: DEFAULT_RATE };
  if (!model) return { sel: safe, warning: `TTS_MODEL boş; varsayılan ses: ${voiceId(safe)}` };
  if (isRoutedModel(model)) return { sel: safe, warning: `TTS_MODEL=${model} yönlendirmeli bir model; TTS için REDDEDİLDİ (her istekte başka ses seçebilir). Kullanılan: ${voiceId(safe)}` };
  if (!voice) return { sel: safe, warning: `TTS_VOICE boş; sabit bir ses kimliği şart. Kullanılan: ${voiceId(safe)}` };
  return { sel: { model, voice, speed: DEFAULT_RATE } };
}

// Abacus.AI (RouteLLM) çalışmazsa AYNI ses doğrudan sağlayıcıdan üretilir: OpenAI sesleri OPENAI_API_KEY ile,
// Gemini sesleri GEMINI_API_KEY ile (kullanıcının seçtiği ses değişmez).
/** Son ses hatası (istemciye x-tts-hata başlığıyla gider: kullanıcı nedenini görsün) */
let lastTtsError = '';
export const ttsLastError = () => lastTtsError;
/** Abacus.AI ses ucu anahtar hatası verdiyse bir süre doğrudan sağlayıcıya gidilir */
let ttsRouteDownUntil = 0;
const clean = (k?: string) => (k || '').replace(/^["']|["']$/g, '').replace(/\s+/g, '');
/** OpenAI sesi için OpenAI anahtarı yoksa Gemini anahtarıyla en yakın Gemini sesi kullanılır (sessiz kalmasın) */
const directKey = (model: string, _voice = '') => !!(clean(process.env.OPENAI_API_KEY) || clean(process.env.GEMINI_API_KEY) || piperReady()) && !!model;
// OpenAI sesleri → benzer Gemini sesleri (erkek/kadın ve ton)
const GEMINI_ESI: Record<string, string> = { onyx: 'Charon', echo: 'Orus', ash: 'Fenrir', ballad: 'Algenib', cedar: 'Iapetus', verse: 'Puck', fable: 'Enceladus', alloy: 'Kore', nova: 'Kore', shimmer: 'Aoede', coral: 'Leda', sage: 'Despina', marin: 'Zephyr' };
// Google'ın hazır ses adları (Gemini TTS yalnız bunları kabul eder; "onyx" gibi OpenAI adları reddedilir)
const GEMINI_NAMES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];
const OPENAI_NAMES = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable', 'marin', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
/** Seçili ses adı → Gemini'nin kabul ettiği ad */
export const geminiVoice = (v: string) => GEMINI_NAMES.find(n => n.toLowerCase() === v.toLowerCase()) ?? GEMINI_ESI[v.toLowerCase()] ?? 'Charon';
/** Seçili ses adı → OpenAI'nin kabul ettiği ad */
export const openaiVoice = (v: string) => {
  const l = v.toLowerCase();
  if (OPENAI_NAMES.includes(l)) return l;
  return Object.entries(GEMINI_ESI).find(([, g]) => g.toLowerCase() === l)?.[0] ?? 'onyx';
};
export const ttsEnabled = (sel: VoiceSel) => sel.model !== BROWSER && ((isEleven(sel.model) ? elevenReady() : isAzure(sel.model) ? azureReady() : isVoiceStudio(sel.model) ? vsUp() : !MOCK && !!API_KEY) || directKey(sel.model, sel.voice));

async function geminiTts(text: string, voice: string, preferred?: string): Promise<Speech> {
  let last = 'Gemini anahtarı yok';
  if (!clean(process.env.GEMINI_API_KEY)) throw new Error(last);
  for (const model of [...(preferred ? [preferred] : []), 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts', 'gemini-2.5-pro-preview-tts']) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': clean(process.env.GEMINI_API_KEY), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ contents: [{ parts: [{ text: `${READ}. ${style()}: ${text}` }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }),
    });
    const j: any = await r.json().catch(() => ({}));
    const data = j?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data;
    if (r.ok && data) {
      const raw = Buffer.from(data, 'base64');
      const buf = isWav(raw) || isMp3(raw) ? raw : pcmToWav(raw);
      return { buf, mime: isMp3(buf) ? 'audio/mpeg' : 'audio/wav' };
    }
    last = `Gemini ses ${r.status}: ${String((Array.isArray(j) ? j[0] : j)?.error?.message ?? '').slice(0, 120)}`;
    if (r.status !== 404 && r.status !== 400) break; // model yoksa sıradakini dene; anahtar/kota hatasında dur
  }
  throw new Error(last);
}

/** OpenAI hesabında kredi yoksa (429 insufficient_quota) ya da anahtar geçersizse bir süre doğrudan Gemini'ye */
let openaiTtsDownUntil = 0;
async function openaiTts(text: string, sel: VoiceSel): Promise<Speech> {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${clean(process.env.OPENAI_API_KEY)}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', input: text, voice: openaiVoice(sel.voice), speed: SERVER_SPEED, response_format: 'mp3', instructions: style() }),
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    if ([401, 402, 403, 429].includes(r.status)) openaiTtsDownUntil = Date.now() + 30 * 60_000;
    throw new Error(`OpenAI ses ${r.status}${/insufficient_quota/.test(body) ? ' (OpenAI hesabında kredi yok)' : ''}: ${body.slice(0, 100)}`);
  }
  return { buf: Buffer.from(await r.arrayBuffer()), mime: 'audio/mpeg' };
}

type Engine = { ad: string; run: () => Promise<Speech> };
/** Seçili ses için doğrudan motorlar, sırayla: aynı ailenin sağlayıcısı → diğer aile (ses adı her sağlayıcının kabul ettiği karşılığa çevrilir) */
function directEngines(text: string, sel: VoiceSel): Engine[] {
  const gem = sel.model.startsWith('gemini');
  const oa = clean(process.env.OPENAI_API_KEY), gk = clean(process.env.GEMINI_API_KEY);
  const openai: Engine[] = oa && Date.now() >= openaiTtsDownUntil ? [{ ad: `OpenAI (${openaiVoice(sel.voice)})`, run: () => openaiTts(text, sel) }] : [];
  const gemini: Engine[] = gk ? [{ ad: `Gemini (${geminiVoice(sel.voice)})`, run: () => geminiTts(text, geminiVoice(sel.voice), gem && /tts/.test(sel.model) ? sel.model : undefined) }] : [];
  // En sonda internetsiz Türkçe ses (kuruluysa): anahtar/kredi/internet olmadan da ses kesilmez
  const yerel: Engine[] = piperReady() ? [{ ad: 'İnternetsiz ses (Piper)', run: async () => ({ buf: await piperSpeak(text, sel.speed), mime: 'audio/wav' }) }] : [];
  return gem ? [...gemini, ...openai, ...yerel] : [...openai, ...gemini, ...yerel];
}

async function viaDirect(text: string, sel: VoiceSel): Promise<Speech> {
  const errs: string[] = [];
  for (const e of directEngines(text, sel)) {
    try { return await e.run(); } catch (err: any) { errs.push(`${e.ad}: ${String(err?.message || err).slice(0, 100)}`); console.warn(`[tts] ${e.ad} olmadı, sıradaki: ${String(err?.message || err).slice(0, 120)}`); }
  }
  throw new Error(errs.join(' · ') || 'kullanılabilir ses motoru yok');
}

// ---------------------------------------------------------------- Üretim

/** Hangi yöntem çalışıyor: ilk başarılı/başarısız denemeden sonra hafızada; istek başına gidip gelinmez. */
const methodFor = new Map<string, 'speech' | 'chat'>();

async function viaSpeech(text: string, sel: VoiceSel): Promise<Speech | 'yok'> {
  const r = await fetch(`${BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: sel.model, input: text, voice: sel.voice, speed: SERVER_SPEED, response_format: 'mp3', instructions: style() }),
    signal: AbortSignal.timeout(30_000),
  });
  if ([400, 404, 405, 501].includes(r.status)) return 'yok';
  if (!r.ok) throw new Error(`/audio/speech HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, mime: isWav(buf) ? 'audio/wav' : 'audio/mpeg' };
}

async function viaChat(text: string, sel: VoiceSel): Promise<Speech & { transcript?: string }> {
  const gemini = sel.model.startsWith('gemini');
  // Gemini TTS saf seslendirme modeli: "<talimat>: <metin>". gpt-audio sohbet modeli: cevap vermemesi açıkça söylenir.
  const content = gemini ? `${READ}. ${style()}: ${text}` : `${READ}. ${style()}. ${NO_ANSWER}: ${text}`;
  const resp = await routellm<ChatResponse>('/chat/completions', {
    model: sel.model,
    modalities: ['text', 'audio'],
    audio: { voice: sel.voice, format: 'mp3' },
    messages: [{ role: 'user', content }],
  });
  const msg = resp.choices?.[0]?.message;
  const audio = msg?.audios?.[0] || msg?.audio;
  if (!audio?.data) throw new Error('ses alanı boş');
  const raw = Buffer.from(audio.data, 'base64');
  // Gemini MP3 istense de ham 24 kHz PCM döndürüyor: tarayıcı çalabilsin diye WAV'a sarılır.
  const buf = isMp3(raw) || isWav(raw) ? raw : pcmToWav(raw);
  return { buf, mime: isMp3(buf) ? 'audio/mpeg' : 'audio/wav', transcript: (audio as { transcript?: string }).transcript };
}

/** Uydurma kontrolü (transcript döndürmeyen modeller için): Türkçe ~14 karakter/sn. */
function plausible(s: Speech, text: string) {
  const sec = wavSeconds(s.buf);
  if (sec === null) return true;
  const expected = text.length / 14;
  return sec >= expected * 0.4 && sec <= expected * 2.2 + 1.5;
}

async function generateOnce(text: string, sel: VoiceSel, ctx: ElevenCtx): Promise<{ speech: Speech; method: 'speech' | 'chat' | 'elevenlabs' | 'azure' | 'voicestudio' } | { error: string }> {
  // Kullanıcı "önce internetsiz ses" dediyse: doğrudan Piper
  if (piperFirst()) return { speech: { buf: await piperSpeak(text, sel.speed), mime: 'audio/wav' }, method: 'speech' };
  // VoiceStudio / Azure / ElevenLabs çalışmazsa (kapalı, anahtar/kredi yok) ses OpenAI ya da Gemini'den gelir
  const ozel = isVoiceStudio(sel.model) ? 'voicestudio' : isAzure(sel.model) ? 'azure' : isEleven(sel.model) ? 'elevenlabs' : null;
  if (ozel) {
    const ready = ozel === 'voicestudio' ? vsUp() : ozel === 'azure' ? azureReady() : elevenReady();
    try {
      if (!ready) throw new Error(`${ozel} hazır değil`);
      const buf = ozel === 'voicestudio' ? await vsSpeak(text, sel.voice, sel.speed) : ozel === 'azure' ? await azureSpeak(text, sel.voice, sel.speed) : await elevenSpeak(text, sel.voice, sel.model, sel.speed, ctx);
      return { speech: { buf, mime: 'audio/mpeg' }, method: ozel };
    } catch (e: any) {
      if (!directKey(sel.model, sel.voice)) throw e;
      console.warn(`[tts] ${ozel} olmadı (${String(e?.message || e).slice(0, 100)}); OpenAI/Gemini sesine geçiliyor`);
      return { speech: await viaDirect(text, { ...sel, voice: 'onyx' }), method: 'speech' };
    }
  }
  // Abacus.AI anahtarı yok/bozuk: aynı ses doğrudan OpenAI/Gemini'den
  if (directKey(sel.model, sel.voice) && (!API_KEY || MOCK || routeLlmDown() || Date.now() < ttsRouteDownUntil)) return { speech: await viaDirect(text, sel), method: 'speech' };
  if (methodFor.get(sel.model) !== 'chat') {
    const r = await viaSpeech(text, sel).catch(e => ({ error: String(e.message) }));
    if (!(r !== 'yok' && !('error' in r)) && r !== 'yok' && directKey(sel.model, sel.voice) && /HTTP (401|402|403|429)/.test(r.error)) { ttsRouteDownUntil = Date.now() + 30 * 60_000; return { speech: await viaDirect(text, sel), method: 'speech' }; }
    if (r !== 'yok' && !('error' in r)) { methodFor.set(sel.model, 'speech'); return { speech: r, method: 'speech' }; }
    if (r === 'yok') methodFor.set(sel.model, 'chat');
    else return r;
  }
  let s: Awaited<ReturnType<typeof viaChat>>;
  try { s = await viaChat(text, sel); }
  catch (e: any) {
    // Abacus.AI ses vermedi (anahtar/kredi): aynı ses doğrudan OpenAI'den, olmazsa Gemini'den
    if (directKey(sel.model, sel.voice)) { ttsRouteDownUntil = Date.now() + 30 * 60_000; return { speech: await viaDirect(text, sel), method: 'speech' }; }
    throw e;
  }
  if (s.transcript != null && normalizeSpeech(s.transcript) !== normalizeSpeech(text)) return { error: `metinden sapma: "${s.transcript.slice(0, 60)}"` };
  if (s.transcript == null && !plausible(s, text)) return { error: 'süre metinle tutmuyor (uydurma şüphesi)' };
  return { speech: { buf: s.buf, mime: s.mime }, method: 'chat' };
}

// Aynı anda en fazla 3 üretim; sıra korunur (FIFO).
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>(r => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

// ElevenLabs'te hız sunucuda uygulanır: farklı hız = farklı ses dosyası
const cacheKey = (text: string, sel: VoiceSel) =>
  createHash('sha1').update([sel.model, sel.voice, isEleven(sel.model) || isAzure(sel.model) || isVoiceStudio(sel.model) ? sel.speed : SERVER_SPEED, style(), text].join('\u0000')).digest('hex');
const memory = new Map<string, Speech>();
const inflight = new Map<string, Promise<Speech | null>>();

function readDisk(key: string): Speech | null {
  for (const [ext, mime] of [['mp3', 'audio/mpeg'], ['wav', 'audio/wav']] as const) {
    const f = path.join(DISK_DIR, `${key}.${ext}`);
    if (fs.existsSync(f)) return { buf: fs.readFileSync(f), mime };
  }
  return null;
}
function writeDisk(key: string, s: Speech) {
  fs.mkdirSync(DISK_DIR, { recursive: true });
  fs.writeFileSync(path.join(DISK_DIR, `${key}.${s.mime === 'audio/wav' ? 'wav' : 'mp3'}`), s.buf);
}

/**
 * Sabit model + sabit ses kimliğiyle seslendirir. Başarısızsa bir kez yeniden dener; yine olmazsa null döner ve
 * istemci o cevabın kalanını tarayıcı sesine geçirir (sahne sahne karışık ses yok).
 * @param label log için, ör. "sahne 3/6"
 */
export function synthesize(text: string, sel: VoiceSel, label = '', persist = false, ctx: ElevenCtx = {}): Promise<Speech | null> {
  if (!ttsEnabled(sel) || !text.trim()) return Promise.resolve(null);
  const key = cacheKey(text, sel);
  const hit = memory.get(key) ?? readDisk(key);
  if (hit) {
    console.log(`[tts] ${label || 'istek'} · ${sel.model} · ${sel.voice} · önbellek · 0 ms · ${hit.buf.length} byte`);
    return Promise.resolve(hit);
  }
  let job = inflight.get(key);
  if (!job) {
    job = withSlot(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const t0 = Date.now();
        const r = await generateOnce(text, sel, ctx).catch(e => ({ error: String(e?.message || e) }));
        const ms = Date.now() - t0;
        if ('speech' in r) {
          console.log(`[tts] ${label || 'istek'} · ${sel.model} · ${sel.voice} · ${r.method} · ${ms} ms · ${r.speech.buf.length} byte · ${text.length} karakter${attempt > 1 ? ' · 2. deneme' : ''}`);
          if (memory.size > 300) memory.delete(memory.keys().next().value!);
          memory.set(key, r.speech);
          if (persist) writeDisk(key, r.speech);
          return r.speech;
        }
        console.warn(`[tts] ${label || 'istek'} · ${sel.model} · ${sel.voice} · BAŞARISIZ (deneme ${attempt}/2) · ${ms} ms · ${r.error}`);
        lastTtsError = r.error;
      }
      return null;
    }).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

/** Brifing açılışını seçili sesle önceden üretip diske yazar (videonun ilk saniyesi: anında ve doğru). */
export async function warmOpening(sel: VoiceSel) {
  if (!ttsEnabled(sel)) return;
  const s = await synthesize(BRIEF_OPENING, sel, 'açılış (hazırlık)', true);
  console.log(s ? `Açılış sesi hazır: ${voiceId(sel)}` : `Açılış sesi hazırlanamadı: ${voiceId(sel)}`);
  // Hazır komutların cümleleri de: anında çalsın
  for (const line of SCRIPTED_LINES) synthesize(line, sel, 'hazır komut (hazırlık)', true).catch(() => {});
}

/** Ayarlar'daki ▶ dinle: sabit örnek cümle, diskte saklanır (ikinci dinleme kredisiz ve anında). */
export const preview = (sel: VoiceSel) => synthesize(PREVIEW_TEXT, sel, `önizleme ${voiceId(sel)}`, true);

