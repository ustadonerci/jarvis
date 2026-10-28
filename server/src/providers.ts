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

/** tur: 'sohbet' = beyin olabilir (OpenAI uyumlu ya da Claude); 'medya' = yalnız anahtar kaydı (görsel/video/ses) */
export interface Provider { id: string; ad: string; keyEnv: string; modelEnv: string; varsayilanModel: string; base?: string; anahtarUrl: string; anahtarSayfasi: string; not?: string; tur: 'sohbet' | 'medya' }

const host = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

export const PROVIDERS: Provider[] = [
  { id: 'openai', ad: 'OpenAI (ChatGPT)', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_CHAT_MODEL', varsayilanModel: 'gpt-4.1', base: 'https://api.openai.com/v1', anahtarUrl: 'https://platform.openai.com/api-keys', anahtarSayfasi: host('https://platform.openai.com/api-keys'), tur: 'sohbet', not: 'Ses tanımada (Whisper) da kullanılır.' },
  { id: 'anthropic', ad: 'Anthropic (Claude)', keyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL', varsayilanModel: 'claude-opus-5-5', anahtarUrl: 'https://console.anthropic.com/settings/keys', anahtarSayfasi: host('https://console.anthropic.com/settings/keys'), tur: 'sohbet', not: 'Daha hızlı/ucuz: claude-sonnet-5-5, claude-haiku-5-5' },
  { id: 'gemini', ad: 'Google Gemini', keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL', varsayilanModel: 'gemini-2.5-flash', base: 'https://generativelanguage.googleapis.com/v1beta/openai', anahtarUrl: 'https://aistudio.google.com/app/apikey', anahtarSayfasi: host('https://aistudio.google.com/app/apikey'), tur: 'sohbet', not: 'Ücretsiz kullanım kotası var.' },
  { id: 'xai', ad: 'xAI (Grok)', keyEnv: 'XAI_API_KEY', modelEnv: 'XAI_MODEL', varsayilanModel: 'grok-4', base: 'https://api.x.ai/v1', anahtarUrl: 'https://console.x.ai', anahtarSayfasi: host('https://console.x.ai'), tur: 'sohbet' },
  { id: 'deepseek', ad: 'DeepSeek', keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL', varsayilanModel: 'deepseek-chat', base: 'https://api.deepseek.com/v1', anahtarUrl: 'https://platform.deepseek.com/api_keys', anahtarSayfasi: host('https://platform.deepseek.com/api_keys'), tur: 'sohbet', not: 'Çok ucuz.' },
  { id: 'mistral', ad: 'Mistral', keyEnv: 'MISTRAL_API_KEY', modelEnv: 'MISTRAL_MODEL', varsayilanModel: 'mistral-large-latest', base: 'https://api.mistral.ai/v1', anahtarUrl: 'https://console.mistral.ai/api-keys', anahtarSayfasi: host('https://console.mistral.ai/api-keys'), tur: 'sohbet' },
  { id: 'groq', ad: 'Groq (çok hızlı)', keyEnv: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL', varsayilanModel: 'llama-3.3-70b-versatile', base: 'https://api.groq.com/openai/v1', anahtarUrl: 'https://console.groq.com/keys', anahtarSayfasi: host('https://console.groq.com/keys'), tur: 'sohbet', not: 'Ücretsiz katman var; en hızlı cevap.' },
  { id: 'openrouter', ad: 'OpenRouter (yüzlerce model)', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', varsayilanModel: 'openai/gpt-4.1', base: 'https://openrouter.ai/api/v1', anahtarUrl: 'https://openrouter.ai/keys', anahtarSayfasi: host('https://openrouter.ai/keys'), tur: 'sohbet', not: 'Tek anahtarla neredeyse bütün modeller (ör. anthropic/claude-sonnet-5-5, google/gemini-2.5-pro).' },
  { id: 'perplexity', ad: 'Perplexity (internette arayan)', keyEnv: 'PERPLEXITY_API_KEY', modelEnv: 'PERPLEXITY_MODEL', varsayilanModel: 'sonar', base: 'https://api.perplexity.ai', anahtarUrl: 'https://www.perplexity.ai/settings/api', anahtarSayfasi: host('https://www.perplexity.ai/settings/api'), tur: 'sohbet', not: 'Cevaplarını internette arayarak verir.' },
  { id: 'cohere', ad: 'Cohere (Command)', keyEnv: 'COHERE_API_KEY', modelEnv: 'COHERE_MODEL', varsayilanModel: 'command-a-03-2025', base: 'https://api.cohere.ai/compatibility/v1', anahtarUrl: 'https://dashboard.cohere.com/api-keys', anahtarSayfasi: host('https://dashboard.cohere.com/api-keys'), tur: 'sohbet', not: 'Deneme anahtarı ücretsiz.' },
  { id: 'together', ad: 'Together AI', keyEnv: 'TOGETHER_API_KEY', modelEnv: 'TOGETHER_MODEL', varsayilanModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', base: 'https://api.together.xyz/v1', anahtarUrl: 'https://api.together.ai/settings/api-keys', anahtarSayfasi: host('https://api.together.ai/settings/api-keys'), tur: 'sohbet', not: 'Açık kaynak modeller (Llama, Qwen, DeepSeek).' },
  { id: 'fireworks', ad: 'Fireworks AI', keyEnv: 'FIREWORKS_API_KEY', modelEnv: 'FIREWORKS_MODEL', varsayilanModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', base: 'https://api.fireworks.ai/inference/v1', anahtarUrl: 'https://fireworks.ai/account/api-keys', anahtarSayfasi: host('https://fireworks.ai/account/api-keys'), tur: 'sohbet' },
  { id: 'cerebras', ad: 'Cerebras (çok hızlı)', keyEnv: 'CEREBRAS_API_KEY', modelEnv: 'CEREBRAS_MODEL', varsayilanModel: 'llama-3.3-70b', base: 'https://api.cerebras.ai/v1', anahtarUrl: 'https://cloud.cerebras.ai', anahtarSayfasi: host('https://cloud.cerebras.ai'), tur: 'sohbet', not: 'Ücretsiz katman var.' },
  { id: 'sambanova', ad: 'SambaNova', keyEnv: 'SAMBANOVA_API_KEY', modelEnv: 'SAMBANOVA_MODEL', varsayilanModel: 'Meta-Llama-3.3-70B-Instruct', base: 'https://api.sambanova.ai/v1', anahtarUrl: 'https://cloud.sambanova.ai/apis', anahtarSayfasi: host('https://cloud.sambanova.ai/apis'), tur: 'sohbet' },
  { id: 'deepinfra', ad: 'DeepInfra', keyEnv: 'DEEPINFRA_API_KEY', modelEnv: 'DEEPINFRA_MODEL', varsayilanModel: 'meta-llama/Llama-3.3-70B-Instruct', base: 'https://api.deepinfra.com/v1/openai', anahtarUrl: 'https://deepinfra.com/dash/api_keys', anahtarSayfasi: host('https://deepinfra.com/dash/api_keys'), tur: 'sohbet' },
  { id: 'huggingface', ad: 'Hugging Face', keyEnv: 'HF_TOKEN', modelEnv: 'HF_MODEL', varsayilanModel: 'meta-llama/Llama-3.3-70B-Instruct', base: 'https://router.huggingface.co/v1', anahtarUrl: 'https://huggingface.co/settings/tokens', anahtarSayfasi: host('https://huggingface.co/settings/tokens'), tur: 'sohbet', not: 'Token türü: Read ya da Inference.' },
  { id: 'nvidia', ad: 'NVIDIA NIM', keyEnv: 'NVIDIA_API_KEY', modelEnv: 'NVIDIA_MODEL', varsayilanModel: 'meta/llama-3.3-70b-instruct', base: 'https://integrate.api.nvidia.com/v1', anahtarUrl: 'https://build.nvidia.com', anahtarSayfasi: host('https://build.nvidia.com'), tur: 'sohbet', not: 'Ücretsiz deneme kredisi.' },
  { id: 'qwen', ad: 'Alibaba Qwen (Model Studio)', keyEnv: 'DASHSCOPE_API_KEY', modelEnv: 'QWEN_MODEL', varsayilanModel: 'qwen-plus', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', anahtarUrl: 'https://modelstudio.console.alibabacloud.com', anahtarSayfasi: host('https://modelstudio.console.alibabacloud.com'), tur: 'sohbet' },
  { id: 'moonshot', ad: 'Moonshot (Kimi)', keyEnv: 'MOONSHOT_API_KEY', modelEnv: 'MOONSHOT_MODEL', varsayilanModel: 'moonshot-v1-8k', base: 'https://api.moonshot.ai/v1', anahtarUrl: 'https://platform.moonshot.ai/console/api-keys', anahtarSayfasi: host('https://platform.moonshot.ai/console/api-keys'), tur: 'sohbet' },
  { id: 'zhipu', ad: 'Zhipu (GLM)', keyEnv: 'ZAI_API_KEY', modelEnv: 'ZAI_MODEL', varsayilanModel: 'glm-4.5', base: 'https://api.z.ai/api/paas/v4', anahtarUrl: 'https://z.ai/manage-apikey/apikey-list', anahtarSayfasi: host('https://z.ai/manage-apikey/apikey-list'), tur: 'sohbet' },
  { id: 'minimax', ad: 'MiniMax', keyEnv: 'MINIMAX_API_KEY', modelEnv: 'MINIMAX_MODEL', varsayilanModel: 'MiniMax-Text-01', base: 'https://api.minimax.io/v1', anahtarUrl: 'https://www.minimax.io/platform', anahtarSayfasi: host('https://www.minimax.io/platform'), tur: 'sohbet' },
  { id: 'ai21', ad: 'AI21 (Jamba)', keyEnv: 'AI21_API_KEY', modelEnv: 'AI21_MODEL', varsayilanModel: 'jamba-large', base: 'https://api.ai21.com/studio/v1', anahtarUrl: 'https://studio.ai21.com/account/api-key', anahtarSayfasi: host('https://studio.ai21.com/account/api-key'), tur: 'sohbet' },
  { id: 'novita', ad: 'Novita AI', keyEnv: 'NOVITA_API_KEY', modelEnv: 'NOVITA_MODEL', varsayilanModel: 'meta-llama/llama-3.3-70b-instruct', base: 'https://api.novita.ai/v3/openai', anahtarUrl: 'https://novita.ai/settings/key-management', anahtarSayfasi: host('https://novita.ai/settings/key-management'), tur: 'sohbet' },
  { id: 'hyperbolic', ad: 'Hyperbolic', keyEnv: 'HYPERBOLIC_API_KEY', modelEnv: 'HYPERBOLIC_MODEL', varsayilanModel: 'meta-llama/Llama-3.3-70B-Instruct', base: 'https://api.hyperbolic.xyz/v1', anahtarUrl: 'https://app.hyperbolic.xyz/settings', anahtarSayfasi: host('https://app.hyperbolic.xyz/settings'), tur: 'sohbet' },
  { id: 'stability', ad: 'Stability AI (görsel)', keyEnv: 'STABILITY_API_KEY', modelEnv: '', varsayilanModel: '', anahtarUrl: 'https://platform.stability.ai/account/keys', anahtarSayfasi: host('https://platform.stability.ai/account/keys'), tur: 'medya', not: 'Stable Diffusion ile görsel üretimi.' },
  { id: 'replicate', ad: 'Replicate (görsel/video/ses modelleri)', keyEnv: 'REPLICATE_API_TOKEN', modelEnv: '', varsayilanModel: '', anahtarUrl: 'https://replicate.com/account/api-tokens', anahtarSayfasi: host('https://replicate.com/account/api-tokens'), tur: 'medya', not: 'Flux, SDXL, video ve ses modelleri.' },
  { id: 'fal', ad: 'fal.ai (görsel/video)', keyEnv: 'FAL_KEY', modelEnv: '', varsayilanModel: '', anahtarUrl: 'https://fal.ai/dashboard/keys', anahtarSayfasi: host('https://fal.ai/dashboard/keys'), tur: 'medya', not: 'Flux, Kling, Veo gibi hızlı görsel/video modelleri.' },
  { id: 'runway', ad: 'Runway (video)', keyEnv: 'RUNWAYML_API_SECRET', modelEnv: '', varsayilanModel: '', anahtarUrl: 'https://dev.runwayml.com', anahtarSayfasi: host('https://dev.runwayml.com'), tur: 'medya', not: 'Gen-4 video üretimi.' },
  { id: 'luma', ad: 'Luma AI (video)', keyEnv: 'LUMAAI_API_KEY', modelEnv: '', varsayilanModel: '', anahtarUrl: 'https://lumalabs.ai/dream-machine/api/keys', anahtarSayfasi: host('https://lumalabs.ai/dream-machine/api/keys'), tur: 'medya', not: 'Dream Machine video üretimi.' },
  { id: 'heygen', ad: 'HeyGen (avatar video)', keyEnv: 'HEYGEN_API_KEY', modelEnv: '', varsayilanModel: '', anahtarUrl: 'https://app.heygen.com/settings?nav=API', anahtarSayfasi: host('https://app.heygen.com/settings?nav=API'), tur: 'medya', not: 'Konuşan avatar videoları (MCP sunucusu da var).' },
  { id: 'assemblyai', ad: 'AssemblyAI (ses tanıma)', keyEnv: 'ASSEMBLYAI_API_KEY', modelEnv: '', varsayilanModel: '', anahtarUrl: 'https://www.assemblyai.com/app/api-keys', anahtarSayfasi: host('https://www.assemblyai.com/app/api-keys'), tur: 'medya', not: 'Konuşmayı yazıya dökme.' },
  { id: 'elevenlabs', ad: 'ElevenLabs (ses)', keyEnv: 'ELEVENLABS_API_KEY', modelEnv: '', varsayilanModel: '', anahtarUrl: 'https://elevenlabs.io/app/settings/api-keys', anahtarSayfasi: host('https://elevenlabs.io/app/settings/api-keys'), tur: 'medya', not: 'Jarvis\'in sesi; API anahtarları listesindeki ElevenLabs alanıyla aynı.' },
  { id: 'deepgram', ad: 'Deepgram (ses tanıma)', keyEnv: 'DEEPGRAM_API_KEY', modelEnv: '', varsayilanModel: '', anahtarUrl: 'https://console.deepgram.com', anahtarSayfasi: host('https://console.deepgram.com'), tur: 'medya', not: 'Jarvis\'in ses tanıması; API anahtarları listesindeki Deepgram alanıyla aynı.' },
];

const env = (k: string) => (process.env[k] || '').trim();
/** Beyin olabilen (sohbet) sağlayıcı */
export const findProvider = (id: string) => PROVIDERS.find(p => p.id === id && p.tur === 'sohbet');
export const anyProvider = (id: string) => PROVIDERS.find(p => p.id === id);
export const providerReady = (p: Provider) => !!env(p.keyEnv);
export const providerModel = (p: Provider) => (p.modelEnv && env(p.modelEnv)) || p.varsayilanModel;

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
  if (p.tur === 'medya') return { modeller: [] };
  const auth = { Authorization: `Bearer ${env(p.keyEnv)}` };
  const r = await fetch(`${p.base}/models`, { headers: auth, signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 404 || r.status === 405) {
    // Model listesi ucu olmayanlar (ör. Perplexity): tek kelimelik deneme isteği
    const c = await fetch(`${p.base}/chat/completions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: providerModel(p), messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }), signal: AbortSignal.timeout(30_000) });
    const cj: any = await c.json().catch(() => ({}));
    if (!c.ok) throw new Error(`${p.ad} ${c.status}: ${String(cj?.error?.message ?? cj?.message ?? '').slice(0, 160)}`);
    return { modeller: [providerModel(p)] };
  }
  if (!r.ok) throw new Error(`${p.ad} ${r.status}: ${String(j?.error?.message ?? j?.message ?? '').slice(0, 160)}`);
  const list: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  return { modeller: list.map(m => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean).slice(0, 80) };
}

export function providerStatus() {
  const aktif = activeProvider();
  return {
    beyin: brain,
    aktif: aktif?.id ?? 'routellm',
    saglayicilar: PROVIDERS.map(p => ({ id: p.id, ad: p.ad, tur: p.tur, hazir: providerReady(p), model: providerModel(p), anahtarSayfasi: p.anahtarSayfasi, anahtarUrl: p.anahtarUrl, not: p.not })),
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
