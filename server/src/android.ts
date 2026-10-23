// Android telefon (kablosuz ADB): Jarvis bilgisayardan telefona uygulama yükler (Google Play sayfasını açıp "Yükle"ye
// basar) ve uygulama kaldırır. Her işlem onay kartıyla yapılır.
// Kurulum (bir kez): Telefonda Ayarlar → Telefon hakkında → "Yapı numarası"na 7 kez dokun (Geliştirici seçenekleri açılır)
// → Geliştirici seçenekleri → Kablosuz hata ayıklama (açık) → "Cihazı eşleştirme koduyla eşle". Ekrandaki adres ve 6
// haneli kod Jarvis → Ayarlar → Android telefon bölümüne yazılır. Telefon ve bilgisayar aynı Wi-Fi'de olmalı.
// Neden ADB: Google Play başka programların uygulama kurmasına izin vermez; ADB telefonun kendi resmî geliştirici aracıdır.
// Ücretli uygulamalarda "Yükle"ye basılmaz (satın alma kullanıcıya bırakılır); sistem uygulamaları kaldırılmaz.
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Router } from 'express';
import { propose } from './approvals.js';
import { adminOnly } from './keys.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DATA, 'android.json');
const WIN = process.platform === 'win32';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

interface Cfg { sonAdres?: string; cihaz?: string }
const readCfg = (): Cfg => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const saveCfg = (c: Cfg) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(c, null, 2)); };

// ---------------------------------------------------------------- adb

let adbPath: string | null = null;
function findAdb(): string | null {
  if (adbPath && fs.existsSync(adbPath)) return adbPath;
  if (process.env.ADB_PATH && fs.existsSync(process.env.ADB_PATH)) return (adbPath = process.env.ADB_PATH);
  const which = spawnSync(WIN ? 'where' : 'which', ['adb'], { encoding: 'utf8' });
  if (which.status === 0) return (adbPath = which.stdout.split(/\r?\n/)[0].trim());
  const guesses: string[] = [];
  if (WIN) {
    const la = process.env.LOCALAPPDATA ?? '';
    guesses.push(path.join(la, 'Microsoft', 'WinGet', 'Links', 'adb.exe'), path.join(la, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
    // winget paketi: …\WinGet\Packages\Google.PlatformTools_…\platform-tools\adb.exe
    try {
      const pk = path.join(la, 'Microsoft', 'WinGet', 'Packages');
      for (const d of fs.readdirSync(pk).filter(d => d.startsWith('Google.PlatformTools'))) guesses.push(path.join(pk, d, 'platform-tools', 'adb.exe'));
    } catch { /* yok */ }
  }
  return (adbPath = guesses.find(g => fs.existsSync(g)) ?? null);
}

/** adb yoksa Windows'ta winget ile kurar (Google'ın resmî Android platform araçları) */
function ensureAdb(): string {
  let a = findAdb();
  if (!a && WIN) {
    console.log('[android] adb kuruluyor (winget Google.PlatformTools)…');
    spawnSync('winget', ['install', '--id', 'Google.PlatformTools', '-e', '--accept-source-agreements', '--accept-package-agreements'], { stdio: 'inherit', timeout: 10 * 60_000 });
    adbPath = null;
    a = findAdb();
  }
  if (!a) throw new Error('adb bulunamadı. https://developer.android.com/tools/releases/platform-tools adresinden "SDK Platform-Tools for Windows" indirilip açılmalı (ya da winget install Google.PlatformTools).');
  return a;
}

function adb(args: string[], timeout = 20_000): Promise<{ ok: boolean; out: string }> {
  const exe = ensureAdb();
  return new Promise(resolve => {
    execFile(exe, args, { timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() }));
  });
}

interface Device { seri: string; model: string }
async function devices(): Promise<Device[]> {
  const r = await adb(['devices', '-l']);
  return r.out.split(/\r?\n/).slice(1)
    .map(l => /^(\S+)\s+device\b(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map(m => ({ seri: m[1], model: (/model:(\S+)/.exec(m[2])?.[1] ?? m[1]).replace(/_/g, ' ') }));
}

/** Bağlı tek cihaz; yoksa son adresle ve ağdaki (mDNS) kablosuz hata ayıklama ilanlarıyla bağlanmayı dener */
async function device(): Promise<Device> {
  let list = await devices();
  if (!list.length) {
    await reconnect();
    list = await devices();
  }
  if (!list.length) throw new Error('Telefon bağlı değil. Telefonda Kablosuz hata ayıklama açık mı, telefon ve bilgisayar aynı Wi-Fi\'de mi? İlk kez ise Ayarlar → Android telefon bölümünden eşleştirin.');
  const pref = readCfg().cihaz;
  return list.find(d => d.seri === pref) ?? list[0];
}

const HOSTPORT = /^[\w.-]+:\d{2,5}$/;

async function reconnect(): Promise<string | null> {
  const cfg = readCfg();
  // Telefon yeniden başlayınca bağlantı portu değişir; mDNS ilanı yeni portu söyler
  const m = await adb(['mdns', 'services'], 8000).catch(() => ({ ok: false, out: '' }));
  const announced = [...m.out.matchAll(/_adb-tls-connect\._tcp\.?\s+([\d.]+:\d+)/g)].map(x => x[1]);
  for (const addr of [...announced, ...(cfg.sonAdres ? [cfg.sonAdres] : [])]) {
    const r = await adb(['connect', addr], 10_000);
    if (/connected to|already connected/i.test(r.out)) {
      saveCfg({ ...cfg, sonAdres: addr });
      return addr;
    }
  }
  return null;
}

export async function pair(adres: string, kod: string): Promise<string> {
  if (!HOSTPORT.test(adres)) throw new Error('Eşleştirme adresi IP:port biçiminde olmalı (ör. 192.168.1.23:37155)');
  if (!/^\d{6}$/.test(kod)) throw new Error('Eşleştirme kodu 6 haneli olmalı');
  const r = await adb(['pair', adres, kod], 30_000);
  if (!/Successfully paired/i.test(r.out)) throw new Error(`Eşleştirilemedi: ${r.out.slice(0, 200) || 'cevap yok'}`);
  // Bağlantı adresi eşleştirme adresinden farklı porttadır: önce ağ ilanına bak
  await new Promise(res => setTimeout(res, 1500));
  const addr = await reconnect();
  return addr ? `Eşleştirildi ve bağlandı (${addr}).` : 'Eşleştirildi. Şimdi telefondaki "Kablosuz hata ayıklama" ekranının üstündeki IP adresi ve bağlantı noktasını "Bağlan" kutusuna yazın.';
}

export async function connect(adres: string): Promise<string> {
  if (!HOSTPORT.test(adres)) throw new Error('Adres IP:port biçiminde olmalı (ör. 192.168.1.23:41235)');
  const r = await adb(['connect', adres], 15_000);
  if (!/connected to|already connected/i.test(r.out)) throw new Error(`Bağlanılamadı: ${r.out.slice(0, 200)}`);
  saveCfg({ ...readCfg(), sonAdres: adres });
  return `Bağlandı (${adres}).`;
}

// ---------------------------------------------------------------- Uygulamalar

const PKG = /^[a-zA-Z][\w]*(\.[\w]+)+$/;

async function installedPackages(seri: string, all = false): Promise<string[]> {
  const r = await adb(['-s', seri, 'shell', 'pm', 'list', 'packages', ...(all ? [] : ['-3'])]);
  return r.out.split(/\r?\n/).map(l => l.replace(/^package:/, '').trim()).filter(p => PKG.test(p)).sort();
}

/** Google Play'de arama: uygulama adı → paket adı (ilk birkaç sonuç, adlarıyla) */
export async function playSearch(q: string): Promise<{ paket: string; ad: string }[]> {
  const get = (u: string) => fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'tr-TR,tr;q=0.9' }, signal: AbortSignal.timeout(15_000) }).then(r => (r.ok ? r.text() : ''));
  const html = await get(`https://play.google.com/store/search?q=${encodeURIComponent(q)}&c=apps&hl=tr&gl=TR`);
  const ids = [...new Set([...html.matchAll(/\/store\/apps\/details\?id=([\w.]+)/g)].map(m => m[1]))].filter(p => PKG.test(p)).slice(0, 5);
  return Promise.all(ids.map(async paket => ({ paket, ad: await playTitle(paket, get) })));
}

async function playTitle(paket: string, get?: (u: string) => Promise<string>): Promise<string> {
  const g = get ?? ((u: string) => fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'tr-TR' }, signal: AbortSignal.timeout(15_000) }).then(r => (r.ok ? r.text() : '')));
  const html = await g(`https://play.google.com/store/apps/details?id=${paket}&hl=tr&gl=TR`).catch(() => '');
  const t = /<title[^>]*>([^<]+)<\/title>/.exec(html)?.[1] ?? '';
  return t.replace(/\s*[-–]\s*Google Play.*$/i, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim() || paket;
}

/** Ekrandaki öğeler (uiautomator dökümü) */
async function screenNodes(seri: string): Promise<{ text: string; desc: string; x: number; y: number; enabled: boolean }[]> {
  const r = await adb(['-s', seri, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], 20_000);
  return [...r.out.matchAll(/<node\b[^>]*>/g)].map(([n]) => {
    const attr = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(n)?.[1] ?? '';
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'));
    return { text: attr('text'), desc: attr('content-desc'), enabled: attr('enabled') !== 'false', x: b ? (Number(b[1]) + Number(b[3])) >> 1 : -1, y: b ? (Number(b[2]) + Number(b[4])) >> 1 : -1 };
  });
}

const INSTALL = /^(Yükle|Install|Güncelle|Update)$/i;
const INSTALLED = /^(Aç|Open|Kaldır|Uninstall|Oyna|Play)$/i;
const PRICE = /(₺|TL|\$|€|£)\s*\d|\d[\d.,]*\s*(₺|TL)/;

async function installViaPlay(paket: string, ad: string): Promise<string> {
  const d = await device();
  await adb(['-s', d.seri, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  const r = await adb(['-s', d.seri, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `market://details?id=${paket}`, '-p', 'com.android.vending']);
  if (/Error|Exception/i.test(r.out)) throw new Error(`Play Store açılamadı: ${r.out.slice(0, 160)}`);
  for (let i = 0; i < 6; i++) {
    await new Promise(res => setTimeout(res, 2500));
    const nodes = await screenNodes(d.seri).catch(() => []);
    if (!nodes.length) continue;
    const label = (n: { text: string; desc: string }) => (n.text || n.desc).trim();
    if (nodes.some(n => INSTALLED.test(label(n)))) return `${ad} telefonda zaten yüklü.`;
    const btn = nodes.find(n => n.enabled && n.x >= 0 && INSTALL.test(label(n)));
    if (btn) {
      await adb(['-s', d.seri, 'shell', 'input', 'tap', String(btn.x), String(btn.y)]);
      return `${ad} için Google Play'de "${label(btn)}" düğmesine basıldı; yükleme telefonda sürüyor (${d.model}).`;
    }
    const paid = nodes.find(n => n.enabled && PRICE.test(label(n)) && label(n).length < 20);
    if (paid) return `${ad} ücretli (${label(paid)}). Satın almayı Jarvis yapmaz; Play Store sayfası telefonda açık, isterseniz kendiniz satın alın.`;
  }
  return `${ad} Play Store sayfası telefonda açıldı ama "Yükle" düğmesi bulunamadı (ekran kilitli olabilir). Telefonda "Yükle"ye dokunun.`;
}

async function uninstall(seri: string, paket: string, ad: string): Promise<string> {
  const r = await adb(['-s', seri, 'uninstall', paket], 60_000);
  if (!/Success/i.test(r.out)) throw new Error(`Kaldırılamadı: ${r.out.slice(0, 200)}`);
  return `${ad} telefondan kaldırıldı.`;
}

/** Ad ya da paket adı → telefonda yüklü (kullanıcı) paketi */
async function resolveInstalled(seri: string, q: string): Promise<{ paket: string; ad: string } | { hata: string }> {
  const user = await installedPackages(seri);
  if (PKG.test(q)) {
    if (user.includes(q)) return { paket: q, ad: await playTitle(q) };
    const all = await installedPackages(seri, true);
    return { hata: all.includes(q) ? `${q} bir sistem uygulaması; Jarvis sistem uygulamalarını kaldırmaz.` : `${q} telefonda yüklü değil.` };
  }
  // Önce Play araması (ad → paket), sonra paket adında kelime eşleşmesi
  const hits = await playSearch(q).catch(() => []);
  const byPlay = hits.find(h => user.includes(h.paket));
  if (byPlay) return byPlay;
  const w = q.toLocaleLowerCase('tr').replace(/[^a-z0-9]/g, '');
  const byName = w.length >= 3 ? user.filter(p => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(w)) : [];
  if (byName.length === 1) return { paket: byName[0], ad: await playTitle(byName[0]) };
  if (byName.length > 1) return { hata: `Birden çok eşleşme var: ${byName.slice(0, 6).join(', ')}. Paket adıyla söyle.` };
  return { hata: `"${q}" telefonda yüklü uygulamalar arasında bulunamadı.` };
}

// ---------------------------------------------------------------- Durum

export async function androidStatus(): Promise<{ adb: boolean; bagli: boolean; cihaz?: string; sonAdres?: string; hata?: string }> {
  if (!findAdb()) return { adb: false, bagli: false };
  try {
    const list = await devices();
    return { adb: true, bagli: list.length > 0, cihaz: list[0]?.model, sonAdres: readCfg().sonAdres };
  } catch (e: any) {
    return { adb: true, bagli: false, hata: String(e?.message || e).slice(0, 160) };
  }
}

export function initAndroid() {
  // Açılışta (ve 5 dakikada bir) daha önce eşleştirilmiş telefona sessizce yeniden bağlan
  const tick = async () => { try { if (findAdb() && readCfg().sonAdres && !(await devices()).length) await reconnect(); } catch { /* sessiz */ } };
  setTimeout(tick, 15_000).unref();
  setInterval(tick, 5 * 60_000).unref();
}

// ---------------------------------------------------------------- Model araçları

export const ANDROID_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'android_uygulamalar',
      description: "Kullanıcının Android telefonundaki (kablosuz ADB ile bağlı) yüklü uygulamaları listeler ya da Google Play'de uygulama arar (play_ara). 'Telefonumda hangi uygulamalar var', 'Play'de X var mı' gibi.",
      parameters: { type: 'object', properties: { ara: { type: 'string', description: 'Paket adında geçen kelime (yüklü listede filtre)' }, play_ara: { type: 'string', description: 'Google Play\'de aranacak uygulama adı' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'android_yukle',
      description: "Telefona Google Play'den ÜCRETSİZ uygulama yükler: Play sayfasını telefonda açar ve 'Yükle'ye basar. Onay kartı açar. Ücretli uygulamada satın almaz. Ad ya da paket adı (com.whatsapp gibi) verilebilir.",
      parameters: { type: 'object', properties: { uygulama: { type: 'string' } }, required: ['uygulama'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'android_kaldir',
      description: 'Telefondan uygulama kaldırır (yalnızca kullanıcının yüklediği uygulamalar; sistem uygulamaları değil). Onay kartı açar; uygulamanın verileri de silinir.',
      parameters: { type: 'object', properties: { uygulama: { type: 'string', description: 'Ad ya da paket adı' } }, required: ['uygulama'] },
    },
  },
] as const;

export const isAndroidTool = (n: string) => ANDROID_TOOLS.some(t => t.function.name === n);

export async function runAndroidTool(name: string, args: any, progress: (l: string) => void): Promise<string> {
  try {
    if (name === 'android_uygulamalar') {
      if (args.play_ara) {
        progress(`Google Play'de aranıyor: ${args.play_ara}`);
        return JSON.stringify({ sonuclar: await playSearch(String(args.play_ara)) });
      }
      const d = await device();
      progress(`${d.model}: uygulamalar okunuyor`);
      const q = String(args.ara ?? '').toLowerCase();
      const list = (await installedPackages(d.seri)).filter(p => !q || p.toLowerCase().includes(q));
      return JSON.stringify({ cihaz: d.model, adet: list.length, paketler: list.slice(0, 300), not: 'Bunlar paket adları; bilinenleri (com.whatsapp = WhatsApp gibi) adıyla söyle.' });
    }
    const q = String(args.uygulama ?? '').trim().slice(0, 100);
    if (!q) return JSON.stringify({ hata: 'uygulama adı boş' });
    const d = await device();
    if (name === 'android_yukle') {
      progress(`Google Play'de aranıyor: ${q}`);
      let hit: { paket: string; ad: string } | undefined;
      if (PKG.test(q)) hit = { paket: q, ad: await playTitle(q) };
      else hit = (await playSearch(q))[0];
      if (!hit) return JSON.stringify({ hata: `Google Play'de "${q}" bulunamadı` });
      if ((await installedPackages(d.seri, true)).includes(hit.paket)) return JSON.stringify({ sonuc: `${hit.ad} (${hit.paket}) telefonda zaten yüklü.` });
      return propose('uygulama', `Telefona yükle: ${hit.ad}`, `Google Play: https://play.google.com/store/apps/details?id=${hit.paket}\nPaket: ${hit.paket}\nCihaz: ${d.model}`,
        'Jarvis telefonda bu uygulamanın Google Play sayfasını açıp "Yükle"ye basacak. Ücretliyse satın almaz. Doğru uygulama olduğundan emin olun (geliştiriciye bakmak için linke tıklayın).',
        () => installViaPlay(hit!.paket, hit!.ad));
    }
    if (name === 'android_kaldir') {
      progress(`telefonda aranıyor: ${q}`);
      const r = await resolveInstalled(d.seri, q);
      if ('hata' in r) return JSON.stringify(r);
      return propose('uygulama', `Telefondan kaldır: ${r.ad}`, `Paket: ${r.paket}\nCihaz: ${d.model}`, 'Uygulama ve bu telefondaki verileri silinir. Google Play\'den yeniden yüklenebilir.', () => uninstall(d.seri, r.paket, r.ad));
    }
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 300) });
  }
  return JSON.stringify({ hata: 'bilinmeyen araç' });
}

export function androidForPrompt(): string {
  const c = readCfg();
  return c.sonAdres ? 'eşleştirilmiş (kablosuz ADB)' : 'eşleştirilmemiş';
}

// ---------------------------------------------------------------- HTTP (Ayarlar)

export function androidRouter(): Router {
  const r = express.Router();
  r.use('/api/android', adminOnly);
  r.get('/api/android', async (_req, res) => res.json(await androidStatus()));
  const wrap = (fn: (b: any) => Promise<string>) => async (req: express.Request, res: express.Response) => {
    try { res.json({ ...(await androidStatus()), mesaj: await fn(req.body ?? {}) }); }
    catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
  };
  r.post('/api/android/eslestir', wrap(b => pair(String(b.adres ?? '').trim(), String(b.kod ?? '').trim())));
  r.post('/api/android/baglan', wrap(b => connect(String(b.adres ?? '').trim())));
  r.post('/api/android/kur', wrap(async () => { ensureAdb(); return 'adb hazır.'; }));
  return r;
}
