// Projeler (Orkas'taki Projects'ten uyarlandı; kod alınmadı): hedefi, kuralları, notları ve klasörü olan çalışma
// alanları. Bir proje açıkken her konuşma o projenin bağlamıyla başlar (sistem talimatına kısa özet eklenir); projenin
// belgeleri belgeler aracında proje adıyla aranır. Veri: server/data/projeler.json.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Proje { id: string; ad: string; hedef: string; kurallar: string; klasor?: string; notlar: { metin: string; at: string }[]; at: string }
interface Store { projeler: Proje[]; aktif?: string }

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'projeler.json');
let st: Store = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { projeler: [] }; } })();
const save = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(st, null, 1)); };
const bul = (q: string) => { const k = q.toLocaleLowerCase('tr').trim(); return st.projeler.find(p => p.id === k) ?? st.projeler.find(p => k && p.ad.toLocaleLowerCase('tr').includes(k)); };

/** Sistem talimatına eklenen aktif proje özeti (yoksa boş) */
export function projeBaglami(): string {
  const p = st.projeler.find(x => x.id === st.aktif);
  if (!p) return '';
  return [
    `\n\n# Açık proje: ${p.ad}`,
    `Bu konuşma bu projenin içinde geçiyor; cevaplarını hedefe ve kurallara göre ver.`,
    `Hedef: ${p.hedef}`,
    p.kurallar ? `Kurallar: ${p.kurallar}` : '',
    p.klasor ? `Klasör: ${p.klasor} (belgeleri \`belgeler\` aracında proje: "${p.ad}" ile aranır)` : '',
    p.notlar.length ? `Proje notları:\n${p.notlar.slice(-10).map(n => `- ${n.metin}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

export const PROJE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'proje',
      description: "Projeler: hedefi, kuralları, notları ve klasörü olan çalışma alanları. Açık proje her konuşmaya bağlam olarak eklenir. islem: olustur (ad, hedef, kurallar?, klasor?; oluşturunca açılır), ac (ad), kapat, liste, not_ekle (metin: projeyle ilgili kalıcı bilgi/karar), guncelle (ad, hedef?, kurallar?, klasor?), sil (yalnız proje kaydı; dosyalar durur). 'Yeni proje: düğün organizasyonu', 'X projesine geç', 'projeyi kapat'. Klasör verilirse belgeleri belgeler ekle (proje adıyla) ile kitaplığa eklemeyi öner.",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['olustur', 'ac', 'kapat', 'liste', 'not_ekle', 'guncelle', 'sil'] },
          ad: { type: 'string' }, hedef: { type: 'string' }, kurallar: { type: 'string' }, klasor: { type: 'string' }, metin: { type: 'string' },
        },
        required: ['islem'],
      },
    },
  },
] as const;
export const isProjeTool = (n: string) => n === 'proje';

export function runProjeTool(a: any): string {
  const j = (v: unknown) => JSON.stringify(v);
  const aktif = () => st.projeler.find(p => p.id === st.aktif);
  const ozet = (p: Proje) => ({ id: p.id, ad: p.ad, hedef: p.hedef, kurallar: p.kurallar, klasor: p.klasor, not_sayisi: p.notlar.length, acik: p.id === st.aktif });
  switch (a.islem) {
    case 'olustur': {
      const ad = String(a.ad ?? '').trim().slice(0, 60), hedef = String(a.hedef ?? '').trim().slice(0, 600);
      if (!ad || !hedef) return j({ hata: 'ad ve hedef gerekli' });
      if (bul(ad)?.ad.toLocaleLowerCase('tr') === ad.toLocaleLowerCase('tr')) return j({ hata: 'Bu adla proje var; ac ile aç ya da guncelle' });
      const klasor = a.klasor ? String(a.klasor).trim() : undefined;
      const p: Proje = { id: randomUUID().slice(0, 6), ad, hedef, kurallar: String(a.kurallar ?? '').trim().slice(0, 1000), klasor: klasor && fs.existsSync(klasor) ? klasor : undefined, notlar: [], at: new Date().toISOString() };
      st.projeler.push(p); st.aktif = p.id; save();
      return j({ ok: true, acildi: ozet(p), uyari: klasor && !p.klasor ? `Klasör bulunamadı: ${klasor}` : undefined });
    }
    case 'ac': { const p = bul(String(a.ad ?? '')); if (!p) return j({ hata: 'Proje bulunamadı', projeler: st.projeler.map(ozet) }); st.aktif = p.id; save(); return j({ ok: true, acildi: ozet(p), notlar: p.notlar.slice(-10).map(n => n.metin) }); }
    case 'kapat': { const p = aktif(); delete st.aktif; save(); return j({ ok: true, kapandi: p?.ad ?? 'açık proje yoktu' }); }
    case 'not_ekle': {
      const p = a.ad ? bul(String(a.ad)) : aktif();
      const metin = String(a.metin ?? '').trim().slice(0, 500);
      if (!p || !metin) return j({ hata: p ? 'metin gerekli' : 'Açık proje yok; ad ver ya da önce aç' });
      if (/şifre|parola|password|cvv|iban|\b\d{16}\b/i.test(metin)) return j({ hata: 'Şifre, kart ya da IBAN projeye yazılmaz.' });
      p.notlar.push({ metin, at: new Date().toISOString() }); save();
      return j({ ok: true, proje: p.ad, not_sayisi: p.notlar.length });
    }
    case 'guncelle': {
      const p = a.ad ? bul(String(a.ad)) : aktif();
      if (!p) return j({ hata: 'Proje bulunamadı' });
      if (a.hedef) p.hedef = String(a.hedef).trim().slice(0, 600);
      if (a.kurallar !== undefined) p.kurallar = String(a.kurallar).trim().slice(0, 1000);
      if (a.klasor) { const k = String(a.klasor).trim(); if (!fs.existsSync(k)) return j({ hata: `Klasör bulunamadı: ${k}` }); p.klasor = k; }
      save();
      return j({ ok: true, proje: ozet(p) });
    }
    case 'sil': {
      const p = bul(String(a.ad ?? ''));
      if (!p) return j({ hata: 'Proje bulunamadı' });
      st.projeler = st.projeler.filter(x => x !== p);
      if (st.aktif === p.id) delete st.aktif;
      save();
      return j({ ok: true, silindi: p.ad, not: 'Yalnız proje kaydı silindi; klasör ve belgeler duruyor.' });
    }
    default: return j({ projeler: st.projeler.map(ozet), acik: aktif()?.ad ?? null });
  }
}
