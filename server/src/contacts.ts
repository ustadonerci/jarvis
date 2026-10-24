// Telefon rehberi: kullanıcı rehberini CSV (Google Kişiler, Outlook, Samsung/iPhone dışa aktarma) ya da vCard (.vcf)
// olarak Jarvis'e gönderir; kişiler yalnızca bu bilgisayarda (server/data/rehber.json) saklanır, yapay zekaya tamamı
// gönderilmez: model yalnızca aranan isme uyan birkaç kişiyi görür.
// "Bilal'i ara" → rehberde bulunur ve aranır:
//  1) Android telefon ADB ile bağlıysa arama doğrudan kullanıcının telefonundan başlar (kendi numarasıyla).
//  2) Değilse ve Twilio + kullanıcının numarası ayarlıysa köprü arama: Twilio önce kullanıcıyı arar, açınca Bilal'e
//     bağlar (karşı taraf Twilio numarasını görür; ücret Twilio'dan).
//  3) İkisi de yoksa Jarvis ekranında "📞 Bilal'i ara" düğmesi çıkar (telefonda dokununca arar) ve WhatsApp'ta
//     kendine yazdığı sohbete numara gönderilir.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidDevice, androidDial, readPhoneContacts } from './android.js';
import { notifySelf } from './messaging.js';
import { bridgeCall, bridgeReady, e164 } from './phone.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DATA, 'rehber.json');

export interface Contact { ad: string; numaralar: { numara: string; tur?: string }[] }

const load = (): Contact[] => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
const save = (l: Contact[]) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(l)); };
export const contactCount = () => load().length;

// ---------------------------------------------------------------- Okuma (CSV / vCard)

/** UTF-8 (BOM'lu/BOM'suz), UTF-16 (Outlook) ve Windows-1254 (eski Türkçe Excel) */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { return new TextDecoder('windows-1254').decode(buf); }
}

/** Tırnaklı alanları ve alan içi satır sonlarını destekleyen CSV okuyucu; ayraç ilk satırdan (, ; tab) */
export function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].map(c => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim())) rows.push(row);
  return rows;
}

/** Telefon numarası gibi mi (en az 7 rakam) */
const phoneLike = (s: string) => (s.match(/\d/g)?.length ?? 0) >= 7 && /^[\d\s+()./-]+$/.test(s.trim());
/** Karşılaştırma için: +90 5xx… / 0 5xx… / 5xx… aynı sayılır (son 10 hane) */
export const numKey = (n: string) => n.replace(/\D/g, '').slice(-10);

const H = (h: string) => h.toLocaleLowerCase('tr').trim();
const isPhoneHeader = (h: string) => /phone|tel|mobile|cep|gsm|numara|number/.test(H(h)) && !/type|label|tür|tur\b|etiket/.test(H(h));
const isPhoneTypeHeader = (h: string) => /phone.*(type|label)|tür|etiket/.test(H(h));

export function contactsFromCsv(text: string): Contact[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0];
  const idx = (re: RegExp) => head.findIndex(h => re.test(H(h)));
  const full = idx(/^(name|display name|full name|ad soyad|adı soyadı|isim|kişi|kisi|ad-soyad)$/);
  const first = idx(/^(first name|given name|ad|adı|isim)$/);
  const middle = idx(/^(middle name|additional name|ikinci ad)$/);
  const last = idx(/^(last name|family name|surname|soyad|soyadı)$/);
  const nick = idx(/^(nickname|takma ad)$/);
  const org = idx(/^(organization name|organization 1 - name|company|şirket|kurum)$/);
  const phoneCols = head.map((h, i) => (isPhoneHeader(h) ? i : -1)).filter(i => i >= 0);
  const out: Contact[] = [];
  for (const r of rows.slice(1)) {
    const g = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    let ad = g(full) || [g(first), g(middle), g(last)].filter(Boolean).join(' ') || g(nick) || g(org);
    // Başlık tanınmadıysa: ilk dolu metin sütunu ad, numara gibi görünen hücreler numara
    const cols = phoneCols.length ? phoneCols : r.map((c, i) => (phoneLike(c) ? i : -1)).filter(i => i >= 0);
    if (!ad) ad = r.find(c => c.trim() && !phoneLike(c))?.trim() ?? '';
    const numaralar: Contact['numaralar'] = [];
    for (const i of cols) {
      // Google: "Phone 1 - Value" içinde birden çok numara " ::: " ile ayrılır; türü yanındaki "Phone 1 - Label/Type"
      const typeCol = head.findIndex((h, j) => j !== i && isPhoneTypeHeader(h) && H(h).split(' - ')[0] === H(head[i]).split(' - ')[0]);
      const tur = typeCol >= 0 ? (r[typeCol] ?? '').replace(/^\*\s*/, '').trim() || undefined : /mobile|cep/i.test(head[i]) ? 'Cep' : undefined;
      for (const n of (r[i] ?? '').split(/\s*:::\s*|\s*\|\s*|\s*\/\s*(?=\+|0)/)) if (phoneLike(n)) numaralar.push({ numara: n.trim(), ...(tur ? { tur } : {}) });
    }
    if (ad && numaralar.length) out.push({ ad: ad.slice(0, 100), numaralar });
  }
  return out;
}

export function contactsFromVcf(text: string): Contact[] {
  const out: Contact[] = [];
  // Katlanmış satırlar (devamı boşlukla başlar) birleştirilir; quoted-printable (eski Android) çözülür
  const unfolded = text.replace(/\r?\n[ \t]/g, '').replace(/=\r?\n/g, '');
  const qp = (s: string) => { try { return decodeURIComponent(s.replace(/%/g, '%25').replace(/=([0-9A-F]{2})/gi, '%$1')); } catch { return s; } };
  for (const card of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    let ad = '';
    const numaralar: Contact['numaralar'] = [];
    for (const line of card.split(/\r?\n/)) {
      const m = /^(?:item\d+\.)?([A-Z-]+)((?:;[^:]*)?):(.*)$/i.exec(line);
      if (!m) continue;
      const [, key, params, raw] = m;
      const val = /QUOTED-PRINTABLE/i.test(params) ? qp(raw) : raw.replace(/\\([,;\\])/g, '$1');
      if (/^FN$/i.test(key) && val.trim()) ad = val.trim();
      else if (/^N$/i.test(key) && !ad) { const [l, f, mid] = val.split(';'); ad = [f, mid, l].filter(x => x?.trim()).join(' ').trim(); }
      else if (/^TEL$/i.test(key) && phoneLike(val.replace(/^tel:/i, ''))) {
        const t = /CELL/i.test(params) ? 'Cep' : /HOME/i.test(params) ? 'Ev' : /WORK/i.test(params) ? 'İş' : undefined;
        numaralar.push({ numara: val.replace(/^tel:/i, '').trim(), ...(t ? { tur: t } : {}) });
      }
    }
    if (ad && numaralar.length) out.push({ ad: ad.slice(0, 100), numaralar });
  }
  return out;
}

/** Dosya içeriğinden kişiler; rehber gibi görünmüyorsa boş liste */
export function parseContacts(buf: Buffer, ad: string): Contact[] {
  const text = decodeText(buf);
  if (/\.vcf$/i.test(ad) || /BEGIN:VCARD/i.test(text.slice(0, 2000))) return contactsFromVcf(text);
  if (/\.csv$/i.test(ad)) return contactsFromCsv(text);
  return [];
}

/** Yeni kişileri ekler; aynı numaralı kişi varsa adı ve numaraları güncellenir. */
export function importContacts(list: Contact[], replace = false): { eklenen: number; guncellenen: number; toplam: number } {
  const cur = replace ? [] : load();
  const byNum = new Map<string, Contact>();
  for (const c of cur) for (const n of c.numaralar) byNum.set(numKey(n.numara), c);
  let eklenen = 0, guncellenen = 0;
  for (const c of list) {
    const nums = c.numaralar.filter((n, i, a) => a.findIndex(x => numKey(x.numara) === numKey(n.numara)) === i);
    const hit = nums.map(n => byNum.get(numKey(n.numara))).find(Boolean);
    if (hit) {
      hit.ad = c.ad;
      for (const n of nums) if (!hit.numaralar.some(x => numKey(x.numara) === numKey(n.numara))) hit.numaralar.push(n);
      guncellenen++;
    } else {
      const nc = { ad: c.ad, numaralar: nums };
      cur.push(nc);
      for (const n of nums) byNum.set(numKey(n.numara), nc);
      eklenen++;
    }
  }
  save(cur);
  console.log(`[rehber] içe aktarıldı: ${eklenen} yeni, ${guncellenen} güncellendi, toplam ${cur.length}`);
  return { eklenen, guncellenen, toplam: cur.length };
}

export function clearContacts() { save([]); }

/** ADB ile bağlı telefondan rehberi alır ve Jarvis'in rehberine ekler */
export async function importFromPhone(): Promise<string> {
  const r = await readPhoneContacts();
  let list: Contact[] = [];
  if (r.vcf) list = contactsFromVcf(decodeText(r.vcf));
  else {
    const by = new Map<string, Contact>();
    for (const s of r.satirlar ?? []) {
      const c = by.get(s.ad) ?? { ad: s.ad.slice(0, 100), numaralar: [] };
      if (!c.numaralar.some(n => numKey(n.numara) === numKey(s.numara))) c.numaralar.push({ numara: s.numara, ...(s.tur ? { tur: s.tur } : {}) });
      by.set(s.ad, c);
    }
    list = [...by.values()];
  }
  if (!list.length) throw new Error(`${r.cihaz}: rehberde numaralı kişi bulunamadı.`);
  const x = importContacts(list);
  return `${r.cihaz} telefonundan rehber alındı (${r.kaynak}): ${x.eklenen} yeni, ${x.guncellenen} güncellendi · toplam ${x.toplam} kişi.`;
}

// ---------------------------------------------------------------- Arama (isimle)

export const fold = (s: string) => s.toLocaleLowerCase('tr')
  .replace(/[çğıöşüâîû]/g, c => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' })[c] ?? c)
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Konuşmadaki ekli hâller: "Bilal'i", "Bilali", "Ayşe'yi", "annemi", "Ahmet abiyi" → kök adaylar */
function stems(word: string): string[] {
  const w = fold(word);
  const out = new Set([w]);
  for (const ek of ['yi', 'yu', 'ye', 'ya', 'nin', 'nun', 'in', 'un', 'i', 'u', 'e', 'a', 'ile', 'la', 'le', 'yla', 'yle']) {
    if (w.length - ek.length >= 2 && w.endsWith(ek)) out.add(w.slice(0, -ek.length));
  }
  return [...out];
}

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}

/** İsme göre puanlı eşleşmeler (en iyi önce). Sorgudaki her kelime kişinin adındaki bir kelimeye uymalı. */
export function findContacts(query: string, list = load()): { kisi: Contact; puan: number }[] {
  const qWords = fold(query.replace(/['’`]\p{L}*/gu, '')).split(' ').filter(w => w && !['ara', 'arar', 'misin', 'beni', 'bana', 'telefon', 'et', 'telefonla', 'hemen', 'lutfen'].includes(w));
  if (!qWords.length) return [];
  const res: { kisi: Contact; puan: number }[] = [];
  for (const c of list) {
    const name = fold(c.ad);
    const nWords = name.split(' ');
    let total = 0, ok = true;
    for (const q of qWords) {
      let best = 0;
      for (const s of stems(q)) for (const n of nWords) {
        const p = n === s ? 10 : n.startsWith(s) && s.length >= 3 ? 6 : s.length >= 4 && lev(n, s) <= 1 ? 5 : s.startsWith(n) && n.length >= 3 ? 4 : 0;
        best = Math.max(best, p);
      }
      if (!best) { ok = false; break; }
      total += best;
    }
    if (ok) res.push({ kisi: c, puan: total + (name === qWords.join(' ') ? 5 : 0) - nWords.length * 0.1 });
  }
  return res.sort((a, b) => b.puan - a.puan);
}

/** Aranacak numara: cep (5xx) öncelikli */
export function bestNumber(c: Contact): string {
  return (c.numaralar.find(n => /^(\+?90|0)?5\d{9}$/.test(n.numara.replace(/[^\d+]/g, ''))) ?? c.numaralar[0]).numara;
}

// ---------------------------------------------------------------- Model aracı


let broadcast: (e: object) => void = () => {};
export const initContacts = (b: (e: object) => void) => { broadcast = b; };

export const CONTACT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'rehber_ara',
      description: "Kullanıcının telefon rehberindeki bir kişiyi ARAR (kullanıcı kendisi konuşur): 'Bilal'i ara', 'annemi ara', 'Ahmet abiyi ara'. Önce Android telefondan (bağlıysa), yoksa Twilio köprüsüyle (önce kullanıcının telefonu çalar), yoksa ekrana dokun-ara düğmesi. Aynı isimde birden çok kişi varsa seçenekleri döndürür: hangisi olduğunu sor ve tam adla tekrar çağır. isim: konuşmadaki ek olmadan ya da olduğu gibi (Bilal'i → Bilal).",
      parameters: {
        type: 'object',
        properties: {
          isim: { type: 'string' },
          numara_turu: { type: 'string', description: 'İsteğe bağlı: "ev", "iş", "cep"' },
          yol: { type: 'string', enum: ['otomatik', 'telefon', 'twilio', 'dugme'], description: 'Varsayılan otomatik' },
        },
        required: ['isim'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rehber',
      description: "Telefon rehberi: bul (isimle kişi ve numaraları; 'Bilal'in numarası ne'), durum (kaç kişi kayıtlı), telefondan_al (USB ya da kablosuz hata ayıklamayla bağlı Android telefondan rehberi çeker: 'telefonuma bağlan rehberi al'), temizle (rehberi siler; yalnız kullanıcı açıkça isterse). Rehber CSV ya da .vcf dosyası Jarvis'e gönderilerek yüklenir.",
      parameters: { type: 'object', properties: { islem: { type: 'string', enum: ['bul', 'durum', 'telefondan_al', 'temizle'] }, isim: { type: 'string' } }, required: ['islem'] },
    },
  },
] as const;

export const isContactTool = (n: string) => n === 'rehber_ara' || n === 'rehber';

const view = (c: Contact) => ({ ad: c.ad, numaralar: c.numaralar.map(n => `${n.numara}${n.tur ? ` (${n.tur})` : ''}`) });

export async function runContactTool(name: string, a: any, progress: (l: string) => void): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  const bos = { hata: 'Rehber boş.', not: "Kullanıcıya: telefonundaki rehberi CSV ya da .vcf olarak dışa aktarıp (Google Kişiler → Dışa aktar; Samsung Kişiler → Kişileri yönet → Dışa aktar) Jarvis'e dosya olarak göndermesini söyle (ataş/dosya düğmesi ya da sürükle-bırak). Rehber yalnızca bu bilgisayarda saklanır." };
  try {
    if (name === 'rehber') {
      if (a.islem === 'durum') return j({ kisi_sayisi: contactCount() });
      if (a.islem === 'temizle') { clearContacts(); return j({ ok: true, not: 'Rehber silindi.' }); }
      if (a.islem === 'telefondan_al') { progress('telefondan rehber okunuyor'); return j({ ok: true, sonuc: await importFromPhone() }); }
      if (!contactCount()) return j(bos);
      const m = findContacts(String(a.isim ?? ''));
      return j(m.length ? { sonuclar: m.slice(0, 5).map(x => view(x.kisi)) } : { sonuc: `Rehberde "${a.isim}" bulunamadı.` });
    }
    if (!contactCount()) return j(bos);
    const isim = String(a.isim ?? '').trim();
    const m = findContacts(isim);
    if (!m.length) return j({ hata: `Rehberde "${isim}" bulunamadı.`, not: 'Kullanıcıya adı rehberde nasıl kayıtlı olduğunu sor (ör. soyadıyla).' });
    // Birden çok kişi neredeyse aynı puanda: hangisi olduğunu sor
    const close = m.filter(x => x.puan >= m[0].puan - 1);
    if (close.length > 1 && close.length <= 8) return j({ secim_gerekli: true, secenekler: close.map(x => view(x.kisi)), not: 'Hangisini aramak istediğini sor; cevaba göre tam adla tekrar rehber_ara çağır.' });
    if (close.length > 8) return j({ secim_gerekli: true, adet: close.length, not: 'Çok fazla eşleşme var; soyadını ya da tam adı sor.' });
    const c = m[0].kisi;
    const want = String(a.numara_turu ?? '').toLocaleLowerCase('tr');
    const raw = (want && c.numaralar.find(n => (n.tur ?? '').toLocaleLowerCase('tr').includes(want))?.numara) || bestNumber(c);
    const numara = e164(raw) ?? raw.replace(/[^\d+]/g, '');
    const yol = String(a.yol ?? 'otomatik');

    if (yol === 'otomatik' || yol === 'telefon') {
      const d = await androidDevice();
      if (d) {
        progress(`${d.model}: ${c.ad} aranıyor`);
        const r = await androidDial(d, numara);
        return j({ ok: true, kisi: c.ad, numara, yol: 'android', cihaz: d.model, ...r, not: r.arandi ? `Arama ${d.model} telefonundan başladı; kısaca "${c.ad} aranıyor" de.` : 'Telefon doğrudan aramaya izin vermedi: numara telefonda çevirici ekranında hazır, kullanıcı yeşil tuşa basmalı.' });
      }
      if (yol === 'telefon') return j({ hata: 'Android telefon ADB ile bağlı değil (Ayarlar → Android telefon).' });
    }
    if ((yol === 'otomatik' || yol === 'twilio') && bridgeReady() && e164(numara)) {
      progress(`Twilio köprü: ${c.ad}`);
      return j({ ok: true, kisi: c.ad, numara, yol: 'twilio', sonuc: await bridgeCall(numara, c.ad), not: 'Kullanıcının telefonu çalacak; açınca kişiye bağlanacak. Karşı taraf Twilio numarasını görür.' });
    }
    if (yol === 'twilio') return j({ hata: 'Twilio ya da kullanıcının numarası ayarlı değil.' });
    broadcast({ type: 'link', baslik: `📞 ${c.ad}`, url: `tel:${numara}`, dugme: 'Ara', aciklama: `${numara} — telefonda dokununca arar.` });
    const wa = await notifySelf(`📞 ${c.ad}: ${numara}`);
    return j({ ok: true, kisi: c.ad, numara, yol: 'dugme', whatsapp_gonderildi: wa, not: `Jarvis aramayı kendisi başlatamadı (Android telefon bağlı değil, Twilio köprüsü kurulu değil). Ekranda "Ara" düğmesi çıktı${wa ? ' ve numara WhatsApp\'ta kendine gönderildi' : ''}; telefonda dokununca arar. Tam otomatik arama için Ayarlar → Android telefon eşleştirmesini öner (bir kez).` });
  } catch (e: any) {
    return j({ hata: String(e?.message || e).slice(0, 300) });
  }
}
