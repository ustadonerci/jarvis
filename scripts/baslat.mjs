// Masaüstündeki Jarvis.bat bunu çalıştırır: güncelle → paketleri kur → ayarları kontrol et → Jarvis + telefon tüneli.
// - Jarvis zaten açıksa yenisini başlatmaz; tarayıcıyı açar ve telefon linkini gösterir.
// - Masaüstüne Jarvis.bat'ı, Windows açılışına da otomatik başlatmayı ekler (server/.env'de OTOMATIK_BASLAT=0 ise kaldırır).
// - Çalışırken yeni sürüm çıkarsa dev.mjs uygular; başlatıcı ya da paketler değiştiyse 76 koduyla çıkılır ve
//   Jarvis.bat bu dosyayı yeniden çalıştırır. Çıkış kodları: 76 yeniden başlat (güncelleme uygulandı),
//   77 zaten açıktı, 78 baştan başla (başlatıcının kendisi güncellendi).
// Argüman "oto": Windows açılışında başlatıldı (tarayıcı açılmaz).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, guncelle } from './guncelleme.mjs';

const WIN = process.platform === 'win32';
const OTO = process.argv.includes('oto');
const YENIDEN = process.env.JARVIS_YENIDEN === '1';
const ENV = path.join(ROOT, 'server', '.env');
const LINK_FILE = path.join(ROOT, 'telefon-linki.txt');
const say = (m) => console.log(`\x1b[36m[jarvis]\x1b[0m ${m}`);

const up = async (url) => { try { return (await fetch(url, { signal: AbortSignal.timeout(2500) })).ok; } catch { return false; } };
const openBrowser = () => WIN && spawn('cmd', ['/c', 'start', '', 'http://localhost:5173'], { detached: true, stdio: 'ignore' }).unref();
const envValue = (k) => { try { return new RegExp(`^\\s*${k}\\s*=\\s*(.*)$`, 'm').exec(fs.readFileSync(ENV, 'utf8'))?.[1]?.trim() ?? ''; } catch { return ''; } };

// ---- Zaten açık mı?
if (!YENIDEN && await up('http://localhost:8787/api/state')) {
  say(`Jarvis zaten açık (arka planda çalışıyor).${OTO ? '' : ' Tarayıcı açılıyor.'}`);
  if (!OTO) openBrowser();
  if (fs.existsSync(LINK_FILE)) say(`Telefon linki: ${fs.readFileSync(LINK_FILE, 'utf8').trim()}`);
  say('Bu pencere 20 sn sonra kendiliğinden kapanır.');
  setTimeout(() => process.exit(77), 20_000);
} else {
  await main();
}

async function main() {
  if (WIN) {
    // Yanıt vermeyen eski bir Jarvis portları tutuyorsa kapat
    spawnSync('powershell', ['-NoProfile', '-Command', 'Get-NetTCPConnection -LocalPort 8787,5173 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }'], { stdio: 'ignore' });
    installLaunchers();
  }

  if (!YENIDEN) {
    say('Güncellemeler kontrol ediliyor…');
    const g = await guncelle();
    if (!g) say('Güncelleme kontrol edilemedi (internet yok olabilir); mevcut sürümle devam ediliyor.');
    else if (g.degisen.length) {
      say(`Güncellendi (${g.degisen.length} dosya).`);
      if (g.yedek) say(`Bu bilgisayardaki kod değişiklikleri yedeklendi: ${g.yedek}`);
      // Başlatıcı dosyaları değiştiyse yeni hâlleriyle baştan başla (78: Jarvis.bat bu dosyayı yeniden çalıştırır)
      if (g.degisen.some(f => f.startsWith('scripts/'))) process.exit(78);
    }
  }

  for (const dir of ['server', 'web']) ensurePackages(dir);
  if (!fs.existsSync(ENV)) fs.copyFileSync(path.join(ROOT, 'server', '.env.example'), ENV);

  if (!YENIDEN) spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'kontrol.mjs')], { cwd: ROOT, stdio: 'inherit' });

  say('Jarvis ve telefon bağlantısı başlatılıyor. Bu pencereyi KAPATMAYIN (küçültebilirsiniz).');
  say('Yeni özellikler eklendiğinde Jarvis kendini otomatik günceller; tekrar açmanız gerekmez.');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'telefon.mjs')], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, JARVIS_BASLAT: '1', JARVIS_GUNCELLE: '1', JARVIS_OTO: OTO ? '1' : '' },
  });
  if (!OTO && !YENIDEN) {
    // Arayüz hazır olunca tarayıcıyı aç
    (async () => { for (let i = 0; i < 90 && !(await up('http://localhost:5173')); i++) await new Promise(r => setTimeout(r, 1000)); openBrowser(); })();
  }
  const stop = () => child.kill();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', code => process.exit(code ?? 0));
}

/** package.json / package-lock.json değiştiyse ya da paketler eksikse npm install */
function ensurePackages(dir) {
  const files = ['package.json', 'package-lock.json'].map(f => path.join(ROOT, dir, f)).filter(f => fs.existsSync(f));
  const hash = createHash('sha256').update(files.map(f => fs.readFileSync(f)).join('\0')).digest('hex');
  const mark = path.join(ROOT, dir, 'node_modules', '.jarvis-paket');
  try { if (fs.readFileSync(mark, 'utf8') === hash) return; } catch { /* ilk kurulum */ }
  say(`${dir}: paketler kuruluyor (ilk seferde birkaç dakika sürebilir)…`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: path.join(ROOT, dir), stdio: 'inherit', shell: WIN });
  if (r.status === 0) fs.writeFileSync(mark, hash);
  else console.error(`\x1b[31m[jarvis] ${dir} paketleri kurulamadı (kod ${r.status}). Yukarıdaki hatayı Claude'a gönderin.\x1b[0m`);
}

/** PowerShell komutu; Türkçe karakterli yollar (ör. OneDrive\Masaüstü) bozulmasın diye çıktı UTF-8, girdiler ortam değişkeniyle */
function ps(command, env = {}) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`], {
    encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true,
  });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** PNG'yi içine gömerek .ico yapar (Windows Vista ve sonrası PNG'li ikonları gösterir) */
function pngToIco(png) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.writeUInt8(w >= 256 ? 0 : w, 6); head.writeUInt8(h >= 256 ? 0 : h, 7);
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

/**
 * Masaüstüne Jarvis kısayolu (Jarvis simgeli) ve Windows açılışına otomatik başlatma.
 * Kısayolun açtığı başlatıcı server/data/Jarvis.bat'tır: git güncellemeleri ona dokunmaz, yalnızca burada yenilenir.
 */
function installLaunchers() {
  try {
    const data = path.join(ROOT, 'server', 'data');
    fs.mkdirSync(data, { recursive: true });
    const bat = fs.readFileSync(path.join(ROOT, 'Jarvis.bat'));
    const launcher = path.join(data, 'Jarvis.bat');
    let cur = null;
    try { cur = fs.readFileSync(launcher); } catch { /* yok */ }
    if (!cur || !cur.equals(bat)) fs.writeFileSync(launcher, bat);
    const ico = path.join(data, 'jarvis.ico');
    if (!fs.existsSync(ico)) fs.writeFileSync(ico, pngToIco(fs.readFileSync(path.join(ROOT, 'web', 'public', 'icon-192.png'))));

    const desk = ps("[Environment]::GetFolderPath('Desktop')").out;
    if (desk && fs.existsSync(desk)) {
      const lnk = path.join(desk, 'Jarvis.lnk');
      const mark = path.join(data, 'kisayol-1');
      if (!fs.existsSync(lnk) || !fs.existsSync(mark)) {
        const r = ps(
          '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:J_LNK); $s.TargetPath = $env:J_BAT; $s.WorkingDirectory = $env:J_DIR; ' +
          '$s.IconLocation = "$env:J_ICO,0"; $s.Description = "Jarvis: bilgisayarda ve telefonda açar"; $s.WindowStyle = 1; $s.Save()',
          { J_LNK: lnk, J_BAT: launcher, J_DIR: ROOT, J_ICO: ico },
        );
        if (r.ok && fs.existsSync(lnk)) { fs.writeFileSync(mark, new Date().toISOString()); say('Masaüstüne Jarvis kısayolu eklendi (Jarvis simgeli).'); }
        else say(`Masaüstü kısayolu oluşturulamadı: ${r.err.slice(0, 200)}`);
      }
      // Eski masaüstü Jarvis.bat'ı kısayol varken gereksiz; ama şu an o dosyadan açıldıysa silinmez (pencere onu okuyor)
      const deskBat = path.join(desk, 'Jarvis.bat');
      const running = path.resolve(process.env.JARVIS_BAT || deskBat).toLowerCase();
      if (fs.existsSync(lnk) && fs.existsSync(deskBat) && running !== path.resolve(deskBat).toLowerCase()) {
        fs.rmSync(deskBat, { force: true });
        say('Masaüstündeki eski Jarvis.bat kaldırıldı; artık Jarvis kısayolunu kullanın.');
      }
    }

    const startup = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const auto = path.join(startup, 'Jarvis.cmd');
    if (envValue('OTOMATIK_BASLAT') === '0') {
      if (fs.existsSync(auto)) { fs.rmSync(auto); say('Windows açılışında otomatik başlatma kapatıldı.'); }
    } else if (fs.existsSync(startup)) {
      const content = `@echo off\r\nrem Jarvis'i Windows acilisinda kucultulmus pencerede baslatir. Kapatmak icin: server\\.env -> OTOMATIK_BASLAT=0\r\nstart "Jarvis" /min "${launcher}" oto\r\n`;
      let old = '';
      try { old = fs.readFileSync(auto, 'utf8'); } catch { /* yok */ }
      if (old !== content) {
        fs.writeFileSync(auto, content);
        if (!old) say('Jarvis artık bilgisayar açılınca kendiliğinden başlayacak.');
      }
    }
  } catch (e) {
    say(`Masaüstü/otomatik başlatma ayarlanamadı: ${e?.message || e}`);
  }
}
