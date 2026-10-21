// Telefondan kullanım: npm run telefon
// 1) server/.env'de ACCESS_TOKEN yoksa rastgele üretir (link bilinmeden kimse Jarvis'e erişemesin).
// 2) cloudflared yoksa Windows'ta winget ile kurar.
// 3) Jarvis'i başlatır, ücretsiz bir Cloudflare tüneli açar ve telefonda açılacak linki + QR kodunu yazar.
// Link her çalıştırmada değişir (ücretsiz "quick tunnel"); bu pencere açık kaldıkça çalışır.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, 'server', '.env');
const WIN = process.platform === 'win32';

// ---- 1) Erişim anahtarı
if (!fs.existsSync(ENV)) fs.copyFileSync(path.join(ROOT, 'server', '.env.example'), ENV);
let env = fs.readFileSync(ENV, 'utf8');
let token = /^ACCESS_TOKEN=(.+)$/m.exec(env)?.[1]?.trim();
if (!token) {
  token = randomBytes(18).toString('base64url');
  env = /^ACCESS_TOKEN=.*$/m.test(env) ? env.replace(/^ACCESS_TOKEN=.*$/m, () => `ACCESS_TOKEN=${token}`) : `${env.replace(/\n*$/, '\n')}ACCESS_TOKEN=${token}\n`;
  fs.writeFileSync(ENV, env);
  console.log('Erişim anahtarı oluşturuldu (server/.env → ACCESS_TOKEN).');
}

// ---- 2) cloudflared
function findCloudflared() {
  const which = spawnSync(WIN ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  if (which.status === 0) return which.stdout.split(/\r?\n/)[0].trim();
  const guesses = WIN
    ? [`${process.env['ProgramFiles(x86)']}\\cloudflared\\cloudflared.exe`, `${process.env.ProgramFiles}\\cloudflared\\cloudflared.exe`, `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\cloudflared.exe`]
    : ['/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared'];
  return guesses.find(g => g && fs.existsSync(g)) ?? null;
}
let cf = findCloudflared();
if (!cf && WIN) {
  console.log('Cloudflare tüneli (cloudflared) kuruluyor; "Evet" sorusu çıkarsa onaylayın…');
  spawnSync('winget', ['install', '--id', 'Cloudflare.cloudflared', '-e', '--accept-source-agreements', '--accept-package-agreements'], { stdio: 'inherit' });
  cf = findCloudflared();
}
if (!cf) {
  console.error('\n[HATA] cloudflared bulunamadı. https://github.com/cloudflare/cloudflared/releases adresinden "cloudflared-windows-amd64.msi" indirip kurun, sonra tekrar deneyin.');
  process.exit(1);
}

// ---- 3) Jarvis + tünel
const jarvis = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev.mjs')], { cwd: ROOT, stdio: 'inherit' });
const tunnel = spawn(cf, ['tunnel', '--no-autoupdate', '--url', 'http://localhost:5173'], { cwd: ROOT });
let shown = false;
const onData = async (d) => {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
  if (!m || shown) return;
  shown = true;
  const link = `${m[0]}/?token=${token}`;
  fs.writeFileSync(path.join(ROOT, 'telefon-linki.txt'), `${link}\n`);
  let qr = '';
  try {
    const QRCode = createRequire(path.join(ROOT, 'server', 'package.json'))('qrcode');
    qr = await QRCode.toString(link, { type: 'terminal', small: true });
  } catch { /* qrcode yoksa yalnızca link */ }
  console.log(`\n${'='.repeat(70)}\n TELEFONDA AÇIN (kamerayla QR'ı okutun ya da linki kendinize gönderin):\n\n ${link}\n\n${qr}\n Link telefon-linki.txt dosyasına da yazıldı. Bu pencere açık kaldıkça çalışır.\n Linki kimseyle paylaşmayın: içindeki anahtar Jarvis'inize erişim sağlar.\n${'='.repeat(70)}\n`);
};
tunnel.stdout.on('data', onData);
tunnel.stderr.on('data', onData);
tunnel.on('exit', code => { if (!shown) console.error(`\n[HATA] Tünel açılamadı (kod ${code}). İnternet bağlantınızı kontrol edip tekrar deneyin.`); });

const stop = () => { tunnel.kill(); jarvis.kill(); process.exit(0); };
process.on('SIGINT', stop);
jarvis.on('exit', () => tunnel.kill());
