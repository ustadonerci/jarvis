// Hata günlüğü: araç hataları, sohbet hataları ve yakalanmamış hatalar server/data/hatalar.json'a yazılır
// (aynı hata tek kayıtta sayılır). Jarvis `hata_gunlugu` ile okur, olası kök nedeni söyler, çözüm önerir;
// gerekirse kendine bir beceri yazarak (yetenek_olustur) aynı hatayı tekrarlamamayı öğrenir.
// Deneyim hafızası: bir hata çözülünce sebebi ve çözümü server/data/deneyimler.json'a yazılır; aynı (benzer) hata
// yeniden görülünce hata_gunlugu o kaydı "gecmis_cozum" olarak hemen getirir.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'hatalar.json');
const MAX = 200;

export interface ErrorEntry { kaynak: string; mesaj: string; adet: number; ilk: string; son: string; cozuldu?: boolean }

let list: ErrorEntry[] = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } })();
let timer: NodeJS.Timeout | null = null;
const save = () => {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list.slice(-MAX), null, 2));
  }, 500);
};

/** Değişken kısımları (sayılar, kimlikler) atarak aynı hatayı tek kayıtta topla */
const shape = (m: string) => m.replace(/\b[0-9a-f]{8,}\b/gi, '…').replace(/\d+/g, '#').slice(0, 200);

export function logError(kaynak: string, err: unknown) {
  const mesaj = String((err as any)?.message ?? err).replace(/\s+/g, ' ').slice(0, 400);
  if (!mesaj) return;
  const now = new Date().toISOString();
  const ex = list.find(e => e.kaynak === kaynak && shape(e.mesaj) === shape(mesaj));
  if (ex) { ex.adet++; ex.son = now; ex.mesaj = mesaj; ex.cozuldu = false; }
  else list.push({ kaynak, mesaj, adet: 1, ilk: now, son: now });
  if (list.length > MAX * 1.2) list = list.slice(-MAX);
  save();
}

/** Bilinen hata kalıpları → olası neden ve çözüm (modelin analizine başlangıç noktası) */
const HINTS: [RegExp, string][] = [
  [/401|unauthori[sz]ed|invalid api key|yetkisiz/i, 'API anahtarı yanlış ya da süresi dolmuş: Ayarlar → API anahtarlarından kontrol edin.'],
  [/402|insufficient|quota|credit|kredi/i, 'Hesapta kredi/kota bitmiş olabilir.'],
  [/429|rate.?limit|istek sınırı/i, 'İstek sınırı aşıldı: biraz bekleyin ya da ilgili anahtarı ekleyin (ör. GITHUB_TOKEN).'],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, 'İnternet bağlantısı yok ya da alan adı çözülemedi.'],
  [/fetch failed|ECONNRESET|socket hang up/i, 'Ağ isteği başarısız: internet bağlantısı, güvenlik duvarı/antivirüs ya da hedef site erişilemiyor.'],
  [/ECONNREFUSED/i, 'Hedef sunucu bağlantıyı reddetti (kapalı ya da yanlış adres/port).'],
  [/ETIMEDOUT|timeout|zaman aşımı|aborted|Request timed out/i, 'Zaman aşımı: ağ yavaş ya da sunucu cevap vermiyor; tekrar denenebilir.'],
  [/uygulama şifresi|AUTHENTICATIONFAILED|Invalid credentials/i, 'E-posta girişi: Gmail için uygulama şifresi gerekir.'],
  [/ENOENT|no such file/i, 'Dosya ya da program bulunamadı (MCP komutu kurulu değil olabilir; ör. npx/uvx/python).'],
  [/EACCES|EPERM|permission/i, 'İzin hatası: dosya/klasör erişimi engellenmiş.'],
  [/JSON|Unexpected token/i, 'Beklenmeyen veri biçimi: kaynak cevabını değiştirmiş olabilir.'],
];
const hintFor = (m: string) => HINTS.find(([re]) => re.test(m))?.[1] ?? null;

export const errorList = () => list.slice().reverse().map(e => ({ ...e, olasi_neden: hintFor(e.mesaj) }));
export const openErrorCount = () => list.filter(e => !e.cozuldu).length;
export function clearErrors() { list = []; save(); }
export function markResolved() { list.forEach(e => { e.cozuldu = true; }); save(); }

/** Geçici (yeniden denenebilir) hata mı? */
export const isTransient = (m: string) => /ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|fetch failed|timeout|zaman aşımı|\b50[234]\b/i.test(m);

export function initErrors() {
  process.on('unhandledRejection', e => { logError('sunucu', e); console.warn('[hata] yakalanmamış:', String((e as any)?.message ?? e).slice(0, 160)); });
  process.on('uncaughtException', e => { logError('sunucu', e); console.error('[hata] beklenmeyen:', e); });
}

// ---------------------------------------------------------------- Deneyim hafızası

const EXP_FILE = path.join(path.dirname(FILE), 'deneyimler.json');
interface Lesson { hata: string; neden: string; cozum: string; at: string; kullanim: number }
const lessons = (): Lesson[] => { try { return JSON.parse(fs.readFileSync(EXP_FILE, 'utf8')); } catch { return []; } };
const words = (t: string) => new Set(t.toLocaleLowerCase('tr').replace(/[^a-zçğıöşü0-9]+/gi, ' ').split(' ').filter(w => w.length > 3));

/** Hata metnine en çok benzeyen geçmiş çözüm (kelime örtüşmesi; en az 3 ortak kelime ya da %40) */
export function pastSolution(err: string): Lesson | null {
  const a = words(err);
  let best: { l: Lesson; sc: number } | null = null;
  for (const l of lessons()) {
    const b = words(l.hata);
    const common = [...a].filter(w => b.has(w)).length;
    const sc = common / Math.max(1, Math.min(a.size, b.size));
    if ((common >= 3 || sc >= 0.4) && (!best || sc > best.sc)) best = { l, sc };
  }
  return best?.l ?? null;
}

function saveLesson(hata: string, neden: string, cozum: string) {
  const all = lessons();
  const same = all.find(l => shape(l.hata) === shape(hata));
  if (same) Object.assign(same, { neden, cozum, at: new Date().toISOString() });
  else all.push({ hata: hata.slice(0, 400), neden: neden.slice(0, 600), cozum: cozum.slice(0, 1500), at: new Date().toISOString(), kullanim: 0 });
  fs.mkdirSync(path.dirname(EXP_FILE), { recursive: true });
  fs.writeFileSync(EXP_FILE, JSON.stringify(all.slice(-300), null, 2));
}

export const ERROR_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'hata_gunlugu',
      description: "Jarvis'in hata günlüğünü getirir (hangi araç/özellik, kaç kez, ne zaman, olası neden). 'Neden çalışmadı', 'hata var mı', 'sistem durumu', 'kendini kontrol et' gibi isteklerde. Kök nedeni açıkla ve çözüm öner; kalıcı bir davranış düzeltmesi gerekiyorsa yetenek_olustur ile kendine not yaz. 'cozuldu' işlemi kullanıcı sorunu giderdiğini söyleyince. Bir hatayı çözünce islem: deneyim_kaydet ile hata, neden ve çözümü kaydet: aynı hata tekrar görülünce listede gecmis_cozum olarak gelir, onu uygula.",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['listele', 'cozuldu', 'temizle', 'deneyim_kaydet'] },
          hata: { type: 'string', description: 'deneyim_kaydet: hatanın metni (günlükteki mesaj)' },
          neden: { type: 'string', description: 'deneyim_kaydet: kök neden' },
          cozum: { type: 'string', description: 'deneyim_kaydet: işe yarayan çözüm, adım adım' },
        },
      },
    },
  },
] as const;

export function runErrorTool(args: any): string {
  if (args.islem === 'temizle') { clearErrors(); return JSON.stringify({ ok: true }); }
  if (args.islem === 'cozuldu') { markResolved(); return JSON.stringify({ ok: true }); }
  if (args.islem === 'deneyim_kaydet') {
    const hata = String(args.hata ?? '').trim(), cozum = String(args.cozum ?? '').trim();
    if (!hata || !cozum) return JSON.stringify({ hata: 'hata ve cozum gerekli' });
    saveLesson(hata, String(args.neden ?? ''), cozum);
    return JSON.stringify({ ok: true, not: 'Deneyim kaydedildi; bu hata tekrar görülünce çözüm hemen gelecek.' });
  }
  const open = errorList().filter(e => !e.cozuldu);
  return JSON.stringify(open.length
    ? { acik_hata: open.length, hatalar: open.slice(0, 30).map(e => { const p = pastSolution(e.mesaj); return p ? { ...e, gecmis_cozum: { neden: p.neden, cozum: p.cozum, kaydedildi: p.at.slice(0, 10) } } : e; }) }
    : { sonuc: 'Kayıtlı açık hata yok; sistem sağlıklı görünüyor.' });
}
