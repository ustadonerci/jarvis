// Hostinger satın alma (resmî API, https://developers.hostinger.com): katalog ve fiyatlar, kayıtlı ödeme yöntemleri,
// abonelikler, SATIN ALMA ve otomatik yenileme. Anahtar: Ayarlar → HOSTINGER_API_TOKEN (hPanel → Hesap → API).
// - Para harcayan her işlem (sipariş, yenileme, otomatik yenilemeyi açma) onay kartıyla yapılır; kartta ürün, dönem,
//   ilk dönem ve yenileme fiyatı, ödeme yöntemi görünür. Kart bilgisi Jarvis'e hiç girilmez: ödeme Hostinger hesabında
//   kayıtlı yöntemden (varsayılan) alınır. HOSTINGER_LIMIT verilirse (ör. 50 = 50 USD) üstündeki siparişler reddedilir.
// - Fiyatlar API'de kuruş/sent cinsinden tam sayıdır (17.99 → 1799).
import { propose } from './approvals.js';

const BASE = () => (process.env.HOSTINGER_API_URL || 'https://developers.hostinger.com').replace(/\/$/, '');
const TOKEN = () => process.env.HOSTINGER_API_TOKEN || '';
export const hostingerReady = () => !!TOKEN();

async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; data: T }> {
  const r = await fetch(`${BASE()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN()}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('Hostinger anahtarı geçersiz ya da süresi dolmuş (hPanel → Hesap → API\'den yenisini alın).');
  if (!r.ok) throw new Error(`Hostinger ${r.status}: ${String(data?.message ?? data?.error ?? JSON.stringify(data?.errors ?? '')).slice(0, 200)}`);
  return { status: r.status, data };
}

const money = (cents: unknown, cur: unknown) => (typeof cents === 'number' ? `${(cents / 100).toFixed(2)} ${String(cur ?? '')}`.trim() : '?');
const period = (p: any) => (p?.period ? `${p.period} ${({ month: 'ay', year: 'yıl', day: 'gün' } as Record<string, string>)[String(p.period_unit)] ?? p.period_unit ?? ''}` : '');

interface PriceRow { item_id: string; urun: string; kategori?: string; secenek?: string; donem: string; ilk_donem: string; yenileme: string; cents: number; currency: string }

/** Katalogu düz satırlara çevirir: her fiyat seçeneği (ör. aylık, yıllık) ayrı bir item_id'dir */
async function catalog(kategori?: string, ad?: string): Promise<PriceRow[]> {
  const q = new URLSearchParams({ ...(kategori ? { category: kategori.toUpperCase() } : {}), ...(ad ? { name: ad } : {}) });
  const { data } = await api<any>(`/api/billing/v1/catalog${q.size ? `?${q}` : ''}`);
  const items: any[] = Array.isArray(data) ? data : data?.data ?? data?.items ?? [];
  const rows: PriceRow[] = [];
  for (const it of items) {
    const prices: any[] = Array.isArray(it.prices) ? it.prices : [];
    for (const p of prices) {
      const first = typeof p.first_period_price === 'number' ? p.first_period_price : p.price;
      rows.push({
        item_id: String(p.id), urun: String(it.name ?? it.id), kategori: it.category, secenek: p.name, donem: period(p),
        ilk_donem: money(first, p.currency), yenileme: money(p.price, p.currency), cents: Number(first) || 0, currency: String(p.currency ?? ''),
      });
    }
  }
  return rows;
}

async function paymentMethods(): Promise<{ id: number; ad: string; varsayilan: boolean }[]> {
  const { data } = await api<any>('/api/billing/v1/payment-methods');
  const list: any[] = Array.isArray(data) ? data : data?.data ?? [];
  return list.map(m => ({
    id: Number(m.id),
    ad: [m.name ?? m.payment_method ?? m.type, m.identifier ?? (m.last4 ? `•••• ${m.last4}` : '')].filter(Boolean).join(' '),
    varsayilan: !!(m.is_default ?? m.default),
  }));
}

export const HOSTINGER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'hostinger',
      description: "Hostinger hesabında işlem yapar (resmî API). islem: katalog (ürünler ve fiyatlar; kategori HOSTING/VPS/DOMAIN/EMAIL, ad ile arama, ör. '*Premium*'), abonelikler, odeme_yontemleri, satin_al (item_id katalogdan; ONAY KARTI açar, kayıtlı ödeme yönteminden çekilir), yenile (abonelik_id; onay kartı), otomatik_yenileme (abonelik_id, acik true/false; onay kartı). Satın almadan önce seçenekleri (dönem, ilk dönem ve yenileme fiyatı) kullanıcıya söyle ve hangisini istediğini netleştir.",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['katalog', 'abonelikler', 'odeme_yontemleri', 'satin_al', 'yenile', 'otomatik_yenileme'] },
          kategori: { type: 'string', enum: ['HOSTING', 'VPS', 'DOMAIN', 'EMAIL'] },
          ad: { type: 'string' },
          item_id: { type: 'string' },
          adet: { type: 'integer' },
          kupon: { type: 'string' },
          abonelik_id: { type: 'string' },
          acik: { type: 'boolean' },
        },
        required: ['islem'],
      },
    },
  },
] as const;

export const isHostingerTool = (n: string) => n === 'hostinger';

export async function runHostingerTool(args: any, progress: (l: string) => void): Promise<string> {
  if (!hostingerReady()) return JSON.stringify({ hata: 'Hostinger bağlı değil: hPanel → Hesap → API bölümünden bir API anahtarı oluşturup Jarvis Ayarlar → API anahtarlarına HOSTINGER_API_TOKEN olarak girmesi gerektiğini söyle.' });
  try {
    const islem = String(args.islem ?? '');
    if (islem === 'katalog') {
      progress('Hostinger fiyatları alınıyor');
      const rows = await catalog(args.kategori, args.ad);
      return JSON.stringify({ adet: rows.length, secenekler: rows.slice(0, 60).map(({ cents, currency, ...r }) => r), not: 'ilk_donem: ilk dönem (indirimli) fiyat; yenileme: sonraki dönemlerde ödenecek fiyat. Abonelikler otomatik yenilenir.' });
    }
    if (islem === 'abonelikler') {
      const { data } = await api<any>('/api/billing/v1/subscriptions');
      const list: any[] = Array.isArray(data) ? data : data?.data ?? [];
      return JSON.stringify({ abonelikler: list.slice(0, 50).map(s => ({ id: s.id, ad: s.name, durum: s.status, otomatik_yenileme: s.is_auto_renewed ?? s.auto_renew, bitis: s.expires_at ?? s.next_billing_at, tutar: money(s.renewal_price ?? s.total_price, s.currency_code ?? s.currency), donem: period(s) })) });
    }
    if (islem === 'odeme_yontemleri') return JSON.stringify({ yontemler: await paymentMethods(), not: 'Yeni kart eklemek ya da silmek için hPanel → Faturalandırma → Ödeme yöntemleri.' });

    if (islem === 'satin_al') {
      const id = String(args.item_id ?? '').trim();
      if (!id) return JSON.stringify({ hata: 'item_id gerekli; önce katalog ile seçenekleri listele' });
      const row = (await catalog()).find(r => r.item_id === id);
      if (!row) return JSON.stringify({ hata: `"${id}" katalogda yok; katalog ile doğru item_id'yi bul` });
      const adet = Math.min(Math.max(Number(args.adet) || 1, 1), 10);
      const limit = Number(process.env.HOSTINGER_LIMIT);
      if (limit > 0 && (row.cents * adet) / 100 > limit) return JSON.stringify({ hata: `Tutar (${row.ilk_donem} × ${adet}) satın alma sınırını (${limit} ${row.currency}) aşıyor. Sınır Ayarlar'da HOSTINGER_LIMIT ile değiştirilebilir.` });
      const pm = await paymentMethods().catch(() => []);
      const def = pm.find(m => m.varsayilan) ?? pm[0];
      if (!def) return JSON.stringify({ hata: 'Hostinger hesabında kayıtlı ödeme yöntemi yok. hPanel → Faturalandırma → Ödeme yöntemleri\'nden kart eklemesi gerekiyor.' });
      const kupon = String(args.kupon ?? '').trim();
      const ayrinti = [
        `Ürün: ${row.urun}${row.secenek ? ` — ${row.secenek}` : ''}`,
        `Dönem: ${row.donem || '?'}${adet > 1 ? ` · Adet: ${adet}` : ''}`,
        `İlk dönem: ${row.ilk_donem}${adet > 1 ? ` × ${adet}` : ''}`,
        `Yenileme: ${row.yenileme} (otomatik yenilenir)`,
        `Ödeme: ${def.ad || `yöntem #${def.id}`}`,
        kupon ? `Kupon: ${kupon}` : '',
        `Katalog kodu: ${row.item_id}`,
      ].filter(Boolean).join('\n');
      return propose('satin_alma', `Hostinger satın al: ${row.urun} (${row.ilk_donem})`, ayrinti,
        'Onaylarsanız sipariş hemen verilir ve tutar kayıtlı ödeme yönteminizden çekilir. Kartınız ek doğrulama (3D Secure) isteyebilir; o zaman Hostinger\'ın gönderdiği adımı tamamlayın. Abonelik otomatik yenilenir; istemezseniz sonra kapatabilirsiniz.',
        async () => {
          const r = await api<any>('/api/billing/v1/orders', { method: 'POST', body: JSON.stringify({ payment_method_id: def.id, items: [{ item_id: row.item_id, quantity: adet }], ...(kupon ? { coupons: [kupon] } : {}) }) });
          console.log(`[satın alma] Hostinger siparişi: ${row.item_id} × ${adet} (${r.status})`);
          return r.status === 202
            ? `Sipariş alındı; ödeme işleniyor (kart doğrulaması gerekebilir). Sipariş: ${JSON.stringify(r.data).slice(0, 300)}`
            : `Sipariş tamamlandı: ${row.urun}. Kurulum (alan adı bağlama, site kurulumu) hPanel'den ya da Jarvis'le yapılır. ${JSON.stringify(r.data).slice(0, 300)}`;
        });
    }
    if (islem === 'yenile' || islem === 'otomatik_yenileme') {
      const sid = String(args.abonelik_id ?? '').trim();
      if (!/^[\w-]{3,60}$/.test(sid)) return JSON.stringify({ hata: 'abonelik_id gerekli; önce abonelikler ile listele' });
      if (islem === 'yenile') {
        return propose('satin_alma', `Hostinger aboneliğini yenile: ${sid}`, `Abonelik: ${sid}\nÖdeme: varsayılan ödeme yöntemi`, 'Onaylarsanız yenileme siparişi verilir ve ücret kayıtlı ödeme yönteminizden çekilir.',
          async () => { const r = await api(`/api/billing/v1/subscriptions/${encodeURIComponent(sid)}/renew`, { method: 'POST', body: '{}' }); return `Yenileme siparişi verildi (${r.status === 202 ? 'ödeme işleniyor' : 'tamam'}).`; });
      }
      const acik = args.acik === true;
      return propose('satin_alma', `Hostinger otomatik yenileme ${acik ? 'AÇ' : 'KAPAT'}: ${sid}`, `Abonelik: ${sid}`, acik ? 'Açılırsa dönem sonunda ücret otomatik çekilir.' : 'Kapatılırsa dönem sonunda abonelik yenilenmez ve hizmet durur.',
        async () => { await api(`/api/billing/v1/subscriptions/${encodeURIComponent(sid)}/auto-renewal/${acik ? 'enable' : 'disable'}`, { method: acik ? 'PATCH' : 'DELETE' }); return `Otomatik yenileme ${acik ? 'açıldı' : 'kapatıldı'}.`; });
    }
    return JSON.stringify({ hata: 'bilinmeyen işlem' });
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 300) });
  }
}
