// Sektörel otomasyon kurulumu (talimat Bölüm 3): hazır, denenmiş n8n şablonları (server/sablonlar/<sektör>/*.json).
// Akış: ihtiyaç eşleştirme (satış danışmanının müşteri kartından) → n8n'e TASLAK olarak kurma (onay kartı; pasif) →
// müşteri hesaplarını n8n'de kendisi bağlar (Google/Meta giriş linki; şifre paylaşılmaz) → sahte veriyle test →
// sahibinin onayıyla canlıya alma → izleme (hata olursa sahibine bildirim, müşteriye bilgi mesajı onay kartıyla).
// n8n adresi ve API anahtarı .env'de (N8N_URL, N8N_API_KEY). Her müşteri için ayrı n8n kurulumu (VPS + Docker/Coolify)
// kullanılıyorsa adres müşteri kaydında tutulur; anahtarı yine .env/Ayarlar'dan girilir.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { propose } from './approvals.js';
import { logActivity } from './activity.js';
import { notifyOwner, sendWhatsAppTo } from './messaging.js';
import { eslestir, fold, sablonlar, type Sablon } from './sablon-katalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const REC = path.join(DATA, 'otomasyonlar.json');

interface Kurulum { id: string; ad: string; sablon: string; musteri: string; musteri_telefon?: string; webhook?: string; durum: 'taslak' | 'test_edildi' | 'canli' | 'durduruldu'; at: string; sonHata?: string; gorulenHatalar?: string[] }

let recs: Kurulum[] = (() => { try { return JSON.parse(fs.readFileSync(REC, 'utf8')); } catch { return []; } })();
const save = () => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(REC, JSON.stringify(recs, null, 2)); };

// ---------------------------------------------------------------- n8n API

const base = () => (process.env.N8N_URL || '').replace(/\/+$/, '');
async function n8n(method: string, p: string, body?: unknown): Promise<any> {
  if (!base() || !process.env.N8N_API_KEY) throw new Error('n8n bağlı değil: Ayarlar → API anahtarlarına N8N_URL ve N8N_API_KEY girin.');
  const r = await fetch(`${base()}/api/v1${p}`, { method, headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY!, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`n8n ${r.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

const slug = (s: string) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'musteri';

async function kur(s: Sablon, musteri: string, tel?: string): Promise<string> {
  const wf = JSON.parse(JSON.stringify(s.wf));
  // Aynı n8n'de müşterilerin webhook adresleri çakışmasın
  let webhook: string | undefined;
  for (const n of wf.nodes) if (n.type === 'n8n-nodes-base.webhook') { n.parameters.path = `${n.parameters.path}-${slug(musteri)}`; webhook = n.parameters.path; }
  const r = await n8n('POST', '/workflows', { name: `${musteri} · ${s.ad}`, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? {} });
  const k: Kurulum = { id: String(r.id), ad: `${musteri} · ${s.ad}`, sablon: s.id, musteri, musteri_telefon: tel, webhook, durum: 'taslak', at: new Date().toISOString() };
  recs.push(k); save();
  logActivity('otomasyon', `n8n'e kuruldu (taslak, pasif): ${k.ad}`);
  return `Kuruldu (pasif taslak): ${k.ad} · n8n kimliği ${k.id}. Sıradaki adım: müşteri ${s.baglanacak_hesaplar.join(', ') || 'gerekli hesapları'} n8n'de kendisi bağlasın, sonra "test et".`;
}

/** Sahte veriyle test: geçici olarak açılır, test verisi webhook'a gönderilir, son çalışmanın durumu okunur, kapatılır */
async function test(k: Kurulum): Promise<{ basarili: boolean; ayrinti: string }> {
  const s = sablonlar().find(x => x.id === k.sablon);
  if (!k.webhook || !s) return { basarili: false, ayrinti: 'Bu şablonun test edilecek webhook\'u yok.' };
  const wasLive = k.durum === 'canli';
  if (!wasLive) await n8n('POST', `/workflows/${k.id}/activate`);
  try {
    const r = await fetch(`${base()}/webhook/${k.webhook}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...s.test_verisi, _test: true }), signal: AbortSignal.timeout(30_000) });
    await new Promise(res => setTimeout(res, 4000));
    const ex = await n8n('GET', `/executions?workflowId=${k.id}&limit=1&includeData=false`);
    const last = ex.data?.[0];
    const ok = r.ok && last && (last.status === 'success' || last.finished === true);
    return { basarili: !!ok, ayrinti: `webhook ${r.status} · son çalışma: ${last?.status ?? 'yok'}${ok ? '' : ' (n8n\'de hesap bağlantılarını ve düğümleri kontrol edin)'}` };
  } finally {
    if (!wasLive) await n8n('POST', `/workflows/${k.id}/deactivate`).catch(() => {});
  }
}

// İzleme: canlı akışlarda yeni hata varsa sahibine bildirim; müşteriye bilgi mesajı onay kartıyla
setInterval(async () => {
  if (!base() || !process.env.N8N_API_KEY) return;
  for (const k of recs.filter(x => x.durum === 'canli')) {
    try {
      const ex = await n8n('GET', `/executions?workflowId=${k.id}&status=error&limit=5&includeData=false`);
      const yeni = (ex.data ?? []).filter((e: any) => !(k.gorulenHatalar ?? []).includes(String(e.id)));
      if (!yeni.length) continue;
      k.gorulenHatalar = [...(k.gorulenHatalar ?? []), ...yeni.map((e: any) => String(e.id))].slice(-50);
      k.sonHata = new Date().toISOString(); save();
      notifyOwner(`⚠️ Otomasyon hatası: ${k.ad}\n${yeni.length} çalışma hata verdi (n8n'de "Executions" bölümüne bakın).`, 'telegram').catch(() => {});
      if (k.musteri_telefon) propose('mesaj', `Müşteriye bilgi ver: ${k.musteri}`, `Mesaj: "Merhaba, ${k.ad.split(' · ')[1]} otomasyonunuzda geçici bir sorun tespit ettik, ilgileniyoruz. Bilginize."`, 'Otomasyonda hata görüldü; onaylarsanız müşteriye bilgi mesajı gider.',
        async () => { await sendWhatsAppTo(k.musteri_telefon!, `Merhaba, ${k.ad.split(' · ')[1]} otomasyonunuzda geçici bir sorun tespit ettik, ilgileniyoruz. Bilginize.`); return 'Müşteriye bilgi verildi.'; });
    } catch { /* n8n'e ulaşılamadı: sonraki turda */ }
  }
}, 15 * 60_000).unref();

// ---------------------------------------------------------------- Model aracı

export const SABLON_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'otomasyon_kur',
      description: "Müşteriye sektörel otomasyon kurulumu (n8n şablonları; şu an restoran: WhatsApp sipariş, rezervasyon, Google yorum cevabı, menü/kampanya duyurusu). sablonlar: liste. eslestir (sektor, talep): müşteri ihtiyacına uygun şablonlar (satış danışmanı kartındaki talep). kur (sablon, musteri, musteri_telefon): n8n'e PASİF taslak olarak kurar (onay kartı). test (id): sahte veriyle dener. canliya_al (id): onay kartıyla açar. durdur (id). kurulumlar: liste ve durumlar. Müşteri hesaplarını (Google/Meta) n8n'de KENDİSİ bağlar; şifre istenmez.",
      parameters: { type: 'object', properties: { islem: { type: 'string', enum: ['sablonlar', 'eslestir', 'kur', 'test', 'canliya_al', 'durdur', 'kurulumlar'] }, sektor: { type: 'string' }, talep: { type: 'string' }, sablon: { type: 'string' }, musteri: { type: 'string' }, musteri_telefon: { type: 'string' }, id: { type: 'string' } }, required: ['islem'] },
    },
  },
] as const;
export const isSablonTool = (n: string) => n === 'otomasyon_kur';

export async function runSablonTool(a: any): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  try {
    if (a.islem === 'sablonlar') return j({ sablonlar: sablonlar().map(s => ({ sablon: s.id, ad: s.ad, aciklama: s.aciklama, hesaplar: s.baglanacak_hesaplar })) });
    if (a.islem === 'eslestir') return j({ oneriler: eslestir(String(a.sektor ?? ''), String(a.talep ?? '')), not: 'Önerileri ve hangi hesapların bağlanacağını söyle; kurulum onay kartıyla yapılır.' });
    if (a.islem === 'kurulumlar') return j({ kurulumlar: recs.map(k => ({ id: k.id, ad: k.ad, durum: k.durum, son_hata: k.sonHata })), n8n: base() || 'bağlı değil' });
    if (a.islem === 'kur') {
      const s = sablonlar().find(x => x.id === a.sablon || x.id.endsWith(`/${a.sablon}`));
      if (!s) return j({ hata: `Şablon bulunamadı: ${a.sablon}`, sablonlar: sablonlar().map(x => x.id) });
      const musteri = String(a.musteri ?? '').trim();
      if (!musteri) return j({ hata: 'Müşteri (işletme) adı gerekli' });
      if (!base() || !process.env.N8N_API_KEY) return j({ hata: 'n8n bağlı değil: Ayarlar → API anahtarlarına N8N_URL ve N8N_API_KEY girin (her müşteriye ayrı n8n kullanılıyorsa o müşterinin adresi).' });
      return propose('komut', `n8n'e kur: ${musteri} · ${s.ad}`, `Şablon: ${s.id}\n${s.aciklama}\nn8n: ${base()}\nBağlanacak hesaplar (müşteri kendisi girer): ${s.baglanacak_hesaplar.join(', ') || '—'}\nAkış PASİF kurulur; test ve canlıya alma ayrı adımlar.`,
        'Onaylarsanız akış n8n\'e pasif taslak olarak eklenir. Hiçbir mesaj gönderilmez.', () => kur(s, musteri, a.musteri_telefon ? String(a.musteri_telefon) : undefined));
    }
    const k = recs.find(x => x.id === String(a.id));
    if (!k) return j({ hata: `Kurulum bulunamadı: ${a.id}`, kurulumlar: recs.map(x => ({ id: x.id, ad: x.ad })) });
    if (a.islem === 'test') {
      const t = await test(k);
      if (t.basarili && k.durum === 'taslak') { k.durum = 'test_edildi'; save(); }
      return j({ ...t, not: t.basarili ? 'Test başarılı; canlıya almak için canliya_al (onay kartı).' : 'Test başarısız: hesap bağlantılarını n8n\'de kontrol etmesini söyle.' });
    }
    if (a.islem === 'canliya_al') {
      if (k.durum === 'taslak') return j({ hata: 'Önce sahte veriyle test edin (test).' });
      return propose('komut', `Canlıya al: ${k.ad}`, `n8n akışı ${k.id} açılacak; gerçek müşterilere mesaj/kayıt başlar.`, 'Test başarılıydı. Onaylarsanız akış canlıya alınır ve izlenir (hata olursa size bildirilir).',
        async () => { await n8n('POST', `/workflows/${k.id}/activate`); k.durum = 'canli'; save(); logActivity('otomasyon', `Canlıya alındı: ${k.ad}`); return `${k.ad} canlıda.`; });
    }
    if (a.islem === 'durdur') { await n8n('POST', `/workflows/${k.id}/deactivate`); k.durum = 'durduruldu'; save(); return j({ ok: true, durum: k.durum }); }
    return j({ hata: 'bilinmeyen işlem' });
  } catch (e: any) { return j({ hata: String(e?.message || e).slice(0, 300) }); }
}
