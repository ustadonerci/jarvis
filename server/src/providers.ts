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
import { spawn } from 'node:child_process';
import { geminiStream } from './gemini.js';
import { resetOpenAiTts } from './tts.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RouteLLMError, onRouteDown, resetRouteDown, registerFallbacks, routeLlmDown, routellmStream, type ChatMessage, type ContentPart, type StreamResult } from './routellm.js';

/** tur: 'sohbet' = beyin olabilir (OpenAI uyumlu ya da Claude); 'medya' = yalnız anahtar kaydı (görsel/video/ses) */
export interface Provider { id: string; ad: string; keyEnv: string; modelEnv: string; varsayilanModel: string; base?: string; anahtarUrl: string; anahtarSayfasi: string; not?: string; tur: 'sohbet' | 'medya' }

const host = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

export const PROVIDERS: Provider[] = [
  // Abacus.AI RouteLLM: sohbet routellm.ts'teki kendi yoluyla yürür; bu kayıt anahtar kartı, test ve "beyin yap" içindir
  { id: 'routellm', ad: 'Abacus.AI (RouteLLM)', keyEnv: 'ABACUS_API_KEY', modelEnv: 'CHAT_MODEL', varsayilanModel: 'route-llm', base: 'https://routellm.abacus.ai/v1', anahtarUrl: 'https://apps.abacus.ai/chatllm/', anahtarSayfasi: host('https://apps.abacus.ai/chatllm/'), tur: 'sohbet', not: 'Abacus.AI ChatLLM aboneliğiyle: apps.abacus.ai → sol menü RouteLLM API → API anahtarı oluştur. route-llm her soruyu uygun modele (GPT, Claude, Gemini…) yönlendirir; ses de buradan üretilebilir.' },
  { id: 'openai', ad: 'OpenAI (ChatGPT)', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_CHAT_MODEL', varsayilanModel: 'gpt-4.1', base: 'https://api.openai.com/v1', anahtarUrl: 'https://platform.openai.com/api-keys', anahtarSayfasi: host('https://platform.openai.com/api-keys'), tur: 'sohbet', not: 'Ses tanımada (Whisper) da kullanılır.' },
  { id: 'anthropic', ad: 'Anthropic (Claude)', keyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL', varsayilanModel: 'claude-opus-5-5', anahtarUrl: 'https://console.anthropic.com/settings/keys', anahtarSayfasi: host('https://console.anthropic.com/settings/keys'), tur: 'sohbet', not: 'Daha hızlı/ucuz: claude-sonnet-5-5, claude-haiku-5-5' },
  { id: 'nvidia', ad: 'NVIDIA (NIM · Llama, Nemotron, DeepSeek, Qwen)', keyEnv: 'NVIDIA_API_KEY', modelEnv: 'NVIDIA_MODEL', varsayilanModel: 'meta/llama-3.3-70b-instruct', base: 'https://integrate.api.nvidia.com/v1', anahtarUrl: 'https://build.nvidia.com', anahtarSayfasi: host('https://build.nvidia.com'), tur: 'sohbet', not: 'build.nvidia.com\'da ücretsiz deneme kredisi; anahtar "nvapi-" ile başlar. Model: meta/llama-3.3-70b-instruct (araç kullanır); diğerleri için Bağlantıyı test et.' },
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
// ---------------------------------------------------------------- Model kendi kendini onarma
// Sağlayıcı bir modeli kaldırınca (NVIDIA 410 "Gone", Groq "does not exist") ya da model adı yanlış yazılınca
// ("gbt5.5") o sağlayıcının model listesinden çalışan bir model seçilir ve hatırlanır. Kullanıcı Ayarlar'da model adını
// değiştirirse (yerine geçtiği ad değişir) bu seçim kendiliğinden bırakılır.
const MODEL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'model-secimi.json');
let overrides: Record<string, { model: string; yerine: string }> = (() => { try { return JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8')); } catch { return {}; } })();
const wanted = (p: Provider) => (p.modelEnv && env(p.modelEnv)) || p.varsayilanModel;
export const providerModel = (p: Provider) => { const o = overrides[p.id]; const w = wanted(p); return o && o.yerine === w ? o.model : w; };
/** Tercih sırası (listede bulunan ilki seçilir; araç çağırabilen sohbet modelleri) */
const MODEL_TERCIH: Record<string, string[]> = {
  // Varsayılan olarak "düşünce" metni yazan modeller (Nemotron v1.5, Qwen3) sonda: cevap JSON'unu bozabilir
  nvidia: ['meta/llama-4-maverick', 'meta/llama-3.1-405b-instruct', 'mistralai/mistral-large', 'meta/llama-3.1-70b-instruct', 'deepseek-ai/deepseek-v3', 'meta/llama-4-scout', 'nvidia/llama-3.3-nemotron-super-49b', 'qwen/qwen3', 'instruct'],
  groq: ['openai/gpt-oss-120b', 'llama-4-maverick', 'moonshotai/kimi-k2', 'qwen/qwen3-32b', 'llama-4-scout', 'llama-3.3-70b', 'gpt-oss-20b'],
  openai: ['gpt-5.5', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o'],
  openrouter: ['openai/gpt-5', 'anthropic/claude-sonnet', 'google/gemini-2.5-flash', 'openai/gpt-4.1'],
  deepseek: ['deepseek-chat', 'deepseek-v3'],
  mistral: ['mistral-large-latest', 'mistral-medium', 'mistral-small'],
  gemini: ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-pro'],
  cerebras: ['gpt-oss-120b', 'qwen-3', 'llama-4', 'llama-3.3-70b', 'llama3.1-8b'],
};
const UYGUNSUZ = /embed|whisper|tts|audio|image|vision-only|guard|rerank|moderation|dall-e|realtime|transcribe|search|instruct-v0\.1/i;
const badModels = new Map<string, Set<string>>();
/** Seçili model bu hesapta çalışmadı: işaretlenir, healModel başka birini seçer */
export function markBadModel(p: Provider) {
  const s = badModels.get(p.id) ?? new Set<string>();
  s.add(providerModel(p));
  badModels.set(p.id, s);
}
export async function healModel(p: Provider): Promise<string | null> {
  if (p.id === 'anthropic' || p.id === 'routellm') return null;
  const { modeller } = await testProvider(p).catch(() => ({ modeller: [] as string[] }));
  // Bu hesapta çalışmadığı görülen modeller (listede olsa da 404 veren) bir daha seçilmez
  const bad = new Set([...(badModels.get(p.id) ?? []), providerModel(p)]);
  const list = modeller.filter(m => !UYGUNSUZ.test(m) && !bad.has(m));
  if (!list.length) return null;
  const pick = (MODEL_TERCIH[p.id] ?? ['instruct', 'chat']).map(t => list.find(m => m.toLowerCase().includes(t.toLowerCase()))).find(Boolean) ?? list[0];
  if (!pick) return null;
  overrides[p.id] = { model: pick, yerine: wanted(p) };
  fs.mkdirSync(path.dirname(MODEL_FILE), { recursive: true });
  fs.writeFileSync(MODEL_FILE, JSON.stringify(overrides, null, 1));
  console.log(`[beyin] ${p.ad}: "${wanted(p)}" modeli yok/çalışmıyor → "${pick}" seçildi`);
  return pick;
}

// ---------------------------------------------------------------- RouteLLM yedekleri

/** Yedek sırası: seçili beyin, sonra ücretsiz katmanı olanlar, sonra diğerleri (yalnız anahtarı girilmiş OpenAI uyumlular) */
const YEDEK_SIRA = ['gemini', 'groq', 'nvidia', 'cerebras', 'openrouter', 'deepseek', 'openai', 'mistral', 'xai', 'together', 'deepinfra', 'huggingface', 'sambanova', 'fireworks', 'cohere', 'qwen'];
const GORSEL = new Set(['gemini', 'openai', 'openrouter', 'xai', 'mistral']);
export function readyFallbacks(): { id: string; ad: string; base: string; key: string; model: string; gorsel: boolean; headers?: Record<string, string> }[] {
  const ids = [brain, ...YEDEK_SIRA, ...PROVIDERS.map(p => p.id)];
  const seen = new Set<string>();
  const out = [];
  for (const id of ids) {
    if (seen.has(id) || id === 'routellm') continue;
    seen.add(id);
    const p = findProvider(id);
    if (!p || !p.base || !providerReady(p)) continue;
    const a = authFor(p);
    out.push({ id: p.id, ad: p.ad, base: p.base, key: a.key, model: providerModel(p), gorsel: GORSEL.has(p.id), headers: a.headers, ...(p.id === 'gemini' ? { native: (b: any, oc?: (d: string, f: string) => void) => geminiStream(a.headers['x-goog-api-key'], providerModel(p), b, oc, p.ad) } : {}) });
  }
  return out;
}
registerFallbacks(readyFallbacks);

/**
 * RouteLLM anahtarı/kredisi bozulunca: beyin RouteLLM ise anahtarı girilmiş ilk sağlayıcıya kalıcı olarak geçilir
 * (kullanıcı Ayarlar'dan geri alabilir). Hiç anahtar yoksa ücretsiz Gemini anahtar sayfası bilgisayarın tarayıcısında
 * bir kez açılır; anahtarı kullanıcı kendi Google hesabıyla alıp Ayarlar'a yapıştırır.
 */
let keyPageOpened = false;
onRouteDown(() => {
  // Beyin değiştirilmez (her turda sıradaki çalışan sağlayıcı kullanılır); hiç anahtar yoksa ücretsiz Gemini sayfası bir kez açılır
  if (!readyFallbacks().length && !keyPageOpened && process.platform === 'win32') {
    keyPageOpened = true;
    spawn('explorer.exe', ['https://aistudio.google.com/app/apikey'], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    console.log('[beyin] yedek anahtar yok: Gemini anahtar sayfası tarayıcıda açıldı');
  }
});

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

/**
 * Kimlik başlıkları: Google Gemini anahtarı x-goog-api-key başlığıyla gider (Google'ın önerdiği yol; yeni biçimli
 * anahtarlar "Bearer" ile gönderilince 401 verebiliyor). Diğerleri Authorization: Bearer.
 */
export function authFor(p: Provider): { key: string; headers: Record<string, string> } {
  const k = env(p.keyEnv).replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  if (p.id === 'gemini') return { key: '', headers: { 'x-goog-api-key': k } };
  return { key: k, headers: p.id === 'openrouter' ? { 'X-Title': 'Jarvis' } : {} };
}

async function openaiStream(p: Provider, body: any, onContent?: (d: string, full: string) => void): Promise<StreamResult> {
  const a = authFor(p);
  // Gemini: OpenAI uyumlu uç yeni anahtarlarla "Missing or invalid Authorization header" veriyor → Google'ın kendi API'si
  if (p.id === 'gemini') return geminiStream(a.headers['x-goog-api-key'], providerModel(p), body, onContent, p.ad);
  // NVIDIA NIM ve bazı açık model sağlayıcılarında varsayılan çıktı sınırı kısa (1024): sahne JSON'u yarıda kesiliyordu
  const extra = body.max_tokens ? {} : ['nvidia', 'groq', 'cerebras', 'together', 'deepinfra', 'huggingface', 'sambanova', 'fireworks', 'novita', 'hyperbolic'].includes(p.id) ? { max_tokens: 4096 } : {};
  return routellmStream({ ...body, ...extra, model: providerModel(p) }, onContent, { base: p.base!, key: a.key, extraHeaders: a.headers, ad: p.ad });
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
    if (e instanceof Anthropic.APIError) throw new RouteLLMError(e.status ?? 500, e.message, 'Anthropic (Claude)');
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
/** Hata veren sağlayıcı bir süre atlanır (her mesajda aynı bozuk anahtar denenmesin) */
const cooldown = new Map<string, { until: number; why: string }>();
const retriedAt = new Map<string, number>();
const resting = (id: string) => (cooldown.get(id)?.until ?? 0) > Date.now();
function rest(id: string, e: any) {
  const st = Number(e?.status ?? /\b(\d{3})\b/.exec(String(e?.message))?.[1] ?? 0);
  // Anahtar/kredi sorunu uzun, geçici hata (ağ, 5xx) kısa süre
  const ms = st === 401 || st === 402 || st === 403 ? 30 * 60_000 : st === 429 ? 10 * 60_000 : 2 * 60_000;
  cooldown.set(id, { until: Date.now() + ms, why: String(e?.message || e).slice(0, 140) });
}

/**
 * Beyin sırası: seçili beyin → anahtarı girilmiş diğer sağlayıcılar (ücretsiz katmanı olanlar önce) → RouteLLM.
 * Biri hata verirse (anahtar geçersiz, kredi bitti, kota, ağ) bu tur sıradakiyle devam edilir; hatalı olan bir süre atlanır.
 * Cevap akmaya başladıktan sonra kesilirse geçiş yapılmaz (sahneler okunmaya başladı).
 */
export async function brainStream(body: any, onContent?: (d: string, full: string) => void): Promise<StreamResult> {
  const order: { id: string; ad: string; run: (relay: (d: string, f: string) => void) => Promise<StreamResult> }[] = [];
  const seen = new Set<string>();
  for (const id of [brain, ...YEDEK_SIRA, 'anthropic', ...PROVIDERS.map(p => p.id)]) {
    if (seen.has(id) || id === 'routellm') continue;
    seen.add(id);
    const p = findProvider(id);
    if (!p || !providerReady(p) || (p.id !== 'anthropic' && !p.base)) continue;
    order.push({ id: p.id, ad: p.ad, run: relay => (p.id === 'anthropic' ? anthropicStream(p, body, relay) : openaiStream(p, body, relay)) });
  }
  // RouteLLM: beyin oysa başta, değilse sonda; anahtarı yoksa hiç
  const route = { id: 'routellm', ad: 'RouteLLM (Abacus.AI)', run: (relay: (d: string, f: string) => void) => routellmStream(body, relay, { base: process.env.ROUTELLM_BASE_URL || 'https://routellm.abacus.ai/v1', key: process.env.ABACUS_API_KEY || '' }).catch(e => { throw e instanceof RouteLLMError ? new RouteLLMError(e.status, e.body) : e; }) };
  if (process.env.ABACUS_API_KEY) { if (brain === 'routellm') order.unshift(route); else order.push(route); }
  // Önce dinlenmede olmayanlar, sonra dinlenmedekiler (kredi yüklenmiş / anahtar düzelmiş olabilir): hiçbiri atlanmaz
  // Dinlenmedeki bir sağlayıcı en çok 3 dakikada bir yeniden denenir (kredi yüklenmiş / anahtar düzelmiş olabilir);
  // her turda hepsini baştan denemek "düşünüyor"da uzun beklemeye yol açıyordu.
  const now = Date.now();
  const retry = order.filter(o => resting(o.id) && (retriedAt.get(o.id) ?? 0) < now - 3 * 60_000);
  const list = [...order.filter(o => !resting(o.id)), ...retry];
  if (!list.length && order.length) list.push(...order); // hepsi dinlenmede ve yakın zamanda denendiyse yine de dene
  const t0 = Date.now();
  if (!list.length) throw new Error('Hiçbir yapay zekâ anahtarı girilmemiş. Ayarlar → Yapay zeka sağlayıcıları\'ndan ücretsiz bir anahtar ekleyin (Google Gemini, Groq ya da NVIDIA).');
  const errs: string[] = [];
  for (const o of list) {
    // Toplam süre sınırı: cevap 90 sn içinde hiçbir sağlayıcıdan gelmediyse daha fazla bekletilmez
    if (errs.length && Date.now() - t0 > 90_000) { errs.push(`süre doldu (${list.length - errs.length} sağlayıcı denenmedi)`); break; }
    if (resting(o.id)) retriedAt.set(o.id, Date.now());
    let started = false;
    const relay = (d: string, full: string) => { started = true; onContent?.(d, full); };
    try {
      const r = await o.run(relay);
      if (cooldown.has(o.id)) cooldown.delete(o.id);
      if (o.id !== brain && errs.length) console.log(`[beyin] bu tur ${o.ad} cevap verdi`);
      return r;
    } catch (e: any) {
      if (started) throw e;
      // 400: istek bu sağlayıcıya uymadı (zorunlu araç seçimi vb.); aynı sağlayıcı 'auto' ile bir kez daha denenir, dinlenmeye alınmaz
      if (e?.status === 400 && body.tool_choice && body.tool_choice !== 'auto') {
        body.tool_choice = 'auto';
        try { return await o.run(relay); } catch { /* sıradakine */ }
      }
      // Model bulunamadı / kaldırıldı / adı yanlış: sağlayıcının listesinden çalışan model seçilip bir kez daha denenir
      const prov = findProvider(o.id);
      if (prov && (e?.status === 404 || e?.status === 410 || (e?.status === 400 && /model/i.test(String(e?.body ?? e?.message)))) && /model|not exist|not found|gone|decommission|deprecated/i.test(String(e?.body ?? e?.message))) {
        // Listede görünen ama bu hesapta açılmayan modeller olabiliyor (NVIDIA 404): en çok 3 model denenir
        for (let k = 0; k < 3; k++) {
          markBadModel(prov);
          const m = await healModel(prov).catch(() => null);
          if (!m) break;
          try { const r = await o.run(relay); cooldown.delete(o.id); return r; } catch (e2: any) {
            if (started) throw e2;
            e = e2;
            if (!(e?.status === 404 || e?.status === 410 || (e?.status === 400 && /model/i.test(String(e?.body ?? e?.message))))) break;
          }
        }
      }
      // 413: istek bu sağlayıcının ücretsiz sınırına göre çok büyük (Groq dakikalık sınır); bir saat atlanır
      if (e?.status === 413) cooldown.set(o.id, { until: Date.now() + 60 * 60_000, why: 'istek bu sağlayıcının ücretsiz sınırı için çok büyük (413)' });
      if (e?.status !== 400 && e?.status !== 413) rest(o.id, e);
      errs.push(`${o.ad}: ${String(e?.message || e).slice(0, 90)}`);
      console.warn(`[beyin] ${o.ad} hata verdi, sıradakine geçiliyor: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  throw new Error(`Yapay zekâ sağlayıcılarının hiçbiri cevap vermedi (${errs.length} denendi). ${errs.join(' · ')}. Ayarlar → Yapay zeka sağlayıcıları'nda anahtarları "Bağlantıyı test et" ile kontrol edin ya da ücretsiz bir anahtar ekleyin (Gemini, Groq, NVIDIA).`);
}

/**
 * Kayıtlı bütün sohbet anahtarlarını dener (model listesi ya da tek kelimelik istek). Çalışmayanlar 30 dk atlanır;
 * sonuç Jarvis'e ve Ayarlar'a döner. Açılışta bir kez kendiliğinden çalışır.
 */
export async function testAllProviders(): Promise<{ ad: string; calisiyor: boolean; neden?: string }[]> {
  const list = PROVIDERS.filter(p => p.tur === 'sohbet' && providerReady(p));
  const out = await Promise.all(list.map(async p => {
    try {
      await testProvider(p);
      cooldown.delete(p.id);
      if (p.id === 'openai') resetOpenAiTts();
      if (p.id === 'routellm') resetRouteDown();
      return { ad: p.ad, calisiyor: true };
    } catch (e: any) {
      const msg = String(e?.message || e);
      cooldown.set(p.id, { until: Date.now() + 30 * 60_000, why: msg.slice(0, 140) });
      return { ad: p.ad, calisiyor: false, neden: msg.slice(0, 120) };
    }
  }));
  console.log(`[beyin] anahtar testi: ${out.filter(x => x.calisiyor).length}/${out.length} çalışıyor${out.some(x => !x.calisiyor) ? ` · çalışmayan: ${out.filter(x => !x.calisiyor).map(x => x.ad).join(', ')}` : ''}`);
  return out;
}
setTimeout(() => { testAllProviders().catch(() => {}); }, 15_000).unref();

/** Sağlayıcıların son durumu (Ayarlar ve Jarvis için): hangisi dinlenmede, neden */
export const brainHealth = () => [...cooldown.entries()].filter(([, v]) => v.until > Date.now()).map(([id, v]) => ({ id, ad: findProvider(id)?.ad ?? id, neden: v.why, dk: Math.ceil((v.until - Date.now()) / 60_000) }));

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
  const fa = authFor(p);
  const auth: Record<string, string> = { ...(fa.key ? { Authorization: `Bearer ${fa.key}` } : {}), ...fa.headers };
  const r = await fetch(`${p.base}/models`, { headers: auth, signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 404 || r.status === 405) {
    // Model listesi ucu olmayanlar (ör. Perplexity): tek kelimelik deneme isteği
    const c = await fetch(`${p.base}/chat/completions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: providerModel(p), messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }), signal: AbortSignal.timeout(30_000) });
    const cj: any = await c.json().catch(() => ({}));
    if (!c.ok) throw new Error(`${p.ad} ${c.status}: ${String(cj?.error?.message ?? cj?.message ?? '').slice(0, 160)}`);
    return { modeller: [providerModel(p)] };
  }
  if (!r.ok) {
    const jj = Array.isArray(j) ? j[0] : j;
    const msg = String(jj?.error?.message ?? jj?.message ?? jj?.error ?? '').slice(0, 160) || JSON.stringify(j).slice(0, 160);
    const ipucu = p.id === 'gemini'
      ? (r.status === 400 ? ' — Google anahtarı tanımadı ("API key not valid"): anahtar eksik/yanlış kopyalanmış ya da AI Studio dışından (ör. Google Cloud OAuth) alınmış olabilir: aistudio.google.com/app/apikey sayfasından "Copy" ile yeniden kopyalayıp yapıştırın'
        : r.status === 403 ? ' — anahtar kısıtlı ya da Generative Language API kapalı: AI Studio\'dan yeni anahtar oluşturun (Google Cloud kısıtlaması olmadan)'
        : r.status === 401 ? ' — anahtar tanınmadı: başında/sonunda boşluk ya da tırnak olmadan yapıştırın, kaydettikten sonra Jarvis yeniden başlasın' : '')
      : '';
    throw new Error(`${p.ad} ${r.status}: ${msg}${ipucu}`);
  }
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

let persistBrain: (id: string) => void = () => {};
/** Kullanıcı hiç seçmediyse: NVIDIA anahtarı girilmişse beyin NVIDIA (kullanıcının isteği), yoksa RouteLLM */
export function initialBrain(saved?: string): string {
  if (saved) return saved;
  const nv = findProvider('nvidia');
  return nv && providerReady(nv) ? 'nvidia' : 'routellm';
}

export const BRAIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'beyin',
      description: "Jarvis'in sohbetini yürüten yapay zekayı (beyin) gösterir ya da değiştirir. islem: durum (hangi beyin, anahtarı girilmiş sağlayıcılar), test ('anahtarlarımı test et', 'hangi yapay zekalar çalışıyor': kayıtlı bütün anahtarları dener), sec (saglayici: nvidia, openai, anthropic, gemini, groq, deepseek… ya da routellm). 'Beyni NVIDIA yap', 'hangi yapay zekayı kullanıyorsun', 'Claude'a geç' isteklerinde.",
      parameters: { type: 'object', properties: { islem: { type: 'string', enum: ['durum', 'sec', 'test'] }, saglayici: { type: 'string' } }, required: ['islem'] },
    },
  },
] as const;
export const isBrainTool = (n: string) => n === 'beyin';
export async function runBrainTool(a: any): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  if (a.islem === 'test') {
    const r = await testAllProviders();
    return j({ sonuc: r, not: 'Çalışanları ve çalışmayanları nedeniyle kısaca söyle. Çalışmayanlar 30 dk atlanır; anahtarı yenilemesi için Ayarlar → Yapay zeka sağlayıcıları\'ndaki "anahtar al" linkini öner. Hiçbiri çalışmıyorsa ücretsiz Gemini anahtarı öner.' });
  }
  const ready = PROVIDERS.filter(p => p.tur === 'sohbet' && providerReady(p)).map(p => ({ id: p.id, ad: p.ad, model: providerModel(p) }));
  if (a.islem === 'sec') {
    const q = String(a.saglayici ?? '').toLowerCase().trim();
    const id = /^(routellm|varsay[ıi]lan|abacus)$/.test(q) ? 'routellm' : PROVIDERS.find(p => p.tur === 'sohbet' && (p.id === q || p.ad.toLowerCase().includes(q)))?.id;
    if (!id) return j({ hata: `"${a.saglayici}" bulunamadı`, anahtari_girilmis: ready });
    const p = findProvider(id);
    if (p && !providerReady(p)) return j({ hata: `${p.ad} anahtarı girilmemiş. Ayarlar → Yapay zeka sağlayıcıları → ${p.ad} kartındaki "anahtar al" linkinden alıp kaydetmesi gerekiyor: ${p.anahtarUrl}`, anahtari_girilmis: ready });
    setBrainProvider(id);
    persistBrain(id);
    console.log(`[beyin] sohbetle seçildi: ${id}`);
    return j({ ok: true, beyin: p ? `${p.ad} · ${providerModel(p)}` : 'RouteLLM', not: 'Bir sonraki cevaptan itibaren geçerli. Hata verirse o cevap anahtarı girilmiş sıradaki yapay zekayla tamamlanır.' });
  }
  const p = activeProvider();
  return j({ beyin: p ? `${p.ad} · ${providerModel(p)}` : 'RouteLLM', secili: brain, anahtari_girilmis: ready, sira: 'Seçili beyin hata verirse anahtarı girilmiş diğerleri sırayla kullanılır (Gemini, Groq, NVIDIA, …, en son RouteLLM).', dinlenen: brainHealth() });
}

/** Ayarlar → Yapay zeka sağlayıcıları. persist: beyin seçimi state'e yazılsın */
export function providersRouter(persist: (id: string) => void): Router {
  persistBrain = persist;
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
  r.post('/api/saglayicilar/test-hepsi', async (_req, res) => res.json({ sonuc: await testAllProviders() }));
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
