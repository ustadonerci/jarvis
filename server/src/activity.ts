// Günlük etkinlik kaydı: Jarvis'in kendi yaptığı işler (onaylı işlemler, kurulan yetenekler, e-posta temizliği,
// GitHub taraması…) günün dosyasına (data/gunluk/YYYY-MM-DD.jsonl) satır satır yazılır. Akşam raporu (daily.ts)
// bunlardan derlenir. Bağımlılığı yok: her modül döngüye girmeden çağırabilir.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUNLUK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'gunluk');
/** Yerel tarih (YYYY-MM-DD) */
export const today = (d = new Date()) => d.toLocaleDateString('sv-SE');

export interface Activity { at: string; tur: string; metin: string }

export function logActivity(tur: string, metin: string) {
  try {
    fs.mkdirSync(GUNLUK, { recursive: true });
    fs.appendFileSync(path.join(GUNLUK, `${today()}.jsonl`), JSON.stringify({ at: new Date().toISOString(), tur, metin: metin.slice(0, 600) }) + '\n');
  } catch { /* kayıt tutulamazsa iş durmasın */ }
}

export function activitiesOf(tarih = today()): Activity[] {
  try {
    return fs.readFileSync(path.join(GUNLUK, `${tarih}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}
