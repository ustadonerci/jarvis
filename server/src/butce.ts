// Bütçe Bekçisi: kart harcamalarını (banka e-postalarından, expenses.ts) aylık kategori limitleriyle kıyaslar,
// limite yaklaşınca / aşınca Patron'a Telegram'dan yazar (dikkat ve kritikte sesli mesaj da). Limitler yalnız
// Patron'un açık komutu ve onayıyla değişir. Harcama toplamları expenses.ts'in kaydından hesaplanır (her ay sıfırdan).
// Hiçbir ödeme/transfer başlatmaz; kart numarası, CVV, şifre, OTP içeren bildirimleri iletmez.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity, today } from './activity.js';
import { emailReady } from './email.js';
import { collectExpenses, drainUnreadable, isBankSender, monthItems, onNewExpenses, type Expense } from './expenses.js';
import { notifyOwner, sendOwnerVoice } from './messaging.js';
import { envVoice, synthesize } from './tts.js';

export const BUTCE_KAT = ['Kira ve Aidat', 'Faturalar', 'Mutfak ve Market', 'Ulaşım', 'Sağlık', 'Kişisel Keyif'] as const;
export type Kat = (typeof BUTCE_KAT)[number];
const ZORUNLU: Kat[] = ['Kira ve Aidat', 'Faturalar', 'Mutfak ve Market', 'Ulaşım', 'Sağlık'];
const DISI = 'Bütçe dışı';
const TOPLAM = 'Zorunlu giderler toplamı';
const ORAN = { zorunlu: 0.65, borc: 0.1, kisa: 0.1, uzun: 0.1, keyif: 0.05 };

interface State {
  gelir: number;
  limitler: Record<Kat, number>;
  /** işyeri anahtarı → Patron'un verdiği kategori */
  ogrenilen: Record<string, Kat | typeof DISI>;
  /** "2026-11|Mutfak ve Market" → tetiklenen eşikler (1 bilgi, 2 dikkat, 3 kritik) */
  uyarilar: Record<string, number[]>;
  sorulan: { anahtar: string; isyeri: string; tutar: number }[];
  bekleyen?: { gelir: number; limitler: Record<Kat, number>; ozet: string };
}

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'butce.json');
const VARSAYILAN: State = {
  gelir: 90_000,
  limitler: { 'Kira ve Aidat': 25_000, Faturalar: 5_500, 'Mutfak ve Market': 16_000, Ulaşım: 7_000, Sağlık: 5_000, 'Kişisel Keyif': 4_500 },
  ogrenilen: {}, uyarilar: {}, sorulan: [],
};
let st: State = (() => { try { return { ...VARSAYILAN, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return structuredClone(VARSAYILAN); } })();
const save = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(st, null, 1)); };

const tl = (n: number) => `${Math.round(n).toLocaleString('tr-TR')} TL`;
export const anahtar = (isyeri: string) => isyeri.toLocaleLowerCase('tr').replace(/[^a-zçğıöşü ]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- Kategori

const KURAL: [RegExp, Kat][] = [
  [/netflix|spotify|youtube premium|disney|exxen|blutv|steam|playstation|sinema|cinema|biletix|passo/i, 'Kişisel Keyif'],
  [/migros|a101|\bbim\b|şok|sok market|carrefour|getir ?market|getir büyük|file market|macro ?center|market/i, 'Mutfak ve Market'],
  [/shell|opet|\bbp\b|petrol ofisi|aytemiz|lukoil|total ?energies|otopark|\bhgs\b|\bogs\b/i, 'Ulaşım'],
  [/t[üu]rk telekom|turkcell|vodafone|superonline|enerjisa|ck enerji|igdaş|iski|aski|izsu|elektrik|doğalgaz|dogalgaz|su idaresi/i, 'Faturalar'],
  [/eczane|hastane|klinik|sigorta|diş|medical/i, 'Sağlık'],
  [/aidat|site yönetim|kira/i, 'Kira ve Aidat'],
  [/restoran|restaurant|cafe|kafe|kahve|starbucks|burger|pizza|döner|lokanta|yemeksepeti/i, 'Kişisel Keyif'],
];
const GIDER_KAT: Record<string, Kat> = { Market: 'Mutfak ve Market', 'Yemek / Restoran': 'Kişisel Keyif', Akaryakıt: 'Ulaşım', Ulaşım: 'Ulaşım', Sağlık: 'Sağlık', Eğlence: 'Kişisel Keyif', 'Fatura / Abonelik': 'Faturalar' };

/** Bütçe kategorisi; DISI = sayılmaz; null = emin değil (Patron'a sorulur) */
export function katOf(e: Pick<Expense, 'isyeri' | 'kategori'>, ogrenilen: State['ogrenilen'] = st.ogrenilen): Kat | typeof DISI | null {
  return ogrenilen[anahtar(e.isyeri)] ?? KURAL.find(([re]) => re.test(e.isyeri))?.[1] ?? GIDER_KAT[e.kategori] ?? null;
}

// ---------------------------------------------------------------- Hesap

const dk = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
/** Aynı işlem iki bildirimle gelirse (tutar ve işyeri aynı, aynı gün, 10 dk'dan az fark) bir kez sayılır */
export function tekil(list: Expense[]): Expense[] {
  const out: Expense[] = [];
  for (const e of list) {
    const ikiz = out.some(x => x.tur === e.tur && x.tutar === e.tutar && x.tarih === e.tarih && anahtar(x.isyeri) === anahtar(e.isyeri) && x.saat && e.saat && Math.abs(dk(x.saat) - dk(e.saat)) < 10);
    if (!ikiz) out.push(e);
  }
  return out;
}

/** Yalnız bankanın kendi adresinden (ya da kart ekstresinden) gelen TL harcamaları */
const gecerli = (ay: string) => tekil(monthItems(ay).filter(e => e.para === 'TRY' && (e.kaynak === 'Kart ekstresi' || isBankSender(e.kaynak))));

/** 0 yok, 1 bilgi, 2 dikkat, 3 kritik (limit aşıldı). 2.000 TL'den küçük limitlerde %75 ve %90. */
export function seviye(limit: number, harcanan: number): 0 | 1 | 2 | 3 {
  if (harcanan > limit) return 3;
  if (limit < 2000) return harcanan >= limit * 0.9 ? 2 : harcanan >= limit * 0.75 ? 1 : 0;
  const kalan = limit - harcanan;
  return kalan <= 1000 ? 2 : kalan <= 2000 ? 1 : 0;
}

export function durum(ay = today().slice(0, 7)) {
  const harcanan = Object.fromEntries(BUTCE_KAT.map(k => [k, 0])) as Record<Kat, number>;
  const bilinmeyen: Expense[] = [];
  for (const e of gecerli(ay)) {
    const k = katOf(e);
    if (k === DISI) continue;
    if (!k) { bilinmeyen.push(e); continue; }
    harcanan[k] += e.tur === 'iade' ? -e.tutar : e.tutar;
  }
  const satir = (ad: string, limit: number, h: number) => ({ ad, limit: Math.round(limit), harcanan: Math.round(h * 100) / 100, kalan: Math.round((limit - h) * 100) / 100 });
  return {
    ay,
    kategoriler: BUTCE_KAT.map(k => satir(k, st.limitler[k], harcanan[k])),
    toplam: satir(TOPLAM, st.gelir * ORAN.zorunlu, ZORUNLU.reduce((t, k) => t + harcanan[k], 0)),
    bilinmeyen,
  };
}

// ---------------------------------------------------------------- Uyarı

async function sesli(metin: string) {
  try {
    const s = await synthesize(metin, envVoice().sel, 'bütçe');
    if (s) await sendOwnerVoice(s.buf, s.mime);
  } catch (e: any) { console.warn(`[butce] sesli mesaj gönderilemedi: ${String(e?.message || e).slice(0, 120)}`); }
}

function mesaj(lv: number, s: { ad: string; limit: number; harcanan: number; kalan: number }, son?: Expense) {
  const ad = s.ad === TOPLAM ? 'zorunlu giderler' : s.ad.toLocaleLowerCase('tr');
  if (lv === 3) return `Patron, ${ad} bütçesini aştın: ${tl(s.limit)} limit, ${tl(s.harcanan)} harcama. ${tl(-s.kalan)} fazladasın.`;
  if (lv === 2) return `Dikkat Patron! ${ad[0].toLocaleUpperCase('tr') + ad.slice(1)} bütçende sadece ${tl(s.kalan)} kaldı.`;
  return `Patron, ${ad} bütçende ${tl(s.kalan)} kaldı. Bu ay ${tl(s.harcanan)} harcadın${son ? ` (son: ${son.isyeri}, ${tl(son.tutar)})` : ''}.`;
}

let busy = Promise.resolve();
/** Yeni harcamalardan sonra (ve kategori/limit değişince) eşikleri kontrol eder; her eşik ayda bir kez. */
export function kontrol(yeni: Expense[] = []): Promise<void> {
  busy = busy.then(() => kontrolOnce(yeni)).catch(e => console.warn(`[butce] kontrol başarısız: ${String(e?.message || e).slice(0, 160)}`));
  return busy;
}

async function kontrolOnce(yeni: Expense[]) {
  const ay = today().slice(0, 7);
  const buAy = yeni.filter(e => e.tarih.startsWith(ay) && e.para === 'TRY' && (e.kaynak === 'Kart ekstresi' || isBankSender(e.kaynak)));

  // Okunamayan bildirimler: tahmin edilmez, mesajın kendisi iletilir (şifre/kod içerenler hariç)
  for (const u of drainUnreadable()) {
    if (/şifre|parola|cvv|otp|doğrulama kodu|tek kullanımlık/i.test(`${u.konu} ${u.metin}`)) continue;
    await notifyOwner(`Patron, okuyamadığım bir harcama bildirimi var:\n${u.konu}\n${u.metin.slice(0, 400)}`, 'telegram').catch(() => []);
  }

  // Emin olunamayan işyerleri Patron'a bir kez sorulur
  for (const e of buAy.filter(x => x.tur === 'harcama' && !katOf(x))) {
    const a = anahtar(e.isyeri);
    if (!a || st.sorulan.some(s => s.anahtar === a)) continue;
    st.sorulan.push({ anahtar: a, isyeri: e.isyeri, tutar: e.tutar });
    save();
    await notifyOwner(`Patron, ${e.isyeri} işyerindeki ${tl(e.tutar)}'lik harcama hangi kategoriye girsin? (${BUTCE_KAT.join(', ')} ya da ${DISI})`, 'telegram').catch(() => []);
  }

  const d = durum(ay);
  for (const s of [...d.kategoriler, d.toplam]) {
    const lv = seviye(s.limit, s.harcanan);
    const key = `${ay}|${s.ad}`;
    const olan = st.uyarilar[key] ?? [];
    const kat = (e: Expense) => (s.ad === TOPLAM ? ZORUNLU.includes(katOf(e) as Kat) : katOf(e) === s.ad);
    const son = buAy.filter(x => x.tur === 'harcama' && kat(x)).at(-1);
    if (lv && !olan.includes(lv)) {
      st.uyarilar[key] = [...new Set([...olan, ...[1, 2, 3].filter(l => l <= lv)])];
      save();
      const m = mesaj(lv, s, son);
      await notifyOwner(m, 'telegram').catch(() => []);
      if (lv >= 2) await sesli(m);
      logActivity('butce', m);
    } else if (lv === 3 && son && s.ad !== TOPLAM) {
      await notifyOwner(`Patron, ${s.ad.toLocaleLowerCase('tr')} limitini ${tl(-s.kalan)} aştın.`, 'telegram').catch(() => []);
    }
  }
}

/** Akşam raporu için: eşiğe gelmiş kategoriler */
export function butceRaporu(): string[] {
  const d = durum();
  const l = [...d.kategoriler, d.toplam].filter(s => seviye(s.limit, s.harcanan)).map(s => `• ${s.ad}: ${s.kalan < 0 ? `${tl(-s.kalan)} aşıldı` : `${tl(s.kalan)} kaldı`} (limit ${tl(s.limit)})`);
  return l.length ? ['', '💰 Bütçe:', ...l] : [];
}

/** Ay sonu: Limit / Harcanan / Fark */
export function butceTablosu(ay: string): string {
  const d = durum(ay);
  return ['💰 Bütçe (Limit / Harcanan / Fark)', ...[...d.kategoriler, d.toplam].map(s => `• ${s.ad}: ${tl(s.limit)} / ${tl(s.harcanan)} / ${s.kalan < 0 ? '−' : '+'}${tl(Math.abs(s.kalan))}`)].join('\n');
}

export function initButce() {
  onNewExpenses(y => { kontrol(y); });
  // Uygulama şifresi (IMAP) varsa banka e-postaları 30 dakikada bir sessizce okunur; yoksa günlük raporun sabah/akşam taramaları
  setInterval(() => { if (emailReady()) collectExpenses(2).catch(() => {}); }, 30 * 60_000).unref();
}

// ---------------------------------------------------------------- Araç

const limitListesi = () => ({ gelir: st.gelir, limitler: st.limitler, zorunlu_toplam: st.gelir * ORAN.zorunlu, oranlar: '%65 zorunlu, %10 borç/ek yatırım, %10 kısa vade, %10 uzun vade, %5 keyif' });

export const BUTCE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'butce',
      description: "Bütçe Bekçisi: aylık kategori limitleri ve kart harcamalarının limitlere göre durumu. islem: durum (bu ay limit/harcanan/kalan + sınıflanamayan harcamalar), limitler ('limitleri göster'), limit_degistir (kategori, tutar), gelir_degistir (gelir; oranlarla yeniden hesaplar), onayla / vazgec (bekleyen limit değişikliği), kategori_ogret (isyeri, kategori: Patron'un 'X işyeri hangi kategori' sorusuna verdiği cevap). Limitler YALNIZ Patron isteyince değişir ve önce eski/yeni gösterilip onay alınır.",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['durum', 'limitler', 'limit_degistir', 'gelir_degistir', 'onayla', 'vazgec', 'kategori_ogret'] },
          kategori: { type: 'string', enum: [...BUTCE_KAT, DISI] },
          tutar: { type: 'number' },
          gelir: { type: 'number' },
          isyeri: { type: 'string' },
        },
        required: ['islem'],
      },
    },
  },
] as const;
export const isButceTool = (n: string) => n === 'butce';

export async function runButceTool(a: any): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  const d = () => { const x = durum(); return { ay: x.ay, kategoriler: x.kategoriler, toplam: x.toplam, siniflanamayan: x.bilinmeyen.map(e => `${e.isyeri} ${tl(e.tutar)} (${e.tarih})`) }; };
  switch (a.islem) {
    case 'limitler': return j(limitListesi());
    case 'limit_degistir': {
      const k = a.kategori as Kat, t = Math.round(Number(a.tutar));
      if (!BUTCE_KAT.includes(k) || !(t > 0)) return j({ hata: 'Kategori ve pozitif tutar gerekli', kategoriler: BUTCE_KAT });
      st.bekleyen = { gelir: st.gelir, limitler: { ...st.limitler, [k]: t }, ozet: `${k}: ${tl(st.limitler[k])} → ${tl(t)}` };
      save();
      return j({ onay_gerekli: st.bekleyen.ozet, not: "Eski ve yeni tutarı Patron'a göster; 'evet' derse islem=onayla çağır." });
    }
    case 'gelir_degistir': {
      const g = Math.round(Number(a.gelir));
      if (!(g > 0)) return j({ hata: 'Pozitif gelir gerekli' });
      const eskiZ = ZORUNLU.reduce((t, k) => t + st.limitler[k], 0) || 1;
      const yeni = { ...st.limitler };
      // Zorunlu kalemler mevcut paylarıyla gelir × %65'e ölçeklenir (100 TL'ye yuvarlanır); keyif gelir × %5
      for (const k of ZORUNLU) yeni[k] = Math.round((st.limitler[k] / eskiZ) * g * ORAN.zorunlu / 100) * 100;
      yeni['Kişisel Keyif'] = Math.round(g * ORAN.keyif / 100) * 100;
      st.bekleyen = { gelir: g, limitler: yeni, ozet: [`Gelir: ${tl(st.gelir)} → ${tl(g)}`, ...BUTCE_KAT.map(k => `${k}: ${tl(st.limitler[k])} → ${tl(yeni[k])}`), `Zorunlu toplam: ${tl(st.gelir * ORAN.zorunlu)} → ${tl(g * ORAN.zorunlu)}`].join('\n') };
      save();
      return j({ onay_gerekli: st.bekleyen.ozet, borc_yatirim: tl(g * ORAN.borc), kisa_vade: tl(g * ORAN.kisa), uzun_vade: tl(g * ORAN.uzun), not: "Eski ve yeni tutarları Patron'a göster; 'evet' derse islem=onayla çağır." });
    }
    case 'onayla': {
      if (!st.bekleyen) return j({ hata: 'Onay bekleyen limit değişikliği yok' });
      const ozet = st.bekleyen.ozet;
      st.gelir = st.bekleyen.gelir;
      st.limitler = st.bekleyen.limitler;
      delete st.bekleyen;
      save();
      logActivity('butce', `Limit değişti: ${ozet.replace(/\n/g, '; ')}`);
      await kontrol();
      return j({ ok: true, degisti: ozet, ...limitListesi() });
    }
    case 'vazgec': delete st.bekleyen; save(); return j({ ok: true });
    case 'kategori_ogret': {
      const k = a.kategori as Kat | typeof DISI;
      const key = anahtar(String(a.isyeri ?? ''));
      if (!key || !(BUTCE_KAT.includes(k as Kat) || k === DISI)) return j({ hata: 'İşyeri ve kategori gerekli', kategoriler: [...BUTCE_KAT, DISI], sorulan: st.sorulan });
      st.ogrenilen[key] = k;
      st.sorulan = st.sorulan.filter(s => s.anahtar !== key);
      save();
      await kontrol();
      return j({ ok: true, ogrenildi: `${a.isyeri} → ${k} (bundan sonra kendim uygularım)`, ...d() });
    }
    default: return j({ ...d(), sorulan: st.sorulan });
  }
}
