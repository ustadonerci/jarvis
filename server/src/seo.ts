// SEO teknik tarama (Orkas'taki SeoGeoAgent'ın seo-tech-audit adımından uyarlandı; kod alınmadı): bir sayfanın başlık,
// açıklama, H1, canonical, noindex, dil, Open Graph, yapılandırılmış veri, görsel alt metni, robots.txt ve sitemap
// durumunu ölçer. Yalnız genel internet adresleri okunur (search.ts'teki koruma). Yorum ve öneriyi "seo" uzmanı yapar.
import { isPrivateHost } from './search.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

async function getir(u: URL, ms = 12_000) {
  if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) throw new Error('Bu adres okunamaz (yalnızca genel internet sayfaları).');
  const t0 = Date.now();
  const r = await fetch(u, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  if (isPrivateHost(new URL(r.url || u.href).hostname)) throw new Error('Sayfa yerel bir adrese yönlendirdi.');
  return { r, ms: Date.now() - t0, metin: (await r.text()).slice(0, 2_000_000) };
}

// Çift tırnaklı değerin içinde kesme işareti olabilir ("Ankara'da"): her tırnak kendi eşiyle kapanır
const attr = (tag: string, a: string) => { const m = new RegExp(`\\b${a}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag); return m ? (m[1] ?? m[2]) : undefined; };
const meta = (html: string, key: string) => {
  for (const m of html.match(/<meta\b[^>]*>/gi) ?? []) if ((attr(m, 'name') ?? attr(m, 'property') ?? '').toLowerCase() === key) return attr(m, 'content') ?? '';
  return undefined;
};

/** HTML'den ölçümler ve sorun listesi (ağ yok; test edilebilir) */
export function htmlDenetle(html: string) {
  const baslik = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const aciklama = meta(html, 'description');
  const h1 = (html.match(/<h1\b/gi) ?? []).length;
  const canonical = (html.match(/<link\b[^>]*>/gi) ?? []).map(l => (/rel\s*=\s*["']canonical["']/i.test(l) ? attr(l, 'href') : undefined)).find(Boolean);
  const robots = meta(html, 'robots') ?? '';
  const lang = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  const og = ['og:title', 'og:description', 'og:image'].filter(k => meta(html, k) !== undefined);
  const jsonld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].flatMap(m => { try { const j = JSON.parse(m[1]); return [j].flat().map((x: any) => x?.['@type']).flat().filter(Boolean); } catch { return ['(bozuk JSON-LD)']; } });
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  const altsiz = imgs.filter(i => !attr(i, 'alt')).length;
  const kelime = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(w => w.length > 1).length;
  const sorunlar: string[] = [];
  if (!baslik) sorunlar.push('Sayfa başlığı (title) yok'); else if (baslik.length < 30 || baslik.length > 60) sorunlar.push(`Başlık ${baslik.length} karakter (30-60 önerilir)`);
  if (aciklama === undefined || !aciklama) sorunlar.push('Meta açıklama yok'); else if (aciklama.length < 70 || aciklama.length > 160) sorunlar.push(`Meta açıklama ${aciklama.length} karakter (70-160 önerilir)`);
  if (h1 !== 1) sorunlar.push(h1 ? `${h1} tane H1 var (1 önerilir)` : 'H1 başlığı yok');
  if (!canonical) sorunlar.push('Canonical bağlantı yok');
  if (/noindex/i.test(robots)) sorunlar.push('Sayfa noindex: arama motorlarında görünmez');
  if (!lang) sorunlar.push('<html lang> yok');
  if (og.length < 3) sorunlar.push(`Open Graph eksik (${['og:title', 'og:description', 'og:image'].filter(k => !og.includes(k)).join(', ')})`);
  if (!jsonld.length) sorunlar.push('Yapılandırılmış veri (JSON-LD / schema.org) yok: yapay zekâ cevaplarında ve zengin sonuçlarda görünürlüğü azaltır');
  if (altsiz) sorunlar.push(`${altsiz}/${imgs.length} görselde alt metni yok`);
  if (kelime < 300) sorunlar.push(`Sayfada az metin var (~${kelime} kelime)`);
  return { baslik, aciklama, h1, canonical, robots: robots || undefined, lang, og, jsonld, gorsel: imgs.length, altsiz, kelime, sorunlar };
}

export const SEO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'seo_tara',
      description: "Bir web sayfasının teknik SEO taraması: başlık, meta açıklama, H1, canonical, noindex, dil, Open Graph, schema.org (JSON-LD), görsel alt metni, kelime sayısı, yanıt süresi, HTTPS, robots.txt ve sitemap. 'Sitemin SEO'suna bak', 'bu sayfa Google'da neden çıkmıyor'. Ayrıntılı denetim ve öneri için seo uzmanını (uzman_ajan) kullan.",
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
] as const;
export const isSeoTool = (n: string) => n === 'seo_tara';

export async function runSeoTool(a: any, progress: (l: string) => void): Promise<string> {
  try {
    const u = new URL(/^https?:\/\//i.test(String(a.url)) ? String(a.url) : `https://${a.url}`);
    progress(`${u.hostname} taranıyor`);
    const { r, ms, metin } = await getir(u);
    const son = new URL(r.url || u.href);
    const kok = `${son.protocol}//${son.host}`;
    const [robots, sitemap] = await Promise.all([
      getir(new URL('/robots.txt', kok), 8000).then(x => (x.r.ok ? x.metin : null)).catch(() => null),
      getir(new URL('/sitemap.xml', kok), 8000).then(x => x.r.ok && /<(urlset|sitemapindex)/i.test(x.metin)).catch(() => false),
    ]);
    const d = htmlDenetle(metin);
    if (son.protocol !== 'https:') d.sorunlar.unshift('HTTPS kullanılmıyor');
    if (!r.ok) d.sorunlar.unshift(`Sayfa ${r.status} döndü`);
    if (ms > 3000) d.sorunlar.push(`Sayfa yavaş açıldı (${(ms / 1000).toFixed(1)} sn)`);
    if (robots === null) d.sorunlar.push('robots.txt yok');
    else if (/^\s*disallow:\s*\/\s*$/im.test(robots)) d.sorunlar.push('robots.txt tüm siteyi engelliyor (Disallow: /)');
    if (!sitemap && !/sitemap:/i.test(robots ?? '')) d.sorunlar.push('sitemap.xml bulunamadı');
    return JSON.stringify({ url: son.href, durum: r.status, sure_ms: ms, ...d, robots_txt: robots !== null, sitemap: sitemap || /sitemap:/i.test(robots ?? ''), not: 'Sorunları önem sırasıyla, her biri için somut düzeltmeyle anlat.' });
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 200) });
  }
}
