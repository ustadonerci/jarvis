// Canlı ses modu (Gemini Live API): tarayıcıdaki mikrofon sesi doğrudan Gemini'ye akar, cevap doğrudan ses olarak
// gelir. Ayrı "yazıya çevir → düşün → seslendir" zinciri olmadığı için cevap çok hızlı başlar ve kullanıcı Jarvis'in
// sözünü kesebilir. Kendi yazdığımız köprü (Mark-LVI'den kod alınmadı, yalnız yaklaşım örnek alındı).
// - Anahtar sunucuda kalır: tarayıcı ↔ /api/canli-ses (WebSocket) ↔ Gemini Live (WebSocket).
// - Sohbet, selamlaşma, kısa sorular canlı modelde; bilgi/işlem gereken her şey (haber, piyasa, mesaj, takvim,
//   tarayıcı, dosya…) "jarvis_gorev" aracıyla Jarvis'in asıl beynine gider (bütün araçlar, onay kartları aynen geçerli).
// - Ses formatı: tarayıcıdan 16 kHz PCM16 mono; Gemini'den 24 kHz PCM16 mono.
import type { IncomingMessage, Server } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// ws paketi kurulu (bağımlılık); tür tanımı olmadığı için gevşek tipli
const { WebSocketServer, WebSocket } = require('ws') as any;

const LIVE_URL = process.env.GEMINI_LIVE_URL || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
/** Denenecek canlı modeller (ilk açılan kullanılır, sonraki oturumlar onunla başlar) */
const MODELS = (process.env.GEMINI_LIVE_MODEL ? [process.env.GEMINI_LIVE_MODEL] : [])
  .concat(['gemini-2.5-flash-native-audio-preview-12-2025', 'gemini-live-2.5-flash-preview', 'gemini-2.0-flash-live-001']);
let workingModel: string | null = null;

const key = () => (process.env.GEMINI_API_KEY || '').replace(/^["']|["']$/g, '').replace(/\s+/g, '');
export const liveReady = () => !!key();

/** OpenAI ses adları → en yakın Gemini canlı ses adı */
const VOICE_MAP: Record<string, string> = { onyx: 'Charon', echo: 'Orus', fable: 'Fenrir', alloy: 'Kore', nova: 'Aoede', shimmer: 'Leda' };

export interface LiveDeps {
  authorize: (req: IncomingMessage) => boolean;
  systemPrompt: () => string;
  voice: () => string;
  runTask: (istek: string) => Promise<string>;
  log?: (l: string) => void;
}

const TOOLS = [{
  functionDeclarations: [{
    name: 'jarvis_gorev',
    description: "Jarvis'in asıl beynine iş verir: güncel bilgi (haber, hava, piyasa, döviz, borsa), internette arama, sayfa açma, mesajlar (WhatsApp/Telegram), e-posta, takvim, hatırlatma, bilgisayarda program/dosya işlemleri, portföy, mesai, yetenekler ve bütün diğer araçlar. Bilgi ya da işlem gereken HER istekte kullan; kendi bilginle güncel bilgi uydurma. Sonuç metnini kullanıcıya kısaca, doğal Türkçe konuşarak anlat. Uzun sürebilir: çağırmadan önce 'hemen bakıyorum efendim' gibi kısa bir şey söyle.",
    parameters: { type: 'OBJECT', properties: { istek: { type: 'STRING', description: 'Kullanıcının isteği, tam ve açık cümleyle (Türkçe)' } }, required: ['istek'] },
  }],
}];

function setupMsg(model: string, d: LiveDeps) {
  const v = d.voice().toLowerCase();
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_MAP[v] ?? (v ? v[0].toUpperCase() + v.slice(1) : 'Charon') } }, languageCode: 'tr-TR' },
      },
      systemInstruction: { parts: [{ text: d.systemPrompt() }] },
      tools: TOOLS,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

/** Gemini'ye bağlanır; model açılmazsa sıradakini dener */
function connectGemini(d: LiveDeps, onReady: (g: any, model: string) => void, onFail: (why: string) => void) {
  const order = workingModel ? [workingModel, ...MODELS.filter(m => m !== workingModel)] : [...new Set(MODELS)];
  let i = 0;
  const tryNext = (lastWhy: string) => {
    if (i >= order.length) return onFail(lastWhy);
    const model = order[i++];
    const g = new WebSocket(`${LIVE_URL}?key=${encodeURIComponent(key())}`, { headers: { 'x-goog-api-key': key() } });
    let ready = false;
    g.on('open', () => g.send(JSON.stringify(setupMsg(model, d))));
    g.on('message', (data: Buffer) => {
      if (ready) return;
      let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.setupComplete) { ready = true; workingModel = model; g.removeAllListeners('message'); g.removeAllListeners('close'); g.removeAllListeners('error'); onReady(g, model); }
    });
    g.on('close', (code: number, reason: Buffer) => { if (!ready) tryNext(`${model}: ${code} ${reason.toString().slice(0, 160)}`); });
    g.on('error', (e: any) => { if (!ready) { try { g.terminate(); } catch { /* */ } tryNext(`${model}: ${String(e?.message || e).slice(0, 160)}`); } });
  };
  tryNext('');
}

export function attachLiveVoice(server: Server, d: LiveDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 << 20 });
  server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
    if (!req.url?.startsWith('/api/canli-ses')) return; // diğer yükseltmelere (Vite HMR vb.) dokunma
    if (!d.authorize(req) || !liveReady()) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws: any) => session(ws, d));
  });
}

function session(ws: any, d: LiveDeps) {
  const send = (o: object) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  let g: any = null;
  let closed = false;
  const pending: Buffer[] = [];
  send({ type: 'durum', metin: 'bağlanıyor' });
  connectGemini(d, (gg, model) => {
    if (closed) { gg.close(); return; }
    g = gg;
    d.log?.(`[canlı ses] açıldı · ${model}`);
    send({ type: 'hazir', model });
    for (const b of pending.splice(0)) audioIn(b);
    g.on('message', async (data: Buffer) => {
      let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
      const sc = m.serverContent;
      if (sc) {
        for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) { if (ws.readyState === 1) ws.send(Buffer.from(p.inlineData.data, 'base64')); }
        if (sc.interrupted) send({ type: 'kesildi' });
        if (sc.inputTranscription?.text) send({ type: 'yazi', kim: 'sen', metin: sc.inputTranscription.text });
        if (sc.outputTranscription?.text) send({ type: 'yazi', kim: 'jarvis', metin: sc.outputTranscription.text });
        if (sc.turnComplete) send({ type: 'tur_bitti' });
      }
      if (m.toolCall?.functionCalls?.length) {
        const responses = await Promise.all(m.toolCall.functionCalls.map(async (fc: any) => {
          const istek = String(fc.args?.istek ?? '').trim();
          send({ type: 'gorev', metin: istek });
          let result: string;
          try { result = istek ? await d.runTask(istek) : 'İstek boş.'; } catch (e: any) { result = `Yapılamadı: ${String(e?.message || e).slice(0, 200)}`; }
          send({ type: 'gorev_bitti' });
          return { id: fc.id, name: fc.name, response: { result: result.slice(0, 6000) } };
        }));
        if (g?.readyState === 1) g.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
      }
      if (m.goAway) send({ type: 'durum', metin: 'oturum yenileniyor' });
    });
    g.on('close', (code: number, reason: Buffer) => { d.log?.(`[canlı ses] Gemini kapandı: ${code} ${reason.toString().slice(0, 120)}`); send({ type: 'kapandi', neden: reason.toString().slice(0, 160) || String(code) }); try { ws.close(); } catch { /* */ } });
    g.on('error', () => { /* close olayı izler */ });
  }, why => {
    d.log?.(`[canlı ses] açılamadı: ${why}`);
    send({ type: 'hata', metin: `Canlı ses açılamadı (${why.slice(0, 160)}). Gemini anahtarı canlı sesi desteklemiyor olabilir; normal mikrofon çalışmaya devam eder.` });
    try { ws.close(); } catch { /* */ }
  });

  function audioIn(b: Buffer) {
    if (!g || g.readyState !== 1) { if (pending.length < 50) pending.push(b); return; }
    g.send(JSON.stringify({ realtimeInput: { audio: { data: b.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
  }
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return audioIn(Buffer.from(data));
    let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'metin' && g?.readyState === 1) g.send(JSON.stringify({ realtimeInput: { text: String(m.metin ?? '').slice(0, 2000) } }));
    if (m.type === 'sessiz' && g?.readyState === 1) g.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  });
  ws.on('close', () => { closed = true; try { g?.close(); } catch { /* */ } });
}
