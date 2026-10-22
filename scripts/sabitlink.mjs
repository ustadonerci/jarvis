// Sabit telefon linki: Tailscale Funnel (ücretsiz). Bilgisayara https://<bilgisayar>.<ağ>.ts.net gibi hiç değişmeyen
// bir adres verir. İlk seferde bir kez kurulum ve Google/Microsoft hesabıyla giriş gerekir (tarayıcı kendiliğinden açılır);
// sonra her açılışta aynı link kullanılır. Funnel ayarı Tailscale'de kalıcıdır.
// Telefonda Tailscale uygulaması gerekmez: link herkese açık internetten açılır, Jarvis'e girmek için anahtar (token) ister.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WIN = process.platform === 'win32';

function findTailscale() {
  const which = spawnSync(WIN ? 'where' : 'which', ['tailscale'], { encoding: 'utf8' });
  if (which.status === 0) return which.stdout.split(/\r?\n/)[0].trim();
  const guesses = WIN
    ? [`${process.env.ProgramFiles}\\Tailscale\\tailscale.exe`, `${process.env['ProgramFiles(x86)']}\\Tailscale\\tailscale.exe`]
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  return guesses.find(g => g && fs.existsSync(g)) ?? null;
}

/** Komutu çalıştırır; çıktıda giriş/izin linki görünürse onUrl'e verir. Süre dolarsa durdurur. */
function run(exe, args, { timeout, onUrl }) {
  return new Promise(resolve => {
    const c = spawn(exe, args, { windowsHide: true });
    let out = '';
    let asked = false;
    const t = setTimeout(() => c.kill(), timeout);
    const on = d => {
      out += d.toString();
      const u = /https:\/\/login\.tailscale\.com\/[^\s"']+/.exec(out)?.[0];
      if (u && !asked) { asked = true; onUrl?.(u); }
    };
    c.stdout.on('data', on);
    c.stderr.on('data', on);
    c.on('error', () => { clearTimeout(t); resolve({ code: -1, out }); });
    c.on('exit', code => { clearTimeout(t); resolve({ code, out, asked }); });
  });
}

async function status(exe) {
  const r = await run(exe, ['status', '--json'], { timeout: 20_000 });
  try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return null; }
}

/**
 * Funnel'ı localPort'a yönlendirir ve sabit adresi döndürür (https://…ts.net) ya da null.
 * interaktif=false iken (Windows açılışında) kurulum/giriş yapılmaz: yalnızca hazırsa kullanılır.
 */
export async function sabitLink({ localPort, interaktif, dataDir, log, openUrl }) {
  let exe = findTailscale();
  const denendi = path.join(dataDir, 'tailscale-kurulamadi');
  if (!exe) {
    if (!interaktif || !WIN || fs.existsSync(denendi)) return null;
    log('Sabit telefon linki için Tailscale kuruluyor (bir kez). Windows "Evet" sorarsa onaylayın…');
    spawnSync('winget', ['install', '--id', 'Tailscale.Tailscale', '-e', '--accept-source-agreements', '--accept-package-agreements'], { stdio: 'inherit' });
    exe = findTailscale();
    if (!exe) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(denendi, new Date().toISOString());
      log('Tailscale kurulamadı; değişen link kullanılacak. Tekrar denemek için server/data/tailscale-kurulamadi dosyasını silin.');
      return null;
    }
    // Hizmetin ayağa kalkması birkaç saniye sürer
    await new Promise(r => setTimeout(r, 8000));
  }

  let st = await status(exe);
  if (st?.BackendState !== 'Running') {
    if (!interaktif) return null;
    log('Tailscale girişi gerekiyor: açılan sayfada Google ya da Microsoft hesabınızla giriş yapın (bir kez).');
    await run(exe, ['up'], { timeout: 10 * 60_000, onUrl: u => { log(`Giriş sayfası: ${u}`); openUrl(u); } });
    st = await status(exe);
    if (st?.BackendState !== 'Running') { log('Tailscale girişi tamamlanmadı; şimdilik değişen link kullanılacak.'); return null; }
  }
  const host = String(st?.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!host.endsWith('.ts.net')) { log('Tailscale adresi alınamadı (MagicDNS kapalı olabilir).'); return null; }

  // İlk seferde Tailscale "Funnel'ı aç" izni ister: sayfada Enable'a basmak yeterli
  const r = await run(exe, ['funnel', '--bg', String(localPort)], {
    timeout: interaktif ? 10 * 60_000 : 30_000,
    onUrl: u => {
      if (!interaktif) return;
      log(`Tailscale bir kez izin istiyor: açılan sayfada "Enable" düğmesine basın. (${u})`);
      openUrl(u);
    },
  });
  if (r.code !== 0) { log(`Sabit link açılamadı (Tailscale funnel, kod ${r.code}); değişen link kullanılacak.`); return null; }
  return `https://${host}`;
}
