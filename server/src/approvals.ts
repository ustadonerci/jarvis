// Onay sistemi: bilgisayarda komut, uygulama kurma, paylaşım, iş akışı tetikleme ve kendi kodunu değiştirme gibi
// riskli işlemleri Jarvis DOĞRUDAN yapmaz. Önerir; ekranda tam olarak ne çalışacağını gösteren bir onay kartı çıkar
// ve yalnızca kullanıcı "Çalıştır" derse yürütülür. Onay yalnızca Jarvis'in çalıştığı bilgisayardan verilebilir
// (ya da ACCESS_TOKEN ile). Öneriler 15 dakika sonra düşer.
import { randomUUID } from 'node:crypto';
import express, { type Router } from 'express';
import { adminOnly } from './keys.js';
import { logError } from './errors.js';

export type ActionKind = 'komut' | 'uygulama' | 'paylasim' | 'webhook' | 'kod' | 'arama' | 'mesaj';

export interface Action {
  id: string;
  tur: ActionKind;
  baslik: string;
  /** Kartta birebir gösterilen içerik: komut, gönderilecek metin, kod değişikliği (diff) */
  ayrinti: string;
  aciklama: string;
  durum: 'bekliyor' | 'calisiyor' | 'tamam' | 'hata' | 'reddedildi' | 'dustu';
  sonuc?: string;
  at: string;
  bitti?: string;
}

const TTL = 15 * 60_000;
const actions = new Map<string, Action & { run: () => Promise<string> }>();
let broadcast: (e: object) => void = () => {};
export function initApprovals(b: (e: object) => void) {
  broadcast = b;
  setInterval(() => {
    for (const a of actions.values()) {
      if (a.durum === 'bekliyor' && Date.now() - Date.parse(a.at) > TTL) { a.durum = 'dustu'; broadcast({ type: 'onay' }); }
      if (a.bitti && Date.now() - Date.parse(a.bitti) > 6 * 3600_000) actions.delete(a.id);
    }
  }, 60_000).unref();
}

const view = ({ run, ...a }: Action & { run: unknown }): Action => a;

/** Onay bekleyen bir işlem oluşturur; modele kartın ekranda olduğunu söyleyen bir sonuç döner. */
export function propose(tur: ActionKind, baslik: string, ayrinti: string, aciklama: string, run: () => Promise<string>): string {
  const a = { id: randomUUID().slice(0, 8), tur, baslik, ayrinti: ayrinti.slice(0, 20_000), aciklama: aciklama.slice(0, 500), durum: 'bekliyor' as const, at: new Date().toISOString(), run };
  actions.set(a.id, a);
  console.log(`[onay] önerildi (${tur}): ${baslik}`);
  broadcast({ type: 'onay', yeni: view(a) });
  return JSON.stringify({
    onay_bekliyor: true, id: a.id, baslik,
    not: 'İşlem YAPILMADI. Bilgisayar ekranında onay kartı açıldı; kullanıcı "Çalıştır" derse yürütülecek. Kullanıcıya kartı onaylamasını söyle. Sonucu sonra islem_sonucu ile görebilirsin.',
  });
}

async function execute(id: string, approve: boolean) {
  const a = actions.get(id);
  if (!a || a.durum !== 'bekliyor') return null;
  if (!approve) {
    a.durum = 'reddedildi';
    a.bitti = new Date().toISOString();
    console.log(`[onay] reddedildi: ${a.baslik}`);
    broadcast({ type: 'onay' });
    return view(a);
  }
  a.durum = 'calisiyor';
  broadcast({ type: 'onay' });
  console.log(`[onay] onaylandı, çalışıyor: ${a.baslik}`);
  try {
    a.sonuc = (await a.run()).slice(0, 20_000);
    a.durum = 'tamam';
  } catch (e: any) {
    a.sonuc = String(e?.message || e).slice(0, 4000);
    a.durum = 'hata';
    logError(`onay:${a.tur}`, a.sonuc);
  }
  a.bitti = new Date().toISOString();
  broadcast({ type: 'onay', bitti: view(a) });
  return view(a);
}

export const actionList = () => [...actions.values()].map(view).reverse();

export const APPROVAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'islem_sonucu',
      description: 'Onaya sunduğun işlemlerin durumunu ve çıktısını getirir (bekliyor / tamam / hata / reddedildi). "Kurulum bitti mi", "komutun sonucu ne" gibi sorularda.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Boşsa son işlemler' } } },
    },
  },
] as const;

export function runApprovalTool(args: any): string {
  const list = actionList();
  const a = args.id ? list.find(x => x.id === args.id) : null;
  if (args.id && !a) return JSON.stringify({ hata: 'işlem bulunamadı' });
  return JSON.stringify(a ? a : { islemler: list.slice(0, 10).map(x => ({ ...x, sonuc: x.sonuc?.slice(-2000) })) });
}

export function approvalsRouter(): Router {
  const r = express.Router();
  r.use('/api/islemler', adminOnly);
  r.get('/api/islemler', (_req, res) => res.json({ islemler: actionList() }));
  r.post('/api/islemler/:id', async (req, res) => {
    const a = await execute(req.params.id, req.body?.onay === true);
    a ? res.json(a) : res.status(404).json({ error: 'İşlem bulunamadı ya da artık beklemiyor' });
  });
  return r;
}
