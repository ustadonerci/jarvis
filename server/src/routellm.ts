import 'dotenv/config';

export const BASE_URL = process.env.ROUTELLM_BASE_URL || 'https://routellm.abacus.ai/v1';
export const API_KEY = process.env.ABACUS_API_KEY || '';
export const CHAT_MODEL = process.env.CHAT_MODEL || 'route-llm';
export const MOCK = process.env.MOCK === '1' || !API_KEY;

export class RouteLLMError extends Error {
  constructor(public status: number, public body: string) {
    super((status === 401 || status === 403) && /invalid|unauthori[sz]ed|permission|password|forbidden/i.test(body)
      ? `Abacus.AI (RouteLLM) anahtarı geçersiz ya da süresi dolmuş (${status}). Ayarlar → Yapay zeka sağlayıcıları'ndan ücretsiz bir anahtar ekleyin (Google Gemini, Groq ya da NVIDIA); Jarvis kendiliğinden ona geçer. Ya da abacus.ai'den yeni anahtar alıp ABACUS_API_KEY alanına girin.`
      : status === 402 || status === 429 ? `Abacus.AI kredisi/kotası bitti (${status}). Ayarlar → Yapay zeka sağlayıcıları'ndan ücretsiz bir anahtar ekleyin (Gemini, Groq, NVIDIA); Jarvis kendiliğinden ona geçer.`
      : `RouteLLM ${status}: ${body.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------- Yedek sağlayıcı
// RouteLLM (Abacus.AI) anahtarı geçersiz, süresi dolmuş ya da kredisi bitmişse (401/402/403/429) sohbet istekleri
// kullanıcının anahtarını girdiği başka bir OpenAI uyumlu sağlayıcıya (Gemini, Groq, NVIDIA…) yönlendirilir.
// Sağlayıcı listesi providers.ts'te; döngüsel içe aktarma olmasın diye oradan kaydedilir.
export interface Fallback { id: string; ad: string; base: string; key: string; model: string; gorsel: boolean; headers?: Record<string, string> }
let fallbacks: () => Fallback[] = () => [];
export const registerFallbacks = (fn: () => Fallback[]) => { fallbacks = fn; };
let onDown: (why: string) => void = () => {};
/** RouteLLM bozulunca (anahtar/kredi) çağrılır: providers.ts beyni çalışan sağlayıcıya geçirir */
export const onRouteDown = (fn: (why: string) => void) => { onDown = fn; };
/** RouteLLM bozuk sayıldığı süre: bu sürede doğrudan yedeğe gidilir (her istekte boşuna denenmesin) */
let routeDownUntil = 0;
let routeDownWhy = '';
const isKeyProblem = (status: number) => status === 401 || status === 402 || status === 403 || status === 429;
export const routeLlmDown = () => (!API_KEY || Date.now() < routeDownUntil ? routeDownWhy || 'Abacus.AI anahtarı yok' : '');
function markDown(e: RouteLLMError) {
  routeDownUntil = Date.now() + 10 * 60_000;
  routeDownWhy = e.status === 429 ? 'Abacus.AI kotası/kredisi bitti' : 'Abacus.AI (RouteLLM) anahtarı geçersiz ya da süresi dolmuş';
  console.warn(`[beyin] ${routeDownWhy} (${e.status}); 10 dk yedek sağlayıcı kullanılacak`);
  try { onDown(routeDownWhy); } catch { /* yok say */ }
}
const hasImage = (body: any) => JSON.stringify(body?.messages ?? '').includes('"image_url"');
/** İsteğe uygun yedekler (görsel varsa görsel anlayanlar) */
export function pickFallbacks(body?: any): Fallback[] {
  const list = fallbacks();
  return hasImage(body) ? list.filter(f => f.gorsel) : list;
}
async function viaFallback<T>(path: string, body: any, cause: Error): Promise<T> {
  if (path !== '/chat/completions') throw cause;
  let last: Error = cause;
  for (const f of pickFallbacks(body)) {
    try {
      const { model: _m, ...rest } = body ?? {};
      const res = await fetch(`${f.base}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${f.key}`, 'Content-Type': 'application/json', ...f.headers },
        body: JSON.stringify({ ...rest, model: f.model }), signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      if (!res.ok) { last = new RouteLLMError(res.status, `${f.ad}: ${text}`); continue; }
      return JSON.parse(text) as T;
    } catch (e: any) { last = e; }
  }
  throw last;
}

export async function routellm<T = any>(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
  if (routeLlmDown() && path === '/chat/completions' && pickFallbacks(body).length) return viaFallback<T>(path, body, new Error(routeLlmDown()));
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const e = new RouteLLMError(res.status, text);
    if (isKeyProblem(res.status)) { markDown(e); if (pickFallbacks(body).length) return viaFallback<T>(path, body, e); }
    throw e;
  }
  return JSON.parse(text) as T;
}

export interface StreamResult {
  content: string;
  tool_calls: NonNullable<ChatMessage['tool_calls']>;
  model: string | null;
  /** İsteğin gönderilmesinden ilk içerik/araç parçasına kadar geçen süre */
  firstTokenMs: number | null;
  totalMs: number;
}

/**
 * Akışlı sohbet isteği (`stream: true`). İçerik geldikçe `onContent` çağrılır; araç çağrıları parçalardan birleştirilir.
 * Sahne JSON'u bu sayede tamamı bitmeden okunmaya başlar (ilk sahne hazır olunca TTS'i başlar).
 */
export async function routellmStream(
  body: object, onContent?: (delta: string, full: string) => void,
  /** Başka bir OpenAI uyumlu sağlayıcı (providers.ts); verilmezse RouteLLM */
  opts?: { base: string; key: string; extraHeaders?: Record<string, string> },
): Promise<StreamResult> {
  // RouteLLM bozuksa (anahtar/kredi) aynı istek sırayla yedek sağlayıcılara gider
  if (!opts && routeLlmDown()) {
    const fb = pickFallbacks(body);
    if (fb.length) return streamFallbacks(body, onContent, fb, new Error(routeLlmDown()));
  }
  const t0 = performance.now();
  // Takılan sağlayıcı sonsuza kadar bekletmesin: 35 sn içinde cevap başlığı, sonra 60 sn'den uzun sessizlik yok
  const ac = new AbortController();
  let idle = setTimeout(() => ac.abort(new Error('yapay zekâ 35 sn içinde cevap vermedi')), 35_000);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new Error('yapay zekâ 60 sn sessiz kaldı')), 60_000); };
  let res: Response;
  try {
    res = await fetch((opts?.base ?? BASE_URL) + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts?.key ?? API_KEY}`, 'Content-Type': 'application/json', ...opts?.extraHeaders },
      body: JSON.stringify({ ...body, stream: true }),
      signal: ac.signal,
    });
  } catch (e) { clearTimeout(idle); throw ac.signal.aborted ? ac.signal.reason : e; }
  bump();
  if (!res.ok || !res.body) {
    clearTimeout(idle);
    const e = new RouteLLMError(res.status, await res.text());
    if (!opts && isKeyProblem(res.status)) {
      markDown(e);
      const fb = pickFallbacks(body);
      if (fb.length) return streamFallbacks(body, onContent, fb, e);
    }
    throw e;
  }
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let model: string | null = null;
  let firstTokenMs: number | null = null;
  const calls: { id: string; name: string; args: string }[] = [];
  try {
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    bump();
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j: any;
      try { j = JSON.parse(data); } catch { continue; }
      model ??= j.model ?? null;
      const d = j.choices?.[0]?.delta ?? {};
      if ((d.content || d.tool_calls) && firstTokenMs === null) firstTokenMs = Math.round(performance.now() - t0);
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: '', name: '', args: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
      if (typeof d.content === 'string' && d.content) {
        content += d.content;
        onContent?.(d.content, content);
      }
    }
  }
  } catch (e) { throw ac.signal.aborted ? ac.signal.reason : e; } finally { clearTimeout(idle); }
  return {
    content,
    tool_calls: calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${i}`, type: 'function' as const, function: { name: c.name, arguments: c.args } })),
    model,
    firstTokenMs,
    totalMs: Math.round(performance.now() - t0),
  };
}

async function streamFallbacks(body: any, onContent: ((d: string, full: string) => void) | undefined, list: Fallback[], cause: Error): Promise<StreamResult> {
  let last = cause;
  for (const f of list) {
    try {
      const { model: _m, ...rest } = body ?? {};
      return await routellmStream({ ...rest, model: f.model }, onContent, { base: f.base, key: f.key, extraHeaders: f.headers });
    } catch (e: any) {
      last = e;
      console.warn(`[beyin] yedek ${f.ad} de olmadı: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  throw last;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ContentPart[];
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ChatResponse {
  model?: string;
  choices: {
    message: ChatMessage & {
      audio?: { data: string };
      audios?: { id: string; data: string; expires_at: number; transcript: string }[];
    };
    finish_reason: string;
  }[];
}

/** Kısa tek seferlik metin isteği (özet, sınıflandırma). Demo modunda ya da hata olursa boş döner. */
export async function askText(system: string, user: string, model = CHAT_MODEL): Promise<string> {
  if (MOCK && (process.env.MOCK === '1' || !fallbacks().length)) return '';
  try {
    const r = await routellm<ChatResponse>('/chat/completions', { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
    const c = r.choices?.[0]?.message?.content;
    return typeof c === 'string' ? c.trim() : '';
  } catch (e: any) {
    console.warn(`[beyin] kısa istek başarısız: ${String(e?.message || e).slice(0, 120)}`);
    return '';
  }
}
