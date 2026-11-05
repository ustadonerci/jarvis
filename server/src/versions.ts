// Kurulu araç ve repoların sürüm kaydı: server/data/versions.json (sürüm numarası, kaynak, lisans, kurulum tarihi).
// Her kurulum/güncellemede yazılır; "kurulu sürümler" sorusu ve aylık güncelleme kontrolü buradan okunur.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'versions.json');

export interface VersionEntry {
  /** repo | arac (Piper, XTTS, ffmpeg…) */
  tur: 'repo' | 'arac';
  surum: string;
  kaynak?: string;
  lisans?: string | null;
  kurulum_tarihi: string;
  /** Önceki sürüm (güncellemede) */
  onceki?: string;
}

export function readVersions(): Record<string, VersionEntry> {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export function recordVersion(ad: string, e: Omit<VersionEntry, 'kurulum_tarihi' | 'onceki'>) {
  try {
    const all = readVersions();
    const old = all[ad];
    all[ad] = { ...e, kurulum_tarihi: new Date().toISOString().slice(0, 10), ...(old && old.surum !== e.surum ? { onceki: old.surum } : old?.onceki ? { onceki: old.onceki } : {}) };
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  } catch (err) { console.warn('[sürüm] versions.json yazılamadı:', String(err).slice(0, 120)); }
}

export function forgetVersion(ad: string) {
  try {
    const all = readVersions();
    if (!(ad in all)) return;
    delete all[ad];
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  } catch { /* yok say */ }
}
