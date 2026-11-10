// İnternette iş yapma (Jarvis'in kendi Chrome penceresiyle, kullanıcının bir insan gibi yapacağı adımlar):
// - YouTube'dan müzik/klip: "YouTube'dan Tarkan'ı aç", "Şımarık şarkısını çal" → YouTube araması açılır, ilk video
//   oynatılır, pencere öne getirilir. Link istenmez. (Arama sayfası kazınmaz; tarayıcıda kullanıcı adına tıklanır.)
// - Alışveriş (Trendyol, Hepsiburada, Amazon): ürün aranır, ilk sonuçlar fiyatlarıyla listelenir; seçilen ürün ONAY
//   KARTIYLA sepete eklenir ve sepet sayfası açılır. Ödeme adımına (siparişi onayla / öde) Jarvis basmaz, kart
//   bilgisi girmez: son adımı kullanıcı kendisi yapar. Para işlemi kartı uzaktan (telefondan) onaylanamaz.
import { spawn } from 'node:child_process';
import { propose } from './approvals.js';
import { browserPage, showBrowser, MONEY_BUTTON } from './browser.js';
import { logActivity } from './activity.js';

// ---------------------------------------------------------------- YouTube

// Türkçe harfler (ç, ş, ı…) \b ile çalışmadığı için harf sınırları elle
const W = (body: string, flags = 'giu') => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, flags);
const MUSIC_HINT = W("youtube\\S*|yutup\\S*|şarkı\\S*|sarki\\S*|klip\\S*|müzi\\S*|muzik\\S*|çal|çalsana|dinlet|dinle", 'iu');
const VERB_END = /(?<![\p{L}])(aç|açar mısın|açsana|açabilir misin|çal|çalar mısın|çalsana|oynat|oynatır mısın|dinlet|dinle|başlat|koy)\s*[.!?]*\s*$/iu;
/** "YouTube'dan Tarkan'ı aç" → "Tarkan"; müzik isteği değilse null */
export function parseMusic(text: string): string | null {
  const t = text.trim();
  if (!MUSIC_HINT.test(t) || !VERB_END.test(t)) return null;
  if (W('kapat|durdur|sesini|nasıl|kaç|nedir|kimdir', 'iu').test(t)) return null;
  let q = t
    .replace(/^\s*jarvis[\s,]*/iu, '')
    .replace(VERB_END, ' ')
    .replace(W("youtube\\S*|yutup\\S*"), ' ')
    .replace(W('bana|bir|biraz|lütfen|hemen|şimdi'), ' ')
    .replace(W('şarkı\\S*|sarki\\S*|klib\\S*|klip|video\\S*|müzi\\S*|muzik\\S*|parça\\S*'), ' ')
    .replace(/['’]\p{L}*/gu, '')
    .replace(/\s+/g, ' ').trim();
  if (!q) q = 'Türkçe pop müzik';
  return q.slice(0, 120);
}

export async function playYouTube(q: string, progress: (l: string) => void = () => {}): Promise<{ ok: boolean; baslik?: string; url?: string; not?: string }> {
  const p = await browserPage();
  progress(`YouTube'da aranıyor: ${q}`);
  await p.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (/consent\.(youtube|google)\.com/.test(p.url())) {
    await showBrowser();
    return { ok: false, not: 'YouTube bir kez çerez onayı istiyor: açılan pencerede "Tümünü kabul et"e basın, sonra tekrar söyleyin.' };
  }
  // İlk gerçek video (reklam ve Shorts değil)
  const link = p.locator('ytd-video-renderer a#video-title[href*="/watch?v="]').first();
  await link.waitFor({ timeout: 10_000 }).catch(() => {});
  const href = await link.getAttribute('href').catch(() => null);
  const baslik = (await link.getAttribute('title').catch(() => null)) ?? (await link.textContent().catch(() => null))?.trim() ?? q;
  if (!href) { await showBrowser(); return { ok: false, not: 'Arama sonuçları açıldı ama video bulunamadı; pencereden seçebilirsiniz.' }; }
  const url = new URL(href, 'https://www.youtube.com').toString();
  progress(`oynatılıyor: ${baslik.slice(0, 50)}`);
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await showBrowser();
  // Otomatik oynatma engellenirse oynat
  await p.waitForTimeout(1500);
  await p.evaluate("(() => { const v = document.querySelector('video'); if (v && v.paused) { v.play().catch(() => {}); } })()").catch(() => {});
  logActivity('youtube', `oynatıldı: ${baslik}`);
  return { ok: true, baslik, url };
}

/** Jarvis'in tarayıcısı açılamazsa YouTube araması bilgisayarın varsayılan tarayıcısında açılır (sessiz kalmasın) */
export async function playYouTubeSafe(q: string, progress: (l: string) => void = () => {}) {
  try { return await playYouTube(q, progress); } catch (e: any) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    if (process.platform === 'win32') { spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); return { ok: true, baslik: `${q} (YouTube araması varsayılan tarayıcıda açıldı)`, url, not: String(e?.message || e).slice(0, 300) }; }
    throw e;
  }
}

// ---------------------------------------------------------------- Alışveriş

type Site = 'trendyol' | 'hepsiburada' | 'amazon';
const SITES: Record<Site, { ara: (q: string) => string; urun: RegExp; sepet: string; ad: string }> = {
  trendyol: { ara: q => `https://www.trendyol.com/sr?q=${encodeURIComponent(q)}`, urun: /-p-\d+/, sepet: 'https://www.trendyol.com/sepet', ad: 'Trendyol' },
  hepsiburada: { ara: q => `https://www.hepsiburada.com/ara?q=${encodeURIComponent(q)}`, urun: /-p(m)?-[A-Z0-9]+/i, sepet: 'https://checkout.hepsiburada.com/sepetim', ad: 'Hepsiburada' },
  amazon: { ara: q => `https://www.amazon.com.tr/s?k=${encodeURIComponent(q)}`, urun: /\/dp\/[A-Z0-9]{10}/, sepet: 'https://www.amazon.com.tr/gp/cart/view.html', ad: 'Amazon' },
};
const siteOf = (s: string): Site | null => (/trend/i.test(s) ? 'trendyol' : /hepsi/i.test(s) ? 'hepsiburada' : /amazon/i.test(s) ? 'amazon' : null);
let lastResults: { site: Site; urunler: { no: number; ad: string; fiyat: string; url: string }[] } | null = null;

export async function shopSearch(siteName: string, q: string, progress: (l: string) => void = () => {}) {
  const site = siteOf(siteName) ?? 'trendyol';
  const S = SITES[site];
  const p = await browserPage();
  progress(`${S.ad}'da aranıyor: ${q}`);
  await p.goto(S.ara(q), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await p.waitForTimeout(2500);
  // Ürün bağlantıları ve kartlarındaki ad/fiyat (site tasarımına bağımlı olmamak için genel okuma)
  const raw: { href: string; text: string }[] = await p.evaluate(`(() => {
    const re = new RegExp(${JSON.stringify(S.urun.source)}, ${JSON.stringify(S.urun.flags)});
    const out = []; const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.href; if (!re.test(h)) continue;
      const key = h.split('?')[0]; if (seen.has(key)) continue; seen.add(key);
      // Kart: ürün bağlantısını içeren, başka ürün bağlantısı içermeyen en geniş üst öğe
      const others = el => [...el.querySelectorAll('a[href]')].filter(x => re.test(x.href) && x.href.split('?')[0] !== key).length;
      let card = a; for (let i = 0; i < 6 && card.parentElement && others(card.parentElement) === 0; i++) card = card.parentElement;
      out.push({ href: h, text: (card.innerText || a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300) });
      if (out.length >= 12) break;
    }
    return out;
  })()`);
  const urunler = raw.map((r, i) => {
    const fiyat = r.text.match(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?)\s*TL/gi)?.pop() ?? '';
    const ad = r.text.replace(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?)\s*TL/gi, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { no: i + 1, ad, fiyat, url: r.href };
  }).filter(u => u.ad).slice(0, 8);
  lastResults = { site, urunler };
  await showBrowser();
  logActivity('alisveris', `${S.ad} araması: ${q} · ${urunler.length} ürün`);
  return { site: S.ad, arama: q, urunler, not: urunler.length ? 'İlk ürünleri adı ve fiyatıyla (en çok 5) kısaca oku; hangisini sepete ekleyeyim diye sor. Fiyatlar sayfadan okundu, değişebilir.' : 'Sonuçlar pencerede açık ama okunamadı; pencereden bakmasını söyle.' };
}

export function proposeAddToCart(no?: number, url?: string): string {
  const u = url ? { no: 0, ad: url, fiyat: '', url } : lastResults?.urunler.find(x => x.no === no);
  if (!u) return JSON.stringify({ hata: 'Hangi ürün? Önce ara, sonra numarasını söyle (ör. 2. ürünü sepete ekle).' });
  const site = lastResults?.site ?? siteOf(u.url) ?? 'trendyol';
  const S = SITES[site];
  return propose('satin_alma', `Sepete ekle: ${u.ad.slice(0, 60)}`, `${S.ad}\nÜrün: ${u.ad}\nFiyat: ${u.fiyat || 'sayfada'}\n${u.url}\n\nYalnız SEPETE eklenir. Ödeme (Siparişi onayla / Öde) ve kart bilgisi sizde.`,
    'Onaylarsanız ürün sepete eklenir ve sepet sayfası açılır; siparişi siz tamamlarsınız.',
    async () => {
      const p = await browserPage();
      await p.goto(u.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await p.waitForTimeout(2000);
      const btn = p.getByRole('button', { name: /sepete ekle|add to cart|sepete at/i }).first();
      const txt = (await btn.textContent({ timeout: 8000 }).catch(() => '')) ?? '';
      if (!txt || MONEY_BUTTON.test(txt)) { await showBrowser(); throw new Error('Sepete ekle düğmesi bulunamadı (beden/renk seçimi gerekebilir); ürün sayfası açık, oradan siz seçin.'); }
      await btn.click({ timeout: 8000 });
      await p.waitForTimeout(2000);
      await p.goto(S.sepet, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await showBrowser();
      logActivity('alisveris', `sepete eklendi: ${u.ad.slice(0, 80)}`);
      return `Sepete eklendi, sepet açık: ${u.ad.slice(0, 60)}. Siparişi kendiniz tamamlayın.`;
    });
}

/** "Trendyol'dan kulaklık al", "Hepsiburada'da airfryer ara" → site + ürün */
export function parseShop(text: string): { site: string; urun: string } | null {
  const m = /(trendyol|hepsiburada|hepsi burada|amazon)['’]?(?:dan|den|tan|ten|da|de|ta|te)?\s+(.+?)\s+(?:al(?:ır mısın|sana)?|ara|bul|sipariş et|satın al|bak)\s*[.!?]*\s*$/i.exec(text.trim());
  if (!m) return null;
  const urun = m[2].replace(/['’](y?[ıiuü]|n[ıiuü])$/i, '').replace(/\b(bana|bir|tane|adet)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return urun ? { site: m[1], urun } : null;
}

// ---------------------------------------------------------------- Model aracı

export const WEBACT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'youtube_cal',
      description: "YouTube'da şarkı, klip ya da video açar ve OYNATIR (link istemeden): 'YouTube'dan Tarkan'ı aç', 'Şımarık'ı çal', 'Sezen Aksu klip aç', 'müzik aç'. sorgu: sanatçı ve/veya şarkı adı.",
      parameters: { type: 'object', properties: { sorgu: { type: 'string' } }, required: ['sorgu'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'alisveris',
      description: "Trendyol / Hepsiburada / Amazon'da alışveriş. ara (site, urun): ürünleri fiyatlarıyla listeler ve sayfayı açar. sepete_ekle (no ya da url): seçilen ürünü ONAY KARTIYLA sepete ekler ve sepeti açar. Ödemeyi (siparişi onayla / öde) ve kart bilgisini kullanıcı kendisi yapar; Jarvis basmaz, istemez.",
      parameters: { type: 'object', properties: { islem: { type: 'string', enum: ['ara', 'sepete_ekle'] }, site: { type: 'string', enum: ['trendyol', 'hepsiburada', 'amazon'] }, urun: { type: 'string' }, no: { type: 'number' }, url: { type: 'string' } }, required: ['islem'] },
    },
  },
] as const;
export const isWebActTool = (n: string) => n === 'youtube_cal' || n === 'alisveris';
export async function runWebActTool(name: string, a: any, progress: (l: string) => void): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  try {
    if (name === 'youtube_cal') return j({ ...(await playYouTubeSafe(String(a.sorgu ?? 'müzik'), progress)), not: 'Açılan şarkının adını kısaca söyle.' });
    if (a.islem === 'sepete_ekle') return proposeAddToCart(a.no ? Number(a.no) : undefined, a.url ? String(a.url) : undefined);
    return j(await shopSearch(String(a.site ?? 'trendyol'), String(a.urun ?? ''), progress));
  } catch (e: any) { return j({ hata: String(e?.message || e).slice(0, 300) }); }
}
