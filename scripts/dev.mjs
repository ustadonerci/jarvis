// Sunucuyu ve arayüzü birlikte başlatır: npm run dev
// JARVIS_DEV: sunucu Ayarlar'dan anahtar kaydedilince kendini yeniden başlatabilir (tsx watch).
// Başlamadan önce eksik paketleri kurar (güncellemeden sonra "npm run setup" unutulursa sunucu açılmıyordu) ve
// sunucu açılamazsa hatasını en altta, kolay görülür biçimde tekrar yazar.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';

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

// Sunucunun son çıktısı: açılamazsa en altta tekrar gösterilir
const serverLog = [];
const run = (name, args) => {
  const p = spawn('npm', args, { stdio: 'pipe', shell: WIN, env: { ...process.env, JARVIS_DEV: '1' } });
  const tag = name === 'server' ? '\x1b[36m[sunucu]\x1b[0m' : '\x1b[33m[arayüz]\x1b[0m';
  const keep = (d) => { if (name === 'server') { serverLog.push(...d.toString().split('\n').filter(Boolean)); serverLog.splice(0, Math.max(0, serverLog.length - 25)); } };
  p.stdout.on('data', d => { keep(d); process.stdout.write(d.toString().split('\n').filter(Boolean).map(l => `${tag} ${l}`).join('\n') + '\n'); });
  p.stderr.on('data', d => { keep(d); process.stderr.write(`${tag} ${d}`); });
  return p;
};
const ps = [run('server', ['--prefix', 'server', 'run', 'dev']), run('web', ['--prefix', 'web', 'run', 'dev'])];
process.on('SIGINT', () => { ps.forEach(p => p.kill()); process.exit(0); });

// 40 sn içinde sunucu 8787'de dinlemiyorsa hatayı göze çarpacak biçimde yaz
const port = Number(/^PORT=(\d+)/m.exec(fs.readFileSync(env, 'utf8'))?.[1] || 8787);
const listening = () => new Promise(res => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
});
setTimeout(async () => {
  if (await listening()) return;
  const bar = '!'.repeat(70);
  console.error(`\n\x1b[41m\x1b[37m${bar}\n JARVIS SUNUCUSU AÇILAMADI. Sebebi aşağıdaki satırlarda; bu kutuyu Claude'a gönderin.\n${bar}\x1b[0m`);
  console.error(serverLog.join('\n') || '(sunucu hiçbir şey yazmadı)');
  console.error(`\x1b[41m\x1b[37m${bar}\x1b[0m\n`);
}, 40_000).unref();
