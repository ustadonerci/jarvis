// Ayarlar → API anahtarları: server/.env dosyasını arayüzden düzenler. Anahtarlar tarayıcıya hiçbir zaman geri
// gönderilmez (yalnızca "kayıtlı · son 4 hane"). Kaydedince sunucu yeniden başlar, çünkü modüller .env'i açılışta okur.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response, NextFunction } from 'express';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(SRC, '..', '.env');
const ENV_EXAMPLE = path.join(SRC, '..', '.env.example');

export interface KeyField { name: string; label: string; hint: string; secret: boolean; /** Ayarlar → Borsalar kartında gösterilir (genel listede değil) */ borsa?: string; /** Ayarlar → Yapay zeka sağlayıcıları kartında gösterilir */ saglayici?: string }

/** Arayüzde her zaman görünen alanlar */
export const KEY_FIELDS: KeyField[] = [
  { name: 'ABACUS_API_KEY', label: 'Abacus RouteLLM (beyin)', hint: 'apps.abacus.ai → LLM APIs. Boşsa Jarvis demo modunda çalışır.', secret: true },
  { name: 'CHAT_MODEL', label: 'Sohbet modeli', hint: 'Varsayılan: route-llm (her soruyu uygun modele yönlendirir).', secret: false },
  { name: 'USER_NAME', label: 'Size nasıl hitap etsin', hint: 'Ör. Ramazan', secret: false },
  { name: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot anahtarı', hint: "Telegram'da @BotFather → /newbot → verilen anahtar. Mesajlarınızı bu bota yazdırın ya da botu gruplara ekleyin.", secret: true },
  { name: 'TELEGRAM_SAHIP_ID', label: 'Telegram kullanıcı kimliğiniz (uzaktan komut)', hint: 'Sayılardan oluşan Telegram ID\'niz (Telegram\'da @userinfobot\'a yazınca söyler). Girilirse bota yazdığınız her mesaj Jarvis\'e komut olur; eşleştirme kodu gerekmez.', secret: false },
  { name: 'TELEGRAM_KANAL', label: 'Telegram kanalı (paylaşım için)', hint: 'İsteğe bağlı. Ör. @kanaladi. Botu kanala yönetici olarak ekleyin; Jarvis onayınızla gönderi paylaşır.', secret: false },
  { name: 'PUBLIC_URL', label: 'Herkese açık adres (tünel)', hint: 'Twilio ve WhatsApp Business webhookları için. Ör. cloudflared ile aldığınız https://….trycloudflare.com (sonda / olmadan)', secret: false },
  { name: 'WHATSAPP_CLOUD_TOKEN', label: 'WhatsApp Business erişim anahtarı', hint: 'İsteğe bağlı, resmî API. developers.facebook.com → uygulamanız → WhatsApp → API Setup', secret: true },
  { name: 'WHATSAPP_PHONE_ID', label: 'WhatsApp Business telefon numarası kimliği', hint: 'API Setup sayfasındaki "Phone number ID"', secret: false },
  { name: 'WHATSAPP_VERIFY_TOKEN', label: 'WhatsApp webhook doğrulama anahtarı', hint: 'Kendiniz uydurun (uzun, rastgele); Meta webhook ayarına da aynısını yazın', secret: true },
  { name: 'WHATSAPP_APP_SECRET', label: 'Meta uygulama gizli anahtarı', hint: 'App settings → Basic → App secret. Gelen mesajların gerçekten Meta\'dan geldiğini doğrular', secret: true },
  { name: 'HOSTINGER_API_TOKEN', label: 'Hostinger API anahtarı', hint: 'İsteğe bağlı: Jarvis Hostinger\'dan satın alma/abonelik yapsın (her işlem onay kartıyla). hPanel → Hesap → API', secret: true },
  { name: 'BINANCE_API_KEY', label: 'API Key', hint: 'Binance → API Yönetimi: yalnız "Spot Trading" (ve okuma) açık, ÇEKİM izni KAPALI anahtar oluşturun (çekim izni açık anahtar robotta reddedilir)', secret: true, borsa: 'binance' },
  { name: 'BINANCE_API_SECRET', label: 'Secret Key', hint: 'Anahtarla birlikte bir kez gösterilen gizli anahtar', secret: true, borsa: 'binance' },
  { name: 'ROBOT_CANLI_MAX', label: 'Robot canlı işlem başı üst sınır (USDT)', hint: 'İsteğe bağlı, varsayılan 100: canlı robot tek işlemde bundan fazla harcamaz', secret: false, borsa: 'binance' },
  { name: 'BTCTURK_API_KEY', label: 'Public Key', hint: 'BtcTurk → Hesabım → API Erişimi: yalnız "Okuma" (ve gerekiyorsa "İşlem") yetkisi, ÇEKİM yetkisi KAPALI; IP adresi olarak bu bilgisayarın internet IP\'sini girin', secret: true, borsa: 'btcturk' },
  { name: 'BTCTURK_API_SECRET', label: 'Private Key', hint: 'API anahtarıyla birlikte verilen gizli anahtar', secret: true, borsa: 'btcturk' },
  { name: 'OKX_API_KEY', label: 'API Key', hint: 'OKX TR → Profil → API: yalnız "Okuma" (ve gerekiyorsa "İşlem") izni, ÇEKİM izni KAPALI', secret: true, borsa: 'okx' },
  { name: 'OKX_API_SECRET', label: 'Secret Key', hint: 'Anahtarla birlikte verilen gizli anahtar', secret: true, borsa: 'okx' },
  { name: 'OKX_API_PASSPHRASE', label: 'Passphrase (API şifresi)', hint: 'API anahtarını oluştururken kendi belirlediğiniz şifre', secret: true, borsa: 'okx' },
  { name: 'OKX_API_URL', label: 'API adresi', hint: 'Boş: https://www.okx.com. Bağlantı testi bölge hatası verirse OKX TR\'nin size verdiği API adresini yazın', secret: false, borsa: 'okx' },
  { name: 'BITLO_API_KEY', label: 'Public Key', hint: 'Bitlo API anahtarı (Bitlo müşteri hizmetlerinden ya da hesap ayarlarından); ÇEKİM yetkisi olmasın', secret: true, borsa: 'bitlo' },
  { name: 'BITLO_API_SECRET', label: 'Private Key', hint: 'Bitlo gizli anahtarı', secret: true, borsa: 'bitlo' },
  { name: 'BRAND24_API_KEY', label: 'Brand24 API anahtarı', hint: 'İsteğe bağlı: marka takibi. app.brand24.com → Hesap → Entegrasyonlar → API (yönetici hakkı ve API içeren plan gerekir)', secret: true },
  { name: 'HOSTINGER_LIMIT', label: 'Hostinger tek sipariş sınırı', hint: 'İsteğe bağlı: bu tutarın (sipariş para biriminde, ör. 50) üstündeki siparişleri Jarvis reddeder', secret: false },
  { name: 'TWILIO_ACCOUNT_SID', label: 'Twilio Account SID', hint: 'İsteğe bağlı: telefon aramaları. console.twilio.com ana sayfası', secret: false },
  { name: 'TWILIO_AUTH_TOKEN', label: 'Twilio Auth Token', hint: 'console.twilio.com ana sayfası', secret: true },
  { name: 'TWILIO_PHONE_NUMBER', label: 'Twilio telefon numarası', hint: 'Twilio\'dan aldığınız numara, ör. +15551234567', secret: false },
  { name: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search (internette arama)', hint: 'İsteğe bağlı. Boşsa anahtarsız DuckDuckGo kullanılır. api.search.brave.com', secret: true },
  { name: 'EMAIL_ADDRESS', label: 'E-posta adresi', hint: 'Gmail, Outlook, Yandex, iCloud… Jarvis gelen kutusunu okur, taslak yazar, onay kartıyla gönderir.', secret: false },
  { name: 'EMAIL_APP_PASSWORD', label: 'E-posta uygulama şifresi', hint: 'Gmail: Google Hesabı → Güvenlik → 2 adımlı doğrulama → Uygulama şifreleri (16 hane). Normal şifreniz çalışmaz.', secret: true },
  { name: 'GITHUB_TOKEN', label: 'GitHub anahtarı', hint: 'İsteğe bağlı. GitHub taramasında istek sınırını yükseltir. github.com → Settings → Developer settings → Personal access tokens', secret: true },
  { name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs (ses)', hint: 'İsteğe bağlı. elevenlabs.io → Profile → API Keys', secret: true },
  { name: 'AZURE_SPEECH_KEY', label: 'Azure Speech anahtarı (ses)', hint: 'İsteğe bağlı. Türkçe erkek (Ahmet) ve kadın (Emel) sesleri. portal.azure.com → Speech service → Keys', secret: true },
  { name: 'AZURE_SPEECH_REGION', label: 'Azure Speech bölgesi', hint: 'Ör. westeurope (Speech kaynağının "Location/Region" değeri)', secret: false },
  { name: 'DEEPGRAM_API_KEY', label: 'Deepgram (ses tanıma)', hint: 'İsteğe bağlı. Konuşmanızı daha hızlı yazıya döker. console.deepgram.com', secret: true },
  { name: 'OPENAI_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://platform.openai.com/api-keys · Ses tanımada (Whisper) da kullanılır.', secret: true, saglayici: 'openai' },
  { name: 'OPENAI_CHAT_MODEL', label: 'Model', hint: 'Boş: gpt-4.1', secret: false, saglayici: 'openai' },
  { name: 'ANTHROPIC_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://console.anthropic.com/settings/keys · Daha hızlı/ucuz: claude-sonnet-5-5, claude-haiku-5-5', secret: true, saglayici: 'anthropic' },
  { name: 'ANTHROPIC_MODEL', label: 'Model', hint: 'Boş: claude-opus-5-5', secret: false, saglayici: 'anthropic' },
  { name: 'GEMINI_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://aistudio.google.com/app/apikey · Ücretsiz kullanım kotası var.', secret: true, saglayici: 'gemini' },
  { name: 'GEMINI_MODEL', label: 'Model', hint: 'Boş: gemini-2.5-flash', secret: false, saglayici: 'gemini' },
  { name: 'XAI_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://console.x.ai', secret: true, saglayici: 'xai' },
  { name: 'XAI_MODEL', label: 'Model', hint: 'Boş: grok-4', secret: false, saglayici: 'xai' },
  { name: 'DEEPSEEK_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://platform.deepseek.com/api_keys · Çok ucuz.', secret: true, saglayici: 'deepseek' },
  { name: 'DEEPSEEK_MODEL', label: 'Model', hint: 'Boş: deepseek-chat', secret: false, saglayici: 'deepseek' },
  { name: 'MISTRAL_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://console.mistral.ai/api-keys', secret: true, saglayici: 'mistral' },
  { name: 'MISTRAL_MODEL', label: 'Model', hint: 'Boş: mistral-large-latest', secret: false, saglayici: 'mistral' },
  { name: 'GROQ_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://console.groq.com/keys · Ücretsiz katman var; en hızlı cevap.', secret: true, saglayici: 'groq' },
  { name: 'GROQ_MODEL', label: 'Model', hint: 'Boş: llama-3.3-70b-versatile', secret: false, saglayici: 'groq' },
  { name: 'OPENROUTER_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://openrouter.ai/keys · Tek anahtarla neredeyse bütün modeller (ör. anthropic/claude-sonnet-5-5, google/gemini-2.5-pro).', secret: true, saglayici: 'openrouter' },
  { name: 'OPENROUTER_MODEL', label: 'Model', hint: 'Boş: openai/gpt-4.1', secret: false, saglayici: 'openrouter' },
  { name: 'PERPLEXITY_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://www.perplexity.ai/settings/api · Cevaplarını internette arayarak verir.', secret: true, saglayici: 'perplexity' },
  { name: 'PERPLEXITY_MODEL', label: 'Model', hint: 'Boş: sonar', secret: false, saglayici: 'perplexity' },
  { name: 'COHERE_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://dashboard.cohere.com/api-keys · Deneme anahtarı ücretsiz.', secret: true, saglayici: 'cohere' },
  { name: 'COHERE_MODEL', label: 'Model', hint: 'Boş: command-a-03-2025', secret: false, saglayici: 'cohere' },
  { name: 'TOGETHER_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://api.together.ai/settings/api-keys · Açık kaynak modeller (Llama, Qwen, DeepSeek).', secret: true, saglayici: 'together' },
  { name: 'TOGETHER_MODEL', label: 'Model', hint: 'Boş: meta-llama/Llama-3.3-70B-Instruct-Turbo', secret: false, saglayici: 'together' },
  { name: 'FIREWORKS_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://fireworks.ai/account/api-keys', secret: true, saglayici: 'fireworks' },
  { name: 'FIREWORKS_MODEL', label: 'Model', hint: 'Boş: accounts/fireworks/models/llama-v3p3-70b-instruct', secret: false, saglayici: 'fireworks' },
  { name: 'CEREBRAS_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://cloud.cerebras.ai · Ücretsiz katman var.', secret: true, saglayici: 'cerebras' },
  { name: 'CEREBRAS_MODEL', label: 'Model', hint: 'Boş: llama-3.3-70b', secret: false, saglayici: 'cerebras' },
  { name: 'SAMBANOVA_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://cloud.sambanova.ai/apis', secret: true, saglayici: 'sambanova' },
  { name: 'SAMBANOVA_MODEL', label: 'Model', hint: 'Boş: Meta-Llama-3.3-70B-Instruct', secret: false, saglayici: 'sambanova' },
  { name: 'DEEPINFRA_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://deepinfra.com/dash/api_keys', secret: true, saglayici: 'deepinfra' },
  { name: 'DEEPINFRA_MODEL', label: 'Model', hint: 'Boş: meta-llama/Llama-3.3-70B-Instruct', secret: false, saglayici: 'deepinfra' },
  { name: 'HF_TOKEN', label: 'API anahtarı', hint: 'Anahtar: https://huggingface.co/settings/tokens · Token türü: Read ya da Inference.', secret: true, saglayici: 'huggingface' },
  { name: 'HF_MODEL', label: 'Model', hint: 'Boş: meta-llama/Llama-3.3-70B-Instruct', secret: false, saglayici: 'huggingface' },
  { name: 'NVIDIA_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://build.nvidia.com · Ücretsiz deneme kredisi.', secret: true, saglayici: 'nvidia' },
  { name: 'NVIDIA_MODEL', label: 'Model', hint: 'Boş: meta/llama-3.3-70b-instruct', secret: false, saglayici: 'nvidia' },
  { name: 'DASHSCOPE_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://modelstudio.console.alibabacloud.com', secret: true, saglayici: 'qwen' },
  { name: 'QWEN_MODEL', label: 'Model', hint: 'Boş: qwen-plus', secret: false, saglayici: 'qwen' },
  { name: 'MOONSHOT_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://platform.moonshot.ai/console/api-keys', secret: true, saglayici: 'moonshot' },
  { name: 'MOONSHOT_MODEL', label: 'Model', hint: 'Boş: moonshot-v1-8k', secret: false, saglayici: 'moonshot' },
  { name: 'ZAI_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://z.ai/manage-apikey/apikey-list', secret: true, saglayici: 'zhipu' },
  { name: 'ZAI_MODEL', label: 'Model', hint: 'Boş: glm-4.5', secret: false, saglayici: 'zhipu' },
  { name: 'MINIMAX_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://www.minimax.io/platform', secret: true, saglayici: 'minimax' },
  { name: 'MINIMAX_MODEL', label: 'Model', hint: 'Boş: MiniMax-Text-01', secret: false, saglayici: 'minimax' },
  { name: 'AI21_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://studio.ai21.com/account/api-key', secret: true, saglayici: 'ai21' },
  { name: 'AI21_MODEL', label: 'Model', hint: 'Boş: jamba-large', secret: false, saglayici: 'ai21' },
  { name: 'NOVITA_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://novita.ai/settings/key-management', secret: true, saglayici: 'novita' },
  { name: 'NOVITA_MODEL', label: 'Model', hint: 'Boş: meta-llama/llama-3.3-70b-instruct', secret: false, saglayici: 'novita' },
  { name: 'HYPERBOLIC_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://app.hyperbolic.xyz/settings', secret: true, saglayici: 'hyperbolic' },
  { name: 'HYPERBOLIC_MODEL', label: 'Model', hint: 'Boş: meta-llama/Llama-3.3-70B-Instruct', secret: false, saglayici: 'hyperbolic' },
  { name: 'STABILITY_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://platform.stability.ai/account/keys · Stable Diffusion ile görsel üretimi.', secret: true, saglayici: 'stability' },
  { name: 'REPLICATE_API_TOKEN', label: 'API anahtarı', hint: 'Anahtar: https://replicate.com/account/api-tokens · Flux, SDXL, video ve ses modelleri.', secret: true, saglayici: 'replicate' },
  { name: 'FAL_KEY', label: 'API anahtarı', hint: 'Anahtar: https://fal.ai/dashboard/keys · Flux, Kling, Veo gibi hızlı görsel/video modelleri.', secret: true, saglayici: 'fal' },
  { name: 'RUNWAYML_API_SECRET', label: 'API anahtarı', hint: 'Anahtar: https://dev.runwayml.com · Gen-4 video üretimi.', secret: true, saglayici: 'runway' },
  { name: 'LUMAAI_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://lumalabs.ai/dream-machine/api/keys · Dream Machine video üretimi.', secret: true, saglayici: 'luma' },
  { name: 'HEYGEN_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://app.heygen.com/settings?nav=API · Konuşan avatar videoları (MCP sunucusu da var).', secret: true, saglayici: 'heygen' },
  { name: 'ASSEMBLYAI_API_KEY', label: 'API anahtarı', hint: 'Anahtar: https://www.assemblyai.com/app/api-keys · Konuşmayı yazıya dökme.', secret: true, saglayici: 'assemblyai' },
  { name: 'YOUTUBE_API_KEY', label: 'YouTube Data API', hint: 'İsteğe bağlı. "… videosunu aç" için.', secret: true },
  { name: 'PEXELS_API_KEY', label: 'Pexels (stok fotoğraf)', hint: 'İsteğe bağlı, ücretsiz.', secret: true },
  { name: 'UNSPLASH_ACCESS_KEY', label: 'Unsplash (stok fotoğraf)', hint: 'İsteğe bağlı, ücretsiz.', secret: true },
  { name: 'HOME_ASSISTANT_URL', label: 'Home Assistant adresi', hint: 'İsteğe bağlı. Ör. http://homeassistant.local:8123', secret: false },
  { name: 'HOME_ASSISTANT_TOKEN', label: 'Home Assistant anahtarı', hint: 'HA → Profil → Güvenlik → Uzun ömürlü erişim anahtarı', secret: true },
];

/**
 * Eklentilerin (MCP sunucuları) istediği ek anahtarlar: yalnızca anahtar gibi görünen adlar kabul edilir, böylece
 * arayüzden PATH, NODE_OPTIONS, PORT, ACCESS_TOKEN gibi sunucunun davranışını değiştiren değişkenler yazılamaz.
 */
const CUSTOM_NAME = /^[A-Z][A-Z0-9_]{1,60}_(API_KEY|KEY|TOKEN|SECRET)$/;
const BLOCKED = new Set(['ACCESS_TOKEN']);
const isKnown = (n: string) => KEY_FIELDS.some(f => f.name === n);
export const isEditable = (n: string) => isKnown(n) || (CUSTOM_NAME.test(n) && !BLOCKED.has(n));

function readEnvLines(): string[] {
  const file = fs.existsSync(ENV_FILE) ? ENV_FILE : ENV_EXAMPLE;
  try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/); } catch { return []; }
}

function parse(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l);
    if (m) out.set(m[1], m[2].replace(/^(["'])(.*)\1$/, '$2'));
  }
  return out;
}

const mask = (v: string) => (v.length <= 8 ? '••••' : `••••${v.slice(-4)}`);

export function listKeys() {
  const env = parse(readEnvLines());
  const view = (f: KeyField) => {
    const v = env.get(f.name) ?? '';
    return { ...f, set: !!v, value: f.secret ? (v ? mask(v) : '') : v };
  };
  const custom = [...env.keys()].filter(n => !isKnown(n) && isEditable(n))
    .map(name => view({ name, label: name, hint: 'Eklenti anahtarı', secret: true }));
  return { fields: KEY_FIELDS.map(view), custom };
}

/** undefined: dokunma · '': sil · diğer: yaz. Değişen alan sayısını döndürür. */
export function saveKeys(values: Record<string, unknown>): number {
  const lines = readEnvLines();
  let changed = 0;
  for (const [name, raw] of Object.entries(values)) {
    if (!isEditable(name) || typeof raw !== 'string') continue;
    // Satır sonu ve tırnak .env'i bozar; anahtarlarda zaten bulunmaz
    const value = raw.replace(/[\r\n"]/g, '').trim();
    const i = lines.findIndex(l => new RegExp(`^\\s*#?\\s*${name}\\s*=`).test(l));
    const line = `${name}=${value}`;
    if (i >= 0) {
      if (lines[i] === line) continue;
      lines[i] = line;
    } else {
      if (!value) continue;
      lines.push(line);
    }
    process.env[name] = value;
    changed++;
  }
  if (changed) fs.writeFileSync(ENV_FILE, lines.join('\n').replace(/\n*$/, '\n'));
  return changed;
}

/** scripts/dev.mjs bu çıkış koduyla kapanan sunucuyu hemen yeniden başlatır */
export const RESTART_CODE = 75;

/**
 * Sunucuyu yeniden başlatır. `npm run dev` altında (scripts/dev.mjs JARVIS_DEV=1 verir) süreç 75 koduyla çıkar,
 * dev.mjs onu yeni .env değerleriyle yeniden açar. `npm start`ta kullanıcı elle yeniden başlatır.
 */
export function restartServer(): boolean {
  if (process.env.JARVIS_DEV !== '1') return false;
  setTimeout(() => process.exit(RESTART_CODE), 300);
  return true;
}

const LOOPBACK = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/;

/**
 * Anahtarları ve eklentileri (bilgisayarda program çalıştırabilir) yalnızca bu bilgisayar değiştirebilir.
 * ACCESS_TOKEN tanımlıysa /api zaten korunuyor; o durumda tokenı bilen her cihaz izinlidir.
 * Vite geliştirme sunucusu isteği localhost'tan iletir ve gerçek adresi X-Forwarded-For'un SONUNA ekler
 * (vite.config.ts → xfwd); baştaki değerler istemcinin uydurabileceği şeyler olduğu için yalnızca son değere bakılır.
 */
/**
 * İstek bu bilgisayardan mı geliyor? Cloudflare tüneli de localhost'tan bağlanır; ondan gelen her istekte
 * Cloudflare'in kendi eklediği (istemcinin silemeyeceği) cf-connecting-ip / cf-ray başlıkları bulunur.
 */
export function isLocalRequest(req: Request): boolean {
  // x-jarvis-uzak: telefon kapısı (scripts/telefon.mjs) tünelden gelen her isteğe ekler (Tailscale ya da Cloudflare)
  if (req.headers['x-jarvis-uzak'] || req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return false;
  const remote = req.socket.remoteAddress ?? '';
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean).pop();
  const ip = LOOPBACK.test(remote) && fwd ? fwd : remote;
  return LOOPBACK.test(ip);
}

export function adminOnly(req: Request, res: Response, next: NextFunction) {
  if (process.env.ACCESS_TOKEN || isLocalRequest(req)) return next();
  res.status(403).json({ error: 'Bu ayar yalnızca Jarvis\'in çalıştığı bilgisayardan değiştirilebilir (ya da .env\'de ACCESS_TOKEN tanımlayın).' });
}
