import 'dotenv/config';
import './envfix.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { runJarvis } from './agent.js';
import { BRIEF_OPENING, BRIEF_TRIGGER } from './brief.js';
import { buildDashboard } from './dashboard.js';
import { IMG_DIR } from './imagegen.js';
import { MOCK, CHAT_MODEL } from './routellm.js';
import { transcribe, STT_MODEL } from './stt.js';
import {
  BROWSER, DEFAULT_RATE, clampRate, envVoice, isRoutedModel, loadCatalog, preview, synthesize, ttsEnabled, usableVoices, voiceId, warmOpening,
  type VoiceSel,
} from './tts.js';
import { knownImageUrls, type PhotoMode } from './photos.js';
import { DEFAULT_WAKE, greetingPeriod, health, mergeWake, type WakeConfig } from './wake.js';
import { addMemory, getMemory, getProfile, removeMemory, saveProfile } from './profile.js';
import { markBlocked } from './youtube.js';
import { CAMERA_ENABLED, VISION_MODEL, cameraRouter, initCameras, onClientClosed } from './camera.js';
import { control, homeState, initHome, type DeviceId, type HomeAction } from './home.js';
import { initLibrary, libraryRouter } from './library.js';
import { extensionsRouter, initExtensions } from './extensions.js';
import { initMessaging, messagingHooksRouter, messagingRouter, notifySelf } from './messaging.js';
import { registerReelsVoice } from './reels.js';
import { initRobot } from './robot.js';
import { importContacts, initContacts, parseContacts } from './contacts.js';
import { initMailClean } from './mailclean.js';
import { checkMic, openPrivacySettings, openRecordingSettings } from './micdiag.js';
import { defaultHiz, fastModel, getHiz, initBrain, setHiz, type Hiz } from './brain.js';
import { initPhone, phoneRouter } from './phone.js';
import { initSocial, socialRouter } from './social.js';
import { androidRouter, initAndroid } from './android.js';
import { initAgents } from './agents.js';
import { VS_MODEL, initVoiceStudio, isVoiceStudio, registerVoiceSetter, vsClone, vsProfiles, vsUp } from './voicestudio.js';
import { dailyRouter, initDaily } from './daily.js';
import { financeRouter, initFinance } from './finance.js';
import { exchangesRouter } from './exchanges.js';
import { getBrainProvider, providersRouter, setBrainProvider } from './providers.js';
import { setRemoteAsk, type Kanal } from './remote.js';
import { clearErrors, errorList, initErrors, logError } from './errors.js';
import { approvalsRouter, initApprovals } from './approvals.js';
import { automationRouter } from './automation.js';
import { adminOnly, isLocalRequest, listKeys, restartServer, saveKeys } from './keys.js';
import { PERSONAS, isPersona, setPersona, type PersonaId } from './persona.js';
import { THEMES, isTheme, voiceGender, type ThemeId } from './look.js';
import { ELEVEN_MODEL, ELEVEN_MODEL_LABEL, elevenReady, elevenUsage, elevenVoices, isEleven } from './eleven.js';
import { AZURE_MODEL, AZURE_VOICES, azureReady, isAzure } from './azure.js';
import type { Device, StoredMessage } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STARTED_AT = new Date().toISOString();
const PORT = Number(process.env.PORT || 8787);
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const DATA_FILE = path.join(__dirname, '..', 'data', 'state.json');
const DEVICES: Device[] = ['masaustu', 'tablet', 'telefon'];

// ---------- Kalıcı durum (tek konuşma, tüm cihazlarda ortak) ----------
interface State {
  messages: StoredMessage[];
  photoMode: PhotoMode;
  /** Ekran: mark1 (sade) · mark2 (yoğun HUD); tüm cihazlarda ortak */
  ui?: 'mark1' | 'mark2';
  lastClient: string | null;
  lastDevice: Device | null;
  /** Seslendiren: Ayarlar'dan seçilir, tüm cihazlarda ortak. .env yalnızca varsayılan. */
  voice?: VoiceSel;
  /** "Jarvis efekti": sahne geçiş sesi */
  sfx?: boolean;
  /** Cevap hızı: hızlı model ya da route-llm yönlendiricisi */
  hiz?: Hiz;
  /** Ana sohbeti yürüten yapay zeka sağlayıcısı (providers.ts); yoksa RouteLLM */
  beyin?: string;
  /** İki alkışla uyanma ayarları (tüm cihazlarda ortak) */
  wake?: WakeConfig;
  /** Konuşma tonu (persona) */
  persona?: PersonaId;
  /** Renk teması */
  theme?: ThemeId;
}
function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { messages: [], photoMode: 'haber', lastClient: null, lastDevice: null };
  }
}
const state = loadState();
if (state.persona && isPersona(state.persona)) setPersona(state.persona);
function saveState() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ ...state, messages: state.messages.slice(-100) }, null, 2));
}

// ---------- Ses seçimi ----------
const env = envVoice();
if (env.warning) console.warn(`[tts] UYARI: ${env.warning}`);
/** Seçili ses kataloğda doğrulanmış mı (ya da tarayıcı sesi mi)? Değilse .env varsayılanına dönülür. */
function validVoice(v: VoiceSel | undefined): v is VoiceSel {
  if (!v || typeof v.model !== 'string' || typeof v.voice !== 'string') return false;
  if (v.model === BROWSER) return true;
  // ElevenLabs: anahtar varsa ve ses kimliği biçimi doğruysa (sesler hesaptan gelir, npm run voices'tan değil)
  if (isEleven(v.model)) return elevenReady() && /^[A-Za-z0-9]{8,40}$/.test(v.voice);
  if (isAzure(v.model)) return azureReady() && AZURE_VOICES.some(a => a.voice === v.voice);
  if (isVoiceStudio(v.model)) return /^[\w-]{4,40}$/.test(v.voice);
  if (isRoutedModel(v.model)) return false;
  const catalog = usableVoices();
  return !catalog.length || catalog.some(c => c.model === v.model && c.voice === v.voice);
}
if (state.voice && !validVoice(state.voice)) {
  console.warn(`[tts] Kayıtlı ses geçersiz (${voiceId(state.voice)}), .env varsayılanına dönülüyor.`);
  delete state.voice;
}
const currentVoice = (): VoiceSel => state.voice ?? env.sel;
const sfx = () => state.sfx ?? true;
const wakeCfg = (): WakeConfig => mergeWake(DEFAULT_WAKE, state.wake ?? {});

/** Karşılama cümleleri seçili sesle önceden üretilip diske yazılır: uyanışta ağ beklemeden çalsın. */
function warmGreetings(v: VoiceSel = currentVoice()) {
  if (!ttsEnabled(v)) return;
  const g = wakeCfg().greetings;
  for (const [period, text] of Object.entries(g)) {
    synthesize(text, v, `karşılama (${period})`, true).catch(() => {});
  }
}

// ---------- SSE: cihazlar arası anlık senkron ----------
/** role 'camera': Jarvis'in gözü olan cihaz (eski iPhone); ekran cihazı sayılmaz (presence, karşılama vb.) */
interface Client { id: string; device: Device; role: 'screen' | 'camera'; res: Response }
const clients = new Map<string, Client>();
function broadcast(event: object) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients.values()) c.res.write(data);
}
/** Yalnızca tek bir istemciye (WebRTC sinyali, kamera komutları) */
function sendTo(clientId: string, event: object): boolean {
  const c = clients.get(clientId);
  if (!c) return false;
  c.res.write(`data: ${JSON.stringify(event)}\n\n`);
  return true;
}
function presence() {
  return DEVICES.filter(d => [...clients.values()].some(c => c.device === d && c.role === 'screen'));
}
initCameras({ broadcast, sendTo });
initHome(broadcast);
initLibrary(broadcast);
initExtensions(broadcast);
initMessaging(broadcast);
initFinance(broadcast);
initErrors();
initApprovals(broadcast);
initPhone({ broadcast, voice: () => currentVoice() });
registerReelsVoice(() => currentVoice());
initRobot({ broadcast, notify: notifySelf });
initContacts(broadcast);
initMailClean();
setHiz(state.hiz ?? defaultHiz());
setBrainProvider(state.beyin ?? 'routellm');
initBrain();
initSocial(broadcast);
initAndroid(broadcast);
initAgents(broadcast);
initDaily({ messages: () => state.messages, broadcast });
initVoiceStudio();

const app = express();
// Dış servislerin çağırdığı webhooklar (Twilio, WhatsApp Business): kendi imza doğrulamaları var ve ham gövde
// gerektiriyor; bu yüzden JSON ayrıştırıcıdan ve /api erişim korumasından önce bağlanır.
app.use(phoneRouter());
app.use(socialRouter());
app.use(androidRouter());
app.use(messagingHooksRouter());
app.use(express.json({ limit: '12mb' })); // kamera fotoğrafı (istemci ~1280 px JPEG'e küçültür)

// İsteğe bağlı erişim koruması (tünel/deploy için önerilir)
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  // Bu bilgisayardan gelen istek anahtarsız geçer; telefon/tünel anahtar ister
  if (!ACCESS_TOKEN || isLocalRequest(req)) return next();
  const t = req.header('x-jarvis-token') || (req.query.token as string);
  if (t === ACCESS_TOKEN) return next();
  res.status(401).json({ error: 'yetkisiz' });
});

const asDevice = (d: unknown): Device => (DEVICES.includes(d as Device) ? (d as Device) : 'masaustu');

app.get('/api/events', (req, res) => {
  const id = String(req.query.client || Math.random());
  const device = asDevice(req.query.device);
  const role = req.query.role === 'camera' ? 'camera' : 'screen';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': bağlandı\n\n');
  clients.set(id, { id, device, role, res });
  broadcast({ type: 'presence', online: presence() });
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    // Aynı istemci yeniden bağlandıysa eski bağlantının kapanışı yenisini silmesin
    if (clients.get(id)?.res !== res) return;
    clients.delete(id);
    onClientClosed(id);
    broadcast({ type: 'presence', online: presence() });
  });
});

const uiMode = () => state.ui ?? 'mark1';
const persona = () => state.persona ?? 'profesyonel';
const theme = () => state.theme ?? 'jarvis';
const settingsEvent = () => ({ type: 'settings', photoMode: state.photoMode, voice: currentVoice(), sfx: sfx(), hiz: getHiz(), wake: wakeCfg(), ui: uiMode(), persona: persona(), theme: theme() });

app.get('/api/state', (_req, res) => {
  res.json({
    mesgul: busy, // otomatik güncelleme cevap yarıdayken sunucuyu yeniden başlatmasın
    messages: state.messages.slice(-50),
    photoMode: state.photoMode,
    lastDevice: state.lastDevice,
    tts: ttsEnabled(currentVoice()),
    voice: currentVoice(),
    sfx: sfx(),
    wake: wakeCfg(),
    ui: uiMode(),
    persona: persona(),
    personas: PERSONAS.map(({ id, ad, onay }) => ({ id, ad, onay: !!onay })),
    theme: theme(),
    themes: THEMES,
    camera: { enabled: CAMERA_ENABLED, vision: VISION_MODEL },
    // El Kontrolü yüz HUD etiketi ("AD · TANINDI"); ad repoda değil .env'de
    userName: process.env.USER_NAME || '',
    mock: MOCK,
    model: CHAT_MODEL,
    hiz: getHiz(),
    beyin: getBrainProvider(),
    hizliModel: fastModel(),
    online: presence(),
  });
});

// ---------- Sabah panosu ----------
// Demo modunda ya da hazır komutla verilmiş eski cevaplar sayılmaz: anahtar girildikten sonra panel hâlâ
// "beyin: demo" gösteriyordu.
const lastModel = () => [...state.messages].reverse()
  .find(m => m.reply?.model && m.reply.router !== 'demo' && m.reply.router !== 'hazır komut' && m.reply.model !== 'demo')?.reply?.model ?? CHAT_MODEL;
const dashboard = () => buildDashboard({ devices: presence(), model: lastModel() });

app.get('/api/dashboard', async (_req, res) => {
  try {
    res.json(await dashboard());
  } catch (e: any) {
    console.error('Pano hatası:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 5 dakikada bir tüm açık cihazlara taze pano (kaynakların kendi önbellekleri 10 dk).
setInterval(() => {
  if (!clients.size) return;
  dashboard()
    .then(data => broadcast({ type: 'dashboard', data }))
    .catch(e => console.warn('Pano yayınlanamadı:', e));
}, 5 * 60_000).unref();

// ---------- Seslendiren ----------
app.get('/api/voices', async (_req, res) => {
  const list = usableVoices().map(({ id, model, voice, label, provider, f0, wpm }) => {
    const hz = f0?.length ? Math.round(f0.reduce((a, b) => a + b, 0) / f0.length) : null;
    return { id, model, voice, label, provider, wpm, f0: hz, gender: voiceGender(voice, hz) };
  });
  // ElevenLabs hesabındaki sesler (anahtar varsa)
  const [eleven, usage] = await Promise.all([elevenVoices(), elevenUsage()]);
  const elevenList = eleven.map(v => ({
    id: `${ELEVEN_MODEL}:${v.voice_id}`,
    model: ELEVEN_MODEL,
    voice: v.voice_id,
    label: `${v.name.split(/\s+[-–]\s+/)[0]} · ${ELEVEN_MODEL_LABEL[ELEVEN_MODEL] ?? ELEVEN_MODEL}`,
    provider: 'ElevenLabs',
    wpm: null,
    f0: null,
    gender: voiceGender(v.name, null, v.labels?.gender),
  }));
  const azureList = azureReady() ? AZURE_VOICES.map(a => ({ id: `${AZURE_MODEL}:${a.voice}`, model: AZURE_MODEL, voice: a.voice, label: a.label, provider: 'Azure', wpm: null, f0: null, gender: a.gender })) : [];
  // VoiceStudio'daki ses profilleri (uygulama açıksa)
  const vsList = (await vsProfiles().catch(() => [])).map(p => ({ id: `${VS_MODEL}:${p.id}`, model: VS_MODEL, voice: p.id, label: `${p.name} · VoiceStudio${p.kind === 'clone' ? ' (klon)' : ''}`, provider: 'VoiceStudio', wpm: null, f0: null, gender: voiceGender(p.name, null) }));
  res.json({ voices: [...vsList, ...elevenList, ...azureList, ...list], current: currentVoice(), tested: loadCatalog().length, eleven: usage });
});

app.get('/api/voices/preview', async (req, res) => {
  const [model, voice] = String(req.query.id || '').split(':');
  const sel = { model, voice, speed: DEFAULT_RATE };
  if (!model || !voice || model === BROWSER || !validVoice(sel)) return res.status(400).json({ error: 'geçersiz ses' });
  const s = await preview(sel).catch(() => null);
  if (!s) return res.status(502).json({ error: 'önizleme üretilemedi' });
  res.setHeader('Content-Type', s.mime);
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.end(s.buf);
});

app.post('/api/settings', (req, res) => {
  if (req.body.photoMode === 'haber' || req.body.photoMode === 'video') state.photoMode = req.body.photoMode;
  if (typeof req.body.sfx === 'boolean') state.sfx = req.body.sfx;
  if (req.body.hiz === 'hizli' || req.body.hiz === 'dengeli') { state.hiz = req.body.hiz; setHiz(req.body.hiz); console.log(`[beyin] hız: ${req.body.hiz}`); }
  if (req.body.ui === 'mark1' || req.body.ui === 'mark2') state.ui = req.body.ui;
  if (isTheme(req.body.theme)) state.theme = req.body.theme;
  if (isPersona(req.body.persona) && req.body.persona !== persona()) {
    state.persona = req.body.persona;
    setPersona(req.body.persona);
    console.log(`[ton] ${req.body.persona}`);
    // Seslendirme üslubu değişti: açılış ve karşılama sesleri yeni üslupla yeniden hazırlansın
    warmOpening(currentVoice()).catch(() => {});
    warmGreetings();
  }
  if (req.body.voice) {
    const v = req.body.voice;
    const sel: VoiceSel = { model: String(v.model ?? ''), voice: String(v.voice ?? ''), speed: clampRate(Number(v.speed ?? currentVoice().speed)) };
    if (!validVoice(sel)) return res.status(400).json({ error: 'Bu ses doğrulanmış listede yok (npm run voices)' });
    const changed = voiceId(sel) !== voiceId(currentVoice());
    state.voice = sel;
    console.log(`[tts] seslendiren: ${voiceId(sel)} · hız ${sel.speed}${changed ? ' (yeni cevaptan itibaren)' : ''}`);
    if (changed) {
      warmOpening(sel).catch(() => {});
      warmGreetings(sel);
    }
  }
  if (req.body.wake) {
    const before = JSON.stringify(wakeCfg().greetings);
    state.wake = mergeWake(wakeCfg(), req.body.wake);
    if (JSON.stringify(state.wake.greetings) !== before) warmGreetings();
  }
  saveState();
  broadcast(settingsEvent());
  res.json({ ok: true, voice: currentVoice(), sfx: sfx() });
});

// ---------- Dosya yükleme (telefondan ya da başka cihazdan): İndirilenler\Jarvis-Gelen'e kaydedilir ----------
// İçerik türü ne olursa olsun ham bayt olarak gelir (istemci application/octet-stream gönderir; .json dosyası JSON
// ayrıştırıcısına takılmasın). Dosya adı sadeleştirilir, var olan dosyanın üstüne yazılmaz.
const UPLOAD_DIR = path.join(os.homedir(), 'Downloads', 'Jarvis-Gelen');
app.post('/api/dosya-yukle', adminOnly, express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Dosya boş' });
  const raw = path.basename(String(req.query.ad || 'dosya')).normalize('NFC');
  const ext = path.extname(raw).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  // Çalıştırılabilir dosyalar kaydedilmez (yanlışlıkla açılmasın)
  if (/^\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|jse|wsf|lnk|hta|cpl|reg)$/.test(ext)) return res.status(415).json({ error: 'Güvenlik için program/betik dosyaları kabul edilmiyor' });
  const stem = path.basename(raw, path.extname(raw)).replace(/[^\p{L}\p{N} ._-]+/gu, '_').trim().slice(0, 80) || 'dosya';
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  let file = path.join(UPLOAD_DIR, `${stem}${ext}`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(UPLOAD_DIR, `${stem} (${i})${ext}`);
  // Telefon rehberi (CSV / vCard): kişiler Jarvis'in rehberine alınır; dosyanın kendisi diske yazılmaz, yapay zekaya gitmez
  if (/^\.(csv|vcf)$/.test(ext)) {
    const kisiler = parseContacts(req.body, raw);
    if (kisiler.length) return res.json({ ok: true, ad: raw, rehber: importContacts(kisiler) });
  }
  fs.writeFileSync(file, req.body);
  const rel = path.relative(os.homedir(), file).split(path.sep).join('/');
  console.log(`[dosya] alındı: ${rel} (${Math.round(req.body.length / 1024)} KB)`);
  res.json({ ok: true, yol: rel, ad: path.basename(file), kb: Math.round(req.body.length / 1024) });
});

// ---------- Mikrofon: Windows ayarları (Ayarlar → Mikrofon · test). Yalnız bu bilgisayardan (pencere burada açılır) ----------
app.get('/api/mikrofon-kontrol', adminOnly, async (_req, res) => {
  try { res.json(await checkMic()); } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});
app.post('/api/mikrofon-ayar-ac', adminOnly, (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'Windows ayarları yalnızca bilgisayarın kendisinden açılabilir.' });
  res.json({ ok: req.body?.ne === 'gizlilik' ? openPrivacySettings() : openRecordingSettings() });
});

// ---------- Ses klonlama (VoiceStudio): ekrandan gönderilen ses dosyası Jarvis'in sesi olur ----------
function useClonedVoice(profileId: string) {
  const sel: VoiceSel = { model: VS_MODEL, voice: profileId, speed: currentVoice().speed };
  state.voice = sel;
  saveState();
  console.log(`[tts] seslendiren: ${voiceId(sel)} (klon ses)`);
  warmOpening(sel).catch(() => {});
  warmGreetings(sel);
  broadcast(settingsEvent());
}
registerVoiceSetter(useClonedVoice);
app.post('/api/ses-klonla', adminOnly, express.raw({ type: ['audio/*', 'video/*', 'application/octet-stream'], limit: '60mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 4000) return res.status(400).json({ error: 'Ses dosyası boş ya da çok kısa' });
  const ad = String(req.query.ad || '').trim().slice(0, 60) || `Jarvis sesi ${new Date().toLocaleDateString('tr-TR')}`;
  const dosya = String(req.query.dosya || 'ses.webm').replace(/[^\w.\-]/g, '_');
  try {
    const p = await vsClone(req.body, dosya, ad);
    useClonedVoice(p.id);
    res.json({ ok: true, profil: p, voice: currentVoice() });
  } catch (e: any) {
    logError('ses klonlama', e);
    res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
});

// ---------- Kamera cihazları (WebRTC sinyali, aralıklı kare, kameraya_bak) ----------
app.use(cameraRouter());

// ---------- Kitaplık (El Kontrolü: raf haritası, kapak, özet, notlar) ----------
app.use(libraryRouter());

// ---------- Yetenekler (beceriler, iş akışları, MCP, GitHub'dan kurulum) ----------
app.use(extensionsRouter());

// ---------- Bağlantılar: Telegram ve WhatsApp ----------
app.use(messagingRouter());

// ---------- Finans: portföy ve fiyat alarmları ----------
app.use(financeRouter());
app.use(exchangesRouter());
app.use(dailyRouter());
app.use(providersRouter(id => { state.beyin = id; saveState(); }));

// ---------- Onay kartları ve otomasyon (webhook) ----------
app.use(approvalsRouter());
app.use(automationRouter());

// ---------- Hata günlüğü ----------
app.get('/api/hatalar', adminOnly, (_req, res) => res.json({ hatalar: errorList() }));
app.delete('/api/hatalar', adminOnly, (_req, res) => { clearErrors(); res.json({ ok: true }); });

// ---------- API anahtarları (server/.env) ----------
// Sürüm: otomatik güncellemenin çalışıp çalışmadığı Ayarlar'da görünsün
app.get('/api/surum', (_req, res) => {
  const repo = path.join(__dirname, '..', '..');
  execFile('git', ['log', '-1', '--format=%h|%cI|%s'], { cwd: repo, windowsHide: true, timeout: 10_000 }, (err, out) => {
    const [kod, tarih, baslik] = String(out || '').trim().split('|');
    res.json(err || !kod ? { kod: 'bilinmiyor' } : { kod, tarih, baslik: (baslik || '').slice(0, 90), calisma: STARTED_AT });
  });
});
app.get('/api/keys', adminOnly, (_req, res) => res.json(listKeys()));
app.post('/api/keys', adminOnly, (req, res) => {
  const values = req.body?.values;
  if (!values || typeof values !== 'object') return res.status(400).json({ error: 'değer yok' });
  const n = saveKeys(values);
  console.log(`[ayarlar] ${n} anahtar güncellendi`);
  // Modüller anahtarları açılışta okuyor: yeni değerler yeniden başlayınca geçerli olur.
  const restarting = n > 0 && restartServer();
  if (restarting) broadcast({ type: 'restarting' });
  res.json({ ok: true, changed: n, restarting, ...listKeys() });
});

// ---------- Akıllı ev ----------
app.get('/api/home', (_req, res) => res.json(homeState()));
app.post('/api/home/:id', (req, res) => {
  const r = control(req.params.id as DeviceId, req.body as HomeAction);
  if ('hata' in r) return res.status(400).json({ error: r.hata });
  res.json(homeState());
});

// ---------- Profil (Hakkımda) ve hafıza ----------
app.get('/api/profile', (_req, res) => res.json({ profile: getProfile(), memory: getMemory() }));
app.post('/api/profile', (req, res) => {
  if (typeof req.body?.text !== 'string' || !req.body.text.trim()) return res.status(400).json({ error: 'tanıtım boş olamaz' });
  const p = saveProfile(req.body.text);
  console.log(`[profil] güncellendi · ${p.text.length} karakter`);
  res.json({ profile: p });
});
app.post('/api/memory', (req, res) => {
  const item = addMemory(String(req.body?.text ?? ''));
  if (!item) return res.status(400).json({ error: 'not boş ya da zaten var' });
  console.log(`[hafıza] elle eklendi [${item.id}] ${item.text}`);
  res.json({ item, memory: getMemory() });
});
app.delete('/api/memory/:id', (req, res) => {
  const item = removeMemory(req.params.id);
  if (!item) return res.status(404).json({ error: 'not bulunamadı' });
  console.log(`[hafıza] elle silindi [${item.id}] ${item.text}`);
  res.json({ memory: getMemory() });
});

// Oynatıcı "sahibi bu sitede oynatılmasını engelledi" dedi (oEmbed bunu göremiyor; ör. LaLiga): bir daha önerilmesin
app.post('/api/video-blocked', (req, res) => {
  const id = String(req.body?.id ?? '');
  markBlocked(id);
  console.log(`[youtube] Jarvis içinde oynamıyor (kod ${req.body?.code ?? '?'}): ${id}`);
  res.json({ ok: true });
});

// ---------- İki alkışla uyanma ----------
// Saat senkronu: istemci gidiş-dönüş süresinin yarısını düşerek sunucu saatine göre ofsetini hesaplar.
app.get('/api/time', (_req, res) => res.json({ now: Date.now() }));

// Açılış sekansındaki sistem kontrolleri: hepsi gerçek ölçüm.
app.get('/api/health', async (_req, res) => res.json(await health(presence())));

// Dinleyici cihaz çift alkışı duydu → tüm cihazlar "dikkat" (ya da süre doldu → geri uykuya)
app.post('/api/attention', (req, res) => {
  const end = req.body?.end === true;
  console.log(`[uyanış] ${end ? 'dikkat bitti' : 'çift alkış → dikkat'}${req.body?.heard ? ` · duyulan: "${String(req.body.heard).slice(0, 60)}"` : ''}`);
  broadcast(end ? { type: 'attention_end' } : { type: 'attention', ms: 4000, by: asDevice(req.body?.device) });
  res.json({ ok: true });
});

// Uyanış: tüm cihazlar açılış sekansını aynı anda (sunucu zamanı + 350 ms) başlatır.
app.post('/api/wake', (req, res) => {
  const cfg = wakeCfg();
  const period = greetingPeriod();
  const at = Date.now() + 350;
  console.log(`[uyanış] ${String(req.body?.via || 'test')} · sekans ${new Date(at).toISOString().slice(11, 23)} · karşılama (${period}) ${cfg.greeter} cihazından${req.body?.heard ? ` · duyulan: "${String(req.body.heard).slice(0, 60)}"` : ''}`);
  broadcast({ type: 'wake', at, greeting: { period, text: cfg.greetings[period] }, greeter: cfg.greeter, brief: cfg.briefOnWake, voice: currentVoice(), via: String(req.body?.via || 'test') });
  res.json({ ok: true, at });
});

app.post('/api/sleep', (_req, res) => {
  console.log('[uyanış] tüm cihazlar uykuya');
  broadcast({ type: 'sleep' });
  res.json({ ok: true });
});

app.post('/api/clear', (_req, res) => {
  state.messages = [];
  state.lastClient = null;
  state.lastDevice = null;
  saveState();
  broadcast({ type: 'cleared' });
  res.json({ ok: true });
});

// ---------- Sohbet: sahneler hazır oldukça akar ----------
let busy = false;
app.post('/api/chat', async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 2000);
  const image = typeof req.body.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(req.body.image) ? req.body.image : undefined;
  const client = String(req.body.client || '');
  const device = asDevice(req.body.device);
  if (!text && !image) return res.status(400).json({ error: 'boş mesaj' });
  if (busy) return res.status(409).json({ error: 'Jarvis şu an başka bir cevabı hazırlıyor' });
  busy = true;
  const t0 = Date.now();

  const prevDevice = state.lastDevice;
  if (state.lastClient && state.lastClient !== client && prevDevice && prevDevice !== device) {
    broadcast({ type: 'handoff', from: prevDevice, to: device, toClient: client });
  }
  state.lastClient = client;
  state.lastDevice = device;

  // Ses bu cevaba sabitlenir: cevap sürerken Ayarlar'dan değişse de bu cevap tek sesle biter.
  const voice = { ...currentVoice() };
  const replyId = randomUUID();
  const userMsg: StoredMessage = { role: 'user', text: image ? `📷 ${text || 'Bu ne?'}` : text, device, at: new Date().toISOString() };
  const history = state.messages.slice();
  state.messages.push(userMsg);
  broadcast({ type: 'user', message: userMsg, origin: client });
  // Açılışın sesi diskte hazır: brifing yazılmayı beklemeden Jarvis hemen cevap versin.
  if (BRIEF_TRIGGER.test(text)) broadcast({ type: 'opening', text: BRIEF_OPENING, voice, origin: client });

  let total = 0;
  let firstTts = false;
  try {
    const reply = await runJarvis({
      text,
      image,
      device,
      prevDevice,
      history,
      photoMode: state.photoMode,
      progress: line => broadcast({ type: 'progress', line, origin: client }),
      onScene: (index, sahne) => {
        total = index + 1;
        broadcast({ type: 'scene', replyId, index, sahne, voice, origin: client });
        // Sesi sahne gelir gelmez üret (aynı anda en fazla 3; istemcinin isteği bu işi paylaşır).
        synthesize(sahne.ses, voice, `sahne ${index + 1}`).then(s => {
          if (s && !firstTts) {
            firstTts = true;
            console.log(`[zaman] ilk TTS hazır · sahne ${index + 1} · ${Date.now() - t0} ms`);
          }
        }).catch(() => {});
      },
      onSceneUpdate: (index, foto) => broadcast({ type: 'scene_update', replyId, index, foto, origin: client }),
      onScenesDone: count => broadcast({ type: 'scene_end', replyId, count, origin: client }),
    });
    const full = { ...reply, id: replyId, voice };
    console.log(`[beyin] ${full.router} → ${full.model} · ${full.sahneler.length} sahne · ${Date.now() - t0} ms`);
    const msg: StoredMessage = { role: 'assistant', text: full.sahneler.map(s => s.ses).join(' '), device, at: full.created_at, reply: full };
    state.messages.push(msg);
    saveState();
    broadcast({ type: 'reply', message: msg, origin: client });
    res.json({ ok: true, scenes: total });
  } catch (e: any) {
    console.error(e);
    logError('sohbet', e);
    broadcast({ type: 'error', error: String(e?.message || e), origin: client });
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    busy = false;
  }
});

// ---------- Uzaktan komut (WhatsApp'ta kendine mesaj / eşleştirilmiş Telegram) ----------
// Ana sohbetle aynı yol: geçmişe yazılır, ekranlarda görünür; ses üretilmez, cevabın metni mesajla döner.
async function askRemote(text: string, kanal: Kanal): Promise<string> {
  for (let i = 0; busy && i < 120; i++) await new Promise(r => setTimeout(r, 1000)); // ekrandaki cevap bitsin
  if (busy) throw new Error('Jarvis şu an meşgul, birazdan tekrar deneyin');
  busy = true;
  const origin = `uzak-${kanal}`;
  const replyId = randomUUID();
  const voice = { ...currentVoice() };
  try {
    const userMsg: StoredMessage = { role: 'user', text: `${kanal === 'whatsapp' ? '💬' : '✈️'} ${text}`, device: 'telefon', at: new Date().toISOString() };
    const history = state.messages.slice();
    state.messages.push(userMsg);
    broadcast({ type: 'user', message: userMsg, origin });
    const reply = await runJarvis({
      text, device: 'telefon', prevDevice: state.lastDevice ?? null, history, photoMode: state.photoMode,
      progress: line => broadcast({ type: 'progress', line, origin }),
      onScene: (index, sahne) => broadcast({ type: 'scene', replyId, index, sahne, voice, origin }),
      onScenesDone: count => broadcast({ type: 'scene_end', replyId, count, origin }),
    });
    const full = { ...reply, id: replyId, voice };
    const msg: StoredMessage = { role: 'assistant', text: full.sahneler.map(s => s.ses).join(' '), device: 'telefon', at: full.created_at, reply: full };
    state.messages.push(msg);
    saveState();
    broadcast({ type: 'reply', message: msg, origin });
    console.log(`[uzak] ${kanal} komutu cevaplandı · ${full.sahneler.length} sahne`);
    return msg.text;
  } finally {
    busy = false;
  }
}
setRemoteAsk(askRemote);

// Sahne sesi. v = cevaba sabitlenmiş ses (model:voice); i/n yalnızca log için.
app.get('/api/tts', async (req, res) => {
  try {
    const [model, voice] = String(req.query.v || '').split(':');
    const sel: VoiceSel = model && voice ? { model, voice, speed: currentVoice().speed } : currentVoice();
    if (!validVoice(sel) || !ttsEnabled(sel)) return res.status(204).end();
    const label = req.query.i ? `sahne ${req.query.i}/${req.query.n ?? '?'}` : 'istek';
    // ElevenLabs: önceki/sonraki cümle bağlamı (tonlama cümleden cümleye kopmasın)
    const ctx = { prev: req.query.prev ? String(req.query.prev).slice(0, 500) : undefined, next: req.query.next ? String(req.query.next).slice(0, 500) : undefined };
    const speech = await synthesize(String(req.query.text || '').slice(0, 1000), sel, label, false, ctx);
    if (!speech) return res.status(503).end(); // istemci bir kez yeniden dener, olmazsa cevabın kalanı tarayıcı sesine geçer
    res.setHeader('Content-Type', speech.mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(speech.buf);
  } catch (e) {
    console.error('TTS hatası:', e);
    res.status(503).end();
  }
});

// ---------- Ses tanıma: MediaRecorder kaydı → RouteLLM ----------
app.post('/api/stt', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '40mb' }), async (req, res) => {
  const mime = String(req.headers['content-type'] || '');
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: 'kayıt boş' });
  try {
    const r = await transcribe(req.body, mime, Number(req.headers['x-sure-ms']) || undefined);
    console.log(`[stt] ${r.model} · ${mime.split(';')[0]} · ${Math.round(req.body.length / 1024)} KB · ${r.ms} ms · "${r.text.slice(0, 60)}"`);
    res.json(r);
  } catch (e: any) {
    console.warn(`[stt] ${STT_MODEL} başarısız: ${String(e?.message || e).slice(0, 120)}`);
    logError('ses tanıma', `${STT_MODEL}: ${String(e?.message || e).slice(0, 300)}`);
    res.status(502).json({ error: 'ses yazıya çevrilemedi' });
  }
});

// İstemcinin ölçtüğü süreler (ilk ses çalmaya başladı vb.) sunucu loguna düşsün.
app.post('/api/metrics', (req, res) => {
  const { event, ms, detail } = req.body ?? {};
  if (typeof event === 'string' && typeof ms === 'number') console.log(`[zaman] istemci · ${event} · ${Math.round(ms)} ms${detail ? ' · ' + String(detail).slice(0, 80) : ''}`);
  res.json({ ok: true });
});

// Yapay zekayla üretilmiş temsili görseller
app.get('/api/genimg/:file', (req, res) => {
  const file = path.basename(req.params.file);
  if (!/^[0-9a-f]{20}\.png$/.test(file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.sendFile(path.join(IMG_DIR, file), err => err && res.status(404).end());
});

// Haber fotoğrafları için proxy (bazı siteler başka sitelerden gösterimi engelliyor)
app.get('/api/img', async (req, res) => {
  const u = String(req.query.u || '');
  if (!knownImageUrls.has(u)) return res.status(404).end();
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(502).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// Üretim: derlenmiş arayüzü aynı porttan sun (tek tünel yeterli)
const dist = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => {
  const v = currentVoice();
  console.log(`Jarvis sunucusu: http://localhost:${PORT}  ${MOCK ? '(DEMO MODU — API anahtarı yok)' : `(beyin: ${CHAT_MODEL})`}`);
  console.log(`[tts] seslendiren: ${voiceId(v)} · STT: ${STT_MODEL}`);
  if (!usableVoices().length) console.warn('[tts] Doğrulanmış ses kataloğu yok: `npm run voices` çalıştırın.');
  warmOpening(v).catch(e => console.warn('Açılış sesi hazırlanamadı:', e));
  warmGreetings(v);
});
