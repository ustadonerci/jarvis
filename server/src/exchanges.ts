// Kripto borsaları: Binance, BtcTurk, OKX TR, Bitlo. Anahtarlar Ayarlar → Borsalar kartlarından server/.env'e yazılır
// (keys.ts, borsa alanı). Bu modül yalnızca OKUR: bağlantı testi ve bakiye. Alım-satım borsa robotunda (robot.ts,
// şimdilik Binance) onay kartı ve limitlerle yapılır. Çekim izni olan anahtar kullanılmamalı (kartlarda yazar).
// İmzalar:
//  - Binance: sorgu + timestamp, HMAC-SHA256(secret) hex → signature; X-MBX-APIKEY.
//  - BtcTurk: X-PCK (public), X-Stamp (ms), X-Signature = base64(HMAC-SHA256(base64-decode(private), public + stamp)).
//  - OKX: OK-ACCESS-KEY/-SIGN/-TIMESTAMP/-PASSPHRASE, SIGN = base64(HMAC-SHA256(secret, ISO zaman + METOT + yol + gövde)).
//  - Bitlo: x-pubkey, x-nonce (ms), x-signature = hex(HMAC-SHA256(secret, pubkey + nonce)). Bakiye yolu belgede
//    açık görünmediği için BITLO_BAKIYE_YOLU ile değiştirilebilir (deneysel).
import { createHmac } from 'node:crypto';
import express, { type Router } from 'express';
import { adminOnly } from './keys.js';

export interface Balance { varlik: string; serbest: number; kilitli: number }
interface Exchange { id: string; ad: string; ready(): boolean; balances(): Promise<Balance[]>; deneysel?: boolean; not?: string }

const env = (k: string) => (process.env[k] || '').trim();
const num = (v: unknown) => Number(v) || 0;
const nonzero = (l: Balance[]) => l.filter(b => b.serbest + b.kilitli > 0).sort((a, b) => b.serbest + b.kilitli - (a.serbest + a.kilitli));

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; data: any }> {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* düz metin */ }
  return { status: r.status, data };
}
const fail = (ad: string, status: number, data: any, hint = '') => {
  const msg = typeof data === 'string' ? data : data?.msg ?? data?.message ?? data?.error ?? JSON.stringify(data);
  return new Error(`${ad} ${status}: ${String(msg).slice(0, 160)}${hint ? ` — ${hint}` : ''}`);
};

const binance: Exchange = {
  id: 'binance', ad: 'Binance',
  ready: () => !!(env('BINANCE_API_KEY') && env('BINANCE_API_SECRET')),
  async balances() {
    const q = new URLSearchParams({ recvWindow: '10000', timestamp: String(Date.now()), omitZeroBalances: 'true' });
    q.set('signature', createHmac('sha256', env('BINANCE_API_SECRET')).update(q.toString()).digest('hex'));
    const base = (process.env.BINANCE_API_URL || 'https://api.binance.com').replace(/\/$/, '');
    const r = await getJson(`${base}/api/v3/account?${q}`, { 'X-MBX-APIKEY': env('BINANCE_API_KEY') });
    if (r.status !== 200) throw fail('Binance', r.status, r.data, r.status === 401 ? 'anahtar ya da IP kısıtı' : '');
    return nonzero((r.data.balances ?? []).map((b: any) => ({ varlik: b.asset, serbest: num(b.free), kilitli: num(b.locked) })));
  },
};

export function btcturkSign(publicKey: string, privateKey: string, stamp: number): string {
  return createHmac('sha256', Buffer.from(privateKey, 'base64')).update(`${publicKey}${stamp}`).digest('base64');
}
const btcturk: Exchange = {
  id: 'btcturk', ad: 'BtcTurk',
  ready: () => !!(env('BTCTURK_API_KEY') && env('BTCTURK_API_SECRET')),
  async balances() {
    const stamp = Date.now();
    const r = await getJson('https://api.btcturk.com/api/v1/users/balances', {
      'X-PCK': env('BTCTURK_API_KEY'), 'X-Stamp': String(stamp), 'X-Signature': btcturkSign(env('BTCTURK_API_KEY'), env('BTCTURK_API_SECRET'), stamp),
    });
    if (r.status !== 200 || r.data?.success === false) throw fail('BtcTurk', r.status, r.data, r.status === 401 ? 'anahtar yanlış, bilgisayarın saati kaymış ya da anahtara bu bilgisayarın IP adresi eklenmemiş' : '');
    return nonzero((r.data?.data ?? []).map((b: any) => ({ varlik: b.asset, serbest: num(b.free), kilitli: num(b.locked) })));
  },
};

export function okxSign(secret: string, ts: string, method: string, pathQuery: string, body = ''): string {
  return createHmac('sha256', secret).update(`${ts}${method}${pathQuery}${body}`).digest('base64');
}
const okx: Exchange = {
  id: 'okx', ad: 'OKX TR',
  ready: () => !!(env('OKX_API_KEY') && env('OKX_API_SECRET') && env('OKX_API_PASSPHRASE')),
  async balances() {
    const base = (env('OKX_API_URL') || 'https://www.okx.com').replace(/\/$/, '');
    const p = '/api/v5/account/balance';
    const ts = new Date().toISOString();
    const r = await getJson(`${base}${p}`, {
      'OK-ACCESS-KEY': env('OKX_API_KEY'), 'OK-ACCESS-SIGN': okxSign(env('OKX_API_SECRET'), ts, 'GET', p), 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': env('OKX_API_PASSPHRASE'),
    });
    if (r.status !== 200 || String(r.data?.code ?? '0') !== '0') {
      const code = String(r.data?.code ?? '');
      throw fail('OKX', r.status, r.data, code === '50119' || code === '50101' ? 'anahtar bu adrese ait değil: OKX TR hesabının API adresini kartta "API adresi" alanına yazın' : code === '50105' ? 'passphrase yanlış' : '');
    }
    const det: any[] = r.data?.data?.[0]?.details ?? [];
    return nonzero(det.map(d => ({ varlik: d.ccy, serbest: num(d.availBal ?? d.cashBal), kilitli: num(d.frozenBal) })));
  },
};

export function bitloSign(pub: string, secret: string, nonce: number): string {
  return createHmac('sha256', secret).update(`${pub}${nonce}`).digest('hex');
}
const bitlo: Exchange = {
  id: 'bitlo', ad: 'Bitlo', deneysel: true,
  not: 'Deneysel: Bitlo\'nun bakiye adresi herkese açık belgede net değil; bağlantı testi hesap özetini dener.',
  ready: () => !!(env('BITLO_API_KEY') && env('BITLO_API_SECRET')),
  async balances() {
    const nonce = Date.now();
    const url = `https://api.bitlo.com${process.env.BITLO_BAKIYE_YOLU || '/customer/account/summary'}`;
    const r = await getJson(url, { 'x-pubkey': env('BITLO_API_KEY'), 'x-nonce': String(nonce), 'x-signature': bitloSign(env('BITLO_API_KEY'), env('BITLO_API_SECRET'), nonce) });
    if (r.status !== 200) throw fail('Bitlo', r.status, r.data, r.status === 404 ? 'bakiye adresi farklı (deneysel destek)' : r.status === 401 || r.status === 403 ? 'anahtar yanlış ya da yetkisiz' : '');
    // Yanıt biçimi belgelenmediği için olası alan adları denenir
    const list: any[] = Array.isArray(r.data) ? r.data : r.data?.data?.balances ?? r.data?.balances ?? r.data?.data ?? r.data?.wallets ?? [];
    return nonzero((Array.isArray(list) ? list : []).map((b: any) => ({
      varlik: String(b.currency ?? b.asset ?? b.symbol ?? b.code ?? '?').toUpperCase(),
      serbest: num(b.available ?? b.free ?? b.availableAmount ?? b.balance), kilitli: num(b.locked ?? b.frozen ?? b.blocked ?? b.inOrder),
    })));
  },
};

export const EXCHANGES: Exchange[] = [binance, btcturk, okx, bitlo];
const find = (id: string) => EXCHANGES.find(e => e.id === id || e.ad.toLowerCase().replace(/\s+tr$/, '') === id.toLowerCase());

export function exchangeStatus() {
  return EXCHANGES.map(e => ({ id: e.id, ad: e.ad, hazir: e.ready(), deneysel: !!e.deneysel, not: e.not }));
}

export function exchangesRouter(): Router {
  const r = express.Router();
  r.use('/api/borsalar', adminOnly);
  r.get('/api/borsalar', (_req, res) => res.json({ borsalar: exchangeStatus() }));
  r.post('/api/borsalar/:id/test', async (req, res) => {
    const e = find(req.params.id);
    if (!e) return res.status(404).json({ error: 'Borsa bulunamadı' });
    if (!e.ready()) return res.status(400).json({ error: `${e.ad} anahtarları girilmemiş` });
    try {
      const b = await e.balances();
      console.log(`[borsa] ${e.ad} bağlantı testi: ${b.length} varlık`);
      res.json({ ok: true, borsa: e.ad, bakiye: b.slice(0, 30) });
    } catch (err: any) {
      res.status(502).json({ error: String(err?.message || err) });
    }
  });
  return r;
}

export const EXCHANGE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'borsa_bakiye',
      description: "Kullanıcının kripto borsalarındaki bakiyesini okur (Binance, BtcTurk, OKX TR, Bitlo; anahtarı girilmiş olanlar). 'BtcTurk'te ne kadar param var', 'borsalardaki bakiyem' gibi isteklerde. Yalnız okur; alım-satım yapmaz.",
      parameters: { type: 'object', properties: { borsa: { type: 'string', description: 'binance, btcturk, okx, bitlo ya da hepsi (varsayılan)' } } },
    },
  },
] as const;
export const isExchangeTool = (n: string) => n === 'borsa_bakiye';

export async function runExchangeTool(a: any, progress: (l: string) => void): Promise<string> {
  const q = String(a.borsa ?? 'hepsi').toLowerCase();
  const list = q === 'hepsi' || !q ? EXCHANGES.filter(e => e.ready()) : [find(q)].filter(Boolean) as Exchange[];
  if (!list.length) return JSON.stringify({ hata: 'Anahtarı girilmiş borsa yok.', not: 'Kullanıcıya Ayarlar → Borsalar kartından borsanın API anahtarlarını girmesini söyle (çekim izni kapalı, salt okuma yeterli). Anahtarı sohbete yazmasın.' });
  const out: Record<string, unknown> = {};
  await Promise.all(list.map(async e => {
    if (!e.ready()) { out[e.ad] = { hata: 'anahtar girilmemiş' }; return; }
    progress(`${e.ad} bakiyesi`);
    try { out[e.ad] = (await e.balances()).slice(0, 25); } catch (err: any) { out[e.ad] = { hata: String(err?.message || err).slice(0, 200) }; }
  }));
  return JSON.stringify({ bakiyeler: out, not: 'Rakamları aynen söyle; toplam TL karşılığı gerekiyorsa piyasa_analiz ile fiyatları alıp hesapla. Yatırım tavsiyesi verme.' });
}
