import type { Dashboard, Device, Health, PersonaOption, ServerEvent, StoredMessage, ThemeOption, UiMode, VoiceOption, VoiceSel, WakeConfig } from './types';

function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* yok say */ } }

// ?token=... bir kez açılınca saklanır
// iPhone'da ise anahtar Safari'de adreste bırakılır: "Ana Ekrana Ekle" adresi olduğu gibi alır ve ana ekran uygulaması
// Safari'nin depolamasını göremez; adreste olmazsa uygulama açılınca anahtar yeniden sorulurdu.
const urlToken = new URLSearchParams(location.search).get('token');
const iosBrowser = (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
  && !(navigator as any).standalone;
if (urlToken) {
  safeSet('jarvis.token', urlToken);
  if (!iosBrowser) history.replaceState(null, '', location.pathname);
}
export const token = safeGet('jarvis.token') || '';
if (!urlToken && token && iosBrowser) history.replaceState(null, '', `${location.pathname}?token=${encodeURIComponent(token)}`);

export const clientId = (() => {
  let id = sessionStorage.getItem('jarvis.client');
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('jarvis.client', id);
  }
  return id;
})();

export function detectDevice(): Device {
  const saved = safeGet('jarvis.device') as Device | null;
  if (saved) return saved;
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 1;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
  if (/iPhone|Android.*Mobile|Mobile/.test(ua) || Math.min(innerWidth, innerHeight) < 500) return 'telefon';
  return 'masaustu';
}
export function saveDevice(d: Device) { safeSet('jarvis.device', d); }

const headers = (): HeadersInit => ({ 'Content-Type': 'application/json', ...(token ? { 'x-jarvis-token': token } : {}) });

export interface AppState {
  messages: StoredMessage[];
  photoMode: 'haber' | 'video';
  lastDevice: Device | null;
  tts: boolean;
  voice: VoiceSel;
  sfx: boolean;
  wake: WakeConfig;
  ui: UiMode;
  persona?: string;
  personas?: PersonaOption[];
  theme?: string;
  themes?: ThemeOption[];
  camera?: { enabled: boolean; vision: string };
  userName?: string;
  mock: boolean;
  model: string;
  online: Device[];
}

export async function getState(): Promise<AppState> {
  const r = await fetch('/api/state', { headers: headers() });
  if (!r.ok) throw new Error(r.status === 401 ? 'yetkisiz — adresi ?token=... ile aç' : 'sunucuya ulaşılamadı');
  return r.json();
}

/** image: kamera/fotoğraf (data URL). Cevap SSE ile sahne sahne gelir. */
export async function sendChat(text: string, device: Device, image?: string) {
  const r = await fetch('/api/chat', { method: 'POST', headers: headers(), body: JSON.stringify({ text, device, client: clientId, image }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'hata');
}

export interface ElevenUsage { used: number; limit: number; resetAt: string | null; tier: string }
export async function getVoices(): Promise<{ voices: VoiceOption[]; current: VoiceSel; tested: number; eleven: ElevenUsage | null }> {
  const r = await fetch('/api/voices', { headers: headers() });
  if (!r.ok) throw new Error('ses listesi alınamadı');
  return r.json();
}
export const previewUrl = (id: string) => `/api/voices/preview?id=${encodeURIComponent(id)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;

/** Ses seçimi tüm cihazlarda ortaktır: sunucuda saklanır ve SSE ile herkese yayılır. */
export async function saveSettings(patch: { voice?: VoiceSel; sfx?: boolean; wake?: Partial<WakeConfig>; ui?: UiMode; persona?: string; theme?: string }) {
  const r = await fetch('/api/settings', { method: 'POST', headers: headers(), body: JSON.stringify(patch) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'kaydedilemedi');
}

/** Mikrofon kaydını RouteLLM ile yazıya çevirir. */
export async function stt(audio: Blob): Promise<string> {
  // Takılırsa ekran "anlıyorum…"da kalmasın; uzun konuşmanın kaydı daha uzun sürer
  const limit = 40_000 + Math.round(audio.size / 20);
  const r = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': audio.type || 'audio/webm', ...(token ? { 'x-jarvis-token': token } : {}) }, body: audio, signal: AbortSignal.timeout(limit) })
    .catch(e => { throw new Error(e?.name === 'TimeoutError' ? `ses tanıma ${Math.round(limit / 1000)} sn içinde cevap vermedi` : 'sunucuya ulaşılamadı'); });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'ses yazıya çevrilemedi');
  return (await r.json()).text ?? '';
}

/** İstemcide ölçülen süreler sunucu loguna düşsün (ör. ilk sesin çalmaya başlaması). */
export function metric(event: string, ms: number, detail?: string) {
  fetch('/api/metrics', { method: 'POST', headers: headers(), body: JSON.stringify({ event, ms, detail }), keepalive: true }).catch(() => {});
}

// ---------- Profil (Hakkımda) ve hafıza ----------
export interface MemoryItem { id: string; text: string; at: string }
export interface ProfileData { profile: { text: string; updated_at: string | null }; memory: MemoryItem[] }
async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'kaydedilemedi');
  return r.json();
}
export const getProfile = () => fetch('/api/profile', { headers: headers() }).then(r => json<ProfileData>(r));
export const saveProfile = (text: string) => fetch('/api/profile', { method: 'POST', headers: headers(), body: JSON.stringify({ text }) }).then(r => json<{ profile: ProfileData['profile'] }>(r));
export const addMemory = (text: string) => fetch('/api/memory', { method: 'POST', headers: headers(), body: JSON.stringify({ text }) }).then(r => json<{ memory: MemoryItem[] }>(r));
export const deleteMemory = (id: string) => fetch(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() }).then(r => json<{ memory: MemoryItem[] }>(r));

// ---------- Ayarlar → API anahtarları ve Yetenekler ----------
export interface KeyView { name: string; label: string; hint: string; secret: boolean; set: boolean; value: string }
export interface KeysData { fields: KeyView[]; custom: KeyView[] }
export const getKeys = () => fetch('/api/keys', { headers: headers() }).then(r => json<KeysData>(r));
export const saveKeys = (values: Record<string, string>) =>
  fetch('/api/keys', { method: 'POST', headers: headers(), body: JSON.stringify({ values }) }).then(r => json<KeysData & { changed: number; restarting: boolean }>(r));

export interface SkillView { id: string; ad: string; aciklama: string; tur: 'beceri' | 'is_akisi'; aktif: boolean; repo?: string; dosya?: string; kaynak?: 'jarvis' | 'takip'; kaynakUrl?: string; uzunluk: number }
export interface ServerView { id: string; ad: string; aktif: boolean; repo?: string; tur: 'stdio' | 'http'; hedef: string; durum: 'kapalı' | 'kuruluyor' | 'bağlanıyor' | 'bağlı' | 'giriş gerekli' | 'hata'; hata?: string; girisAdresi?: string; araclar: string[]; kurulum?: 'npm' }
export interface BulkView { calisiyor: boolean; liste: { url: string; durum: 'bekliyor' | 'kuruluyor' | 'tamam' | 'atlandı' | 'hata'; mesaj?: string }[] }
export interface ExtensionsData { repos: { slug: string; url: string; at: string }[]; skills: SkillView[]; servers: ServerView[]; toplu?: BulkView }
const ext = (path: string, method = 'GET', body?: object) =>
  fetch(`/api/extensions${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined }).then(r => json<ExtensionsData>(r));
export const getExtensions = () => ext('');
export const installGitHub = (url: string) => ext('/github', 'POST', { url }) as Promise<ExtensionsData & { bilgi?: boolean; beceri: number; is_akisi: number; mcp: number }>;
export const installBulk = (liste: string) => ext('/github-toplu', 'POST', { liste });

export type SosyalPlatform = 'youtube' | 'instagram' | 'tiktok' | 'x';
export interface TakipData {
  kanallar: { id: string; platform: SosyalPlatform; ad: string; url: string; eklendi: string; son_kontrol?: string; ogrenilen_yetenek: number }[];
  oneriler: { ad: string; aciklama: string; kaynak?: string }[];
  not?: string;
}
const takip = (path: string, method = 'GET', body?: object) =>
  fetch(`/api/takip${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined }).then(r => json<TakipData>(r));
export const getTakip = () => takip('');
export const addTakip = (kim: string, platform?: SosyalPlatform) => takip('', 'POST', { kim, platform });
export const removeTakip = (id: string) => takip(`/${id}`, 'DELETE');
export const checkTakip = () => takip('/kontrol', 'POST');
export const removeRepo = (slug: string) => ext(`/repo/${encodeURIComponent(slug)}`, 'DELETE');
export const addSkill = (s: { ad: string; aciklama: string; icerik: string; tur: 'beceri' | 'is_akisi' }) => ext('/skill', 'POST', s);
export const toggleSkill = (id: string, aktif: boolean) => ext(`/skill/${id}`, 'POST', { aktif });
export const deleteSkill = (id: string) => ext(`/skill/${id}`, 'DELETE');
export const addServer = (s: { ad: string; komut?: string; url?: string; env?: string; basliklar?: string }) => ext('/server', 'POST', s);
export const toggleServer = (id: string, aktif: boolean) => ext(`/server/${id}`, 'POST', { aktif });
export const retryServer = (id: string) => ext(`/server/${id}`, 'POST', { yenile: true });
export const deleteServer = (id: string) => ext(`/server/${id}`, 'DELETE');
export const logoutServer = (id: string) => ext(`/server/${id}/cikis`, 'POST', {});

// ---------- Ayarlar → Bağlantılar (Telegram, WhatsApp) ----------
export interface MessagingCfg { telegramOto: boolean; whatsappOto: boolean; aramaMesaji: boolean; aramaMetni: string; talimat: string }
export interface MessagingData {
  telegram: { durum: 'anahtar yok' | 'kapalı' | 'bağlı' | 'hata'; bot: string; hata: string };
  whatsapp: { durum: 'kapalı' | 'qr' | 'bağlanıyor' | 'bağlı' | 'hata'; qr: string; numara: string; hata: string };
  whatsappCloud?: { hazir: boolean; webhook: string | null; imza: boolean };
  telefon?: { hazir: boolean; numara: string | null; webhook: string | null; son: { sid: string; yon: 'gelen' | 'giden'; numara: string; basla: string; sure_sn?: number; ozet: string }[] };
  ayar: MessagingCfg;
  okunmamis: number;
}
const msgApi = (path: string, method = 'GET', body?: object) =>
  fetch(`/api/mesaj${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined }).then(r => json<MessagingData>(r));
export const getMessaging = () => msgApi('');
export const saveMessaging = (patch: Partial<MessagingCfg>) => msgApi('/ayar', 'POST', patch);
export const connectWhatsApp = () => msgApi('/whatsapp/baglan', 'POST', {});
export const logoutWhatsApp = () => msgApi('/whatsapp/cikis', 'POST', {});

// ---------- Ayarlar → Portföy ----------
export interface HoldingView { id: string; sembol: string; ad?: string; adet: number; para?: string; fiyat?: number; maliyet_birim?: number; deger_tl?: number; kar_tl?: number; kar_yuzde?: number; agirlik_yuzde?: number; gunluk_degisim?: number; sinyal?: string; hata?: string }
export interface PortfolioData { bos?: boolean; toplam_deger_tl?: number; toplam_kar_tl?: number; toplam_kar_yuzde?: number; risk?: { yillik_oynaklik: number | null; en_buyuk_dusus_1y: number | null }; varliklar?: HoldingView[]; hata?: string }
export interface AlarmView { id: string; sembol: string; kosul: 'ust' | 'alt'; fiyat: number; tetiklendi?: string }
export const getPortfolio = () => fetch('/api/finans/portfoy', { headers: headers() }).then(r => json<PortfolioData>(r));
export const addPortfolio = (sembol: string, adet: number, maliyet: number) =>
  fetch('/api/finans/portfoy', { method: 'POST', headers: headers(), body: JSON.stringify({ sembol, adet, maliyet }) }).then(r => json<{ ok: true }>(r));
export const deletePortfolio = (id: string) => fetch(`/api/finans/portfoy/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() }).then(r => json<{ ok: true }>(r));
export const getAlarms = () => fetch('/api/finans/alarm', { headers: headers() }).then(r => json<{ alarmlar: AlarmView[] }>(r));
export const deleteAlarm = (id: string) => fetch(`/api/finans/alarm/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() }).then(r => json<{ ok: true }>(r));

// ---------- Ayarlar → Sistem günlüğü ----------
export interface ErrorView { kaynak: string; mesaj: string; adet: number; ilk: string; son: string; cozuldu?: boolean; olasi_neden: string | null }
export const getErrors = () => fetch('/api/hatalar', { headers: headers() }).then(r => json<{ hatalar: ErrorView[] }>(r));
export const clearErrorLog = () => fetch('/api/hatalar', { method: 'DELETE', headers: headers() }).then(r => json<{ ok: true }>(r));

// ---------- Onay kartları ve webhook'lar ----------
export interface ActionView { id: string; tur: 'komut' | 'uygulama' | 'paylasim' | 'webhook' | 'kod' | 'arama' | 'mesaj' | 'satin_alma' | 'borsa'; baslik: string; ayrinti: string; aciklama: string; durum: 'bekliyor' | 'calisiyor' | 'tamam' | 'hata' | 'reddedildi' | 'dustu'; sonuc?: string; at: string; bitti?: string }
export const getActions = () => fetch('/api/islemler', { headers: headers() }).then(r => json<{ islemler: ActionView[] }>(r));
export const decideAction = (id: string, onay: boolean) =>
  fetch(`/api/islemler/${encodeURIComponent(id)}`, { method: 'POST', headers: headers(), body: JSON.stringify({ onay }) }).then(r => json<ActionView>(r));
export interface WebhookView { id: string; ad: string; url: string; aciklama: string }
export const getWebhooks = () => fetch('/api/webhook', { headers: headers() }).then(r => json<{ webhooklar: WebhookView[] }>(r));
export const addWebhook = (w: { ad: string; url: string; aciklama: string }) =>
  fetch('/api/webhook', { method: 'POST', headers: headers(), body: JSON.stringify(w) }).then(r => json<{ ok: true }>(r));
export const deleteWebhook = (id: string) => fetch(`/api/webhook/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() }).then(r => json<{ ok: true }>(r));

/** Oynatıcı "sahibi bu sitede oynatılmasını engelledi" dedi: sunucu bir daha Jarvis içinde önermesin */
export const reportVideoBlocked = (id: string, code: number) => post('/api/video-blocked', { id, code });

// ---------- İki alkışla uyanma ----------
const post = (url: string, body: object = {}) => fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) }).then(r => r.ok);
/** Dinleyici çift alkışı duydu (tüm cihazlar "dikkat"); end: komut gelmedi, uykuya dön. heard: sunucu loguna */
export const postAttention = (device: Device, end = false, heard?: string) => post('/api/attention', { device, end, heard });
/** Tüm cihazlarda senkron uyanış. via: "alkış + ses", "test (W)"… */
export const postWake = (via: string, heard?: string) => post('/api/wake', { via, heard });
export const postSleep = () => post('/api/sleep');
export async function getHealth(): Promise<Health | null> {
  try {
    const r = await fetch('/api/health', { headers: headers() });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}
export async function serverTime(): Promise<number> {
  const r = await fetch('/api/time', { headers: headers(), cache: 'no-store' });
  return (await r.json()).now;
}

export async function getDashboard(): Promise<Dashboard> {
  const r = await fetch('/api/dashboard', { headers: headers() });
  if (!r.ok) throw new Error('pano alınamadı');
  return r.json();
}

export async function setPhotoMode(photoMode: 'haber' | 'video') {
  await fetch('/api/settings', { method: 'POST', headers: headers(), body: JSON.stringify({ photoMode }) });
}

export async function clearConversation() {
  await fetch('/api/clear', { method: 'POST', headers: headers() });
}

/** Önceki/sonraki cümle: ElevenLabs tonlamayı cümleler arasında sürdürsün diye */
export interface TtsCtx { prev?: string; next?: string }

/** v: cevaba sabitlenmiş ses; i/n yalnızca sunucu logu için ("sahne 3/6"). */
export function ttsUrl(text: string, voice?: VoiceSel, i?: number, n?: number, ctx: TtsCtx = {}) {
  const q = new URLSearchParams({ text });
  if (ctx.prev) q.set('prev', ctx.prev);
  if (ctx.next) q.set('next', ctx.next);
  if (voice) q.set('v', `${voice.model}:${voice.voice}`);
  if (i !== undefined) q.set('i', String(i));
  if (n !== undefined) q.set('n', String(n));
  if (token) q.set('token', token);
  return `/api/tts?${q}`;
}

export function subscribe(device: Device, onEvent: (e: ServerEvent) => void, onStatus: (ok: boolean) => void, role: 'screen' | 'camera' = 'screen') {
  let es: EventSource | null = null;
  let closed = false;
  const open = () => {
    es = new EventSource(`/api/events?client=${clientId}&device=${device}&role=${role}${token ? `&token=${encodeURIComponent(token)}` : ''}`);
    es.onopen = () => onStatus(true);
    es.onmessage = m => { try { onEvent(JSON.parse(m.data)); } catch { /* yok say */ } };
    es.onerror = () => {
      onStatus(false);
      es?.close();
      if (!closed) setTimeout(open, 1500);
    };
  };
  open();
  return () => { closed = true; es?.close(); };
}

export interface AndroidData { adb: boolean; bagli: boolean; cihaz?: string; sonAdres?: string; hata?: string; mesaj?: string }
const android = (path: string, body?: object) =>
  fetch(`/api/android${path}`, { method: body ? 'POST' : 'GET', headers: headers(), body: body ? JSON.stringify(body) : undefined }).then(r => json<AndroidData>(r));
export const getAndroid = () => android('');
export const pairAndroid = (adres: string, kod: string) => android('/eslestir', { adres, kod });
export const connectAndroid = (adres: string) => android('/baglan', { adres });
export const setupAdb = () => android('/kur', {});

/** Ses dosyasından klon ses (VoiceStudio): sunucu sesi temizler, profili oluşturur ve Jarvis'in sesi yapar */
export async function cloneVoice(f: File, ad?: string): Promise<{ profil: { id: string; name: string; temizlendi: boolean } }> {
  const q = new URLSearchParams({ dosya: f.name, ...(ad ? { ad } : {}) });
  const r = await fetch(`/api/ses-klonla?${q}`, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream', ...(token ? { 'x-jarvis-token': token } : {}) }, body: f });
  return json(r);
}

/** Dosyayı bilgisayara (İndirilenler\\Jarvis-Gelen) yükler; ilerleme 0-1 arası bildirilir */
export function uploadFile(f: File, onProgress?: (p: number) => void): Promise<{ yol: string; ad: string; kb: number }> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/dosya-yukle?ad=${encodeURIComponent(f.name)}`);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    if (token) x.setRequestHeader('x-jarvis-token', token);
    x.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let j: any = {};
      try { j = JSON.parse(x.responseText); } catch { /* boş */ }
      if (x.status >= 200 && x.status < 300) resolve(j);
      else reject(new Error(j.error || (x.status === 413 ? 'Dosya çok büyük' : `yüklenemedi (${x.status})`)));
    };
    x.onerror = () => reject(new Error('bağlantı koptu'));
    x.send(f);
  });
}
