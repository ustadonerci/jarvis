// Yapay zeka sağlayıcıları: RouteLLM'e ek olarak kullanıcının kendi anahtarlarıyla OpenAI, Anthropic (Claude), Google
// Gemini, xAI (Grok), DeepSeek, Mistral, Groq ve OpenRouter. Ayarlar → Yapay zeka sağlayıcıları kartlarından anahtar
// ve model girilir; biri "beyin" seçilirse Jarvis'in ana sohbeti (ekran, Telegram, WhatsApp) o sağlayıcıyla çalışır.
// Diğer işler (ses tanıma, görsel, özetler) RouteLLM'de kalır. Seçili sağlayıcı hata verirse o tur RouteLLM'e döner.
// - Anthropic resmî SDK ile (Messages API): OpenAI biçimindeki mesaj/araçlar çevrilir; sunucu tarafı yedek model
//   (fallbacks: "default") açıktır, Claude bir isteği reddederse uygun modele yönlendirilir.
// - Diğerleri OpenAI uyumlu /chat/completions (akışlı, araçlı).
import Anthropic from '@anthropic-ai/sdk';
import express, { type Router } from 'express';
import { adminOnly } from './keys.js';
import { RouteLLMError, routellmStream, type ChatMessage, type ContentPart, type StreamResult } from './routellm.js';

export interface Provider { id: string; ad: string; keyEnv: string; modelEnv: string; varsayilanModel: string; base?: string; anahtarSayfasi: string }

export const PROVIDERS: Provider[] = [
  { id: 'openai', ad: 'OpenAI (ChatGPT)', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_CHAT_MODEL', varsayilanModel: 'gpt-4.1', base: 'https://api.openai.com/v1', anahtarSayfasi: 'platform.openai.com → API keys' },
  { id: 'anthropic', ad: 'Anthropic (Claude)', keyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL', varsayilanModel: 'claude-opus-5-5', anahtarSayfasi: 'platform.claude.com → API Keys' },
  { id: 'gemini', ad: 'Google Gemini', keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL', varsayilanModel: 'gemini-2.5-flash', base: 'https://generativelanguage.googleapis.com/v1beta/openai', anahtarSayfasi: 'aistudio.google.com → Get API key' },
  { id: 'xai', ad: 'xAI (Grok)', keyEnv: 'XAI_API_KEY', modelEnv: 'XAI_MODEL', varsayilanModel: 'grok-4', base: 'https://api.x.ai/v1', anahtarSayfasi: 'console.x.ai → API Keys' },
  { id: 'deepseek', ad: 'DeepSeek', keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL', varsayilanModel: 'deepseek-chat', base: 'https://api.deepseek.com/v1', anahtarSayfasi: 'platform.deepseek.com → API keys' },
  { id: 'mistral', ad: 'Mistral', keyEnv: 'MISTRAL_API_KEY', modelEnv: 'MISTRAL_MODEL', varsayilanModel: 'mistral-large-latest', base: 'https://api.mistral.ai/v1', anahtarSayfasi: 'console.mistral.ai → API Keys' },
  { id: 'groq', ad: 'Groq (çok hızlı)', keyEnv: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL', varsayilanModel: 'llama-3.3-70b-versatile', base: 'https://api.groq.com/openai/v1', anahtarSayfasi: 'console.groq.com → API Keys' },
  { id: 'openrouter', ad: 'OpenRouter (yüzlerce model)', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', varsayilanModel: 'openai/gpt-4.1', base: 'https://openrouter.ai/api/v1', anahtarSayfasi: 'openrouter.ai → Keys' },
];

const env = (k: string) => (process.env[k] || '').trim();
export const findProvider = (id: string) => PROVIDERS.find(p => p.id === id);
export const providerReady = (p: Provider) => !!env(p.keyEnv);
export const providerModel = (p: Provider) => env(p.modelEnv) || p.varsayilanModel;

// ---------------------------------------------------------------- Beyin seçimi

let brain = 'routellm';
export const setBrainProvider = (id: string) => { brain = id === 'routellm' || findProvider(id) ? id : 'routellm'; };
export const getBrainProvider = () => brain;
/** Seçili ve anahtarı girilmiş sağlayıcı; yoksa null (RouteLLM) */
export function activeProvider(): Provider | null {
  const p = brain === 'routellm' ? null : findProvider(brain);
  return p && providerReady(p) ? p : null;
}

// ---------------------------------------------------------------- OpenAI uyumlu akış

async function openaiStream(p: Provider, body: any, onContent?: (d: string, full: string) => void): Promise<StreamResult> {
  return routellmStream({ ...body, model: providerModel(p) }, onContent, { base: p.base!, key: env(p.keyEnv), extraHeaders: p.id === 'openrouter' ? { 'X-Title': 'Jarvis' } : {} });
}

// ---------------------------------------------------------------- Anthropic (resmî SDK)

let anthropicClient: Anthropic | null = null;
let anthropicKey = '';
function claude(): Anthropic {
  const key = env('ANTHROPIC_API_KEY');
  if (!anthropicClient || anthropicKey !== key) { anthropicClient = new Anthropic({ apiKey: key }); anthropicKey = key; }
  return anthropicClient;
}

/** OpenAI biçimindeki içerik → Claude içerik blokları (metin ve data URL görseller) */
function toBlocks(c: ChatMessage['content']): Anthropic.Beta.BetaContentBlockParam[] {
  if (c == null) return [];
  if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : [];
  const out: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const part of c as ContentPart[]) {
    if (part.type === 'text' && part.text) out.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') {
      const m = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(part.image_url.url);
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1] as 'image/jpeg', data: m[2] } });
    }
  }
  return out;
}

/** OpenAI sohbet geçmişi → Claude system + messages (araç sonuçları tek kullanıcı mesajında toplanır) */
export function toClaude(messages: ChatMessage[]): { system: string; messages: Anthropic.Beta.BetaMessageParam[] } {
  const system = messages.filter(m => m.role === 'system').map(m => (typeof m.content === 'string' ? m.content : '')).join('\n\n');
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  const push = (role: 'user' | 'assistant', blocks: Anthropic.Beta.BetaContentBlockParam[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) (last.content as Anthropic.Beta.BetaContentBlockParam[]).push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }]);
    } else if (m.role === 'assistant') {
      const blocks = toBlocks(m.content);
      for (const tc of m.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* bozuk argüman: boş */ }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      push('assistant', blocks);
    } else push('user', toBlocks(m.content));
  }
  return { system, messages: out };
}

async function anthropicStream(p: Provider, body: any, onContent?: (d: string, full: string) => void): Promise<StreamResult> {
  const t0 = performance.now();
  const { system, messages } = toClaude(body.messages ?? []);
  const tools: Anthropic.Beta.BetaToolUnion[] = (body.tools ?? []).map((t: any) => ({
    name: t.function.name, description: String(t.function.description ?? '').slice(0, 4000),
    input_schema: { type: 'object', properties: {}, ...(t.function.parameters ?? {}) },
  }));
  // Zorunlu araç (tool_choice "tool"/"any") güncel Claude modellerinde 400 verir: "auto" ve talimatla yönlendirilir
  const forced = body.tool_choice?.function?.name as string | undefined;
  const sys = forced ? `${system}\n\n[Bu turda önce \`${forced}\` aracını çağır.]` : system;
  let content = '';
  let firstTokenMs: number | null = null;
  const stream = claude().beta.messages.stream({
    model: providerModel(p),
    max_tokens: 16000,
    system: sys,
    messages,
    ...(tools.length ? { tools, tool_choice: { type: 'auto' as const } } : {}),
    // Sesli asistan: hızlı cevap için düşük efor (sohbet için önerilen)
    output_config: { effort: 'low' },
    // Claude bir isteği reddederse sunucu uygun modelle yeniden dener
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  stream.on('text', delta => {
    if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - t0);
    content += delta;
    onContent?.(delta, content);
  });
  let msg: Anthropic.Beta.BetaMessage;
  try {
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw new RouteLLMError(e.status ?? 500, `Anthropic: ${e.message}`);
    throw e;
  }
  if (msg.stop_reason === 'refusal' && !content) content = '{"sahneler":[{"ses":"Bu isteğe yardımcı olamıyorum efendim.","gorsel":{"tip":"yok"}}],"detay":""}';
  const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
  // Araç girdisi max_tokens'ta kesildiyse çalıştırılmaz
  const calls = msg.stop_reason === 'max_tokens' ? [] : toolUses;
  if (firstTokenMs === null && calls.length) firstTokenMs = Math.round(performance.now() - t0);
  return {
    content,
    tool_calls: calls.map(b => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })),
    model: msg.model,
    firstTokenMs,
    totalMs: Math.round(performance.now() - t0),
  };
}

/** Ana sohbet akışı: seçili sağlayıcı, yoksa (ya da hata verirse) RouteLLM */
export async function brainStream(body: any, onContent?: (d: string, full: string) => void): Promise<StreamResult> {
  const p = activeProvider();
  if (!p) return routellmStream(body, onContent);
  let started = false;
  const relay = (d: string, full: string) => { started = true; onContent?.(d, full); };
  try {
    return p.id === 'anthropic' ? await anthropicStream(p, body, relay) : await openaiStream(p, body, relay);
  } catch (e: any) {
    // Cevap yarıda kesildiyse baştan RouteLLM'e geçilemez (sahneler zaten okunmaya başladı)
    if (started) throw e;
    console.warn(`[beyin] ${p.ad} hata verdi, bu tur RouteLLM'e dönülüyor: ${String(e?.message || e).slice(0, 200)}`);
    return routellmStream(body, onContent);
  }
}

/** Bağlantı testi: anahtar çalışıyor mu, hangi modeller var */
export async function testProvider(p: Provider): Promise<{ modeller: string[] }> {
  if (!providerReady(p)) throw new Error(`${p.ad} anahtarı girilmemiş`);
  if (p.id === 'anthropic') {
    const ids: string[] = [];
    try {
      for await (const m of claude().models.list()) { ids.push(m.id); if (ids.length >= 40) break; }
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic anahtarı geçersiz');
      if (e instanceof Anthropic.APIError) throw new Error(`Anthropic ${e.status}: ${e.message.slice(0, 160)}`);
      throw e;
    }
    return { modeller: ids };
  }
  const r = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${env(p.keyEnv)}` }, signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p.ad} ${r.status}: ${String(j?.error?.message ?? j?.message ?? '').slice(0, 160)}`);
  const list: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  return { modeller: list.map(m => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean).slice(0, 80) };
}

export function providerStatus() {
  const aktif = activeProvider();
  return {
    beyin: brain,
    aktif: aktif?.id ?? 'routellm',
    saglayicilar: PROVIDERS.map(p => ({ id: p.id, ad: p.ad, hazir: providerReady(p), model: providerModel(p), anahtarSayfasi: p.anahtarSayfasi })),
  };
}

/** Ayarlar → Yapay zeka sağlayıcıları. persist: beyin seçimi state'e yazılsın */
export function providersRouter(persist: (id: string) => void): Router {
  const r = express.Router();
  r.use('/api/saglayicilar', adminOnly);
  r.get('/api/saglayicilar', (_req, res) => res.json(providerStatus()));
  r.post('/api/saglayicilar/beyin', (req, res) => {
    const id = String(req.body?.id ?? '');
    const p = findProvider(id);
    if (id !== 'routellm' && !p) return res.status(404).json({ error: 'Sağlayıcı bulunamadı' });
    if (p && !providerReady(p)) return res.status(400).json({ error: `${p.ad} anahtarı girilmemiş` });
    setBrainProvider(id);
    persist(id);
    console.log(`[beyin] sağlayıcı: ${p ? `${p.ad} · ${providerModel(p)}` : 'RouteLLM'}`);
    res.json(providerStatus());
  });
  r.post('/api/saglayicilar/:id/test', async (req, res) => {
    const p = findProvider(req.params.id);
    if (!p) return res.status(404).json({ error: 'Sağlayıcı bulunamadı' });
    try {
      const t = await testProvider(p);
      console.log(`[beyin] ${p.ad} bağlantı testi: ${t.modeller.length} model`);
      res.json({ ok: true, ...t });
    } catch (e: any) {
      res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
    }
  });
  return r;
}
