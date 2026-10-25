// Ses tanıma (STT) RouteLLM'den: tarayıcının Web Speech API'si iPhone'da güvenilir değil, yalnızca yedek.
// Ölçüm (5 Ekim 2026): /audio/transcriptions RouteLLM'de yok (404). Ses girdili sohbet modelleri arasında
// gemini-2.5-flash 2,7 sn'de birebir doğru yazdı; gemini-2.5-pro 9 sn; gpt-audio-1.5 metni bozdu.
import { API_KEY, BASE_URL, routellm, type ChatResponse } from './routellm.js';

export const STT_MODEL = process.env.STT_MODEL || 'gemini-2.5-flash';
let transcriptionsEndpoint: boolean | null = null; // ilk denemeden sonra hafızada

/** MediaRecorder MIME türü → RouteLLM input_audio biçimi */
export function audioFormat(mime: string): string | null {
  const m = mime.toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return null;
}

/**
 * Ayrı ses tanıma sağlayıcıları (isteğe bağlı, anahtar girildiyse sırayla denenir; olmazsa RouteLLM):
 * - Deepgram (DEEPGRAM_API_KEY): hızlı; Türkçe için nova-2 (DEEPGRAM_MODEL ile değiştirilebilir).
 * - OpenAI Whisper (OPENAI_API_KEY): OPENAI_STT_MODEL, varsayılan whisper-1 (gpt-4o-transcribe de olur).
 */
async function viaDeepgram(audio: Buffer, mime: string): Promise<{ text: string; model: string }> {
  const model = process.env.DEEPGRAM_MODEL || 'nova-2';
  const r = await fetch(`https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&language=tr&smart_format=true&punctuate=true`, {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': mime.split(';')[0] || 'audio/webm' },
    body: new Uint8Array(audio),
    signal: AbortSignal.timeout(limitMs(audio)),
  });
  if (!r.ok) throw new Error(`Deepgram ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const j: any = await r.json();
  return { text: String(j.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim(), model: `deepgram/${model}` };
}
async function viaWhisper(audio: Buffer, mime: string, format: string): Promise<{ text: string; model: string }> {
  const model = process.env.OPENAI_STT_MODEL || 'whisper-1';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `kayit.${format}`);
  form.append('model', model);
  form.append('language', 'tr');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(limitMs(audio) + 10_000) });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const j: any = await r.json();
  return { text: String(j.text ?? '').trim(), model: `openai/${model}` };
}

/** Uzun kayıt (mikrofon kullanıcı kapatana kadar açık) daha uzun sürer: 20 sn + her ~20 KB için 1 sn */
const limitMs = (audio: Buffer) => 20_000 + Math.round(audio.length / 20);

export async function transcribe(audio: Buffer, mime: string): Promise<{ text: string; model: string; ms: number }> {
  const t0 = Date.now();
  const format = audioFormat(mime);
  if (!format) throw new Error(`desteklenmeyen ses biçimi: ${mime}`);

  const providers: [boolean, () => Promise<{ text: string; model: string }>][] = [
    [!!process.env.DEEPGRAM_API_KEY, () => viaDeepgram(audio, mime)],
    [!!process.env.OPENAI_API_KEY, () => viaWhisper(audio, mime, format)],
  ];
  for (const [ready, run] of providers) {
    if (!ready) continue;
    try {
      const r = await run();
      return { ...r, ms: Date.now() - t0 };
    } catch (e: any) {
      console.warn(`[stt] ${String(e?.message || e).slice(0, 140)} · sıradaki sağlayıcı deneniyor`);
    }
  }

  if (transcriptionsEndpoint !== false) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `kayit.${format}`);
    form.append('model', STT_MODEL);
    form.append('language', 'tr');
    const r = await fetch(`${BASE_URL}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}` }, body: form }).catch(() => null);
    if (r?.ok) {
      transcriptionsEndpoint = true;
      const j: any = await r.json();
      return { text: String(j.text ?? '').trim(), model: STT_MODEL, ms: Date.now() - t0 };
    }
    transcriptionsEndpoint = false;
  }

  const resp = await routellm<ChatResponse>('/chat/completions', {
    model: STT_MODEL,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: audio.toString('base64'), format } },
          { type: 'text', text: 'Bu, Jarvis adlı sesli asistana Türkçe söylenmiş bir komut ya da soru. Kelimesi kelimesine yazıya dök: kişi adlarını, sayıları, saatleri, para birimlerini ve uygulama/marka adlarını (WhatsApp, YouTube, Bitcoin, Trendyol…) doğru yaz; Türkçe karakterleri (ç, ğ, ı, İ, ö, ş, ü) kullan. Sadece duyduğun metni yaz; tırnak, açıklama ya da başlık ekleme, cümleyi düzeltme ya da tamamlama. Konuşma yoksa hiçbir şey yazma.' },
        ],
      },
    ],
  });
  const raw = String(resp.choices?.[0]?.message?.content ?? '').trim();
  // Model bazen {"text": "..."} biçiminde dönüyor
  let text = (/^\{\s*"(?:text|transcript(?:ion)?)"\s*:\s*"([\s\S]*)"\s*\}$/.exec(raw)?.[1] ?? raw).replace(/^["“]|["”]$/g, '').trim();
  // Sessiz kayıtta model bazen kendi talimatını geri döndürüyor ("Türkçeyi kelimesi kelimesine yazıya dök"):
  // bu, kullanıcının sözü değil. Boş say (istemci "Sizi duyamadım" der).
  const f = text.toLocaleLowerCase('tr');
  if (/kelimesi kelimesine|yazıya dök|duyduğun metni|konuşma yok|ses yok|sesli asistana|komut ya da soru|türkçe karakter|marka adlarını|^\W*$/.test(f)) text = '';
  return { text, model: resp.model ?? STT_MODEL, ms: Date.now() - t0 };
}
