// Kurulum kontrolü: npm run kontrol
// "DEMO yazıyor", "anahtar çalışmıyor" gibi durumlarda server/.env'i denetler, bilinen sorunları düzeltir
// (önce yedek alır) ve Abacus anahtarını gerçek bir istekle sınar. Anahtarın kendisini ekrana yazmaz.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, 'server', '.env');
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const mask = (v) => (v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} karakter)` : `(${v.length} karakter)`);

console.log('\nJarvis kurulum kontrolü\n');

if (!fs.existsSync(ENV)) {
  fs.copyFileSync(path.join(ROOT, 'server', '.env.example'), ENV);
  warn('server/.env yoktu, örnekten oluşturuldu. Abacus anahtarını yazmanız gerekiyor.');
}

// ---- 1) Kodlama: Not Defteri "Unicode" (UTF-16) ile kaydederse Jarvis hiçbir ayarı okuyamaz
let raw = fs.readFileSync(ENV);
let text;
let fixed = false;
if (raw[0] === 0xff && raw[1] === 0xfe) { text = raw.subarray(2).toString('utf16le'); fixed = true; bad('Dosya UTF-16 kaydedilmiş (Jarvis okuyamıyordu) → UTF-8 yapıldı'); }
else if (raw[0] === 0xfe && raw[1] === 0xff) { text = Buffer.from(raw.subarray(2)).swap16().toString('utf16le'); fixed = true; bad('Dosya UTF-16 BE kaydedilmiş → UTF-8 yapıldı'); }
else { text = raw.toString('utf8'); if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); fixed = true; warn('Dosya başındaki BOM işareti kaldırıldı'); } }
if (!fixed) ok('Dosya kodlaması doğru (UTF-8)');

let lines = text.split(/\r?\n/);

// ---- 1b) Bozuk Türkçe karakterler: "Ä°stanbul" → "İstanbul" (UTF-8, Windows-1252 sanılıp yeniden kaydedilmiş)
const CP1252 = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
const unmojibake = (s) => {
  if (!/[ÃÄÅÂ]/.test(s)) return s;
  const bytes = [];
  for (const ch of s) { const c = ch.codePointAt(0); if (c < 256) bytes.push(c); else if (CP1252[ch] !== undefined) bytes.push(CP1252[ch]); else return s; }
  const out = Buffer.from(bytes).toString('utf8');
  return out.includes('�') ? s : out;
};
const repaired = lines.map(unmojibake);
if (repaired.some((l, i) => l !== lines[i])) { lines = repaired; fixed = true; bad('Bozuk Türkçe karakterler vardı (ör. "Ä°stanbul") → düzeltildi'); }

// ---- 2) MOCK=1 demo modunu zorlar
const mockIdx = lines.findIndex(l => /^\s*MOCK\s*=\s*1\s*$/.test(l));
if (mockIdx >= 0) { lines[mockIdx] = `# ${lines[mockIdx].trim()}   (kontrol: demo modunu kapatmak için devre dışı bırakıldı)`; fixed = true; bad('MOCK=1 satırı Jarvis\'i demo modunda tutuyordu → devre dışı bırakıldı'); }
else ok('MOCK=1 yok');

// ---- 3) ABACUS_API_KEY
const keyIdx = lines.map((l, i) => (/^\s*#?\s*ABACUS_API_KEY\s*=/.test(l) ? i : -1)).filter(i => i >= 0);
const active = keyIdx.filter(i => !/^\s*#/.test(lines[i]));
const values = keyIdx.map(i => lines[i].replace(/^\s*#?\s*ABACUS_API_KEY\s*=/, '').trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
let key = '';
// Anahtar yoksa (ya da "npm run kontrol -- --yeni" ile) burada sorulur ve doğru biçimde yazılır
if ((!values.length || process.argv.includes('--yeni')) && process.stdin.isTTY) {
  if (!values.length) bad('ABACUS_API_KEY boş. Anahtar dosyaya yazılmamış.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\n  Abacus anahtarınızı buraya yapıştırıp Enter\'a basın\n  (PowerShell\'de SAĞ TIK = yapıştır; boş bırakırsanız atlanır):\n  > ')).trim().replace(/^["']|["']$/g, '').trim();
  rl.close();
  if (answer) { values.push(answer); keyIdx.length || keyIdx.push(lines.length); fixed = true; ok('Yeni anahtar alındı'); }
}
if (!values.length) {
  bad('ABACUS_API_KEY boş. Anahtar dosyaya yazılmamış. "npm.cmd run kontrol" ile tekrar deneyin.');
} else {
  // Birden çok satır varsa en son yazılanı (en sondaki dolu satır) kullan, diğerlerini kaldır
  key = values[values.length - 1];
  const before = lines.join('\n');
  lines = lines.filter((_, i) => !keyIdx.includes(i));
  const at = Math.min(...keyIdx);
  lines.splice(Math.min(at, lines.length), 0, `ABACUS_API_KEY=${key}`);
  if (lines.join('\n') !== before) { fixed = true; warn(keyIdx.length > 1 ? `ABACUS_API_KEY ${keyIdx.length} kez yazılmıştı → tek satıra indirildi (sondaki kullanıldı)` : 'ABACUS_API_KEY satırı düzeltildi (boşluk / tırnak / # kaldırıldı)'); }
  if (!active.length) warn('Anahtar satırının başında # vardı (yorum satırı sayılıyordu) → kaldırıldı');
  ok(`ABACUS_API_KEY dolu: ${mask(key)}`);
  if (!/^s2_/.test(key)) warn('Abacus anahtarları genelde "s2_" ile başlar; doğru anahtarı yapıştırdığınızdan emin olun.');
  if (/\s/.test(key)) bad('Anahtarın içinde boşluk var; yanlış kopyalanmış olabilir.');
}

if (fixed) {
  fs.copyFileSync(ENV, `${ENV}.yedek`);
  fs.writeFileSync(ENV, lines.join('\n').replace(/\n*$/, '\n'), 'utf8');
  ok('Düzeltmeler kaydedildi (eski hali: server/.env.yedek)');
}

// ---- 4) Anahtarı Abacus'ta sına
if (key) {
  const base = (/^\s*ROUTELLM_BASE_URL\s*=\s*(\S+)/m.exec(lines.join('\n'))?.[1]) || 'https://routellm.abacus.ai/v1';
  try {
    const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (r.ok) ok('Abacus anahtarı GEÇERLİ (RouteLLM cevap verdi)');
    else if (r.status === 401 || r.status === 403) bad(`Abacus anahtarı reddedildi (${r.status}). Anahtar yanlış/silinmiş ya da hesabın RouteLLM API yetkisi yok.`);
    else warn(`Abacus beklenmeyen cevap verdi (${r.status}).`);
  } catch (e) {
    bad(`Abacus'a ulaşılamadı: ${e?.cause?.code || e?.message || e}. İnternet / güvenlik duvarı / antivirüs kontrol edin.`);
  }
}

// ---- 5) Çalışan Jarvis hangi modda?
try {
  const r = await fetch('http://localhost:8787/api/state', { signal: AbortSignal.timeout(3000) });
  const s = await r.json();
  if (s.mock) warn('Şu an çalışan Jarvis DEMO modunda. Jarvis\'i kapatıp yeniden başlatın (yeni ayarlar ancak öyle okunur).');
  else ok(`Çalışan Jarvis gerçek modda (beyin: ${s.model}).`);
} catch {
  console.log('  · Jarvis şu an çalışmıyor; "npm.cmd run dev" ile başlatın.');
}
console.log('');
