// Bozuk Türkçe karakter onarımı: server/.env bir Windows aracıyla yanlış kodlamayla kaydedilince "İstanbul" gibi
// değerler "Ä°stanbul" olur (UTF-8 baytları Windows-1252 sanılıp yeniden yazılmış). .env'deki değerler açılışta
// düzeltilir; dosyanın kendisini "npm run kontrol" (scripts/kontrol.mjs) onarır.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CP1252: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

/** "Ä°stanbul" → "İstanbul". Bozuk değilse ya da çözülemiyorsa aynen döner. */
export function fixMojibake(s: string): string {
  if (!/[ÃÄÅÂ]/.test(s)) return s;
  const bytes: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 256) bytes.push(c);
    else if (CP1252[ch] !== undefined) bytes.push(CP1252[ch]);
    else return s;
  }
  const out = Buffer.from(bytes).toString('utf8');
  return out.includes('�') ? s : out;
}

// Yalnızca .env'de yazılı anahtarlar (sistemin kendi ortam değişkenlerine dokunulmaz)
try {
  const env = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8');
  for (const m of env.matchAll(/^\s*([A-Za-z_][\w]*)\s*=/gm)) {
    const k = m[1];
    const v = process.env[k];
    if (v) {
      const f = fixMojibake(v);
      if (f !== v) { process.env[k] = f; console.log(`[ayar] ${k}: bozuk Türkçe karakterler düzeltildi`); }
    }
  }
} catch { /* .env yok */ }
