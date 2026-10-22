// Otomatik güncelleme: GitHub'daki Jarvis dalını çeker ve bu klasöre uygular. baslat.mjs açılışta, dev.mjs
// çalışırken birkaç dakikada bir kullanır. Anahtarlar (server/.env) ve veriler (server/data) git'te olmadığı için korunur.
// Bu klasörde elle ya da Jarvis'in kendi kodunu düzenlemesiyle yapılmış değişiklikler güncellemeyle çakışırsa
// önce server/data/kod-yedek/ altına yama dosyası olarak saklanır, sonra güncelleme uygulanır.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_URL = process.env.JARVIS_REPO_URL || 'https://github.com/ustadonerci/jarvis.git';
export const BRANCH = 'ayarlar-yetenekler';

const git = (...args) => new Promise((resolve) => {
  execFile('git', args, { cwd: ROOT, timeout: 120_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr || err?.message || '').trim() }));
});

/**
 * Yeni sürüm varsa uygular. Dönen değer: null (kontrol edilemedi: internet yok vb.),
 * { degisen: [] } (güncel) ya da { degisen: [dosyalar…], yedek? } (güncellendi).
 */
export async function guncelle() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return null;
  const f = await git('fetch', '-q', REPO_URL, BRANCH);
  if (!f.ok) return null;
  const head = (await git('rev-parse', 'HEAD')).out;
  const yeni = (await git('rev-parse', 'FETCH_HEAD')).out;
  if (!yeni || head === yeni) return { degisen: [] };
  // Buradaki sürüm GitHub'dakinden ileride ise (yerel commit) dokunma
  if ((await git('merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD')).ok) return { degisen: [] };
  const degisen = (await git('diff', '--name-only', 'HEAD', 'FETCH_HEAD')).out.split(/\r?\n/).filter(Boolean);
  if ((await git('merge', '-q', '--ff-only', 'FETCH_HEAD')).ok) return { degisen };
  // Hızlı ileri alınamadı: yerel değişiklikleri yedekle, sonra GitHub'daki sürüme geç
  let yedek;
  const diff = await git('diff', 'HEAD');
  if (diff.out) {
    const dir = path.join(ROOT, 'server', 'data', 'kod-yedek');
    fs.mkdirSync(dir, { recursive: true });
    yedek = path.join(dir, `guncelleme-oncesi-${new Date().toISOString().replace(/[:.]/g, '-')}.patch`);
    fs.writeFileSync(yedek, `${diff.out}\n`);
  }
  const r = await git('reset', '-q', '--hard', 'FETCH_HEAD');
  if (!r.ok) return null;
  return { degisen, yedek };
}

/** Değişen dosyalara göre ne yapılmalı: 'tam' (paketler/başlatıcı değişti), 'sunucu' ya da 'arayuz' (Vite kendisi yeniler) */
export function etki(degisen) {
  if (degisen.some(f => /^(scripts\/|Jarvis\.bat$|package(-lock)?\.json$|(server|web)\/package(-lock)?\.json$|web\/vite\.config|(server|web)\/tsconfig)/.test(f))) return 'tam';
  if (degisen.some(f => f.startsWith('server/'))) return 'sunucu';
  if (degisen.some(f => f.startsWith('web/'))) return 'arayuz';
  return null;
}

/**
 * Eski masaüstü dosyası "npm run dev" / "npm run telefon" ile açtıysa (Windows) yeni başlatıcıya yönlendirir:
 * böylece güncelleme ve telefon bağlantısı her durumda çalışır. Yönlendirdiyse true döner.
 */
export function baslaticiyaYonlendir() {
  if (process.platform !== 'win32' || process.env.JARVIS_BASLAT) return false;
  const run = (yeniden) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'baslat.mjs')], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, JARVIS_YENIDEN: yeniden ? '1' : '' },
    });
    process.removeAllListeners('SIGINT');
    process.on('SIGINT', () => c.kill());
    c.on('exit', code => (code === 76 ? run(true) : code === 78 ? run(false) : process.exit(code === 77 ? 0 : code ?? 0)));
  };
  run(false);
  return true;
}
