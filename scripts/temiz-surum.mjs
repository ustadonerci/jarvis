// Temiz çekirdek sürüm (ürün olarak sunmak için): kişisel veri, API anahtarı, hafıza, ses örnekleri ve yerel notlar
// OLMADAN bir kopya çıkarır ve lisans uyarılarını raporlar. Kullanım: npm run temiz-surum  → ../jarvis-temiz-<tarih>/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tarih = new Date().toISOString().slice(0, 10);
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(ROOT, '..', `jarvis-temiz-${tarih}`);
const HARIC = [/^\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)dist(\/|$)/, /^server\/data(\/|$)/, /^server\/\.env(?!\.example$)/, /^ses-ornekleri(\/|$)/, /^docs\/DEVIR-NOTU\.md$/, /^telefon-linki\.txt$/, /^\.claude(\/|$)/, /^web\/public\/models(\/|$)/, /\.pyc$/];

if (fs.existsSync(OUT)) { console.error(`Hedef klasör zaten var: ${OUT}`); process.exit(1); }
let n = 0;
const walk = (rel) => {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (HARIC.some(re => re.test(r))) continue;
    if (e.isDirectory()) walk(r);
    else { fs.mkdirSync(path.join(OUT, path.dirname(r)), { recursive: true }); fs.copyFileSync(path.join(ROOT, r), path.join(OUT, r)); n++; }
  }
};
walk('');
// Kontrol: kopyada anahtar ya da kişisel veri kalmadı mı
const supheli = [];
const scan = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) scan(f); else if (/\.(ts|tsx|js|mjs|json|md|env|txt)$/.test(e.name)) { const t = fs.readFileSync(f, 'utf8'); if (/sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|nvapi-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{20,}/.test(t)) supheli.push(path.relative(OUT, f)); } } };
scan(OUT);
// Lisans uyarıları: bağımlılıklardan AGPL/GPL/ticari-kullanım-yasak olanlar (node_modules yoksa atlanır)
const lisans = [];
for (const p of ['server', 'web']) {
  const lock = path.join(ROOT, p, 'package-lock.json');
  if (!fs.existsSync(lock)) continue;
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(lock, 'utf8')).packages ?? {})) {
    if (!k || !v.license) continue;
    const lic = String(v.license);
    // Çift lisansta (ör. "MIT OR GPL-3.0") serbest seçenek varsa sorun yok
    if (/\b(MIT|Apache-2\.0|BSD|ISC)\b/.test(lic) && /\bOR\b/.test(lic)) continue;
    if (/AGPL|(^|[^L])GPL|SSPL|BUSL|\bNC\b|Commons-Clause/i.test(lic)) lisans.push(`${p}: ${k.replace(/^node_modules\//, '')} (${v.license})`);
  }
}
const rapor = [`Temiz sürüm: ${OUT}`, `${n} dosya kopyalandı (kişisel veri, .env, hafıza, ses örnekleri hariç).`,
  supheli.length ? `⚠️ Anahtar gibi görünen içerik: ${supheli.join(', ')}` : '✅ Kopyada API anahtarı bulunamadı.',
  lisans.length ? `⚠️ Ticari üründe sorunlu olabilecek lisanslar:\n  ${[...new Set(lisans)].join('\n  ')}` : '✅ Bağımlılıklarda AGPL/GPL/ticari-kullanım-yasak lisans bulunamadı.',
  'Kurulum: musteri.env (anahtarlar) + docker compose up -d. Ayrıntı: docs/URUN.md'].join('\n');
fs.writeFileSync(path.join(OUT, 'TEMIZ-SURUM-RAPORU.txt'), rapor + '\n');
console.log(rapor);
if (supheli.length) process.exit(2);
