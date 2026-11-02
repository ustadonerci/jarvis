// Ana ekran düzeni: Jarvis (sesle) ya da kullanıcı (Ayarlar → Ekran düzeni) ana ekranı değiştirir: genel büyüklük,
// çekirdeğin boyutu, altyazı yazısının boyutu, yan panellerin genişliği ya da gizlenmesi, renk teması ve arayüz
// (Mark 1 / Mark 2). Ayar sunucuda saklanır, tüm cihazlarda ortaktır; değişiklik anında ekranlara yayınlanır.
import { THEMES, isTheme, type ThemeId } from './look.js';

export interface Ekran {
  /** Bütün arayüzün büyüklüğü (0,7–1,5) */
  genel: number;
  /** Çekirdek (orta halka) boyutu (0,5–1,6) */
  cekirdek: number;
  /** Altyazı / cevap yazısı boyutu (0,7–2) */
  yazi: number;
  /** Yan panellerin genişliği (0,7–1,5) */
  panel: number;
  /** Yan paneller: hepsi / yalnız sol / yalnız sağ / gizli */
  paneller: 'hepsi' | 'sol' | 'sag' | 'gizli';
  /** Kartların yüksekliği (0 gizli, 1 normal, en çok 2,5): sol sütunda Hava + Sistem, sağda Piyasalar + Gündem paylaşır */
  kartlar: Record<Kart, number>;
  /** Gündem kartındaki mesajlar: hangileri görünsün */
  mesajlar: MesajFiltre;
}
export interface MesajFiltre { goster: boolean; whatsapp: boolean; telegram: boolean; arama: boolean; grup: boolean; sadeceOkunmamis: boolean }
export type Kart = 'hava' | 'sistem' | 'piyasa' | 'gundem';
export const KARTLAR: Kart[] = ['hava', 'sistem', 'piyasa', 'gundem'];
export const EKRAN_VARSAYILAN: Ekran = { genel: 1, cekirdek: 1, yazi: 1, panel: 1, paneller: 'hepsi', kartlar: { hava: 1, sistem: 1, piyasa: 1, gundem: 1 }, mesajlar: { goster: true, whatsapp: true, telegram: true, arama: true, grup: true, sadeceOkunmamis: false } };
const LIM: Record<'genel' | 'cekirdek' | 'yazi' | 'panel', [number, number]> = { genel: [0.7, 1.5], cekirdek: [0.5, 1.6], yazi: [0.7, 2], panel: [0.7, 1.5] };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Gelen değişikliği sınırlar içinde uygular (bilinmeyen alanlar yok sayılır) */
export function mergeEkran(cur: Ekran, p: any): Ekran {
  const out = { ...EKRAN_VARSAYILAN, ...cur };
  for (const k of Object.keys(LIM) as (keyof typeof LIM)[]) {
    const v = Number(p?.[k]);
    if (p?.[k] !== undefined && Number.isFinite(v)) out[k] = r2(Math.min(LIM[k][1], Math.max(LIM[k][0], v)));
  }
  if (['hepsi', 'sol', 'sag', 'gizli'].includes(p?.paneller)) out.paneller = p.paneller;
  out.kartlar = { ...EKRAN_VARSAYILAN.kartlar, ...cur?.kartlar };
  for (const k of KARTLAR) {
    const v = Number(p?.kartlar?.[k] ?? p?.[k]);
    if ((p?.kartlar?.[k] ?? p?.[k]) !== undefined && Number.isFinite(v)) out.kartlar[k] = r2(Math.min(2.5, Math.max(0, v)));
  }
  out.mesajlar = { ...EKRAN_VARSAYILAN.mesajlar, ...cur?.mesajlar };
  for (const k of Object.keys(EKRAN_VARSAYILAN.mesajlar) as (keyof MesajFiltre)[]) if (typeof p?.mesajlar?.[k] === 'boolean') out.mesajlar[k] = p.mesajlar[k];
  return out;
}

interface Hooks { get(): { ekran: Ekran; theme: ThemeId; ui: 'mark1' | 'mark2' }; set(p: { ekran?: Ekran; theme?: ThemeId; ui?: 'mark1' | 'mark2' }): void }
let hooks: Hooks | null = null;
export const registerScreen = (h: Hooks) => { hooks = h; };

export const SCREEN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ekran_duzenle',
      description: "Jarvis'in ANA EKRANINI değiştirir (tüm cihazlarda): 'ekranı büyüt/küçült', 'yazıları büyüt', 'çekirdeği küçült', 'yan panelleri gizle/göster', 'sadece sol paneli göster', 'panelleri genişlet', 'temayı kırmızı yap', 'Mark 2 arayüzüne geç', 'ekranı eski haline getir', 'sistem kartını büyüt', 'gündem kartını küçült', 'hava kartını gizle', 'gündemde sadece WhatsApp mesajları görünsün', 'grup mesajlarını gösterme', 'mesajları gizle'. islem: durum | ayarla | buyut | kucult | sifirla. buyut/kucult: hedef (genel, cekirdek, yazi, panel %15; kartlar hava, sistem, piyasa, gundem %25 adım). Kart yüksekliği ayarla ile kartlar: {sistem: 1.5} (0 gizler, 1 normal, en çok 2.5); aynı sütundaki kartlar alanı paylaşır. ayarla: genel 0.7–1.5, cekirdek 0.5–1.6, yazi 0.7–2, panel 0.7–1.5 (1 = normal), paneller (hepsi/sol/sag/gizli), tema, arayuz (mark1/mark2).",
      parameters: {
        type: 'object',
        properties: {
          islem: { type: 'string', enum: ['durum', 'ayarla', 'buyut', 'kucult', 'sifirla'] },
          hedef: { type: 'string', enum: ['genel', 'cekirdek', 'yazi', 'panel', 'hava', 'sistem', 'piyasa', 'gundem'] },
          mesajlar: { type: 'object', description: 'Gündem kartındaki mesajlar', properties: { goster: { type: 'boolean' }, whatsapp: { type: 'boolean' }, telegram: { type: 'boolean' }, arama: { type: 'boolean' }, grup: { type: 'boolean' }, sadeceOkunmamis: { type: 'boolean' } } },
          kartlar: { type: 'object', properties: { hava: { type: 'number' }, sistem: { type: 'number' }, piyasa: { type: 'number' }, gundem: { type: 'number' } } },
          genel: { type: 'number' }, cekirdek: { type: 'number' }, yazi: { type: 'number' }, panel: { type: 'number' },
          paneller: { type: 'string', enum: ['hepsi', 'sol', 'sag', 'gizli'] },
          tema: { type: 'string', description: THEMES.map(t => `${t.id} (${t.ad})`).join(', ') },
          arayuz: { type: 'string', enum: ['mark1', 'mark2'] },
        },
        required: ['islem'],
      },
    },
  },
] as const;

export const isScreenTool = (n: string) => n === 'ekran_duzenle';

export async function runScreenTool(a: any): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  if (!hooks) return j({ hata: 'Ekran ayarı hazır değil' });
  const cur = hooks.get();
  const view = (e: Ekran, t: ThemeId, ui: string) => ({ ...e, tema: THEMES.find(x => x.id === t)?.ad ?? t, arayuz: ui === 'mark2' ? 'Mark 2 (yoğun HUD)' : 'Mark 1' });
  if (a.islem === 'durum') return j(view(cur.ekran, cur.theme, cur.ui));
  let ekran = cur.ekran;
  if (a.islem === 'sifirla') ekran = { ...EKRAN_VARSAYILAN };
  else if (a.islem === 'buyut' || a.islem === 'kucult') {
    const step = a.islem === 'buyut' ? 1.15 : 1 / 1.15;
    if (KARTLAR.includes(a.hedef)) {
      // Kart yüksekliği: %25 adım (gizliyse büyütünce normale döner)
      const k = a.hedef as Kart, v = ekran.kartlar[k];
      ekran = mergeEkran(ekran, { kartlar: { [k]: a.islem === 'buyut' ? (v === 0 ? 1 : v * 1.25) : v / 1.25 } });
      if (ekran.kartlar[k] === v) return j({ ok: false, not: `${k} kartı zaten ${a.islem === 'buyut' ? 'en büyük' : 'en küçük'} boyutta` });
    } else {
      const h = (['genel', 'cekirdek', 'yazi', 'panel'] as const).includes(a.hedef) ? a.hedef as keyof typeof LIM : 'genel';
      ekran = mergeEkran(ekran, { [h]: ekran[h] * step });
      if (ekran[h] === cur.ekran[h]) return j({ ok: false, not: `${h} zaten ${a.islem === 'buyut' ? 'en büyük' : 'en küçük'} değerde (${ekran[h]})` });
    }
  } else ekran = mergeEkran(ekran, a);
  const patch: Parameters<Hooks['set']>[0] = { ekran };
  if (a.tema !== undefined) {
    const t = String(a.tema).toLowerCase();
    const hit = THEMES.find(x => x.id === t || x.ad.toLowerCase().includes(t));
    if (!hit || !isTheme(hit.id)) return j({ hata: 'Böyle bir tema yok', temalar: THEMES.map(x => x.ad) });
    patch.theme = hit.id;
  }
  if (a.arayuz === 'mark1' || a.arayuz === 'mark2') patch.ui = a.arayuz;
  hooks.set(patch);
  const n = hooks.get();
  return j({ ok: true, ekran: view(n.ekran, n.theme, n.ui), not: 'Değişiklik ekranlara hemen uygulandı; kısaca ne değiştiğini söyle. Kullanıcı Ayarlar → Ekran düzeni\'nden kaydırıcılarla da ayarlayabilir.' });
}
