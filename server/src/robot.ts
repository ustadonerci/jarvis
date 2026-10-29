// Otomatik alım-satım robotu. piyasa_analiz'deki kural tabanlı sinyali (RSI, MACD, ortalamalar, Bollinger) ve işlem
// planını (ATR'ye göre stop, hedef 1-2, risk/ödül) kullanır:
//  - Pozisyon yokken sinyal AL ve risk/ödül yeterliyse alır; stop'a değerse zararı keser, hedef 1'de stop'u maliyete
//    çeker (artık zarar etmez), hedef 2'de ya da sinyal SAT olunca satar. Aynı sembolü kapattıktan sonra 12 saat almaz.
//  - Günlük zarar sınırına ulaşınca robot kendini durdurur ve haber verir. "Robotu durdur" her zaman anında çalışır.
// Modlar:
//  - kagit (varsayılan): sanal bakiyeyle simülasyon; gerçek para yok. BIST, ABD hissesi, kripto, altın hepsi olur.
//  - canli: yalnızca kripto; Binance spot (BINANCE_API_KEY / BINANCE_API_SECRET) ya da OKX TR spot (OKX_API_KEY /
//    OKX_API_SECRET / OKX_API_PASSPHRASE, adres OKX_API_URL), USDT pariteleri. Açmak, yeniden başlatmak, ayarları
//    değiştirmek ve elle pozisyon kapatmak onay kartıyla. Çekim (withdraw) izni açık anahtar reddedilir; işlem başı
//    tutar ROBOT_CANLI_MAX'ı (varsayılan 100 USDT) geçemez. BINANCE_API_URL=https://testnet.binance.vision ile test ağı.
// strateji_gelistir: tüm indikatörleri ve varsayılan puanı seçili sembollerde geriye dönük dener, getiri/düşüş/tutarlılığa
// göre sıralar ve en iyisini seçer (canlı modda onay kartıyla).
// Yatırım tavsiyesi değildir; geçmiş sonuç geleceği göstermez.
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { propose } from './approvals.js';
import { analyze, getSeries, resolveSymbol, round, type Series } from './finance.js';
import { okxSign } from './exchanges.js';
import { findIndicator, indicatorDecision, INDICATORS } from './indicators.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CFG_FILE = path.join(DATA, 'robot.json');
const STATE_FILE = path.join(DATA, 'robot-durum.json');

export interface RobotConfig {
  aktif: boolean; mod: 'kagit' | 'canli'; semboller: string[];
  /** İşlem başı tutar (USD karşılığı) */
  islem_basi: number; max_pozisyon: number; gunluk_zarar_limiti: number; aralik_dk: number; min_risk_odul: number; baslangic_bakiye: number;
  /** 'varsayilan': piyasa_analiz puanı; ya da bir indikatör id'si (indicators.ts: supertrend, utbot, squeeze…) */
  strateji?: string;
  /** Canlı modun borsası (varsayılan binance) */
  borsa?: Venue;
}
type Venue = 'binance' | 'okx';
interface Position { sembol: string; para: string; adet: number; giris: number; stop: number; hedef1: number; hedef2: number; h1: boolean; maliyet_usd: number; at: string; mod: 'kagit' | 'canli'; borsa?: Venue }
interface Trade { id: string; at: string; sembol: string; yon: 'AL' | 'SAT'; fiyat: number; adet: number; tutar_usd: number; neden: string; kar_usd?: number; mod: 'kagit' | 'canli' }
interface RobotState { nakit_usd: number; pozisyonlar: Record<string, Position>; islemler: Trade[]; gun: { tarih: string; pnl: number }; son_kapanis: Record<string, string>; son_tur?: string; durdu?: string; hata_sayisi: number; /** Günlük sınır sonrası: yeni alış yok ama açık pozisyonların stop/hedefi izlenir */ koruma?: boolean }

const DEFAULT_CFG: RobotConfig = { aktif: false, mod: 'kagit', semboller: ['BTC-USD', 'ETH-USD'], islem_basi: 100, max_pozisyon: 3, gunluk_zarar_limiti: 50, aralik_dk: 15, min_risk_odul: 1.5, baslangic_bakiye: 1000 };
const readJson = <T,>(f: string, d: T): T => { try { return { ...d, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return d; } };
const writeJson = (f: string, v: unknown) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const freshState = (c: RobotConfig): RobotState => ({ nakit_usd: c.baslangic_bakiye, pozisyonlar: {}, islemler: [], gun: { tarih: today(), pnl: 0 }, son_kapanis: {}, hata_sayisi: 0 });
const today = () => new Date().toISOString().slice(0, 10);

/** Seçili stratejiye göre sinyal ve işlem planı */
function decide(s: Series, strateji = cfg.strateji): { sinyal: string; puan?: number; islem_plani?: any } {
  const id = strateji && strateji !== 'varsayilan' ? strateji : '';
  return id ? indicatorDecision(id, s) : (analyze(s) as any);
}

let cfg = readJson(CFG_FILE, DEFAULT_CFG);
let st = readJson<RobotState>(STATE_FILE, freshState(cfg));
const saveCfg = () => writeJson(CFG_FILE, cfg);
const saveState = () => { st.islemler = st.islemler.slice(-500); writeJson(STATE_FILE, st); };

let broadcast: (e: object) => void = () => {};
let notify: (t: string) => Promise<unknown> = async () => {};
const tell = (metin: string, phone = false) => {
  console.log(`[robot] ${metin}`);
  broadcast({ type: 'robot', metin });
  if (phone) notify(`🤖 Jarvis borsa robotu: ${metin}`).catch(() => {});
};

const LIVE_MAX = () => Number(process.env.ROBOT_CANLI_MAX) || 100;
const isCrypto = (sym: string) => /-(USD|USDT)$/.test(sym);

// ---------------------------------------------------------------- Kur çevirisi (kâğıt bakiye USD)

async function usdPer(para: string): Promise<number> {
  if (!para || para === 'USD' || para === 'USDT') return 1;
  const s = await getSeries(`USD${para}=X`); // USDTRY=X → 1 USD kaç TL
  return 1 / s.fiyat;
}

// ---------------------------------------------------------------- Binance (canlı)

const BIN = () => (process.env.BINANCE_API_URL || 'https://api.binance.com').replace(/\/$/, '');
export const binanceReady = () => !!(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET);
const pairOf = (sym: string) => `${sym.split('-')[0]}USDT`;

async function signed(method: 'GET' | 'POST', p: string, params: Record<string, string> = {}): Promise<any> {
  const q = new URLSearchParams({ ...params, recvWindow: '10000', timestamp: String(Date.now()) });
  q.set('signature', createHmac('sha256', process.env.BINANCE_API_SECRET!).update(q.toString()).digest('hex'));
  const r = await fetch(`${BIN()}${p}?${q}`, { method, headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY! }, signal: AbortSignal.timeout(15_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Binance ${r.status}: ${String(j?.msg ?? '').slice(0, 160)}`);
  return j;
}

/** Anahtar işlem yapabiliyor mu, çekim izni kapalı mı? (testnet'te apiRestrictions yok; orada yalnız hesap bakılır) */
async function checkKey(): Promise<{ ok: boolean; neden?: string; usdt?: number }> {
  if (!binanceReady()) return { ok: false, neden: 'Binance anahtarı yok (Ayarlar → Anahtarlar: BINANCE_API_KEY ve BINANCE_API_SECRET).' };
  try {
    const acc = await signed('GET', '/api/v3/account');
    if (acc.canTrade === false) return { ok: false, neden: 'Bu Binance anahtarının işlem (Spot Trading) izni yok.' };
    if (!/testnet/.test(BIN())) {
      const rs = await signed('GET', '/sapi/v1/account/apiRestrictions');
      if (rs.enableWithdrawals) return { ok: false, neden: 'Bu anahtarın ÇEKİM izni açık. Güvenlik için Binance\'te çekim izni kapalı, yalnızca "Spot Trading" açık yeni bir anahtar oluşturun.' };
    }
    const usdt = Number((acc.balances ?? []).find((b: any) => b.asset === 'USDT')?.free ?? 0);
    return { ok: true, usdt };
  } catch (e: any) {
    return { ok: false, neden: String(e?.message || e) };
  }
}

async function stepSize(pair: string): Promise<number> {
  const r = await fetch(`${BIN()}/api/v3/exchangeInfo?symbol=${pair}`, { signal: AbortSignal.timeout(10_000) }).then(x => x.json()).catch(() => null);
  const f = r?.symbols?.[0]?.filters?.find((x: any) => x.filterType === 'LOT_SIZE');
  return Number(f?.stepSize) || 0.000001;
}
const floorStep = (q: number, step: number) => {
  const d = Math.max(0, Math.round(-Math.log10(step)));
  return Number((Math.floor(q / step + 1e-9) * step).toFixed(d));
};

async function liveBuy(sym: string, usd: number): Promise<{ adet: number; fiyat: number; tutar: number }> {
  const base = sym.split('-')[0];
  const o = await signed('POST', '/api/v3/order', { symbol: pairOf(sym), side: 'BUY', type: 'MARKET', quoteOrderQty: usd.toFixed(2) });
  // Komisyon alınan coin'den kesildiyse elde kalan miktar o kadar azdır
  const fee = (o.fills ?? []).filter((f: any) => f.commissionAsset === base).reduce((t: number, f: any) => t + Number(f.commission), 0);
  const adet = Number(o.executedQty) - fee, tutar = Number(o.cummulativeQuoteQty);
  return { adet, fiyat: tutar / Number(o.executedQty), tutar };
}

async function liveSell(sym: string, adet: number): Promise<{ adet: number; fiyat: number; tutar: number }> {
  const pair = pairOf(sym);
  const qty = floorStep(adet, await stepSize(pair));
  const o = await signed('POST', '/api/v3/order', { symbol: pair, side: 'SELL', type: 'MARKET', quantity: String(qty) });
  const tutar = Number(o.cummulativeQuoteQty);
  return { adet: Number(o.executedQty), fiyat: tutar / Number(o.executedQty), tutar };
}

// ---------------------------------------------------------------- OKX TR (canlı)
// İmza exchanges.ts'teki gibi: base64(HMAC-SHA256(secret, ISO zaman + METOT + yol + gövde)). Piyasa emri, USDT paritesi, nakit (cash) hesap.

const OKX = () => (process.env.OKX_API_URL || 'https://www.okx.com').replace(/\/$/, '');
export const okxReady = () => !!(process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE);
const instOf = (sym: string) => `${sym.split('-')[0]}-USDT`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function okxReq(method: 'GET' | 'POST', p: string, body?: object): Promise<any[]> {
  const ts = new Date().toISOString(), b = body ? JSON.stringify(body) : '';
  const r = await fetch(`${OKX()}${p}`, {
    method, body: b || undefined, signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', 'OK-ACCESS-KEY': process.env.OKX_API_KEY!, 'OK-ACCESS-SIGN': okxSign(process.env.OKX_API_SECRET!, ts, method, p, b), 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': process.env.OKX_API_PASSPHRASE! },
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || String(j?.code ?? '') !== '0') {
    const d = j?.data?.[0];
    throw new Error(`OKX ${r.status}: ${String(d?.sMsg || j?.msg || '').slice(0, 160)} (${d?.sCode || j?.code || '?'})`);
  }
  return j.data ?? [];
}

async function checkKeyOkx(): Promise<{ ok: boolean; neden?: string; usdt?: number }> {
  if (!okxReady()) return { ok: false, neden: 'OKX TR anahtarı yok (Ayarlar → Borsalar → OKX TR: API Key, Secret Key, Passphrase).' };
  try {
    const perm = String((await okxReq('GET', '/api/v5/account/config'))[0]?.perm ?? '');
    if (/withdraw/i.test(perm)) return { ok: false, neden: 'Bu OKX anahtarının ÇEKİM izni açık. Güvenlik için OKX TR\'de çekim izni kapalı, yalnız "Okuma" ve "İşlem" izni olan yeni bir anahtar oluşturun.' };
    if (!/trade/i.test(perm)) return { ok: false, neden: 'Bu OKX anahtarının "İşlem" (Trade) izni yok. OKX TR → API\'de anahtara İşlem iznini verin (çekim izni kapalı kalsın).' };
    const det: any[] = (await okxReq('GET', '/api/v5/account/balance?ccy=USDT'))[0]?.details ?? [];
    return { ok: true, usdt: Number(det.find(d => d.ccy === 'USDT')?.availBal ?? 0) };
  } catch (e: any) {
    return { ok: false, neden: String(e?.message || e) };
  }
}

/** Emrin dolmasını bekler; dolan adet, ortalama fiyat ve komisyon */
async function okxFill(instId: string, ordId: string) {
  let d: any = null;
  for (let i = 0; i < 8; i++) {
    d = (await okxReq('GET', `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`))[0];
    if (d && (d.state === 'filled' || d.state === 'canceled' || d.state === 'mmp_canceled')) break;
    await sleep(750);
  }
  const sz = Number(d?.accFillSz ?? 0), px = Number(d?.avgPx ?? 0);
  if (!sz || !px) throw new Error(`OKX: emir dolmadı (${d?.state ?? 'bilinmiyor'})`);
  return { sz, px, fee: Number(d.fee ?? 0), feeCcy: String(d.feeCcy ?? '') }; // fee eksi işaretli
}

async function okxBuy(sym: string, usd: number) {
  const instId = instOf(sym), base = sym.split('-')[0];
  const o = (await okxReq('POST', '/api/v5/trade/order', { instId, tdMode: 'cash', side: 'buy', ordType: 'market', sz: usd.toFixed(2), tgtCcy: 'quote_ccy' }))[0];
  const f = await okxFill(instId, o.ordId);
  return { adet: f.sz + (f.feeCcy === base ? f.fee : 0), fiyat: f.px, tutar: f.sz * f.px };
}

async function okxSell(sym: string, adet: number) {
  const instId = instOf(sym);
  const r = await fetch(`${OKX()}/api/v5/public/instruments?instType=SPOT&instId=${instId}`, { signal: AbortSignal.timeout(10_000) }).then(x => x.json()).catch(() => null);
  const ins = r?.data?.[0];
  const qty = floorStep(adet, Number(ins?.lotSz) || 0.000001);
  if (ins?.minSz && qty < Number(ins.minSz)) throw new Error(`OKX: satılacak miktar (${qty}) en küçük emir miktarının (${ins.minSz}) altında`);
  const o = (await okxReq('POST', '/api/v5/trade/order', { instId, tdMode: 'cash', side: 'sell', ordType: 'market', sz: String(qty) }))[0];
  const f = await okxFill(instId, o.ordId);
  return { adet: f.sz, fiyat: f.px, tutar: f.sz * f.px + (f.feeCcy === 'USDT' ? f.fee : 0) };
}

// ---------------------------------------------------------------- Canlı borsa seçimi

const venue = (c: RobotConfig = cfg): Venue => c.borsa === 'okx' ? 'okx' : 'binance';
const venueName = (v: Venue) => v === 'okx' ? 'OKX TR' : 'Binance';
const venueKey = (v: Venue) => v === 'okx' ? checkKeyOkx() : checkKey();
const venueBuy = (sym: string, usd: number) => venue() === 'okx' ? okxBuy(sym, usd) : liveBuy(sym, usd);
const venueSell = (sym: string, adet: number, v: Venue = venue()) => v === 'okx' ? okxSell(sym, adet) : liveSell(sym, adet);
const keyHelp = (v: Venue) => v === 'okx'
  ? 'Kullanıcıya OKX TR → API bölümünde ÇEKİM izni KAPALI, yalnız Okuma + İşlem izni olan bir anahtar oluşturup Ayarlar → Borsalar → OKX TR kartına (API Key, Secret, Passphrase) girmesini söyle; anahtarı sohbete yazmasın. Bölge hatası olursa karttaki "API adresi" alanı.'
  : 'Kullanıcıya Binance\'te çekim izni KAPALI, yalnız Spot Trading açık bir API anahtarı oluşturup Ayarlar → Anahtarlar\'a girmesini söyle; anahtarı sohbete yazmasın.';

// ---------------------------------------------------------------- Al / sat

function rollDay() {
  if (st.gun.tarih !== today()) st.gun = { tarih: today(), pnl: 0 };
}

async function open(sym: string, s: Series, plan: any): Promise<Trade | null> {
  const per = await usdPer(s.para);
  let usd = Math.min(cfg.islem_basi, cfg.mod === 'canli' ? LIVE_MAX() : Infinity);
  if (cfg.mod === 'kagit') usd = Math.min(usd, st.nakit_usd);
  if (usd < 5) return null;
  let adet: number, fiyat: number;
  if (cfg.mod === 'canli') ({ adet, fiyat, tutar: usd } = await venueBuy(sym, usd));
  else { fiyat = s.fiyat; adet = usd / (fiyat * per); st.nakit_usd -= usd; }
  // Gerçekleşen fiyat analizdekinden farklıysa stop ve hedefler aynı mesafede kalacak şekilde kaydırılır
  const kay = fiyat - plan.giris;
  plan = { ...plan, stop_loss: round(plan.stop_loss + kay), hedef1: round(plan.hedef1 + kay), hedef2: round(plan.hedef2 + kay) };
  st.pozisyonlar[sym] = { sembol: sym, para: s.para, adet, giris: fiyat, stop: plan.stop_loss, hedef1: plan.hedef1, hedef2: plan.hedef2, h1: false, maliyet_usd: usd, at: new Date().toISOString(), mod: cfg.mod, ...(cfg.mod === 'canli' ? { borsa: venue() } : {}) };
  const t: Trade = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), sembol: sym, yon: 'AL', fiyat: round(fiyat)!, adet, tutar_usd: round(usd, 2)!, neden: `sinyal AL, risk/ödül ${plan.risk_odul}`, mod: cfg.mod };
  st.islemler.push(t);
  tell(`${cfg.mod === 'canli' ? 'CANLI' : 'Kâğıt'} ALIŞ: ${s.ad} @ ${round(fiyat)} ${s.para} · ${round(usd, 2)} USD · stop ${plan.stop_loss}, hedef ${plan.hedef1}/${plan.hedef2}`, cfg.mod === 'canli');
  return t;
}

async function close(sym: string, price: number, neden: string): Promise<Trade> {
  const p = st.pozisyonlar[sym];
  let usd: number, fiyat = price;
  if (p.mod === 'canli') { const r = await venueSell(sym, p.adet, p.borsa ?? 'binance'); usd = r.tutar; fiyat = r.fiyat; }
  else { usd = p.adet * price * (await usdPer(p.para)); st.nakit_usd += usd; }
  const kar = usd - p.maliyet_usd;
  delete st.pozisyonlar[sym];
  st.son_kapanis[sym] = new Date().toISOString();
  rollDay();
  st.gun.pnl += kar;
  const t: Trade = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), sembol: sym, yon: 'SAT', fiyat: round(fiyat)!, adet: p.adet, tutar_usd: round(usd, 2)!, neden, kar_usd: round(kar, 2)!, mod: p.mod };
  st.islemler.push(t);
  tell(`${p.mod === 'canli' ? 'CANLI' : 'Kâğıt'} SATIŞ (${neden}): ${sym} @ ${round(fiyat)} · ${kar >= 0 ? 'kâr' : 'zarar'} ${round(kar, 2)} USD`, p.mod === 'canli');
  return t;
}

let busy = false;
/** Bir tur: açık pozisyonları yönet, sonra yeni alış fırsatlarına bak */
export async function tick(force = false): Promise<string[]> {
  if (busy || (!cfg.aktif && !st.koruma && !force)) return [];
  busy = true;
  const log: string[] = [];
  try {
    rollDay();
    const syms = [...new Set([...cfg.semboller.map(resolveSymbol), ...Object.keys(st.pozisyonlar)])];
    for (const sym of syms) {
      try {
        const s = await getSeries(sym);
        const a = decide(s);
        const p = st.pozisyonlar[sym];
        const price = s.fiyat;
        if (p) {
          const neden = price <= p.stop ? (p.h1 ? 'maliyette koruma stop' : 'zarar kes (stop)') : price >= p.hedef2 ? 'hedef 2' : a.sinyal === 'SAT' ? 'sinyal SAT' : '';
          if (neden) { const t = await close(sym, price, neden); log.push(`${sym}: SATILDI (${neden}) @ ${t.fiyat}, ${t.kar_usd} USD`); }
          else if (!p.h1 && price >= p.hedef1) { p.h1 = true; p.stop = Math.max(p.stop, p.giris); log.push(`${sym}: hedef 1 geçildi, stop maliyete çekildi`); tell(`${sym} hedef 1'i geçti; stop maliyete (${round(p.giris)}) çekildi`); }
          else log.push(`${sym}: pozisyon açık, ${round(price)} (stop ${round(p.stop)}, hedef ${round(p.h1 ? p.hedef2 : p.hedef1)})`);
          continue;
        }
        const plan: any = (a as any).islem_plani;
        const cool = st.son_kapanis[sym] && Date.now() - Date.parse(st.son_kapanis[sym]) < 12 * 3600_000;
        const limitHit = st.gun.pnl <= -cfg.gunluk_zarar_limiti;
        if (a.sinyal !== 'AL') { log.push(`${sym}: sinyal ${a.sinyal} (puan ${a.puan}), alış yok`); continue; }
        if (!plan || plan.risk_odul < cfg.min_risk_odul) { log.push(`${sym}: sinyal AL ama risk/ödül ${plan?.risk_odul ?? '?'} düşük`); continue; }
        if (cool) { log.push(`${sym}: yakın zamanda kapandı, bekleniyor`); continue; }
        if (limitHit || !cfg.aktif) continue;
        if (Object.keys(st.pozisyonlar).length >= cfg.max_pozisyon) { log.push(`${sym}: en fazla ${cfg.max_pozisyon} pozisyon`); continue; }
        if (cfg.mod === 'canli' && !isCrypto(sym)) { log.push(`${sym}: canlı modda yalnız kripto`); continue; }
        const t = await open(sym, s, plan);
        log.push(t ? `${sym}: ALINDI @ ${t.fiyat}` : `${sym}: bakiye yetersiz`);
      } catch (e: any) {
        log.push(`${sym}: hata ${String(e?.message || e).slice(0, 120)}`);
        if (cfg.mod === 'canli' && /Binance|OKX/.test(String(e?.message))) st.hata_sayisi++;
      }
    }
    if (st.gun.pnl <= -cfg.gunluk_zarar_limiti && cfg.aktif) {
      cfg.aktif = false; st.koruma = Object.keys(st.pozisyonlar).length > 0; st.durdu = `günlük zarar sınırı (${cfg.gunluk_zarar_limiti} USD) aşıldı`; saveCfg();
      tell(`Robot DURDU: ${st.durdu}. Yeni alış yok${st.koruma ? '; açık pozisyonların stop/hedefi izlenmeye devam ediyor' : ''}.`, true);
    }
    if (st.hata_sayisi >= 3 && cfg.aktif) {
      cfg.aktif = false; st.durdu = `${venueName(venue())} üst üste hata verdi`; st.hata_sayisi = 0; saveCfg();
      tell(`Robot DURDU: ${st.durdu}. Anahtarı ve bakiyeyi kontrol edin.`, true);
    }
    if (st.koruma && !Object.keys(st.pozisyonlar).length) st.koruma = false;
    st.son_tur = new Date().toISOString();
    saveState();
  } finally {
    busy = false;
  }
  return log;
}

// ---------------------------------------------------------------- Geriye dönük test

/** Son ~1 yılın günlük verisinde aynı kuralları uygular (kapanışta giriş; gün içi düşük/yüksekle stop/hedef) */
export async function backtest(raw: string | Series, strateji = cfg.strateji) {
  const s = typeof raw === 'string' ? await getSeries(raw) : raw;
  const decide_ = (x: Series) => decide(x, strateji);
  const o = s.ohlc;
  if (!o || s.kapanis.length < 230) throw new Error('Geriye dönük test için en az ~230 günlük OHLC verisi gerekli');
  const sub = (i: number): Series => ({ ...s, kapanis: s.kapanis.slice(0, i + 1), tarih: s.tarih.slice(0, i + 1), fiyat: s.kapanis[i],
    ohlc: { acilis: o.acilis.slice(0, i + 1), yuksek: o.yuksek.slice(0, i + 1), dusuk: o.dusuk.slice(0, i + 1), hacim: o.hacim.slice(0, i + 1) } });
  let eq = 1, peak = 1, mdd = 0, pos: { giris: number; stop: number; h1: number; h2: number; hit1: boolean } | null = null;
  const trades: { giris: string; cikis: string; getiri: number; neden: string }[] = [];
  let entryAt = '';
  const start = 210;
  for (let i = start; i < s.kapanis.length; i++) {
    const day = new Date(s.tarih[i]).toISOString().slice(0, 10);
    if (pos) {
      let exit: number | null = null, neden = '';
      if (o.dusuk[i] <= pos.stop) { exit = pos.stop; neden = pos.hit1 ? 'koruma stop' : 'stop'; }
      else if (o.yuksek[i] >= pos.h2) { exit = pos.h2; neden = 'hedef 2'; }
      else {
        if (!pos.hit1 && o.yuksek[i] >= pos.h1) { pos.hit1 = true; pos.stop = Math.max(pos.stop, pos.giris); }
        if (decide_(sub(i)).sinyal === 'SAT') { exit = s.kapanis[i]; neden = 'sinyal SAT'; }
      }
      if (exit !== null) {
        const g = exit / pos.giris - 1 - 0.002; // alış+satış komisyonu ~%0,2
        eq *= 1 + g;
        trades.push({ giris: entryAt, cikis: day, getiri: round(g * 100, 2)!, neden });
        pos = null;
      }
    } else {
      const a: any = decide_(sub(i));
      if (a.sinyal === 'AL' && a.islem_plani && a.islem_plani.risk_odul >= cfg.min_risk_odul) {
        pos = { giris: s.kapanis[i], stop: a.islem_plani.stop_loss, h1: a.islem_plani.hedef1, h2: a.islem_plani.hedef2, hit1: false };
        entryAt = day;
      }
    }
    const mark = pos ? eq * (s.kapanis[i] / pos.giris) : eq;
    peak = Math.max(peak, mark); mdd = Math.min(mdd, mark / peak - 1);
  }
  const wins = trades.filter(t => t.getiri > 0).length;
  return {
    sembol: s.sembol, ad: s.ad, donem: `${new Date(s.tarih[start]).toISOString().slice(0, 10)} → ${new Date(s.tarih[s.tarih.length - 1]).toISOString().slice(0, 10)}`,
    islem_sayisi: trades.length, kazanma_orani_yuzde: trades.length ? round((wins / trades.length) * 100, 1) : null,
    toplam_getiri_yuzde: round((eq - 1) * 100, 2), en_buyuk_dusus_yuzde: round(mdd * 100, 2),
    al_tut_getiri_yuzde: round((s.kapanis[s.kapanis.length - 1] / s.kapanis[start] - 1) * 100, 2),
    acik_pozisyon: !!pos, son_islemler: trades.slice(-8),
    not: 'Günlük veriyle basit simülasyon (komisyon %0,2 dahil, kayma yok). Geçmiş sonuç geleceği göstermez.',
  };
}

// ---------------------------------------------------------------- Strateji geliştirme

/** Varsayılan puan + her indikatör, her sembolde geriye dönük; puan = ort. getiri + ort. en büyük düşüş/2 (düşüş eksi) */
export async function developStrategy(syms: string[], progress: (l: string) => void = () => {}) {
  const ids = ['varsayilan', ...INDICATORS.map(i => i.id)];
  const series: Series[] = [];
  for (const sym of syms) {
    try { series.push(await getSeries(sym)); } catch (e: any) { progress(`${sym}: veri yok (${String(e?.message || e).slice(0, 60)})`); }
  }
  if (!series.length) throw new Error('Test için veri alınamadı');
  const rows: { id: string; ad: string; getiri: number; dusus: number; islem: number; kazanma: number | null; pozitif: number; puan: number; al_tut: number }[] = [];
  for (const id of ids) {
    progress(`strateji deneniyor: ${id}`);
    const rs: Awaited<ReturnType<typeof backtest>>[] = [];
    for (const s of series) { try { rs.push(await backtest(s, id)); } catch { /* veri yetersiz */ } }
    if (!rs.length) continue;
    const avg = (f: (r: typeof rs[number]) => number) => rs.reduce((t, r) => t + f(r), 0) / rs.length;
    const islem = rs.reduce((t, r) => t + r.islem_sayisi, 0);
    const kaz = rs.filter(r => r.kazanma_orani_yuzde != null);
    const getiri = avg(r => r.toplam_getiri_yuzde ?? 0), dusus = avg(r => r.en_buyuk_dusus_yuzde ?? 0);
    rows.push({
      id, ad: id === 'varsayilan' ? 'Varsayılan (RSI+MACD+ortalamalar+Bollinger puanı)' : findIndicator(id)?.ad ?? id,
      getiri: round(getiri, 2)!, dusus: round(dusus, 2)!, islem, kazanma: kaz.length ? round(kaz.reduce((t, r) => t + (r.kazanma_orani_yuzde ?? 0), 0) / kaz.length, 1)! : null,
      pozitif: rs.filter(r => (r.toplam_getiri_yuzde ?? 0) > 0).length, puan: round(getiri + dusus / 2, 2)!, al_tut: round(avg(r => r.al_tut_getiri_yuzde ?? 0), 2)!,
    });
  }
  // Az işlemli (şans eseri) sonuçlar ve sembollerin yarısından fazlasında kaybettirenler elenir
  const enough = rows.filter(r => r.islem >= Math.max(2, series.length) && r.pozitif * 2 >= series.length);
  const ranked = (enough.length ? enough : rows).sort((a, b) => b.puan - a.puan);
  return { semboller: series.map(s => s.sembol), denenen: rows.length, en_iyi: ranked[0], ilk5: ranked.slice(0, 5), uygun_yok: !enough.length };
}

// ---------------------------------------------------------------- Durum ve başlatma

async function status() {
  rollDay();
  const pos = [];
  let posUsd = 0;
  for (const p of Object.values(st.pozisyonlar)) {
    const s = await getSeries(p.sembol).catch(() => null);
    const deger = s ? p.adet * s.fiyat * (await usdPer(p.para).catch(() => 0)) : p.maliyet_usd;
    posUsd += deger;
    pos.push({ sembol: p.sembol, mod: p.mod, giris: round(p.giris), fiyat: s ? round(s.fiyat) : null, stop: round(p.stop), hedef: round(p.h1 ? p.hedef2 : p.hedef1), kar_usd: round(deger - p.maliyet_usd, 2) });
  }
  const closed = st.islemler.filter(t => t.yon === 'SAT');
  return {
    aktif: cfg.aktif, mod: cfg.mod, ayarlar: { ...cfg, aktif: undefined },
    ...(cfg.mod === 'canli' ? { borsa: venueName(venue()) } : {}),
    ...(cfg.mod === 'kagit' ? { kagit_bakiye: { nakit_usd: round(st.nakit_usd, 2), pozisyon_usd: round(posUsd, 2), toplam_usd: round(st.nakit_usd + posUsd, 2), baslangic_usd: cfg.baslangic_bakiye } } : { canli_islem_basi_sinir_usdt: LIVE_MAX() }),
    pozisyonlar: pos, bugun_kar_zarar_usd: round(st.gun.pnl, 2),
    kapanan_islem: closed.length, kazanan: closed.filter(t => (t.kar_usd ?? 0) > 0).length, toplam_kar_usd: round(closed.reduce((t, x) => t + (x.kar_usd ?? 0), 0), 2),
    son_tur: st.son_tur, durma_nedeni: cfg.aktif ? undefined : st.durdu,
  };
}

function applySettings(a: any): RobotConfig {
  const n = (v: unknown, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isFinite(x) && v !== undefined && v !== null && v !== '' ? Math.min(hi, Math.max(lo, x)) : d; };
  const next: RobotConfig = { ...cfg };
  if (Array.isArray(a.semboller) && a.semboller.length) next.semboller = a.semboller.map((x: unknown) => resolveSymbol(String(x))).filter(Boolean).slice(0, 10);
  next.islem_basi = n(a.islem_basi, 5, 100_000, cfg.islem_basi);
  next.max_pozisyon = Math.round(n(a.max_pozisyon, 1, 10, cfg.max_pozisyon));
  next.gunluk_zarar_limiti = n(a.gunluk_zarar_limiti, 1, 1_000_000, cfg.gunluk_zarar_limiti);
  next.aralik_dk = Math.round(n(a.aralik_dk, 5, 1440, cfg.aralik_dk));
  next.min_risk_odul = n(a.min_risk_odul, 1, 5, cfg.min_risk_odul);
  next.baslangic_bakiye = n(a.baslangic_bakiye, 50, 10_000_000, cfg.baslangic_bakiye);
  if (a.borsa !== undefined && a.borsa !== null && a.borsa !== '') next.borsa = /okx/i.test(String(a.borsa)) ? 'okx' : 'binance';
  if (typeof a.strateji === 'string' && a.strateji.trim()) {
    const q = a.strateji.trim();
    if (/^(varsay[ıi]lan|default|puan)$/i.test(q)) next.strateji = 'varsayilan';
    else { const ind = findIndicator(q); if (!ind) throw new Error(`"${q}" stratejisi bulunamadı (indikator liste ile bakın)`); next.strateji = ind.id; }
  }
  return next;
}

const liveSummary = (c: RobotConfig) => [
  `Borsa: ${venue(c) === 'okx' ? `OKX TR spot, USDT pariteleri (${OKX()})` : `Binance spot (${BIN()})`}`, `Semboller: ${c.semboller.filter(isCrypto).join(', ') || '(kripto yok!)'}`,
  `İşlem başı: ${Math.min(c.islem_basi, LIVE_MAX())} USDT (üst sınır ${LIVE_MAX()})`, `En fazla açık pozisyon: ${c.max_pozisyon}`,
  `Günlük zarar sınırı: ${c.gunluk_zarar_limiti} USDT (aşılırsa robot durur)`, `Kontrol aralığı: ${c.aralik_dk} dk`,
  `Strateji: ${c.strateji && c.strateji !== 'varsayilan' ? `${findIndicator(c.strateji)?.ad ?? c.strateji} indikatörü` : 'piyasa_analiz puanı'}; ` + 'sinyal AL + risk/ödül ≥ ' + c.min_risk_odul + '; stop, hedef 1\'de maliyete koruma, hedef 2 ya da sinyal SAT\'ta satış',
].join('\n');

export function initRobot(o: { broadcast: (e: object) => void; notify?: (t: string) => Promise<unknown> }) {
  broadcast = o.broadcast;
  if (o.notify) notify = o.notify;
  setInterval(() => {
    if (!cfg.aktif && !st.koruma) return;
    if (st.son_tur && Date.now() - Date.parse(st.son_tur) < cfg.aralik_dk * 60_000 - 5000) return;
    tick().catch(e => console.warn('[robot] tur hatası:', e?.message || e));
  }, 60_000).unref();
  if (cfg.aktif) console.log(`[robot] açık · ${cfg.mod === 'canli' ? 'CANLI' : 'kâğıt'} · ${cfg.semboller.join(', ')} · ${cfg.aralik_dk} dk`);
}

// ---------------------------------------------------------------- Model aracı

export const ROBOT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'borsa_robotu',
      description: "Otomatik alım-satım robotu. Varsayılan KÂĞIT (sanal para, simülasyon) modudur; canlı mod yalnız kripto, Binance ya da OKX TR (borsa: 'okx'), onay kartıyla. İşlemler: durum (bakiye, pozisyonlar, kâr/zarar), baslat, durdur (anında), ayarla (semboller, islem_basi USD, max_pozisyon, gunluk_zarar_limiti USD, aralik_dk, min_risk_odul, baslangic_bakiye, strateji: 'varsayilan' ya da indikatör id'si: ott, most, pmax, alphatrend, tillson_t3, supertrend, utbot, squeeze, wavetrend, ichimoku, ema_kesisim, golden_cross, rsi, stoch_rsi, macd, bollinger, psar, adx, hull, donchian, chandelier, obv, cci, mfi, williams_r), tur (şimdi bir kontrol turu), strateji_gelistir (tüm indikatörleri ve varsayılan puanı sembollerde son 1 yılda dener, en iyisini seçip robota uygular; uygula:false yalnız sıralar), test_et (sembolün son 1 yılında stratejiyi geriye dönük dener), gecmis (son işlemler), pozisyon_kapat (sembol ya da 'hepsi'), canli_ac (onay kartı; borsa: binance|okx), kagida_don, sifirla (kâğıt bakiyeyi sıfırla).",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['durum', 'baslat', 'durdur', 'ayarla', 'tur', 'strateji_gelistir', 'test_et', 'gecmis', 'pozisyon_kapat', 'canli_ac', 'kagida_don', 'sifirla'] },
          sembol: { type: 'string' },
          semboller: { type: 'array', items: { type: 'string' }, description: 'Ör. ["BTC-USD","ETH-USD","THYAO"]' },
          islem_basi: { type: 'number' }, max_pozisyon: { type: 'number' }, gunluk_zarar_limiti: { type: 'number' },
          aralik_dk: { type: 'number' }, min_risk_odul: { type: 'number' }, baslangic_bakiye: { type: 'number' },
          strateji: { type: 'string', description: "'varsayilan' ya da indikatör id'si (ör. supertrend)" },
          borsa: { type: 'string', enum: ['binance', 'okx'], description: 'Canlı modun borsası (okx = OKX TR)' },
          uygula: { type: 'boolean', description: 'strateji_gelistir: en iyi stratejiyi robota uygula (varsayılan true)' },
        },
        required: ['islem'],
      },
    },
  },
] as const;

export const isRobotTool = (n: string) => n === 'borsa_robotu';

export async function runRobotTool(a: any, progress: (l: string) => void): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  try {
    switch (a.islem) {
      case 'durum': progress('robot durumu'); return j(await status());
      case 'gecmis': return j({ islemler: st.islemler.slice(-20).reverse() });
      case 'durdur':
        cfg.aktif = false; st.koruma = false; st.durdu = 'kullanıcı durdurdu'; saveCfg(); saveState();
        tell('Robot durduruldu: yeni alış da otomatik satış da yok. Açık pozisyonlar olduğu gibi duruyor.');
        return j({ ok: true, durdu: true, acik_pozisyon: Object.keys(st.pozisyonlar), not: 'Açık pozisyon varsa kapatmak isteyip istemediğini sor (pozisyon_kapat).' });
      case 'test_et': {
        const sym = String(a.sembol ?? cfg.semboller[0] ?? '');
        progress(`geriye dönük test: ${sym}`);
        return j(await backtest(sym));
      }
      case 'strateji_gelistir': {
        const syms = (Array.isArray(a.semboller) && a.semboller.length ? a.semboller.map((x: unknown) => resolveSymbol(String(x))) : cfg.semboller).slice(0, 6);
        const r = await developStrategy(syms, progress);
        const best = r.en_iyi;
        const out = { ...r, not: 'Günlük veriyle geçmiş simülasyon (komisyon dahil). Geçmiş sonuç geleceği göstermez; az işlemli sonuçlar elendi.' };
        if (a.uygula === false || !best) return j(out);
        if (best.puan <= 0 || r.uygun_yok) return j({ ...out, uygulanmadi: 'Hiçbir strateji bu sembollerde tutarlı kazandırmadı; robotun stratejisi değiştirilmedi. Beklemek de bir stratejidir.' });
        const next = { ...cfg, strateji: best.id };
        if (cfg.mod === 'canli') {
          return propose('borsa', `Canlı robotun stratejisi: ${best.ad}`, `${liveSummary(next)}\nGeçmiş test (ort.): getiri %${best.getiri}, en büyük düşüş %${best.dusus}, ${best.islem} işlem, kazanma %${best.kazanma ?? '-'} (al-tut %${best.al_tut})`, 'Onaylarsanız canlı robot bu stratejiyle gerçek parayla işlem yapar.', async () => {
            cfg = { ...next, aktif: cfg.aktif, mod: 'canli' }; saveCfg(); return `Canlı robot stratejisi: ${best.ad}`;
          });
        }
        cfg = { ...next }; saveCfg();
        return j({ ...out, uygulandi: best.id });
      }
      case 'tur': progress('robot turu'); return j({ tur: await tick(true), durum: await status() });
      case 'sifirla':
        if (cfg.mod !== 'kagit') return j({ hata: 'Sıfırlama yalnız kâğıt modunda' });
        if (Object.values(st.pozisyonlar).some(p => p.mod === 'canli')) return j({ hata: 'Açık canlı pozisyon var; önce kapatın' });
        st = freshState(cfg); saveState();
        return j({ ok: true, bakiye_usd: cfg.baslangic_bakiye });
      case 'ayarla': {
        const next = applySettings(a);
        if (cfg.mod === 'canli') {
          if (venue(next) !== venue()) {
            const k = await venueKey(venue(next));
            if (!k.ok) return j({ hata: k.neden, not: keyHelp(venue(next)) });
          }
          return propose('borsa', 'Borsa robotu (CANLI) ayarlarını değiştir', liveSummary(next), 'Onaylarsanız canlı robot bu ayarlarla gerçek parayla işlem yapar.', async () => {
            cfg = { ...next, aktif: cfg.aktif, mod: 'canli' }; saveCfg(); return 'Canlı robot ayarları güncellendi.';
          });
        }
        cfg = { ...next, aktif: cfg.aktif, mod: cfg.mod }; saveCfg();
        return j({ ok: true, ayarlar: cfg });
      }
      case 'baslat': {
        if (a.semboller || a.islem_basi || a.gunluk_zarar_limiti) cfg = { ...applySettings(a), aktif: cfg.aktif, mod: cfg.mod };
        if (cfg.mod === 'canli') {
          const k = await venueKey(venue());
          if (!k.ok) return j({ hata: k.neden, not: keyHelp(venue()) });
          return propose('borsa', 'Borsa robotunu CANLI başlat (gerçek para)', `${liveSummary(cfg)}\nUSDT bakiye: ${k.usdt}`, `Onaylarsanız robot ${venueName(venue())} hesabınızda gerçek parayla otomatik alım-satım yapar. "Robotu durdur" deyince anında durur.`, async () => {
            cfg.aktif = true; st.durdu = undefined; st.hata_sayisi = 0; saveCfg(); saveState();
            tell('CANLI robot başladı.', true);
            return (await tick()).join('\n') || 'Canlı robot başladı.';
          });
        }
        cfg.aktif = true; st.durdu = undefined; saveCfg();
        progress('kâğıt robot başladı');
        const tur = await tick();
        return j({ ok: true, mod: 'kagit', ayarlar: cfg, ilk_tur: tur, not: 'Bu bir simülasyon; gerçek para kullanılmıyor.' });
      }
      case 'pozisyon_kapat': {
        const q = String(a.sembol ?? '').trim();
        const list = /^hepsi$|^tum/i.test(q) ? Object.keys(st.pozisyonlar) : Object.keys(st.pozisyonlar).filter(s => s === resolveSymbol(q));
        if (!list.length) return j({ hata: 'Bu sembolde açık pozisyon yok', acik: Object.keys(st.pozisyonlar) });
        const doClose = async () => {
          const out: string[] = [];
          for (const sym of list) out.push(`${sym}: ${j(await close(sym, (await getSeries(sym)).fiyat, 'elle kapatıldı'))}`);
          saveState();
          return out.join('\n');
        };
        if (list.some(s => st.pozisyonlar[s].mod === 'canli'))
          return propose('borsa', `Canlı pozisyon kapat: ${list.join(', ')}`, list.map(s => `${s}: ${st.pozisyonlar[s].adet} adet, giriş ${round(st.pozisyonlar[s].giris)}`).join('\n'), 'Onaylarsanız piyasa fiyatından satılır.', doClose);
        return j({ ok: true, sonuc: await doClose() });
      }
      case 'canli_ac': {
        const next = applySettings(a);
        const k = await venueKey(venue(next));
        if (!k.ok) return j({ hata: k.neden, not: keyHelp(venue(next)) });
        if (!next.semboller.some(isCrypto)) next.semboller = ['BTC-USD', 'ETH-USD'];
        if (Object.values(st.pozisyonlar).some(p => p.mod === 'kagit')) return j({ hata: 'Açık kâğıt pozisyonları var; önce pozisyon_kapat hepsi ya da sifirla.' });
        return propose('borsa', 'Borsa robotunu CANLI moda al (gerçek para)', `${liveSummary(next)}\nUSDT bakiye: ${k.usdt}`, `Onaylarsanız robot canlı moda geçer ve hemen başlar: ${venueName(venue(next))} hesabınızda gerçek parayla işlem yapar. Kayıp riski vardır.`, async () => {
          cfg = { ...next, mod: 'canli', aktif: true }; st.durdu = undefined; st.hata_sayisi = 0; saveCfg(); saveState();
          tell('Robot CANLI moda geçti ve başladı.', true);
          return (await tick()).join('\n') || 'Canlı robot başladı.';
        });
      }
      case 'kagida_don':
        if (Object.values(st.pozisyonlar).some(p => p.mod === 'canli')) return j({ hata: 'Açık canlı pozisyon var; önce kapatın ya da borsada elle yönetin.', acik: Object.keys(st.pozisyonlar) });
        cfg.mod = 'kagit'; cfg.aktif = false; saveCfg();
        return j({ ok: true, mod: 'kagit', not: 'Kâğıt moda dönüldü; robot durdu. "Robotu başlat" ile simülasyon başlar.' });
    }
    return j({ hata: 'bilinmeyen işlem' });
  } catch (e: any) {
    return j({ hata: String(e?.message || e).slice(0, 300) });
  }
}
