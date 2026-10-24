// Finans: canlı fiyat, teknik göstergeler, sinyal, portföy ve fiyat alarmı.
// - Veri: Yahoo Finance grafik API'si (anahtarsız; hisse, BIST, döviz, emtia, kripto). Kripto için yedek: Binance.
// - Sinyal: göstergelerden puanlanan basit bir kural seti (RSI, MACD, SMA 50/200, Bollinger). Gerekçesiyle döner.
//   Yatırım tavsiyesi değildir; Jarvis alım-satım yapmaz.
// - Portföy ve alarmlar server/data altında (git'e girmez).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Router } from 'express';
import { adminOnly } from './keys.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const PORTFOLIO_FILE = path.join(DATA, 'portfoy.json');
const ALARM_FILE = path.join(DATA, 'alarmlar.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const TROY_OUNCE_G = 31.1034768;

export interface Holding { id: string; sembol: string; adet: number; maliyet: number; at: string; not?: string }
export interface Alarm { id: string; sembol: string; kosul: 'ust' | 'alt'; fiyat: number; at: string; tetiklendi?: string }

const readJson = <T,>(f: string, d: T): T => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f: string, v: unknown) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };

// ---------------------------------------------------------------- Sembol çözümleme

/** Türkçe adlar → Yahoo sembolü. "GRAM_ALTIN" özel: ons altın × USD/TRY ÷ 31,1 */
const ALIASES: Record<string, string> = {
  'altin': 'GC=F', 'ons altin': 'GC=F', 'ons': 'GC=F', 'gold': 'GC=F', 'xau': 'GC=F', 'xauusd': 'GC=F',
  'gram altin': 'GRAM_ALTIN', 'gram': 'GRAM_ALTIN', 'gramaltin': 'GRAM_ALTIN',
  'gumus': 'SI=F', 'silver': 'SI=F', 'xag': 'SI=F', 'platin': 'PL=F', 'paladyum': 'PA=F',
  'petrol': 'BZ=F', 'brent': 'BZ=F', 'wti': 'CL=F', 'dogalgaz': 'NG=F', 'bakir': 'HG=F',
  'dolar': 'USDTRY=X', 'usd': 'USDTRY=X', 'usdtry': 'USDTRY=X', 'euro': 'EURTRY=X', 'eur': 'EURTRY=X', 'eurtry': 'EURTRY=X',
  'sterlin': 'GBPTRY=X', 'gbp': 'GBPTRY=X', 'eurusd': 'EURUSD=X', 'parite': 'EURUSD=X', 'yen': 'JPYTRY=X',
  'bist': 'XU100.IS', 'bist100': 'XU100.IS', 'bist 100': 'XU100.IS', 'xu100': 'XU100.IS', 'bist30': 'XU030.IS',
  'nasdaq': '^IXIC', 'sp500': '^GSPC', 's&p 500': '^GSPC', 'dow': '^DJI', 'dax': '^GDAXI',
  'bitcoin': 'BTC-USD', 'btc': 'BTC-USD', 'ethereum': 'ETH-USD', 'eth': 'ETH-USD', 'solana': 'SOL-USD', 'sol': 'SOL-USD',
  'xrp': 'XRP-USD', 'ripple': 'XRP-USD', 'bnb': 'BNB-USD', 'doge': 'DOGE-USD', 'dogecoin': 'DOGE-USD', 'avax': 'AVAX-USD',
  'cardano': 'ADA-USD', 'ada': 'ADA-USD', 'tether': 'USDT-USD', 'usdt': 'USDT-USD',
};
const norm = (s: string) => s.toLocaleLowerCase('tr').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').trim();

export function resolveSymbol(raw: string): string {
  const s = raw.trim();
  const a = ALIASES[norm(s)];
  if (a) return a;
  // "THYAO" gibi BIST kodu: kullanıcı ".IS" yazmadıysa ve kendisi bir Yahoo sembolü değilse
  if (/^[A-Za-z]{4,6}$/.test(s) && /^[A-Z]+$/.test(s.toUpperCase()) && BIST_HINT.test(s.toUpperCase())) return `${s.toUpperCase()}.IS`;
  return s.toUpperCase();
}
// Yaygın BIST kodları (diğerleri için model ".IS" ekler)
const BIST_HINT = /^(THYAO|ASELS|GARAN|AKBNK|YKBNK|ISCTR|KCHOL|SAHOL|SISE|EREGL|TUPRS|BIMAS|FROTO|TOASO|PGSUS|TCELL|TTKOM|KOZAL|HEKTS|SASA|PETKM|ARCLK|ENKAI|EKGYO|KRDMD|VESTL|ALARK|ASTOR|KONTR|MGROS|ULKER|DOAS|OYAKC|GUBRF|TAVHL|HALKB|VAKBN|SOKM|AEFES|CCOLA|TKFEN|ODAS|ZOREN|AKSEN|ENJSA|EUPWR|SMRTG|CIMSA|OTKAR|BRSAN|ISMEN|MAVI)$/;

const isCrypto = (y: string) => /-(USD|USDT|TRY)$/.test(y);

// ---------------------------------------------------------------- Veri

export interface Series {
  sembol: string; ad: string; para: string; kapanis: number[]; tarih: number[]; fiyat: number; kaynak: string;
  /** Günlük açılış/yüksek/düşük/hacim (kapanışla aynı sırada); hesaplanan serilerde (gram altın) yok */
  ohlc?: { acilis: number[]; yuksek: number[]; dusuk: number[]; hacim: number[] };
}

const cache = new Map<string, { at: number; s: Series }>();
const TTL = 60_000;

class NotFound extends Error {}

async function yahoo(sym: string, range = '1y'): Promise<Series> {
  // query1 yoğunlukta 429 verebiliyor; query2 aynı veriyi sunar
  let r: Response | null = null;
  let j: any = null;
  for (const host of ['query1', 'query2']) {
    r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d&includePrePost=false`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    j = await r?.json().catch(() => null);
    if (r && r.status !== 429 && r.status < 500) break;
  }
  const res = j?.chart?.result?.[0];
  // Yahoo bilinmeyen sembolde "No data found, symbol may be delisted" der
  if (r?.status === 404 || j?.chart?.error?.code === 'Not Found') throw new NotFound(`"${sym}" Yahoo Finance'ta bulunamadı`);
  if (!r?.ok || !res) throw new Error(`Yahoo Finance cevap vermedi (${r?.status ?? 'bağlantı yok'})${j?.chart?.error?.description ? `: ${j.chart.error.description}` : ''}`);
  const ts: number[] = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0] ?? {};
  const num = (a: any, i: number, d: number) => (typeof a?.[i] === 'number' ? a[i] : d);
  const rows = ts.map((t, i) => ({ t, c: q.close?.[i] })).filter((r): r is { t: number; c: number } => typeof r.c === 'number');
  if (rows.length < 2) throw new NotFound(`"${sym}" için fiyat geçmişi yok`);
  const idx = ts.map((_, i) => i).filter(i => typeof q.close?.[i] === 'number');
  const meta = res.meta ?? {};
  const fiyat = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : rows[rows.length - 1].c;
  return {
    sembol: sym, ad: meta.shortName || meta.longName || sym, para: meta.currency || '', kapanis: rows.map(r => r.c), tarih: rows.map(r => r.t * 1000), fiyat, kaynak: 'Yahoo Finance',
    ohlc: {
      acilis: idx.map(i => num(q.open, i, q.close[i])), yuksek: idx.map(i => num(q.high, i, q.close[i])),
      dusuk: idx.map(i => num(q.low, i, q.close[i])), hacim: idx.map(i => num(q.volume, i, 0)),
    },
  };
}

/** Yahoo arama: şirket adı ya da eksik yazılmış koddan sembol bulur (Borsa İstanbul öncelikli) */
async function yahooSearch(q: string): Promise<string[]> {
  const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&lang=tr-TR&region=TR`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const j: any = await r?.json().catch(() => null);
  const quotes: any[] = (j?.quotes ?? []).filter((x: any) => x?.symbol && /EQUITY|ETF|INDEX|CRYPTOCURRENCY|CURRENCY|FUTURE|MUTUALFUND/.test(String(x.quoteType)));
  quotes.sort((a, b) => Number(b.exchange === 'IST') - Number(a.exchange === 'IST'));
  return quotes.map(x => String(x.symbol)).slice(0, 4);
}

/** Bulunamayan sembol için denenecek diğer yazımlar: BIST (.IS), kripto (-USD) */
function alternatives(sym: string, raw: string): string[] {
  const out: string[] = [];
  const base = sym.replace(/\.IS$/, '');
  if (/^[A-Z0-9]{2,6}$/.test(sym)) out.push(`${sym}.IS`, `${sym}-USD`);
  if (/^[A-Z0-9]{2,6}\.IS$/.test(sym)) out.push(base);
  if (/^[A-Z0-9]{2,10}(USDT|TRY)$/.test(sym)) out.push(`${sym.replace(/(USDT|TRY)$/, '')}-USD`);
  return out.filter(x => x !== sym && x !== raw);
}

/** Kullanıcının yazdığı → bulunan Yahoo sembolü (yeniden aramamak için) */
const resolved = new Map<string, string>();

async function binance(sym: string): Promise<Series> {
  const base = sym.split('-')[0];
  const pair = `${base}USDT`;
  const [k, t] = await Promise.all([
    fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=365`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json()),
    fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json()),
  ]);
  if (!Array.isArray(k) || !k.length) throw new Error(`Binance'te ${pair} yok`);
  return {
    sembol: sym, ad: base, para: 'USD', kapanis: k.map((x: any[]) => Number(x[4])), tarih: k.map((x: any[]) => Number(x[0])), fiyat: Number(t?.price) || Number(k[k.length - 1][4]), kaynak: 'Binance',
    ohlc: { acilis: k.map((x: any[]) => Number(x[1])), yuksek: k.map((x: any[]) => Number(x[2])), dusuk: k.map((x: any[]) => Number(x[3])), hacim: k.map((x: any[]) => Number(x[5])) },
  };
}

export async function getSeries(raw: string): Promise<Series> {
  const sym = resolveSymbol(raw);
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL) return hit.s;
  let s: Series;
  if (sym === 'GRAM_ALTIN') {
    const [ons, usd] = await Promise.all([getSeries('GC=F'), getSeries('USDTRY=X')]);
    // Günleri tarihe göre eşleştir (tatiller farklı olabilir)
    const usdBy = new Map(usd.tarih.map((t, i) => [new Date(t).toISOString().slice(0, 10), usd.kapanis[i]]));
    const rows = ons.tarih.map((t, i) => [t, ons.kapanis[i] * (usdBy.get(new Date(t).toISOString().slice(0, 10)) ?? NaN) / TROY_OUNCE_G] as const).filter(r => Number.isFinite(r[1]));
    s = { sembol: 'GRAM_ALTIN', ad: 'Gram altın (ons × USD/TRY)', para: 'TRY', kapanis: rows.map(r => r[1]), tarih: rows.map(r => r[0]), fiyat: ons.fiyat * usd.fiyat / TROY_OUNCE_G, kaynak: 'Yahoo Finance (hesaplanan)' };
  } else {
    s = await findSeries(sym, raw);
  }
  cache.set(sym, { at: Date.now(), s });
  return s;
}

/** Önce sembolün kendisi; bulunamazsa diğer yazımlar, sonra Yahoo araması; kripto için Binance */
async function findSeries(sym: string, raw: string): Promise<Series> {
  const known = resolved.get(sym);
  if (known) return yahoo(known);
  let first: unknown;
  try {
    return await yahoo(sym);
  } catch (e) {
    first = e;
    if (!(e instanceof NotFound)) {
      if (isCrypto(sym)) return binance(sym);
      throw e;
    }
  }
  const tried = new Set([sym]);
  const tryAll = async (list: string[]) => {
    for (const alt of list) {
      if (tried.has(alt)) continue;
      tried.add(alt);
      try {
        const s = await yahoo(alt);
        resolved.set(sym, alt);
        console.log(`[finans] "${raw}" → ${alt}`);
        return s;
      } catch (e) { if (!(e instanceof NotFound)) throw e; }
    }
    return null;
  };
  const s = await tryAll(alternatives(sym, raw)) ?? await tryAll(await yahooSearch(raw.trim()));
  if (s) return s;
  if (isCrypto(sym)) return binance(sym).catch(() => { throw first; });
  throw new Error(`"${raw.trim()}" bulunamadı. Borsa İstanbul hissesi için kodu yazın (ör. THYAO ya da THYAO.IS); şirket adıyla da arayabilirsiniz.`);
}

// ---------------------------------------------------------------- Göstergeler

const last = (a: number[]) => a[a.length - 1];
export function sma(a: number[], n: number): number | null {
  if (a.length < n) return null;
  return a.slice(-n).reduce((x, y) => x + y, 0) / n;
}
export function emaSeries(a: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  a.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}
/** Wilder RSI */
export function rsi(a: number[], n = 14): number | null {
  if (a.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = a[i] - a[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
export function macd(a: number[]) {
  if (a.length < 35) return null;
  const e12 = emaSeries(a, 12), e26 = emaSeries(a, 26);
  const line = a.map((_, i) => e12[i] - e26[i]);
  const signal = emaSeries(line.slice(25), 9);
  const hist = signal.map((s, i) => line[i + 25] - s);
  return { macd: last(line), sinyal: last(signal), histogram: last(hist), oncekiHistogram: hist[hist.length - 2] };
}
export function bollinger(a: number[], n = 20, k = 2) {
  const m = sma(a, n);
  if (m === null) return null;
  const sd = Math.sqrt(a.slice(-n).reduce((s, v) => s + (v - m) ** 2, 0) / n);
  return { orta: m, ust: m + k * sd, alt: m - k * sd };
}
/** Günlük getirilerin yıllık oynaklığı (%) */
export function volatility(a: number[]): number | null {
  if (a.length < 20) return null;
  const r = a.slice(1).map((v, i) => Math.log(v / a[i]));
  const m = r.reduce((x, y) => x + y, 0) / r.length;
  return Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252) * 100;
}
/** En büyük düşüş (%) */
export function maxDrawdown(a: number[]): number {
  let peak = a[0], dd = 0;
  for (const v of a) { peak = Math.max(peak, v); dd = Math.min(dd, (v - peak) / peak); }
  return dd * 100;
}

const change = (a: number[], days: number) => (a.length > days ? (last(a) / a[a.length - 1 - days] - 1) * 100 : null);
/** Sayıyı fiyatın büyüklüğüne göre yuvarla (sahne görselleri bu değerleri doğrular) */
export const round = (v: number | null | undefined, d?: number): number | null => {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const digits = d ?? (Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 4 : 6);
  return Number(v.toFixed(digits));
};

// ---------------------------------------------------------------- Fiyat yapısı (OHLC gerekir)

/** Ortalama gerçek aralık (14): stop ve hedef mesafesi için */
export function atr(h: number[], l: number[], c: number[], n = 14): number | null {
  if (c.length <= n) return null;
  const tr = c.slice(1).map((_, i) => Math.max(h[i + 1] - l[i + 1], Math.abs(h[i + 1] - c[i]), Math.abs(l[i + 1] - c[i])));
  return tr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

/** Salınım tepeleri/dipleri (2 sol 2 sağ): üstündekiler alış tarafı, altındakiler satış tarafı likiditesi (stopların birikebileceği yerler) */
export function swings(h: number[], l: number[], look = 120) {
  const tepe: number[] = [], dip: number[] = [];
  const start = Math.max(2, h.length - look);
  for (let i = start; i < h.length - 2; i++) {
    if (h[i] > h[i - 1] && h[i] > h[i - 2] && h[i] >= h[i + 1] && h[i] >= h[i + 2]) tepe.push(h[i]);
    if (l[i] < l[i - 1] && l[i] < l[i - 2] && l[i] <= l[i + 1] && l[i] <= l[i + 2]) dip.push(l[i]);
  }
  return { tepe, dip };
}

/** Doldurulmamış adil değer boşlukları (FVG): 3 mumluk dizide 1. mumun tepesiyle 3. mumun dibi arasındaki boşluk */
export function fairValueGaps(h: number[], l: number[], look = 60) {
  const out: { yon: 'yükseliş' | 'düşüş'; alt: number; ust: number; gun_once: number }[] = [];
  const n = h.length;
  for (let i = Math.max(2, n - look); i < n; i++) {
    let gap: { yon: 'yükseliş' | 'düşüş'; alt: number; ust: number } | null = null;
    if (l[i] > h[i - 2]) gap = { yon: 'yükseliş', alt: h[i - 2], ust: l[i] };
    else if (h[i] < l[i - 2]) gap = { yon: 'düşüş', alt: h[i], ust: l[i - 2] };
    if (!gap) continue;
    // Sonraki mumlar boşluğa tamamen girdiyse dolmuş sayılır
    let filled = false;
    for (let j = i + 1; j < n && !filled; j++) filled = gap.yon === 'yükseliş' ? l[j] <= gap.alt : h[j] >= gap.ust;
    if (!filled) out.push({ ...gap, gun_once: n - 1 - i });
  }
  return out;
}

/** Hacim profili: son günlerin hacmi fiyat aralıklarına dağıtılır. POC = en çok işlem gören fiyat; değer alanı = hacmin %70'i */
export function volumeProfile(h: number[], l: number[], c: number[], v: number[], look = 120, bins = 24) {
  const s = Math.max(0, c.length - look);
  const lo = Math.min(...l.slice(s)), hi = Math.max(...h.slice(s));
  if (!(hi > lo) || !v.slice(s).some(x => x > 0)) return null;
  const step = (hi - lo) / bins;
  const vol = new Array(bins).fill(0);
  for (let i = s; i < c.length; i++) {
    // Mumun hacmi kapsadığı aralıklara eşit dağıtılır
    const a = Math.max(0, Math.floor((l[i] - lo) / step)), b = Math.min(bins - 1, Math.floor((h[i] - lo) / step));
    for (let k = a; k <= b; k++) vol[k] += v[i] / (b - a + 1);
  }
  const poc = vol.indexOf(Math.max(...vol));
  const total = vol.reduce((x, y) => x + y, 0);
  let inArea = vol[poc], dn = poc, up = poc;
  while (inArea < total * 0.7 && (dn > 0 || up < bins - 1)) {
    const nd = dn > 0 ? vol[dn - 1] : -1, nu = up < bins - 1 ? vol[up + 1] : -1;
    if (nu >= nd) inArea += vol[++up]; else inArea += vol[--dn];
  }
  const mid = (k: number) => lo + step * (k + 0.5);
  return { poc: mid(poc), deger_alani_ust: lo + step * (up + 1), deger_alani_alt: lo + step * dn };
}

export type Signal = 'AL' | 'SAT' | 'KÂR AL' | 'TUT';

export function analyze(s: Series, holding?: { maliyet: number }) {
  const c = s.kapanis.slice();
  // Güncel fiyat son kapanıştan farklıysa (seans içi) hesaba kat
  if (Math.abs(s.fiyat - last(c)) / last(c) > 1e-6) c.push(s.fiyat);
  const p = s.fiyat;
  const r = rsi(c), m = macd(c), b = bollinger(c);
  const s50 = sma(c, 50), s200 = sma(c, 200);
  let puan = 0;
  const gerekce: string[] = [];
  if (r !== null) {
    if (r < 30) { puan += 2; gerekce.push(`RSI ${r.toFixed(1)}: aşırı satım bölgesi (+2)`); }
    else if (r > 70) { puan -= 2; gerekce.push(`RSI ${r.toFixed(1)}: aşırı alım bölgesi (−2)`); }
    else gerekce.push(`RSI ${r.toFixed(1)}: nötr`);
  }
  if (m) {
    if (m.histogram > 0 && m.oncekiHistogram <= 0) { puan += 2; gerekce.push('MACD sinyal çizgisini yukarı kesti (+2)'); }
    else if (m.histogram < 0 && m.oncekiHistogram >= 0) { puan -= 2; gerekce.push('MACD sinyal çizgisini aşağı kesti (−2)'); }
    else if (m.histogram > 0) { puan += 1; gerekce.push('MACD pozitif, yükseliş ivmesi (+1)'); }
    else { puan -= 1; gerekce.push('MACD negatif, düşüş ivmesi (−1)'); }
  }
  if (s50 !== null) {
    if (p > s50) { puan += 1; gerekce.push('Fiyat 50 günlük ortalamanın üstünde (+1)'); }
    else { puan -= 1; gerekce.push('Fiyat 50 günlük ortalamanın altında (−1)'); }
  }
  if (s50 !== null && s200 !== null) {
    if (s50 > s200) { puan += 1; gerekce.push('50 günlük ortalama 200 günlüğün üstünde: uzun vadeli yükseliş eğilimi (+1)'); }
    else { puan -= 1; gerekce.push('50 günlük ortalama 200 günlüğün altında: uzun vadeli düşüş eğilimi (−1)'); }
  }
  if (b) {
    if (p < b.alt) { puan += 1; gerekce.push('Fiyat alt Bollinger bandının altında (+1)'); }
    else if (p > b.ust) { puan -= 1; gerekce.push('Fiyat üst Bollinger bandının üstünde (−1)'); }
  }
  const kar = holding && holding.maliyet > 0 ? (p / holding.maliyet - 1) * 100 : null;
  let sinyal: Signal = puan >= 3 ? 'AL' : puan <= -3 ? 'SAT' : 'TUT';
  // Elde olan ve yüksek kârdaki varlık aşırı alımdaysa ya da ivme dönüyorsa kâr almayı öner
  if (kar !== null && kar >= 15 && ((r !== null && r > 65) || (m && m.histogram < 0))) {
    sinyal = 'KÂR AL';
    gerekce.push(`Pozisyon %${kar.toFixed(1)} kârda ve ivme zayıflıyor: kârın bir kısmını realize etmek düşünülebilir`);
  }
  // Yapı: likidite seviyeleri, FVG, hacim profili, ATR'ye göre stop/hedef ve risk/ödül
  let yapi: any = null, plan: any = null;
  const o = s.ohlc;
  if (o && o.yuksek.length === s.kapanis.length && o.yuksek.length > 30) {
    const a = atr(o.yuksek, o.dusuk, s.kapanis);
    const sw = swings(o.yuksek, o.dusuk);
    const direnc = sw.tepe.filter(x => x > p).sort((x, y) => x - y).slice(0, 3);
    const destek = sw.dip.filter(x => x < p).sort((x, y) => y - x).slice(0, 3);
    const gaps = fairValueGaps(o.yuksek, o.dusuk).sort((x, y) => Math.abs((x.alt + x.ust) / 2 - p) - Math.abs((y.alt + y.ust) / 2 - p)).slice(0, 3);
    const vp = volumeProfile(o.yuksek, o.dusuk, s.kapanis, o.hacim);
    yapi = {
      atr14: round(a), direncler_alis_likiditesi: direnc.map(x => round(x)), destekler_satis_likiditesi: destek.map(x => round(x)),
      fvg: gaps.map(g => ({ yon: g.yon, alt: round(g.alt), ust: round(g.ust), gun_once: g.gun_once })),
      hacim_profili: vp ? { poc: round(vp.poc), deger_alani_ust: round(vp.deger_alani_ust), deger_alani_alt: round(vp.deger_alani_alt), fiyat_konumu: p > vp.deger_alani_ust ? 'değer alanının üstünde' : p < vp.deger_alani_alt ? 'değer alanının altında' : 'değer alanı içinde' } : null,
    };
    if (vp) {
      if (p > vp.deger_alani_ust) gerekce.push(`Fiyat hacim profilinin değer alanı üstünde (POC ${round(vp.poc)}): kabul görürse yükseliş sürer, geri dönerse POC'a çekilebilir`);
      else if (p < vp.deger_alani_alt) gerekce.push(`Fiyat değer alanının altında (POC ${round(vp.poc)}): zayıflık; POC'a dönüş direnç olabilir`);
    }
    if (a) {
      const yukari = sinyal !== 'SAT';
      // Stop: en yakın destek/direncin yarım ATR ötesi; çok yakın ya da çok uzaksa 1,5 ATR
      const nearStop = yukari ? (destek[0] !== undefined ? destek[0] - 0.5 * a : NaN) : (direnc[0] !== undefined ? direnc[0] + 0.5 * a : NaN);
      const dist = Math.abs(p - nearStop);
      const stop = Number.isFinite(nearStop) && dist >= 0.75 * a && dist <= 3 * a ? nearStop : yukari ? p - 1.5 * a : p + 1.5 * a;
      const risk = Math.abs(p - stop);
      const hedef1 = yukari ? (direnc[0] !== undefined && direnc[0] - p >= risk ? direnc[0] : p + 2 * risk) : (destek[0] !== undefined && p - destek[0] >= risk ? destek[0] : p - 2 * risk);
      const hedef2 = yukari ? Math.max(hedef1, p + 3 * risk) : Math.min(hedef1, p - 3 * risk);
      plan = {
        yon: { AL: 'alış', TUT: 'bekle: yeni alış için net sinyal yok; pozisyon varsa koruma seviyeleri', 'KÂR AL': 'kârın bir kısmını al, kalanını stopla koru', SAT: 'satış / pozisyondan çık' }[sinyal],
        giris: round(p), stop_loss: round(stop), hedef1: round(hedef1), hedef2: round(hedef2),
        risk_odul: round(Math.abs(hedef1 - p) / risk, 2), stop_mesafesi_yuzde: round((risk / p) * 100, 2),
        not: 'Kural tabanlı hesap (ATR, destek/direnç); yatırım tavsiyesi değildir. Pozisyon büyüklüğü: sermayenin %1–2\'sinden fazlasını tek stopla riske atma.',
      };
    }
  }
  return {
    sembol: s.sembol, ad: s.ad, para: s.para, kaynak: s.kaynak,
    fiyat: round(p),
    degisim: { gunluk: round(change(c, 1), 2), haftalik: round(change(c, 5), 2), aylik: round(change(c, 21), 2), yillik: round(change(c, 252), 2) },
    gostergeler: {
      rsi14: round(r, 1),
      macd: m ? { macd: round(m.macd), sinyal: round(m.sinyal), histogram: round(m.histogram) } : null,
      sma20: round(sma(c, 20)), sma50: round(s50), sma200: round(s200),
      bollinger: b ? { ust: round(b.ust), orta: round(b.orta), alt: round(b.alt) } : null,
      yillik_oynaklik: round(volatility(c.slice(-253)), 1),
      en_buyuk_dusus_1y: round(maxDrawdown(c.slice(-253)), 1),
    },
    sinyal, puan, gerekce,
    ...(yapi ? { yapi } : {}),
    ...(plan ? { islem_plani: plan } : {}),
    ...(kar !== null ? { pozisyon_kar_yuzde: round(kar, 2) } : {}),
    // Son 10 işlem günü (grafik sahnesi bu sayılardan çizilir)
    son_kapanislar: s.tarih.slice(-10).map((t, i) => ({ tarih: new Date(t).toISOString().slice(0, 10), kapanis: round(s.kapanis.slice(-10)[i]) })),
  };
}

// ---------------------------------------------------------------- Portföy

const portfolio = () => readJson<Holding[]>(PORTFOLIO_FILE, []);
/** USD varlıklar TL'ye çevrilir (rapor TL bazında) */
async function toTry(para: string): Promise<number> {
  if (!para || para === 'TRY') return 1;
  const fx: Record<string, string> = { USD: 'USDTRY=X', EUR: 'EURTRY=X', GBP: 'GBPTRY=X' };
  if (!fx[para]) return NaN;
  return (await getSeries(fx[para])).fiyat;
}

export async function portfolioReport() {
  const list = portfolio();
  if (!list.length) return { bos: true, mesaj: 'Portföy boş. "Portföyüme 10 adet THYAO ekle, maliyet 300" gibi ekleyebilir ya da Ayarlar → Portföy bölümünü kullanabilirsin.' };
  const rows = await Promise.all(list.map(async h => {
    try {
      const s = await getSeries(h.sembol);
      const kur = await toTry(s.para);
      const a = analyze(s, h);
      const deger = s.fiyat * h.adet * kur;
      const maliyet = h.maliyet * h.adet * kur;
      return { id: h.id, sembol: h.sembol, ad: s.ad, adet: h.adet, para: s.para, fiyat: round(s.fiyat), maliyet_birim: h.maliyet, deger_tl: round(deger, 2)!, maliyet_tl: round(maliyet, 2)!, kar_tl: round(deger - maliyet, 2)!, kar_yuzde: round((deger / maliyet - 1) * 100, 2), gunluk_degisim: a.degisim.gunluk, oynaklik: a.gostergeler.yillik_oynaklik, sinyal: a.sinyal, kapanis: s.kapanis.slice(-253), kur };
    } catch (e: any) {
      return { id: h.id, sembol: h.sembol, adet: h.adet, hata: String(e?.message || e) };
    }
  }));
  const ok = rows.filter((r): r is Extract<typeof r, { deger_tl: number }> => 'deger_tl' in r);
  const toplam = ok.reduce((s, r) => s + r.deger_tl, 0);
  const maliyet = ok.reduce((s, r) => s + r.maliyet_tl, 0);
  // Portföy oynaklığı: ağırlıklı günlük getiriler (ortak son N gün)
  const n = Math.min(...ok.map(r => r.kapanis.length));
  let oynaklik: number | null = null, dusus: number | null = null;
  if (ok.length && n > 20) {
    const value = Array.from({ length: n }, (_, i) => ok.reduce((s, r) => s + r.kapanis[r.kapanis.length - n + i] * r.adet * r.kur, 0));
    oynaklik = round(volatility(value), 1);
    dusus = round(maxDrawdown(value), 1);
  }
  return {
    toplam_deger_tl: round(toplam, 2), toplam_maliyet_tl: round(maliyet, 2), toplam_kar_tl: round(toplam - maliyet, 2),
    toplam_kar_yuzde: maliyet ? round((toplam / maliyet - 1) * 100, 2) : null,
    risk: { yillik_oynaklik: oynaklik, en_buyuk_dusus_1y: dusus, getiri_risk_orani: oynaklik && maliyet ? round(((toplam / maliyet - 1) * 100) / oynaklik, 2) : null },
    varliklar: rows.map(r => {
      if (!('deger_tl' in r)) return r;
      const { kapanis, kur, ...rest } = r;
      return { ...rest, agirlik_yuzde: toplam ? round(((rest.deger_tl ?? 0) / toplam) * 100, 1) : null };
    }),
    not: 'Sinyaller teknik göstergelerden hesaplanır; yatırım tavsiyesi değildir.',
  };
}

export function addHolding(sembol: string, adet: number, maliyet: number, not?: string): Holding | { hata: string } {
  if (!sembol.trim() || !(adet > 0) || !(maliyet >= 0)) return { hata: 'sembol, adet (>0) ve maliyet gerekli' };
  const list = portfolio();
  const sym = resolveSymbol(sembol);
  const ex = list.find(h => h.sembol === sym);
  // Aynı varlık tekrar eklenirse ortalama maliyetle birleştir
  if (ex) {
    ex.maliyet = (ex.maliyet * ex.adet + maliyet * adet) / (ex.adet + adet);
    ex.adet += adet;
    writeJson(PORTFOLIO_FILE, list);
    return ex;
  }
  const h: Holding = { id: randomUUID().slice(0, 8), sembol: sym, adet, maliyet, at: new Date().toISOString(), not };
  list.push(h);
  writeJson(PORTFOLIO_FILE, list);
  return h;
}
export function removeHolding(q: string, adet?: number): Holding | { hata: string } {
  const list = portfolio();
  const sym = resolveSymbol(q);
  const i = list.findIndex(h => h.id === q || h.sembol === sym);
  if (i < 0) return { hata: `${q} portföyde yok` };
  const h = list[i];
  if (adet && adet < h.adet) h.adet -= adet; else list.splice(i, 1);
  writeJson(PORTFOLIO_FILE, list);
  return h;
}

// ---------------------------------------------------------------- Alarmlar

const alarms = () => readJson<Alarm[]>(ALARM_FILE, []);
let broadcast: (e: object) => void = () => {};

async function checkAlarms() {
  const list = alarms();
  const open = list.filter(a => !a.tetiklendi);
  if (!open.length) return;
  for (const a of open) {
    try {
      const s = await getSeries(a.sembol);
      if ((a.kosul === 'ust' && s.fiyat >= a.fiyat) || (a.kosul === 'alt' && s.fiyat <= a.fiyat)) {
        a.tetiklendi = new Date().toISOString();
        console.log(`[finans] alarm: ${a.sembol} ${a.kosul === 'ust' ? '≥' : '≤'} ${a.fiyat} (şu an ${round(s.fiyat)})`);
        broadcast({ type: 'alarm', sembol: a.sembol, ad: s.ad, fiyat: round(s.fiyat), hedef: a.fiyat, kosul: a.kosul });
      }
    } catch { /* veri yoksa bir sonraki turda */ }
  }
  writeJson(ALARM_FILE, list);
}

export function initFinance(b: (e: object) => void) {
  broadcast = b;
  setInterval(() => checkAlarms().catch(() => {}), 5 * 60_000).unref();
}

// ---------------------------------------------------------------- Model araçları

export const FINANCE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'piyasa_analiz',
      description: "Bir hisse (BIST dahil), kripto, döviz, altın/gümüş ya da endeksin canlı fiyatını, günlük/haftalık/aylık/yıllık değişimini, teknik göstergelerini (RSI, MACD, SMA 20/50/200, Bollinger, oynaklık) ve gerekçeli Al/Sat/Tut sinyalini, fiyat yapısını (destek/direnç = likidite seviyeleri, doldurulmamış FVG'ler, hacim profili POC ve değer alanı, ATR) ve işlem planını (giriş, stop-loss, hedef 1-2, risk/ödül) getirir. 'Bitcoin ne olur', 'THYAO alınır mı', 'gram altın kaç', 'dolar analizi' gibi isteklerde kullanılır.",
      parameters: {
        type: 'object',
        properties: {
          sembol: { type: 'string', description: 'Ör. "bitcoin", "ETH-USD", "THYAO" (BIST için THYAO.IS de olur), "gram altın", "ons altın", "dolar", "AAPL", "BIST100"' },
        },
        required: ['sembol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'portfoy_rapor',
      description: 'Kullanıcının portföyündeki varlıkların güncel değerini, TL bazında kâr/zararını, ağırlıklarını, her birinin sinyalini ve portföyün risk ölçülerini (yıllık oynaklık, en büyük düşüş, getiri/risk) getirir.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'portfoy_guncelle',
      description: "Portföye varlık ekler ya da çıkarır. 'Portföyüme 0,5 bitcoin ekle, 60 bin dolardan aldım', '10 THYAO sattım' gibi isteklerde. Maliyet, varlığın kendi para birimindedir (BIST için TL, kripto/ABD hissesi için USD).",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['ekle', 'cikar'] },
          sembol: { type: 'string' },
          adet: { type: 'number', description: 'Adet / miktar (gram altın için gram)' },
          maliyet: { type: 'number', description: 'Birim alış fiyatı (yalnızca ekle)' },
        },
        required: ['islem', 'sembol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fiyat_alarmi',
      description: "Fiyat alarmı kurar ya da alarmları listeler/siler. 'Bitcoin 100 bini geçerse haber ver', 'gram altın 3000'in altına düşerse söyle'. Alarmlar 5 dakikada bir kontrol edilir ve ekranda bildirim çıkar.",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['kur', 'listele', 'sil'] },
          sembol: { type: 'string' },
          kosul: { type: 'string', enum: ['ust', 'alt'], description: 'ust: fiyat bu değerin üstüne çıkınca; alt: altına inince' },
          fiyat: { type: 'number' },
          id: { type: 'string', description: 'sil için alarm kimliği' },
        },
        required: ['islem'],
      },
    },
  },
] as const;

export const isFinanceTool = (n: string) => FINANCE_TOOLS.some(t => t.function.name === n);

export async function runFinanceTool(name: string, args: any, progress: (l: string) => void): Promise<string> {
  try {
    if (name === 'piyasa_analiz') {
      const q = String(args.sembol ?? '').trim();
      progress(`piyasa: ${q}`);
      const h = portfolio().find(x => x.sembol === resolveSymbol(q));
      const a = analyze(await getSeries(q), h);
      progress(`${a.ad}: ${a.fiyat} ${a.para} · ${a.sinyal}`);
      return JSON.stringify({ ...a, not: 'Sinyal teknik göstergelerden hesaplandı; yatırım tavsiyesi değildir. Bunu cevapta kısaca belirt.' });
    }
    if (name === 'portfoy_rapor') {
      progress('portföy hesaplanıyor');
      return JSON.stringify(await portfolioReport());
    }
    if (name === 'portfoy_guncelle') {
      const r = args.islem === 'cikar'
        ? removeHolding(String(args.sembol ?? ''), Number(args.adet) || undefined)
        : addHolding(String(args.sembol ?? ''), Number(args.adet), Number(args.maliyet));
      progress('hata' in r ? `portföy: ${r.hata}` : `portföy güncellendi: ${r.sembol}`);
      broadcast({ type: 'portfoy' });
      return JSON.stringify('hata' in r ? r : { ok: true, islem: args.islem, varlik: r });
    }
    if (name === 'fiyat_alarmi') {
      const list = alarms();
      if (args.islem === 'listele') return JSON.stringify({ alarmlar: list.filter(a => !a.tetiklendi) });
      if (args.islem === 'sil') {
        const rest = list.filter(a => a.id !== args.id && !(args.sembol && a.sembol === resolveSymbol(String(args.sembol))));
        writeJson(ALARM_FILE, rest);
        return JSON.stringify({ ok: true, silinen: list.length - rest.length });
      }
      const fiyat = Number(args.fiyat);
      if (!args.sembol || !(fiyat > 0)) return JSON.stringify({ hata: 'sembol ve fiyat gerekli' });
      const s = await getSeries(String(args.sembol));
      const kosul: 'ust' | 'alt' = args.kosul === 'alt' || args.kosul === 'ust' ? args.kosul : fiyat >= s.fiyat ? 'ust' : 'alt';
      const a: Alarm = { id: randomUUID().slice(0, 8), sembol: s.sembol, kosul, fiyat, at: new Date().toISOString() };
      writeJson(ALARM_FILE, [...list, a]);
      progress(`alarm: ${s.ad} ${kosul === 'ust' ? '≥' : '≤'} ${fiyat}`);
      return JSON.stringify({ ok: true, alarm: a, simdiki_fiyat: round(s.fiyat), para: s.para });
    }
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 200), not: 'Veri alınamadı; rakam uydurma.' });
  }
  return JSON.stringify({ hata: 'bilinmeyen araç' });
}

// ---------------------------------------------------------------- HTTP (Ayarlar → Portföy)

export function financeRouter(): Router {
  const r = express.Router();
  r.use('/api/finans', adminOnly);
  r.get('/api/finans/portfoy', async (_req, res) => res.json(await portfolioReport().catch(e => ({ hata: String(e?.message || e) }))));
  r.post('/api/finans/portfoy', (req, res) => {
    const h = addHolding(String(req.body?.sembol ?? ''), Number(req.body?.adet), Number(req.body?.maliyet));
    'hata' in h ? res.status(400).json({ error: h.hata }) : res.json({ ok: true, varlik: h });
  });
  r.delete('/api/finans/portfoy/:id', (req, res) => {
    const h = removeHolding(req.params.id);
    'hata' in h ? res.status(404).json({ error: h.hata }) : res.json({ ok: true });
  });
  r.get('/api/finans/alarm', (_req, res) => res.json({ alarmlar: alarms() }));
  r.delete('/api/finans/alarm/:id', (req, res) => {
    writeJson(ALARM_FILE, alarms().filter(a => a.id !== req.params.id));
    res.json({ ok: true });
  });
  return r;
}
