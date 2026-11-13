// Kişisel defter (KAFA Asistan kılavuzundaki yeteneklerden Jarvis'te olmayanlar; kod alınmadı, işlev uyarlandı):
// yapılacaklar (tarihli), para defteri (gelir, gider, borç/alacak, kişi bazında), müşteri/kişi takibi ("kime dönmem
// lazım"), alışkanlıklar (seri), kararlar, hedefler (adımlara bölünmüş, ilerleme), "Günaydın" (günün 3 önemli işi,
// bekleyenler) ve "Günü kapat" (biten, kalan, yarın ilk iş), "benim gibi yaz" (kullanıcının kendi mesaj örnekleri).
// Veriler yalnız bu bilgisayarda: server/data/defter.json. Değişmez kurallar: şifre, kart, kimlik numarası kaydedilmez;
// fişten okunan tutar kullanıcı "evet" demeden kaydedilmez (talimat); silme ve sıfırlama onay kartıyla.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { propose } from './approvals.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'defter.json');

interface Gorev { id: string; metin: string; tarih?: string; bitti?: string; at: string }
interface Para { id: string; tur: 'gider' | 'gelir' | 'borc_verdim' | 'borc_aldim' | 'tahsil' | 'odedim'; tutar: number; kisi?: string; aciklama?: string; tarih: string }
interface Takip { id: string; kisi: string; konu: string; tarih?: string; bitti?: string; at: string }
interface Aliskanlik { id: string; ad: string; gunler: string[]; at: string }
interface Karar { id: string; metin: string; tarih: string }
interface Hedef { id: string; ad: string; adimlar: { metin: string; bitti?: string }[]; at: string }
interface Defter { gorevler: Gorev[]; para: Para[]; takipler: Takip[]; aliskanliklar: Aliskanlik[]; kararlar: Karar[]; hedefler: Hedef[] }

const EMPTY: Defter = { gorevler: [], para: [], takipler: [], aliskanliklar: [], kararlar: [], hedefler: [] };
let d: Defter = (() => { try { return { ...EMPTY, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return structuredClone(EMPTY); } })();
const save = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 1)); };
const id = () => randomUUID().slice(0, 6);

// ---------------------------------------------------------------- Tarih (Türkçe: bugün, yarın, cuma, 15 kasım…)

const local = (x = new Date()) => x.toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
export const today = () => local();
const addDays = (n: number) => local(new Date(Date.now() + n * 86400_000));
const GUN = ['pazar', 'pazartesi', 'salı', 'çarşamba', 'perşembe', 'cuma', 'cumartesi'];
const AY = ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'];
export function parseDate(s?: string): string | undefined {
  const t = String(s ?? '').toLocaleLowerCase('tr').trim();
  if (!t) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/bugün|bu akşam|bu gece/.test(t)) return today();
  if (/öbür gün|ertesi gün/.test(t)) return addDays(2);
  if (/yarın/.test(t)) return addDays(1);
  if (/haftaya|gelecek hafta/.test(t)) return addDays(7);
  // Uzun adlar önce: "cumartesi" içinde "cuma", "pazartesi" içinde "pazar" geçiyor
  const hit = ['pazartesi', 'cumartesi', 'çarşamba', 'perşembe', 'pazar', 'salı', 'cuma'].find(x => t.includes(x));
  if (hit) { const g = GUN.indexOf(hit), now = new Date(`${today()}T12:00:00`).getDay(); return addDays(((g - now + 7) % 7) || 7); }
  const m = /(\d{1,2})\s*(ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)/.exec(t);
  if (m) {
    const y = Number(today().slice(0, 4)), mo = AY.indexOf(m[2]);
    let dt = `${y}-${String(mo + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (dt < today()) dt = `${y + 1}${dt.slice(4)}`;
    return dt;
  }
  return undefined;
}
const fmt = (s?: string) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'short' }) : '');
const SECRET = /şifre|parola|password|cvv|kart numara|tc kimlik|kimlik no|iban|\b\d{11}\b|\b\d{16}\b/i;

// ---------------------------------------------------------------- Görünümler

const acikGorevler = () => d.gorevler.filter(g => !g.bitti).sort((a, b) => (a.tarih ?? '9999').localeCompare(b.tarih ?? '9999'));
const findBy = <T extends { id: string }>(list: T[], q: unknown, text: (x: T) => string): T | undefined => {
  const s = String(q ?? '').toLocaleLowerCase('tr').trim();
  if (!s) return undefined;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1];
  return list.find(x => x.id === s) ?? list.find(x => text(x).toLocaleLowerCase('tr').includes(s));
};
function seri(a: Aliskanlik): number {
  const set = new Set(a.gunler);
  let n = 0;
  for (let i = set.has(today()) ? 0 : 1; set.has(addDays(-i)); i++) n++;
  return n;
}
function paraOzet(ay = today().slice(0, 7)) {
  const buAy = d.para.filter(p => p.tarih.startsWith(ay));
  const top = (t: Para['tur']) => buAy.filter(p => p.tur === t).reduce((s, p) => s + p.tutar, 0);
  const kisiler: Record<string, number> = {};
  // pozitif: o kişi BANA borçlu; negatif: ben ona borçluyum
  for (const p of d.para) if (p.kisi) {
    const k = p.kisi;
    kisiler[k] = (kisiler[k] ?? 0) + (p.tur === 'borc_verdim' ? p.tutar : p.tur === 'tahsil' ? -p.tutar : p.tur === 'borc_aldim' ? -p.tutar : p.tur === 'odedim' ? p.tutar : 0);
  }
  return {
    ay, gider: top('gider'), gelir: top('gelir'), net: top('gelir') - top('gider'),
    bana_borclu: Object.entries(kisiler).filter(([, v]) => v > 0).map(([k, v]) => ({ kisi: k, tutar: v })),
    benim_borcum: Object.entries(kisiler).filter(([, v]) => v < 0).map(([k, v]) => ({ kisi: k, tutar: -v })),
    son_kayitlar: buAy.slice(-8).map(p => `${p.tarih} · ${p.tur} · ${p.tutar} TL${p.kisi ? ` · ${p.kisi}` : ''}${p.aciklama ? ` · ${p.aciklama}` : ''}`),
  };
}

/** Günaydın: günün en önemli 3 işi (gecikmiş ve bugünkü önce), dönülecek kişiler, alışkanlıklar, hedefler */
export function gunaydin() {
  const t = today();
  const gorev = acikGorevler();
  const onemli = [...gorev.filter(g => g.tarih && g.tarih < t), ...gorev.filter(g => g.tarih === t), ...gorev.filter(g => !g.tarih), ...gorev.filter(g => g.tarih && g.tarih > t)].slice(0, 3);
  return {
    tarih: fmt(t),
    gunun_3_isi: onemli.map(g => `${g.metin}${g.tarih && g.tarih < t ? ' (gecikti)' : ''}`),
    geciken: gorev.filter(g => g.tarih && g.tarih < t).length,
    donulecekler: d.takipler.filter(k => !k.bitti && (!k.tarih || k.tarih <= t)).map(k => `${k.kisi}: ${k.konu}`),
    aliskanliklar: d.aliskanliklar.map(a => `${a.ad} · seri ${seri(a)} gün${a.gunler.includes(t) ? ' ✓' : ''}`),
    hedefler: d.hedefler.map(h => `${h.ad} · %${h.adimlar.length ? Math.round(100 * h.adimlar.filter(x => x.bitti).length / h.adimlar.length) : 0}${h.adimlar.find(x => !x.bitti) ? ` · sıradaki: ${h.adimlar.find(x => !x.bitti)!.metin}` : ''}`),
  };
}
export function gunuKapat() {
  const t = today();
  const biten = d.gorevler.filter(g => g.bitti?.startsWith(t)).map(g => g.metin);
  const kalan = acikGorevler().filter(g => !g.tarih || g.tarih <= t).map(g => g.metin);
  const yarin = acikGorevler().find(g => !g.tarih || g.tarih <= addDays(1));
  return { biten, kalan, yarin_ilk_is: yarin?.metin ?? null, aliskanlik_yapilmadi: d.aliskanliklar.filter(a => !a.gunler.includes(t)).map(a => a.ad) };
}
/** Panel/Ayarlar için özet */
export const defterView = () => ({ ...gunaydin(), gorevler: acikGorevler().map(g => ({ id: g.id, metin: g.metin, tarih: g.tarih })), para: paraOzet() });

// ---------------------------------------------------------------- Model aracı

let samples: (n: number) => string[] = () => [];
/** "Benim gibi yaz" için kullanıcının kendi gönderdiği mesajlardan örnekler (messaging.ts kaydeder) */
export const registerOwnSamples = (fn: (n: number) => string[]) => { samples = fn; };

export const DEFTER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'defter',
      description: "Kişisel defter. Görevler: gorev_ekle (metin, tarih: 'cuma'/'yarın'/YYYY-MM-DD), gorev_bitti (no ya da metin), gorevler ('ne kaldı'), gorev_sil. Para defteri: para_ekle (tur: gider|gelir|borc_verdim|borc_aldim|tahsil|odedim, tutar, kisi?, aciklama?) — '300 TL un aldım'=gider, 'Zeynep hanım 1.200 ödedi'=tahsil ya da gelir, 'Ahmet 2.000 borçlu'=borc_verdim; para_ozet ('bu ay ne harcadım', 'kim bana borçlu'). Takip: takip_ekle (kisi, konu, tarih), takip_bitti, takipler ('kime dönmem lazım'). Alışkanlık: aliskanlik_ekle (ad), aliskanlik_yaptim (ad: 'yürüdüm'), aliskanliklar. Kararlar: karar_ekle (metin), kararlar. Hedef: hedef_ekle (ad, adimlar: dizi — büyük hedefi 4-8 somut adıma sen böl), hedef_adim_bitti (hedef, no), hedefler. gunaydin: günün 3 işi + bekleyenler; gunu_kapat: biten/kalan/yarın ilk iş. uslup: kullanıcının kendi mesaj örnekleri ('benim gibi yaz' — taslak yaz, GÖNDERME). sifirla: defteri temizler (onay kartı).",
      parameters: { type: 'object', properties: {
        islem: { type: 'string', enum: ['gorev_ekle', 'gorev_bitti', 'gorevler', 'gorev_sil', 'para_ekle', 'para_ozet', 'takip_ekle', 'takip_bitti', 'takipler', 'aliskanlik_ekle', 'aliskanlik_yaptim', 'aliskanliklar', 'karar_ekle', 'kararlar', 'hedef_ekle', 'hedef_adim_bitti', 'hedefler', 'gunaydin', 'gunu_kapat', 'uslup', 'sifirla'] },
        metin: { type: 'string' }, tarih: { type: 'string' }, no: { type: 'number' }, tur: { type: 'string' }, tutar: { type: 'number' }, kisi: { type: 'string' }, aciklama: { type: 'string' }, konu: { type: 'string' }, ad: { type: 'string' }, hedef: { type: 'string' }, adimlar: { type: 'array', items: { type: 'string' } }, ay: { type: 'string' },
      }, required: ['islem'] },
    },
  },
] as const;
export const isDefterTool = (n: string) => n === 'defter';

export function runDefterTool(a: any): string {
  const j = (v: unknown) => JSON.stringify(v);
  const metin = String(a.metin ?? '').trim().slice(0, 300);
  if ([metin, a.aciklama, a.konu, a.ad].some(x => x && SECRET.test(String(x)))) return j({ hata: 'Şifre, kart, IBAN ya da kimlik numarası deftere kaydedilmez.' });
  switch (a.islem) {
    case 'gorev_ekle': {
      if (!metin) return j({ hata: 'Görev metni boş' });
      const g = { id: id(), metin, tarih: parseDate(a.tarih) ?? parseDate(metin), at: new Date().toISOString() };
      d.gorevler.push(g); save();
      return j({ ok: true, eklendi: g.metin, tarih: fmt(g.tarih) || 'tarihsiz', acik: acikGorevler().length });
    }
    case 'gorev_bitti': case 'gorev_sil': {
      const list = acikGorevler();
      const g = findBy(list, a.no ?? metin, x => x.metin);
      if (!g) return j({ hata: 'Görev bulunamadı', acik: list.map((x, i) => `${i + 1}. ${x.metin}`) });
      if (a.islem === 'gorev_sil') d.gorevler = d.gorevler.filter(x => x.id !== g.id); else g.bitti = new Date().toISOString();
      save();
      return j({ ok: true, [a.islem === 'gorev_sil' ? 'silindi' : 'bitti']: g.metin, kalan: acikGorevler().length });
    }
    case 'gorevler': return j({ acik: acikGorevler().map((g, i) => `${i + 1}. ${g.metin}${g.tarih ? ` · ${fmt(g.tarih)}${g.tarih < today() ? ' (gecikti)' : ''}` : ''}`), bugun_biten: d.gorevler.filter(g => g.bitti?.startsWith(today())).map(g => g.metin) });
    case 'para_ekle': {
      const tutar = Number(a.tutar);
      const tur = ['gider', 'gelir', 'borc_verdim', 'borc_aldim', 'tahsil', 'odedim'].includes(a.tur) ? a.tur : 'gider';
      if (!(tutar > 0)) return j({ hata: 'Tutar gerekli' });
      if (['borc_verdim', 'borc_aldim', 'tahsil', 'odedim'].includes(tur) && !a.kisi) return j({ hata: 'Borç/alacak için kişi adı gerekli' });
      d.para.push({ id: id(), tur, tutar, kisi: a.kisi ? String(a.kisi).slice(0, 60) : undefined, aciklama: a.aciklama ? String(a.aciklama).slice(0, 120) : undefined, tarih: parseDate(a.tarih) ?? today() });
      save();
      const o = paraOzet();
      return j({ ok: true, kaydedildi: `${tur} · ${tutar} TL${a.kisi ? ` · ${a.kisi}` : ''}`, bu_ay: { gider: o.gider, gelir: o.gelir }, ...(a.kisi ? { kisi_durumu: [...o.bana_borclu, ...o.benim_borcum.map(x => ({ ...x, tutar: -x.tutar }))].find(x => x.kisi === a.kisi) } : {}) });
    }
    case 'para_ozet': return j({ ...paraOzet(/^\d{4}-\d{2}$/.test(String(a.ay)) ? String(a.ay) : undefined), not: 'Kart harcamaları (banka e-postaları) ayrı: harcamalar aracı.' });
    case 'takip_ekle': {
      if (!a.kisi) return j({ hata: 'Kişi gerekli' });
      const k = { id: id(), kisi: String(a.kisi).slice(0, 60), konu: String(a.konu ?? metin).slice(0, 200), tarih: parseDate(a.tarih), at: new Date().toISOString() };
      d.takipler.push(k); save();
      return j({ ok: true, eklendi: `${k.kisi}: ${k.konu}`, tarih: fmt(k.tarih) || 'tarihsiz' });
    }
    case 'takip_bitti': {
      const list = d.takipler.filter(k => !k.bitti);
      const k = findBy(list, a.no ?? a.kisi ?? metin, x => `${x.kisi} ${x.konu}`);
      if (!k) return j({ hata: 'Takip bulunamadı', acik: list.map((x, i) => `${i + 1}. ${x.kisi}: ${x.konu}`) });
      k.bitti = new Date().toISOString(); save();
      return j({ ok: true, bitti: `${k.kisi}: ${k.konu}` });
    }
    case 'takipler': {
      const list = d.takipler.filter(k => !k.bitti).sort((x, y) => (x.tarih ?? '9999').localeCompare(y.tarih ?? '9999'));
      return j({ donulecekler: list.map((k, i) => `${i + 1}. ${k.kisi}: ${k.konu}${k.tarih ? ` · ${fmt(k.tarih)}${k.tarih < today() ? ' (gecikti)' : k.tarih === today() ? ' (bugün)' : ''}` : ''}`) });
    }
    case 'aliskanlik_ekle': {
      if (!a.ad && !metin) return j({ hata: 'Alışkanlık adı gerekli' });
      const al = { id: id(), ad: String(a.ad ?? metin).slice(0, 80), gunler: [], at: new Date().toISOString() };
      d.aliskanliklar.push(al); save();
      return j({ ok: true, takip_ediliyor: al.ad });
    }
    case 'aliskanlik_yaptim': {
      const al = findBy(d.aliskanliklar, a.ad ?? metin, x => x.ad) ?? (d.aliskanliklar.length === 1 ? d.aliskanliklar[0] : undefined);
      if (!al) return j({ hata: 'Alışkanlık bulunamadı', liste: d.aliskanliklar.map(x => x.ad) });
      if (!al.gunler.includes(today())) al.gunler.push(today());
      save();
      return j({ ok: true, aliskanlik: al.ad, seri: seri(al) });
    }
    case 'aliskanliklar': return j({ aliskanliklar: d.aliskanliklar.map(x => ({ ad: x.ad, seri: seri(x), bugun: x.gunler.includes(today()), son_30_gun: x.gunler.filter(g => g >= addDays(-29)).length })) });
    case 'karar_ekle': {
      if (!metin) return j({ hata: 'Karar metni boş' });
      d.kararlar.push({ id: id(), metin, tarih: today() }); save();
      return j({ ok: true, kaydedildi: metin });
    }
    case 'kararlar': return j({ kararlar: d.kararlar.slice(-20).map(k => `${fmt(k.tarih)}: ${k.metin}`) });
    case 'hedef_ekle': {
      const adimlar = (Array.isArray(a.adimlar) ? a.adimlar : []).map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 12);
      if (!a.ad && !metin) return j({ hata: 'Hedef adı gerekli' });
      const h: Hedef = { id: id(), ad: String(a.ad ?? metin).slice(0, 120), adimlar: adimlar.map((m: string) => ({ metin: m.slice(0, 160) })), at: new Date().toISOString() };
      d.hedefler.push(h); save();
      return j({ ok: true, hedef: h.ad, adimlar: h.adimlar.map((x, i) => `${i + 1}. ${x.metin}`) });
    }
    case 'hedef_adim_bitti': {
      const h = findBy(d.hedefler, a.hedef ?? metin, x => x.ad) ?? (d.hedefler.length === 1 ? d.hedefler[0] : undefined);
      if (!h) return j({ hata: 'Hedef bulunamadı', hedefler: d.hedefler.map(x => x.ad) });
      const s = h.adimlar[(Number(a.no) || h.adimlar.findIndex(x => !x.bitti) + 1) - 1];
      if (!s) return j({ hata: 'Adım bulunamadı' });
      s.bitti = new Date().toISOString(); save();
      return j({ ok: true, hedef: h.ad, biten_adim: s.metin, ilerleme: `%${Math.round(100 * h.adimlar.filter(x => x.bitti).length / h.adimlar.length)}`, siradaki: h.adimlar.find(x => !x.bitti)?.metin ?? 'hepsi bitti 🎉' });
    }
    case 'hedefler': return j({ hedefler: d.hedefler.map(h => ({ ad: h.ad, ilerleme: `%${h.adimlar.length ? Math.round(100 * h.adimlar.filter(x => x.bitti).length / h.adimlar.length) : 0}`, adimlar: h.adimlar.map((x, i) => `${x.bitti ? '✓' : '○'} ${i + 1}. ${x.metin}`) })) });
    case 'gunaydin': return j({ ...gunaydin(), not: "Kısa ve sıcak bir günaydın: önce günün 3 işi, sonra dönülecek kişiler, alışkanlık ve hedefin sıradaki adımı. Hava/gündem istenirse ilgili araçlar." });
    case 'gunu_kapat': return j({ ...gunuKapat(), not: 'Biteni takdir et, kalanı yarına taşı önerisiyle söyle, yarının ilk işini net söyle.' });
    case 'uslup': {
      const s = samples(30);
      return j({ ornekler: s, not: s.length ? 'Bu örneklerdeki üslupla (kelime seçimi, uzunluk, selamlaşma, emoji kullanımı) taslak yaz. GÖNDERME; göndermek için mesaj_gonder (onay kartı).' : 'Kullanıcının kendi mesaj örneği yok; Hakkımda bilgisine göre samimi, kısa yaz.' });
    }
    case 'sifirla':
      return propose('komut', 'Defteri sıfırla', `Silinecek: ${d.gorevler.length} görev, ${d.para.length} para kaydı, ${d.takipler.length} takip, ${d.aliskanliklar.length} alışkanlık, ${d.kararlar.length} karar, ${d.hedefler.length} hedef`, 'Onaylarsanız defterdeki her şey silinir (geri alınamaz).',
        async () => { d = structuredClone(EMPTY); save(); return 'Defter sıfırlandı.'; });
  }
  return j({ hata: 'bilinmeyen işlem' });
}
