// Site indirme (RIFKI listesindeki "Website-downloader"ın Jarvis içindeki karşılığı): bir web sitesini sayfaları,
// görselleri, stil ve betikleriyle birlikte internetsiz açılabilir biçimde İndirilenler\Jarvis-Siteler altına kaydeder.
// Orijinal proje Linux'taki wget'i çalıştırıyordu; Windows'ta da çalışsın diye website-scraper kullanılır.
// Yalnızca genel internet: yerel ağ / bu bilgisayar adresleri indirilmez. Derinlik ve dosya sayısı sınırlıdır.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPrivateHost } from './search.js';

const OUT = path.join(os.homedir(), 'Downloads', 'Jarvis-Siteler');
const MAX_FILES = 400;
const TIMEOUT = 3 * 60_000;
const RESOURCE = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|json|xml|txt|pdf)(\?|#|$)/i;

export async function downloadSite(raw: string, depth = 1, opts: { allowPrivate?: boolean; outDir?: string } = {}) {
  const url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  if (!opts.allowPrivate && isPrivateHost(url.hostname)) throw new Error('Yalnızca genel internet siteleri indirilebilir.');
  const host = url.hostname.replace(/^www\./, '');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const dir = path.join(opts.outDir ?? OUT, `${host}-${stamp}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  let files = 0;
  const { default: scrape } = await import('website-scraper');
  const job = scrape({
    urls: [url.href],
    directory: dir,
    recursive: depth > 0,
    maxRecursiveDepth: Math.min(Math.max(depth, 0), 3),
    requestConcurrency: 4,
    filenameGenerator: 'bySiteStructure',
    // Sayfalar yalnızca aynı siteden; görsel/stil/font gibi kaynaklar CDN'den de gelebilir. Yerel adresler asla.
    urlFilter: (u: string) => {
      try {
        const x = new URL(u);
        if (!opts.allowPrivate && isPrivateHost(x.hostname)) return false;
        if (files >= MAX_FILES) return false;
        const same = x.hostname.replace(/^www\./, '') === host;
        const ok = same || RESOURCE.test(x.pathname);
        if (ok) files++;
        return ok;
      } catch { return false; }
    },
    request: { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' } },
  } as any);
  const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('3 dakikada bitmedi; daha küçük derinlikle deneyin.')), TIMEOUT));
  await Promise.race([job, timer]);

  // Giriş sayfası: klasörün kökünde ya da site adlı alt klasörde (ör. "site.com" veya "site.com_8080")
  const index = [dir, ...(fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name)) : [])]
    .map(d => path.join(d, 'index.html')).find(p => fs.existsSync(p));
  const count = (d: string): number => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
  return { klasor: dir, giris: index ?? null, dosya_sayisi: fs.existsSync(dir) ? count(dir) : 0, sinira_ulasti: files >= MAX_FILES };
}

export const SITE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'site_indir',
      description: "Bir web sitesini sayfaları, görselleri, stil ve betikleriyle internetsiz açılabilir biçimde bilgisayara indirir (İndirilenler\\Jarvis-Siteler). 'Şu siteyi indir', 'bu sayfayı arşivle', 'siteyi kaydet' gibi isteklerde. Derinlik 0: yalnız o sayfa; 1: bağlantı verdiği sayfalar da (varsayılan); en çok 3.",
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Sitenin adresi' },
          derinlik: { type: 'integer', description: '0-3, varsayılan 1' },
        },
        required: ['url'],
      },
    },
  },
] as const;

export const isSiteTool = (n: string) => n === 'site_indir';

export async function runSiteTool(args: any, progress: (l: string) => void): Promise<string> {
  try {
    progress(`site indiriliyor: ${String(args.url ?? '').slice(0, 60)}`);
    const r = await downloadSite(String(args.url ?? ''), Number.isFinite(Number(args.derinlik)) ? Number(args.derinlik) : 1);
    progress(`${r.dosya_sayisi} dosya indirildi`);
    console.log(`[site] indirildi: ${r.klasor} (${r.dosya_sayisi} dosya)`);
    return JSON.stringify({ ok: true, ...r, not: r.sinira_ulasti ? `Dosya sınırına (${MAX_FILES}) ulaşıldı; site kısmen indirildi.` : undefined });
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 300) });
  }
}
