// Sunucuyu ve arayüzü birlikte başlatır: npm run dev
//
// Windows'ta "npm --prefix server run dev" (tsx watch, npm + kabuk katmanı) ile sunucu açılmazken aynı kod
// "npx tsx src/index.ts" ile açılıyordu. Bu yüzden ikisi de npm/kabuk olmadan, doğrudan Node ile başlatılır:
// sunucu node --import tsx ile (izleme modu yok), arayüz Vite'ın kendi giriş dosyasıyla.
// - Ayarlar'dan anahtar kaydedilince sunucu 75 koduyla çıkar (JARVIS_DEV=1); burada hemen yeniden açılır.
// - Sunucu başka bir sebeple kapanırsa hatası kırmızı kutuyla gösterilir ve 5 sn sonra yeniden denenir.
// - Başlamadan önce eksik paketler kurulur, .env yoksa oluşturulur.
// - JARVIS_GUNCELLE=1 ise (masaüstündeki Jarvis.bat) 3 dakikada bir GitHub'da yeni sürüm aranır ve uygulanır:
//   arayüz değişiklikleri sayfaya kendiliğinden gelir, sunucu değişikliklerinde sunucu yeniden başlar (Jarvis bir
//   cevabı hazırlıyorsa bitmesi beklenir), paket/başlatıcı değişikliklerinde 76 koduyla çıkılır ve hepsi yeniden açılır.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baslaticiyaYonlendir, etki, guncelle } from './guncelleme.mjs';

if (baslaticiyaYonlendir()) await new Promise(() => {});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const RESTART_CODE = 75;
const UPDATE_EXIT = 76;
const UPDATE_EVERY = (Number(process.env.JARVIS_GUNCELLE_SN) || 180) * 1000;

/** package.json'daki her bağımlılık node_modules'ta var mı? Yoksa o klasörde npm install. */
function ensureDeps(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
  const missing = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter(d => !fs.existsSync(path.join(ROOT, dir, 'node_modules', ...d.split('/'), 'package.json')));
  if (!missing.length) return;
  console.log(`\n[kurulum] ${dir}: eksik paketler kuruluyor (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''})…\n`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: path.join(ROOT, dir), stdio: 'inherit', shell: WIN });
  if (r.status !== 0) console.error(`\n[kurulum] ${dir} paketleri kurulamadı (kod ${r.status}). Yukarıdaki hatayı Claude'a gönderin.\n`);
}
ensureDeps('server');
ensureDeps('web');
const env = path.join(ROOT, 'server', '.env');
if (!fs.existsSync(env)) fs.copyFileSync(path.join(ROOT, 'server', '.env.example'), env);

const TAGS = { server: '\x1b[36m[sunucu]\x1b[0m', web: '\x1b[33m[arayüz]\x1b[0m' };
const serverLog = [];
let proxyNoted = false;
let stopping = false;

/** Çıktıyı etiketleyerek yazar. Sunucu kapalıyken Vite'ın her saniye yazdığı proxy hatalarını bir kez gösterir. */
function pipe(name, child) {
  const out = (d, stream) => {
    const lines = d.toString().split(/\r?\n/).filter(Boolean);
    if (name === 'server') { serverLog.push(...lines); serverLog.splice(0, Math.max(0, serverLog.length - 25)); }
    const shown = lines.filter(l => name !== 'web' || !/http proxy error|ECONNREFUSED|internalConnectMultiple|afterConnectMultiple/.test(l) || (!proxyNoted && (proxyNoted = true)));
    if (shown.length) stream.write(shown.map(l => `${TAGS[name]} ${l}`).join('\n') + '\n');
  };
  child.stdout.on('data', d => out(d, process.stdout));
  child.stderr.on('data', d => out(d, process.stderr));
}

function banner(code) {
  const bar = '!'.repeat(70);
  console.error(`\n\x1b[41m\x1b[37m${bar}\n JARVIS SUNUCUSU KAPANDI (kod ${code}). Sebebi aşağıda; bu kutuyu Claude'a gönderin. 5 sn sonra yeniden denenecek.\n${bar}\x1b[0m`);
  console.error(serverLog.join('\n') || '(sunucu hiçbir şey yazmadı)');
  console.error(`\x1b[41m\x1b[37m${bar}\x1b[0m\n`);
}

let server = null;
let updating = false;
function startServer() {
  serverLog.length = 0;
  // tsx Node'un içine yüklenir (--import): tek süreç olur, kapatınca arkada sunucu kalmaz
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, JARVIS_DEV: '1' },
    windowsHide: true,
  });
  pipe('server', server);
  server.on('exit', code => {
    if (stopping) return;
    if (code === RESTART_CODE || updating) {
      console.log(`${TAGS.server} ${updating ? 'yeni sürümle' : 'yeni ayarlarla'} yeniden başlatılıyor…`);
      updating = false;
      proxyNoted = false;
      return startServer();
    }
    banner(code);
    setTimeout(startServer, 5000);
  });
}

const web = spawn(process.execPath, [path.join(ROOT, 'web', 'node_modules', 'vite', 'bin', 'vite.js')], {
  cwd: path.join(ROOT, 'web'),
  env: process.env,
  windowsHide: true,
});
pipe('web', web);
web.on('exit', code => { if (!stopping) console.error(`${TAGS.web} arayüz kapandı (kod ${code})`); });

startServer();

const stop = (code = 0) => {
  stopping = true;
  server?.kill();
  web.kill();
  process.exit(code);
};

// ---- Otomatik güncelleme
const idle = async () => {
  try { return !(await (await fetch('http://localhost:8787/api/state', { signal: AbortSignal.timeout(5000) })).json()).mesgul; } catch { return true; }
};
async function checkUpdate() {
  const g = await guncelle();
  const e = g && etki(g.degisen);
  if (!e) return;
  console.log(`\n\x1b[32m[güncelleme]\x1b[0m Yeni sürüm indirildi (${g.degisen.length} dosya).`);
  if (g.yedek) console.log(`\x1b[32m[güncelleme]\x1b[0m Bu bilgisayardaki kod değişiklikleri yedeklendi: ${g.yedek}`);
  if (e === 'arayuz') return console.log('\x1b[32m[güncelleme]\x1b[0m Arayüz güncellendi; sayfa kendiliğinden yenilenir.');
  // Jarvis bir cevabı hazırlıyorsa bitmesini bekle (en fazla 10 dk)
  for (let i = 0; i < 60 && !(await idle()); i++) await new Promise(r => setTimeout(r, 10_000));
  if (e === 'tam') {
    console.log('\x1b[32m[güncelleme]\x1b[0m Paketler/başlatıcı değişti; Jarvis baştan açılıyor…');
    return stop(UPDATE_EXIT);
  }
  console.log('\x1b[32m[güncelleme]\x1b[0m Sunucu yeni sürümle yeniden başlatılıyor…');
  updating = true;
  server?.kill();
}
if (process.env.JARVIS_GUNCELLE === '1') {
  let running = false;
  setInterval(async () => {
    if (running || stopping) return;
    running = true;
    try { await checkUpdate(); } catch (err) { console.warn(`[güncelleme] kontrol başarısız: ${err?.message || err}`); } finally { running = false; }
  }, UPDATE_EVERY);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
