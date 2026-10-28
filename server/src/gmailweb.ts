// Uygulama şifresi olmadan Gmail: Jarvis'in tarayıcısında (browser.ts) kullanıcının bir kez giriş yaptığı Gmail
// oturumuyla çalışır. Gmail'in kendi aramasını kullanır:
//  - "category:promotions" (Tanıtımlar) ve Spam: listedeki göndericiler not alınır, aboneliklerinden çıkılır (Gmail
//    → Abonelikleri yönet sayfasında yalnız bu göndericiler), e-postalar Çöp'e taşınır (30 gün geri alınabilir).
//  - Gelen kutusundaki önemliler (tanıtım/sosyal/güncelleme dışı) gönderen + konu + önizlemeyle özet için döner.
// Gmail sayfa yapısı: satır tr.zA, gönderen [email], konu .bog, önizleme .y2, araç çubuğu div[gh="tm"] (Sil: act=10).
import type { Page } from 'playwright-core';
import { browserPage } from './browser.js';
import type { MailRoutineResult } from './mailclean.js';

export class GmailLoginNeeded extends Error {}

const BASE = process.env.GMAIL_WEB_URL || 'https://mail.google.com/mail/u/0/';

interface Row { adres: string; ad: string; konu: string; onizleme: string; tarih: string; okunmadi: boolean; id: string }

async function open(p: Page, hash: string) {
  await p.goto(`${BASE}#${hash}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (/accounts\.google\.com|ServiceLogin|signin/i.test(p.url())) throw new GmailLoginNeeded();
  await p.waitForSelector('div[role="main"]', { timeout: 45_000 }).catch(() => { throw /accounts\.google/.test(p.url()) ? new GmailLoginNeeded() : new Error('Gmail sayfası yüklenmedi'); });
  // Arama sonuçları gelsin (ya da "eşleşen ileti yok")
  await p.waitForTimeout(2500);
}

async function rows(p: Page, max = 100): Promise<Row[]> {
  return p.evaluate((n: number) => Array.from(document.querySelectorAll('div[role="main"] tr.zA')).slice(0, n).map(r => {
    const s = r.querySelector('[email]');
    return {
      adres: (s?.getAttribute('email') || '').toLowerCase(),
      ad: s?.getAttribute('name') || (s as HTMLElement | null)?.innerText || '',
      konu: (r.querySelector('.bog') as HTMLElement | null)?.innerText || '',
      onizleme: ((r.querySelector('.y2') as HTMLElement | null)?.innerText || '').replace(/^\s*[-–]\s*/, '').slice(0, 300),
      tarih: r.querySelector('td.xW span[title]')?.getAttribute('title') || '',
      okunmadi: r.classList.contains('zE'),
      id: r.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id') || r.querySelector('[data-thread-id]')?.getAttribute('data-thread-id')?.replace(/^#?thread-f:/, '') || '',
    };
  }), max);
}

/** Aramadaki tüm e-postaları Çöp'e taşır (sayfa sayfa; "eşleşen tümünü seç" varsa tek seferde). Taşınan sayı. */
async function trashSearch(p: Page, query: string, seen: Row[]): Promise<number> {
  let total = 0;
  let prev = '';
  for (let round = 0; round < 25; round++) {
    await open(p, `search/${encodeURIComponent(query)}`);
    const list = await rows(p, 100);
    if (!list.length) break;
    // Silme işe yaramadıysa (Gmail'in görünümü değişmiş) aynı satırlar tekrar gelir: saymadan dur
    const sig = list.slice(0, 5).map(r => `${r.adres}|${r.konu}|${r.tarih}`).join('/');
    if (sig === prev) throw new Error('Gmail\'de silme düğmesi çalışmadı (Gmail görünümü değişmiş olabilir)');
    prev = sig;
    if (round === 0) seen.push(...list);
    await p.locator('div[gh="tm"] div[role="checkbox"]').first().click({ timeout: 10_000 });
    await p.waitForTimeout(800);
    // "Bu aramayla eşleşen tüm N ileti dizisini seç"
    let count = list.length;
    const all = p.locator('div[role="main"] span[role="link"]').filter({ hasText: /(tüm|all).*(seç|select)|(seç|select).*(tüm|all)|eşleşen|that match/i }).first();
    if (await all.isVisible().catch(() => false)) {
      const t = await all.innerText().catch(() => '');
      await all.click().catch(() => {});
      const n = Number((t.match(/[\d.,]+/) ?? [''])[0].replace(/[.,]/g, ''));
      if (n > count) count = n;
    }
    const del = p.locator('div[gh="tm"] div[act="10"]').first();
    if (await del.isVisible().catch(() => false)) await del.click();
    else await p.locator('div[gh="tm"] [role="button"][aria-label="Sil"], div[gh="tm"] [role="button"][aria-label="Delete"], div[gh="tm"] [data-tooltip="Sil"], div[gh="tm"] [data-tooltip="Delete"], div[gh="tm"] [aria-label*="Sonsuza"], div[gh="tm"] [aria-label*="Delete forever"]').first().click({ timeout: 10_000 });
    // Toplu işlem onayı
    const ok = p.locator('div[role="alertdialog"] button[name="ok"], div[role="dialog"] button[name="ok"]').first();
    if (await ok.isVisible({ timeout: 4000 }).catch(() => false)) await ok.click();
    await p.waitForTimeout(3000);
    total += count;
    if (count > list.length) break; // hepsi tek seferde gitti
  }
  return total;
}

/** Gmail → Abonelikleri yönet: yalnız verilen göndericilerin aboneliğinden çıkar */
async function unsubscribeSenders(p: Page, senders: Row[]): Promise<{ cikildi: string[]; not?: string }> {
  const out: string[] = [];
  try {
    await open(p, 'sub');
  } catch (e) {
    if (e instanceof GmailLoginNeeded) throw e;
    return { cikildi: out, not: 'Gmail "Abonelikleri yönet" sayfası açılamadı' };
  }
  const keys = [...new Set(senders.flatMap(s => [s.adres, s.ad.trim()]).filter(k => k && k.length > 2))];
  for (let i = 0; i < 40; i++) {
    const buttons = p.locator('div[role="main"] button, div[role="main"] [role="button"]').filter({ hasText: /^\s*(Abonelikten çık|Unsubscribe)\s*$/i });
    const n = await buttons.count();
    let clicked = false;
    for (let k = 0; k < n; k++) {
      const b = buttons.nth(k);
      // Düğmenin bulunduğu satırın metni (gönderen adı / adresi)
      const rowText = await b.evaluate(el => {
        let r: HTMLElement | null = el as HTMLElement;
        for (let d = 0; d < 6 && r?.parentElement; d++) { r = r.parentElement; if ((r.innerText || '').length > 20) break; }
        return r?.innerText || '';
      }).catch(() => '');
      const who = keys.find(key => rowText.toLowerCase().includes(key.toLowerCase()));
      if (!who || out.includes(who)) continue;
      await b.click().catch(() => {});
      const confirm = p.locator('div[role="dialog"] button, div[role="alertdialog"] button').filter({ hasText: /^\s*(Abonelikten çık|Unsubscribe|Tamam|OK)\s*$/i }).last();
      if (await confirm.isVisible({ timeout: 4000 }).catch(() => false)) await confirm.click().catch(() => {});
      await p.waitForTimeout(1500);
      out.push(who);
      clicked = true;
      break;
    }
    if (!clicked) break;
  }
  return { cikildi: out };
}

export async function gmailWebRoutine(o: { gun: number; grupla?: boolean }): Promise<MailRoutineResult> {
  const p = await browserPage();
  const silinenler: Row[] = [];
  // Önce önemliler (silmeden önce gelen kutusu)
  await open(p, `search/${encodeURIComponent(`in:inbox newer_than:${o.gun}d -category:promotions -category:social -category:updates -category:forums`)}`);
  const onemli = await rows(p, 20);
  await open(p, `search/${encodeURIComponent(`in:inbox newer_than:${o.gun}d category:social`)}`);
  const sosyal = (await rows(p, 100)).length;
  await open(p, `search/${encodeURIComponent(`in:inbox newer_than:${o.gun}d category:updates`)}`);
  const bildirim = (await rows(p, 100)).length;
  // Tanıtımlar: göndericiler not alınır, abonelikten çıkılır, Çöp'e
  await open(p, `search/${encodeURIComponent(`category:promotions newer_than:${o.gun}d`)}`);
  const promo = await rows(p, 100);
  const promoSenders = [...new Map(promo.filter(r => r.adres).map(r => [r.adres, r])).values()];
  const unsub = promoSenders.length ? await unsubscribeSenders(p, promoSenders) : { cikildi: [] as string[] };
  const promoN = await trashSearch(p, `category:promotions newer_than:${o.gun}d`, silinenler);
  const spamRows: Row[] = [];
  const spamN = await trashSearch(p, 'in:spam', spamRows);
  let klasorlenen: Record<string, number> = {};
  let klasorNot = '';
  if (o.grupla) {
    try { klasorlenen = await organizeLabels(o.gun); } catch (e: any) { if (e instanceof GmailLoginNeeded) throw e; klasorNot = `Klasörleme yapılamadı: ${String(e?.message || e).split('\n')[0].slice(0, 120)}`; }
  }
  const by = new Map<string, { ad: string; adres: string; adet: number; kategori: string }>();
  for (const [r, kat] of [...silinenler.map(r => [r, 'Tanıtım / reklam'] as const), ...spamRows.map(r => [r, 'Spam'] as const)]) {
    const k = r.adres || r.ad;
    const cur = by.get(k) ?? { ad: r.ad || r.adres, adres: r.adres, adet: 0, kategori: kat };
    cur.adet++;
    by.set(k, cur);
  }
  return {
    taranan_gun: o.gun,
    toplam: onemli.length + sosyal + bildirim + Math.max(promoN, promo.length) + spamN,
    gruplar: Object.fromEntries(Object.entries({ 'Kişisel / önemli': onemli.length, 'Sosyal medya (Gmail sekmesi)': sosyal, 'Güncellemeler (Gmail sekmesi)': bildirim, 'Tanıtım / reklam': Math.max(promoN, promo.length), Spam: spamN }).filter(([, n]) => n > 0)),
    silinen: promoN + spamN,
    silinen_gondericiler: [...by.values()].sort((a, b) => b.adet - a.adet),
    abonelik: { cikildi: unsub.cikildi.length, elle: [unsub.not, klasorNot].filter(Boolean) as string[] },
    klasorlenen,
    onemli: onemli.map(r => ({ kimden: `${r.ad} <${r.adres}>`, konu: r.konu, tarih: r.tarih, grup: 'Gelen kutusu', metin: r.onizleme })),
  };
}

// ---------------------------------------------------------------- E-posta metinleri (harcama bildirimleri için)

export interface WebMail { id: string; kimden: string; konu: string; tarih: string; metin: string }

/** Aramadaki e-postaları tek tek açıp metnini okur (en fazla max). Okundu işareti Gmail'de değişebilir. */
export async function readSearch(query: string, max = 40, skip: Set<string> = new Set()): Promise<WebMail[]> {
  const p = await browserPage();
  await open(p, `search/${encodeURIComponent(query)}`);
  const list = (await rows(p, max)).filter(r => r.id && !skip.has(`gw-${r.id}`));
  const out: WebMail[] = [];
  for (const r of list) {
    try {
      await p.goto(`${BASE}#all/${r.id}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await p.waitForSelector('div.a3s', { timeout: 15_000 });
      const metin = await p.evaluate(() => Array.from(document.querySelectorAll('div.a3s')).map(e => (e as HTMLElement).innerText).join('\n---\n'));
      out.push({ id: `gw-${r.id}`, kimden: `${r.ad} <${r.adres}>`, konu: r.konu, tarih: r.tarih, metin: metin.replace(/\s+/g, ' ').slice(0, 3000) });
    } catch {
      // Açılamadıysa önizlemesiyle (tutar çoğunlukla ilk satırdadır)
      out.push({ id: `gw-${r.id}`, kimden: `${r.ad} <${r.adres}>`, konu: r.konu, tarih: r.tarih, metin: r.onizleme });
    }
  }
  return out;
}

// ---------------------------------------------------------------- Klasörler (Gmail etiketleri)

/** Gelen kutusundan Jarvis/… etiketlerine taşınacaklar (Gmail araması) */
export const WEB_FOLDERS: { ad: string; sorgu: string }[] = [
  { ad: 'Jarvis/Kredi Kartı', sorgu: '(harcama OR provizyon OR ekstre OR "hesap özeti" OR "kartınızla" OR "kredi kartı") -category:promotions' },
  { ad: 'Jarvis/Faturalar', sorgu: '(fatura OR e-fatura OR e-arşiv OR dekont OR makbuz OR invoice OR receipt) -category:promotions' },
  { ad: 'Jarvis/Sipariş-Kargo', sorgu: '(kargo OR sipariş OR "siparişiniz" OR "order" OR shipped OR teslim) -category:promotions' },
  { ad: 'Jarvis/Sosyal', sorgu: 'category:social' },
  { ad: 'Jarvis/Bildirimler', sorgu: 'category:updates' },
];

async function ensureLabel(p: Page, name: string) {
  await p.goto(`${BASE}#settings/labels`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await p.waitForTimeout(2500);
  const exists = await p.evaluate((n: string) => (document.body.innerText || '').split('\n').some(l => l.trim() === n || l.trim() === n.split('/').pop()), name);
  if (exists) return;
  const create = p.locator('button, [role="button"]').filter({ hasText: /^\s*(Yeni etiket oluştur|Create new label)\s*$/i }).first();
  if (!(await create.isVisible().catch(() => false))) return;
  await create.click();
  const input = p.locator('div[role="dialog"] input[type="text"], div[role="alertdialog"] input[type="text"]').first();
  await input.fill(name, { timeout: 8000 });
  await p.locator('div[role="dialog"] button[name="ok"], div[role="alertdialog"] button[name="ok"]').first().click({ timeout: 8000 }).catch(() => p.keyboard.press('Enter'));
  await p.waitForTimeout(1500);
}

/** Gelen kutusundaki e-postaları etiketlere taşır (gelen kutusundan çıkar; etikette durur, silinmez). Sayılar. */
export async function organizeLabels(gun: number): Promise<Record<string, number>> {
  const p = await browserPage();
  const out: Record<string, number> = {};
  for (const f of WEB_FOLDERS) {
    const q = `in:inbox newer_than:${gun}d ${f.sorgu}`;
    await open(p, `search/${encodeURIComponent(q)}`);
    const list = await rows(p, 100);
    if (!list.length) continue;
    await ensureLabel(p, f.ad);
    await open(p, `search/${encodeURIComponent(q)}`);
    await p.locator('div[gh="tm"] div[role="checkbox"]').first().click({ timeout: 10_000 });
    await p.waitForTimeout(600);
    const all = p.locator('div[role="main"] span[role="link"]').filter({ hasText: /(tüm|all).*(seç|select)|eşleşen|that match/i }).first();
    let n = list.length;
    if (await all.isVisible().catch(() => false)) {
      const t = await all.innerText().catch(() => '');
      await all.click().catch(() => {});
      n = Math.max(n, Number((t.match(/[\d.,]+/) ?? [''])[0].replace(/[.,]/g, '')) || 0);
    }
    // "Taşı" menüsü: etiket adını yazıp Enter
    const move = p.locator('div[gh="tm"] [aria-label="Taşı"], div[gh="tm"] [aria-label="Move to"], div[gh="tm"] [data-tooltip="Taşı"], div[gh="tm"] [data-tooltip="Move to"]').first();
    if (!(await move.isVisible().catch(() => false))) throw new Error('Gmail\'de "Taşı" düğmesi bulunamadı');
    await move.click();
    const box = p.locator('div[role="menu"] input, div[role="listbox"] input').first();
    await box.fill(f.ad, { timeout: 8000 });
    await p.waitForTimeout(800);
    const item = p.locator('div[role="menu"] [role="menuitem"], div[role="menu"] [role="menuitemradio"], div[role="menu"] [role="option"]').filter({ hasText: new RegExp(`^\\s*${f.ad.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`) }).first();
    if (await item.isVisible().catch(() => false)) await item.click(); else await p.keyboard.press('Enter');
    const ok = p.locator('div[role="alertdialog"] button[name="ok"], div[role="dialog"] button[name="ok"]').first();
    if (await ok.isVisible({ timeout: 3000 }).catch(() => false)) await ok.click();
    await p.waitForTimeout(2500);
    out[f.ad] = n;
  }
  return out;
}

// ---------------------------------------------------------------- Okuma (eposta_listele / eposta_oku yedeği)

export async function webInbox(o: { gun: number; ara: string; sadece_okunmamis: boolean; adet: number }) {
  const p = await browserPage();
  await open(p, `search/${encodeURIComponent(`in:inbox newer_than:${Math.min(Math.max(o.gun, 1), 90)}d${o.sadece_okunmamis ? ' is:unread' : ''}${o.ara ? ` ${o.ara}` : ''}`)}`);
  return (await rows(p, Math.min(Math.max(o.adet, 1), 50))).map(r => ({ id: r.id, kimden: `${r.ad} <${r.adres}>`, konu: r.konu, tarih: r.tarih, okunmadi: r.okunmadi, ozet: r.onizleme }));
}

export async function webRead(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error('geçersiz e-posta kimliği');
  const p = await browserPage();
  await p.goto(`${BASE}#all/${id}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (/accounts\.google\.com/.test(p.url())) throw new GmailLoginNeeded();
  await p.waitForSelector('div.a3s', { timeout: 20_000 });
  return p.evaluate(() => ({
    konu: (document.querySelector('h2.hP') as HTMLElement | null)?.innerText || '',
    kimden: Array.from(document.querySelectorAll('span.gD[email]')).map(e => `${e.getAttribute('name')} <${e.getAttribute('email')}>`).pop() || '',
    metin: Array.from(document.querySelectorAll('div.a3s')).map(e => (e as HTMLElement).innerText).join('\n---\n').slice(0, 6000),
  }));
}
