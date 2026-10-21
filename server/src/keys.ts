// Ayarlar → API anahtarları: server/.env dosyasını arayüzden düzenler. Anahtarlar tarayıcıya hiçbir zaman geri
// gönderilmez (yalnızca "kayıtlı · son 4 hane"). Kaydedince sunucu yeniden başlar, çünkü modüller .env'i açılışta okur.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response, NextFunction } from 'express';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(SRC, '..', '.env');
const ENV_EXAMPLE = path.join(SRC, '..', '.env.example');

export interface KeyField { name: string; label: string; hint: string; secret: boolean }

/** Arayüzde her zaman görünen alanlar */
export const KEY_FIELDS: KeyField[] = [
  { name: 'ABACUS_API_KEY', label: 'Abacus RouteLLM (beyin)', hint: 'apps.abacus.ai → LLM APIs. Boşsa Jarvis demo modunda çalışır.', secret: true },
  { name: 'CHAT_MODEL', label: 'Sohbet modeli', hint: 'Varsayılan: route-llm (her soruyu uygun modele yönlendirir).', secret: false },
  { name: 'USER_NAME', label: 'Size nasıl hitap etsin', hint: 'Ör. Ramazan', secret: false },
  { name: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot anahtarı', hint: "Telegram'da @BotFather → /newbot → verilen anahtar. Mesajlarınızı bu bota yazdırın ya da botu gruplara ekleyin.", secret: true },
  { name: 'TELEGRAM_KANAL', label: 'Telegram kanalı (paylaşım için)', hint: 'İsteğe bağlı. Ör. @kanaladi. Botu kanala yönetici olarak ekleyin; Jarvis onayınızla gönderi paylaşır.', secret: false },
  { name: 'PUBLIC_URL', label: 'Herkese açık adres (tünel)', hint: 'Twilio ve WhatsApp Business webhookları için. Ör. cloudflared ile aldığınız https://….trycloudflare.com (sonda / olmadan)', secret: false },
  { name: 'WHATSAPP_CLOUD_TOKEN', label: 'WhatsApp Business erişim anahtarı', hint: 'İsteğe bağlı, resmî API. developers.facebook.com → uygulamanız → WhatsApp → API Setup', secret: true },
  { name: 'WHATSAPP_PHONE_ID', label: 'WhatsApp Business telefon numarası kimliği', hint: 'API Setup sayfasındaki "Phone number ID"', secret: false },
  { name: 'WHATSAPP_VERIFY_TOKEN', label: 'WhatsApp webhook doğrulama anahtarı', hint: 'Kendiniz uydurun (uzun, rastgele); Meta webhook ayarına da aynısını yazın', secret: true },
  { name: 'WHATSAPP_APP_SECRET', label: 'Meta uygulama gizli anahtarı', hint: 'App settings → Basic → App secret. Gelen mesajların gerçekten Meta\'dan geldiğini doğrular', secret: true },
  { name: 'TWILIO_ACCOUNT_SID', label: 'Twilio Account SID', hint: 'İsteğe bağlı: telefon aramaları. console.twilio.com ana sayfası', secret: false },
  { name: 'TWILIO_AUTH_TOKEN', label: 'Twilio Auth Token', hint: 'console.twilio.com ana sayfası', secret: true },
  { name: 'TWILIO_PHONE_NUMBER', label: 'Twilio telefon numarası', hint: 'Twilio\'dan aldığınız numara, ör. +15551234567', secret: false },
  { name: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search (internette arama)', hint: 'İsteğe bağlı. Boşsa anahtarsız DuckDuckGo kullanılır. api.search.brave.com', secret: true },
  { name: 'EMAIL_ADDRESS', label: 'E-posta adresi', hint: 'Gmail, Outlook, Yandex, iCloud… Jarvis gelen kutusunu okur, taslak yazar; e-posta göndermez.', secret: false },
  { name: 'EMAIL_APP_PASSWORD', label: 'E-posta uygulama şifresi', hint: 'Gmail: Google Hesabı → Güvenlik → 2 adımlı doğrulama → Uygulama şifreleri (16 hane). Normal şifreniz çalışmaz.', secret: true },
  { name: 'GITHUB_TOKEN', label: 'GitHub anahtarı', hint: 'İsteğe bağlı. GitHub taramasında istek sınırını yükseltir. github.com → Settings → Developer settings → Personal access tokens', secret: true },
  { name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs (ses)', hint: 'İsteğe bağlı. elevenlabs.io → Profile → API Keys', secret: true },
  { name: 'AZURE_SPEECH_KEY', label: 'Azure Speech anahtarı (ses)', hint: 'İsteğe bağlı. Türkçe erkek (Ahmet) ve kadın (Emel) sesleri. portal.azure.com → Speech service → Keys', secret: true },
  { name: 'AZURE_SPEECH_REGION', label: 'Azure Speech bölgesi', hint: 'Ör. westeurope (Speech kaynağının "Location/Region" değeri)', secret: false },
  { name: 'DEEPGRAM_API_KEY', label: 'Deepgram (ses tanıma)', hint: 'İsteğe bağlı. Konuşmanızı daha hızlı yazıya döker. console.deepgram.com', secret: true },
  { name: 'OPENAI_API_KEY', label: 'OpenAI (Whisper ses tanıma)', hint: 'İsteğe bağlı. Ses tanımada Deepgram yoksa kullanılır. platform.openai.com → API keys', secret: true },
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

/**
 * Sunucuyu yeniden başlatır. `npm run dev` altında (scripts/dev.mjs JARVIS_DEV=1 verir) tsx watch kaynak dosya
 * değişince süreci yeniden açar; dosyanın tarihini güncellemek yeterli. `npm start`ta kullanıcı elle yeniden başlatır.
 */
export function restartServer(): boolean {
  if (process.env.JARVIS_DEV !== '1') return false;
  setTimeout(() => {
    const now = new Date();
    fs.utimesSync(path.join(SRC, 'index.ts'), now, now);
  }, 300);
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
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return false;
  const remote = req.socket.remoteAddress ?? '';
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean).pop();
  const ip = LOOPBACK.test(remote) && fwd ? fwd : remote;
  return LOOPBACK.test(ip);
}

export function adminOnly(req: Request, res: Response, next: NextFunction) {
  if (process.env.ACCESS_TOKEN || isLocalRequest(req)) return next();
  res.status(403).json({ error: 'Bu ayar yalnızca Jarvis\'in çalıştığı bilgisayardan değiştirilebilir (ya da .env\'de ACCESS_TOKEN tanımlayın).' });
}
