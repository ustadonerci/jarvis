// Canlı sohbet (gerçek zamanlı ses): tarayıcı OpenAI Realtime'a doğrudan WebRTC ile bağlanır. Kullanıcının sesi
// yazıya çevrilmeden modele gider, model sesle cevap verir: bekleme yok, söze girilince anında susar, Türkçe doğal
// konuşur. Bu sunucu yalnız kısa ömürlü bir anahtar (ek_…) üretir; asıl API anahtarı tarayıcıya gitmez.
// Jarvis'in yetenekleri (hava, piyasa, e-posta, borsa, bilgisayar, hatırlama…) "jarvis_sor" aracıyla Jarvis'in
// normal beynine gider (uzaktan komutla aynı yol: geçmişe yazılır, onay kartları aynen geçerli), cevabı sesle söylenir.
// Ayarlar: OPENAI_API_KEY (zorunlu), OPENAI_REALTIME_MODEL (varsayılan gpt-realtime), OPENAI_REALTIME_VOICE (cedar).
import express, { type Router } from 'express';
import { adminOnly } from './keys.js';
import { logActivity } from './activity.js';

const key = () => (process.env.OPENAI_API_KEY || '').trim();
export const realtimeModel = () => (process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime').trim();
export const realtimeVoice = () => (process.env.OPENAI_REALTIME_VOICE || 'cedar').trim();
export const realtimeReady = () => !!key();

let ask: ((text: string) => Promise<string>) | null = null;
/** index.ts: istek → Jarvis'in normal beyni (uzaktan komut yolu) → cevap metni */
export const setLiveAsk = (fn: (text: string) => Promise<string>) => { ask = fn; };

function instructions(): string {
  const ad = (process.env.USER_NAME || '').trim();
  return [
    `Sen Jarvis'sin: ${ad ? `${ad} adlı kullanıcının` : 'kullanıcının'} kişisel yapay zekâ asistanı. Türkçe konuş; kullanıcıya "efendim" diye hitap et.`,
    'Sesli sohbettesin: kısa, doğal, sıcak cümleler kur (çoğunlukla 1-3 cümle). Liste okuma, madde işareti ya da emoji kullanma.',
    'Güncel ya da kişisel bilgi gereken her şeyde (hava durumu, döviz/borsa/kripto, haberler, e-postalar, takvim, harcamalar, borsa robotu, Telegram kanalları, indikatörler, bilgisayarda bir şey yapmak, mesaj göndermek, hatırlatma, kullanıcının geçmiş konuşmaları ya da bilmediğin herhangi bir şey) önce çok kısa "Bakıyorum efendim" de, sonra jarvis_sor aracını kullanıcının isteğini tam yazarak çağır. Aracın cevabını kendi cümlelerinle kısaca, sayıları doğru aktar.',
    'Asla bilgi uydurma; emin değilsen jarvis_sor\'a sor. Para harcayan ya da riskli işler Jarvis\'te onay kartıyla yapılır: araç onay beklediğini söylerse kullanıcıya bilgisayar ekranındaki kartı onaylamasını söyle.',
    'Kullanıcı söze girerse hemen sus ve onu dinle. "Devam et" derse kaldığın yerden sürdür.',
  ].join('\n');
}

const TOOLS = [
  {
    type: 'function',
    name: 'jarvis_sor',
    description: "Jarvis'in kendisine (tüm araçları ve hafızasıyla) bir istek iletir ve cevabını metin olarak döndürür. Hava, piyasa, haber, e-posta, takvim, harcama, robot, bilgisayar işleri, mesaj, hatırlatma ve bilmediğin her şey için kullan.",
    parameters: { type: 'object', properties: { istek: { type: 'string', description: 'Kullanıcının isteği, Türkçe ve eksiksiz (ör. "Yarın İstanbul\'da hava nasıl?")' } }, required: ['istek'] },
  },
];

/** GA uç noktası; hesap/sürüm desteklemiyorsa eski (beta) oturum ucu */
async function mint(): Promise<{ token: string; model: string; legacy: boolean }> {
  const model = realtimeModel(), voice = realtimeVoice();
  const auth = { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' };
  const ga = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST', headers: auth, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      session: {
        type: 'realtime', model, instructions: instructions(),
        audio: {
          input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'tr' }, turn_detection: { type: 'semantic_vad' } },
          output: { voice },
        },
        tools: TOOLS, tool_choice: 'auto',
      },
    }),
  });
  const gj: any = await ga.json().catch(() => ({}));
  if (ga.ok && (gj?.value || gj?.client_secret?.value)) return { token: gj.value ?? gj.client_secret.value, model, legacy: false };
  if (ga.status === 401) throw new Error('OpenAI anahtarı geçersiz (Ayarlar → Yapay zeka sağlayıcıları → OpenAI).');
  // Eski oturum ucu (beta)
  const old = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST', headers: { ...auth, 'OpenAI-Beta': 'realtime=v1' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      model, voice, instructions: instructions(),
      input_audio_transcription: { model: 'whisper-1', language: 'tr' }, turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
      tools: TOOLS, tool_choice: 'auto',
    }),
  });
  const oj: any = await old.json().catch(() => ({}));
  if (old.ok && oj?.client_secret?.value) return { token: oj.client_secret.value, model, legacy: true };
  const msg = String(gj?.error?.message ?? oj?.error?.message ?? `${ga.status}/${old.status}`);
  throw new Error(`Canlı sohbet başlatılamadı: ${msg.slice(0, 200)}${/model/i.test(msg) ? ' (OPENAI_REALTIME_MODEL ayarını kontrol edin)' : ''}`);
}

export function realtimeRouter(): Router {
  const r = express.Router();
  r.use('/api/canli', adminOnly);
  r.get('/api/canli', (_req, res) => res.json({ hazir: realtimeReady(), model: realtimeModel(), ses: realtimeVoice() }));
  r.post('/api/canli/oturum', async (_req, res) => {
    if (!realtimeReady()) return res.status(400).json({ error: 'Canlı sohbet için OpenAI API anahtarı gerekli: Ayarlar → Yapay zeka sağlayıcıları → OpenAI kartı.' });
    try {
      const t = await mint();
      console.log(`[canlı] oturum açıldı · ${t.model}${t.legacy ? ' (eski uç)' : ''}`);
      logActivity('canli', `canlı sesli sohbet başladı (${t.model})`);
      res.json(t);
    } catch (e: any) {
      console.warn(`[canlı] ${String(e?.message || e).slice(0, 200)}`);
      res.status(502).json({ error: String(e?.message || e) });
    }
  });
  r.post('/api/canli/arac', async (req, res) => {
    const name = String(req.body?.name ?? '');
    let args: any = req.body?.args ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (name !== 'jarvis_sor' || !ask) return res.json({ output: 'Bu araç yok.' });
    const istek = String(args.istek ?? '').trim().slice(0, 2000);
    if (!istek) return res.json({ output: 'İstek boş.' });
    try {
      const out = await ask(istek);
      res.json({ output: out.slice(0, 3000) });
    } catch (e: any) {
      res.json({ output: `Jarvis şu an cevap veremedi: ${String(e?.message || e).slice(0, 200)}` });
    }
  });
  return r;
}
