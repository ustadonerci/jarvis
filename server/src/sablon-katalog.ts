// Otomasyon şablon kataloğu (server/sablonlar/<sektör>/*.json) ve ihtiyaç eşleştirme. Yan etkisiz: satış danışmanı da kullanır.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sablonlar');
export interface Sablon { id: string; sektor: string; ad: string; aciklama: string; anahtar_kelimeler: string[]; test_verisi: any; baglanacak_hesaplar: string[]; wf: any }

export function sablonlar(): Sablon[] {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).flatMap(sektor => {
    const d = path.join(DIR, sektor);
    if (!fs.statSync(d).isDirectory()) return [];
    return fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => {
      const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      const { _jarvis: m, ...wf } = j;
      return { id: `${sektor}/${f.replace(/\.json$/, '')}`, sektor, ad: m.ad, aciklama: m.aciklama, anahtar_kelimeler: m.anahtar_kelimeler ?? [], test_verisi: m.test_verisi, baglanacak_hesaplar: m.baglanacak_hesaplar ?? [], wf };
    });
  });
}

export const fold = (s: string) => s.toLocaleLowerCase('tr').replace(/[çğıöşü]/g, c => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c] ?? c);
const GIDA = /restoran|lokanta|kafe|cafe|pide|kebap|pizza|burger|yemek|gida|firin|pastane|tatli|catering|mutfak/;

/** İhtiyaç eşleştirme: sektör + talep metninden en uygun şablonlar */
export function eslestir(sektor: string, talep: string) {
  const s = fold(sektor), t = fold(`${talep} ${sektor}`);
  const sektorKey = GIDA.test(s) || GIDA.test(t) ? 'restoran' : s.split(/\s+/)[0];
  return sablonlar()
    .map(x => ({ x, puan: (x.sektor === sektorKey ? 2 : 0) + x.anahtar_kelimeler.reduce((p, k) => p + (t.includes(fold(k)) ? 3 : 0), 0) }))
    .filter(r => r.puan > 0).sort((a, b) => b.puan - a.puan)
    .map(({ x, puan }) => ({ sablon: x.id, ad: x.ad, aciklama: x.aciklama, hesaplar: x.baglanacak_hesaplar, uygunluk: puan }));
}

