// Telefondan kullanım: npm run telefon (masaüstündeki Jarvis.bat bunu kendisi çalıştırır)
// 1) server/.env'de ACCESS_TOKEN yoksa rastgele üretir (link bilinmeden kimse Jarvis'e erişemesin).
// 2) SABİT LİNK: Tailscale Funnel ile hiç değişmeyen bir adres (ilk seferde bir kez kurulum + giriş; scripts/sabitlink.mjs).
//    Olmazsa (ya da SABIT_LINK=0 ise) ücretsiz Cloudflare tüneli: link her açılışta değişir.
// 3) Telefondan gelen her istek önce buradaki "kapı"dan (yerel 5174) geçer; kapı isteğe x-jarvis-uzak başlığı ekler,
//    böylece Jarvis tünelden gelen isteği asla "bu bilgisayardan" saymaz ve anahtar (token) ister.
// Yeni link Jarvis'e bildirilir; WhatsApp bağlıysa Jarvis linki size (kendinize yazdığınız sohbete) gönderir.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baslaticiyaYonlendir } from './guncelleme.mjs';
import { sabitLink } from './sabitlink.mjs';

if (baslaticiyaYonlendir()) await new Promise(() => {});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, 'server', '.env');
const WIN = process.platform === 'win32';
const KAPI = 5174;
const LINK_FILE = path.join(ROOT, 'telefon-linki.txt');
const envOf = (k) => new RegExp(`^\\s*${k}\\s*=\\s*(.*)$`, 'm').exec(fs.readFileSync(ENV, 'utf8'))?.[1]?.trim() ?? '';
const openUrl = (u) => WIN && spawn('cmd', ['/c', 'start', '', u.replace(/&/g, '^&')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

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

// ---- 2) Kapı: tünelden gelen her isteği "uzak" diye işaretleyip arayüze (Vite, 5173) iletir
const UZAK = 'x-jarvis-uzak';
const fwdHeaders = (raw) => {
  const h = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() !== UZAK) h.push(raw[i], raw[i + 1]);
  return [...h, UZAK, '1'];
};
const kapi = http.createServer((req, res) => {
  const p = http.request({ host: '127.0.0.1', port: 5173, method: req.method, path: req.url, headers: fwdHeaders(req.rawHeaders) }, r => {
    res.writeHead(r.statusCode ?? 502, r.rawHeaders);
    r.pipe(res);
  });
  p.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Jarvis açılıyor, birkaç saniye sonra sayfayı yenileyin.'); });
  req.pipe(p);
});
// Canlı yenileme (websocket) bağlantıları
kapi.on('upgrade', (req, sock, head) => {
  const up = net.connect(5173, '127.0.0.1', () => {
    const h = fwdHeaders(req.rawHeaders);
    let txt = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < h.length; i += 2) txt += `${h[i]}: ${h[i + 1]}\r\n`;
    up.write(`${txt}\r\n`);
    if (head?.length) up.write(head);
    sock.pipe(up).pipe(sock);
  });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});
kapi.on('error', e => console.error(`[telefon] kapı açılamadı (port ${KAPI}): ${e.message}`));
kapi.listen(KAPI, '127.0.0.1');

// ---- 3) Jarvis
const jarvis = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev.mjs')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, JARVIS_BASLAT: '1' } });
let tunnel = null;
let stopping = false;

/** Yeni linki Jarvis'e bildirir (sunucu henüz açılmadıysa bekler) */
async function report(link) {
  for (let i = 0; i < 60 && !stopping; i++) {
    try {
      const r = await fetch('http://localhost:8787/api/telefon-linki', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link }), signal: AbortSignal.timeout(5000) });
      if (r.ok) return;
    } catch { /* sunucu açılıyor */ }
    await new Promise(r => setTimeout(r, 3000));
  }
}

async function showLink(link, sabit) {
  let prev = '';
  try { prev = fs.readFileSync(LINK_FILE, 'utf8').trim(); } catch { /* ilk sefer */ }
  fs.writeFileSync(LINK_FILE, `${link}\n`);
  let qr = '';
  try {
    const QRCode = createRequire(path.join(ROOT, 'server', 'package.json'))('qrcode');
    qr = await QRCode.toString(link, { type: 'terminal', small: true });
  } catch { /* qrcode yoksa yalnızca link */ }
  const not = sabit
    ? ' Bu link SABİT: hiç değişmez. Telefonda bir kez açıp tarayıcı menüsünden "Ana ekrana ekle" deyin;\n Jarvis telefonda uygulama gibi durur.'
    : ' Link her açılışta değişir (sabit link için Tailscale kurulumu tamamlanmadı).';
  console.log(`\n${'='.repeat(70)}\n TELEFONDA AÇIN (kamerayla QR'ı okutun; WhatsApp bağlıysa link size de gönderilir):\n\n ${link}\n\n${qr}\n${not}\n Link telefon-linki.txt dosyasına da yazıldı. Linki kimseyle paylaşmayın: içindeki anahtar Jarvis'inize erişim sağlar.\n${'='.repeat(70)}\n`);
  // Sabit link zaten gönderildiyse her açılışta tekrar gönderme
  if (link !== prev) report(link);
}

// ---- 4) Sabit link (Tailscale), olmazsa Cloudflare
function findCloudflared() {
  const which = spawnSync(WIN ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  if (which.status === 0) return which.stdout.split(/\r?\n/)[0].trim();
  const guesses = WIN
    ? [`${process.env['ProgramFiles(x86)']}\\cloudflared\\cloudflared.exe`, `${process.env.ProgramFiles}\\cloudflared\\cloudflared.exe`, `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\cloudflared.exe`]
    : ['/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared'];
  return guesses.find(g => g && fs.existsSync(g)) ?? null;
}

function startTunnel(cf) {
  let shown = false;
  tunnel = spawn(cf, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${KAPI}`], { cwd: ROOT, windowsHide: true });
  const onData = (d) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
    if (!m || shown || m[0].includes('api.trycloudflare')) return;
    shown = true;
    showLink(`${m[0]}/?token=${token}`, false);
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  tunnel.on('exit', code => {
    if (stopping) return;
    // İnternet kopması, uyku modu vb.: 20 sn sonra yeni tünel (link değişir, yenisi gösterilir/gönderilir)
    console.error(`\n[telefon] Tünel kapandı (kod ${code}); 20 sn sonra yeniden açılacak.`);
    setTimeout(() => !stopping && startTunnel(cf), 20_000);
  });
}

(async () => {
  if (envOf('SABIT_LINK') !== '0') {
    const host = await sabitLink({
      localPort: KAPI,
      interaktif: process.env.JARVIS_OTO !== '1',
      dataDir: path.join(ROOT, 'server', 'data'),
      log: m => console.log(`\x1b[35m[telefon]\x1b[0m ${m}`),
      openUrl,
    }).catch(e => { console.error(`[telefon] sabit link: ${e?.message || e}`); return null; });
    if (stopping) return;
    if (host) return showLink(`${host}/?token=${token}`, true);
  }
  let cf = findCloudflared();
  if (!cf && WIN) {
    console.log('Cloudflare tüneli (cloudflared) kuruluyor; "Evet" sorusu çıkarsa onaylayın…');
    spawnSync('winget', ['install', '--id', 'Cloudflare.cloudflared', '-e', '--accept-source-agreements', '--accept-package-agreements'], { stdio: 'inherit' });
    cf = findCloudflared();
  }
  if (!cf) return console.error('\n[UYARI] Telefon bağlantısı açılamadı; Jarvis yalnızca bu bilgisayarda çalışıyor.\n');
  startTunnel(cf);
})();

const stop = () => { stopping = true; tunnel?.kill(); jarvis.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
jarvis.on('exit', code => { stopping = true; tunnel?.kill(); process.exit(code ?? 0); });
