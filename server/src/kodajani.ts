// Kod ajanları (Orkas'taki External CLI Agents'tan uyarlandı; kod alınmadı): bilgisayarda kurulu Claude Code ya da Codex
// bir klasörde tek seferlik görevle çalıştırılır ("şu projedeki hatayı düzelt", "README yaz"). Dosya değiştirdikleri
// için her çalıştırma ONAY KARTIYLA yapılır; kartta klasör ve komut birebir görünür. Sınırlar: Claude Code yalnız dosya
// düzenleyebilir (acceptEdits: izinsiz komut çalıştıramaz), Codex workspace-write korumalı alanında (yalnız o klasör).
// En fazla 20 dakika; bitince sonuç Telegram'a da gider.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { propose } from './approvals.js';
import { logActivity } from './activity.js';
import { notifyOwner } from './messaging.js';

type Arac = 'claude' | 'codex';
const SURE = 20 * 60_000;

/** Çalıştırılacak program ve argümanlar (kabuk kullanılmaz: görev metni komut olarak yorumlanamaz) */
export function komut(arac: Arac, klasor: string, gorev: string): { exe: string; args: string[] } {
  return arac === 'claude'
    ? { exe: 'claude', args: ['-p', gorev, '--permission-mode', 'acceptEdits', '--output-format', 'text'] }
    : { exe: 'codex', args: ['exec', '-s', 'workspace-write', '-C', klasor, '--skip-git-repo-check', gorev] };
}

function calistir(arac: Arac, klasor: string, gorev: string): Promise<string> {
  const { exe, args } = komut(arac, klasor, gorev);
  return new Promise(resolve => {
    execFile(exe, args, { cwd: klasor, timeout: SURE, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const cikti = `${stdout}`.trim() || `${stderr}`.trim();
      const sonuc = err && !stdout ? `Hata: ${(err as any).killed ? '20 dakikada bitmedi, durduruldu' : String(err.message).slice(0, 300)}\n${cikti.slice(-1500)}` : cikti.slice(-4000) || '(çıktı yok)';
      logActivity('islem', `${arac === 'claude' ? 'Claude Code' : 'Codex'} bitti (${klasor}): ${gorev.slice(0, 80)}`);
      notifyOwner(`🧑‍💻 ${arac === 'claude' ? 'Claude Code' : 'Codex'} işi bitti: "${gorev.slice(0, 80)}"\n\n${sonuc.slice(-1500)}`, 'telegram').catch(() => []);
      resolve(sonuc);
    });
  });
}

export const KOD_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'kod_ajani',
      description: "Bilgisayarda kurulu Claude Code ya da Codex'i bir klasörde tek seferlik görevle çalıştırır (kod yazma, hata düzeltme, inceleme, README). Onay kartı açılır; kullanıcı onaylayınca çalışır, en fazla 20 dk, sonuç Telegram'a da gelir. arac: claude (varsayılan) ya da codex; klasor: projenin tam yolu; gorev: ajana açık ve eksiksiz talimat (ne yapılacak, neye dokunulmayacak, nasıl test edilecek).",
      parameters: {
        type: 'object',
        properties: { arac: { type: 'string', enum: ['claude', 'codex'] }, klasor: { type: 'string' }, gorev: { type: 'string' } },
        required: ['klasor', 'gorev'],
      },
    },
  },
] as const;
export const isKodTool = (n: string) => n === 'kod_ajani';

export function runKodTool(a: any): string {
  const arac: Arac = a.arac === 'codex' ? 'codex' : 'claude';
  const klasor = String(a.klasor ?? '').trim().replace(/^"|"$/g, '');
  const gorev = String(a.gorev ?? '').trim().slice(0, 6000);
  if (!gorev) return JSON.stringify({ hata: 'gorev gerekli' });
  if (!klasor || !fs.existsSync(klasor) || !fs.statSync(klasor).isDirectory()) return JSON.stringify({ hata: `Klasör bulunamadı: ${klasor || '(boş)'}`, not: 'Yeri belli değilse dosya_listele ile bul.' });
  const { exe, args } = komut(arac, klasor, gorev);
  const ad = arac === 'claude' ? 'Claude Code' : 'Codex';
  return propose('kod', `${ad}: ${gorev.slice(0, 60)}`, `Klasör: ${klasor}\nKomut: ${exe} ${args.map(x => (x === gorev ? '"<görev>"' : x)).join(' ')}\n\nGörev:\n${gorev}`,
    `${ad} bu klasördeki dosyaları değiştirebilir (${arac === 'claude' ? 'yalnız dosya düzenleme' : 'yalnız bu klasörde yazma'}). En fazla 20 dakika.`, () => calistir(arac, klasor, gorev));
}
