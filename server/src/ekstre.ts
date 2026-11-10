// Kredi kartı ekstresi PDF metni → işlem satırları (TOM Bank Hadi biçimi: "14/09/2026 ALTIN ALIMI 963.35", ödemeler "+7.02").
// shortcut: yalnız bu biçim denendi; başka bankanın ekstresi eklenince örneğine göre genişletilmeli.
export interface EkstreSatir { tarih: string; aciklama: string; tutar: number; tur: 'harcama' | 'iade'; masraf: boolean }

const LINE = /^(\d{2})\/(\d{2})\/(\d{4})\s+(.+?)\s+(\+)?(\d{1,3}(?:,\d{3})*\.\d{2})(?:\s.*)?$/;
const PAYMENT = /ODEME ICIN|^ODEME\b/i;
const FEE = /KAR PAYI|BSMV|KKDF|GECIKME CEZASI|FAIZ|KART AIDATI|YILLIK UCRET/i;
const money = (s: string) => Number(s.replace(/,/g, ''));
const round = (n: number) => Math.round(n * 100) / 100;

export function parseStatement(text: string): { kart: string; satirlar: EkstreSatir[]; tutarli: boolean } {
  const satirlar: EkstreSatir[] = [];
  let odeme = 0;
  for (const l of text.split(/\r?\n/)) {
    const m = LINE.exec(l.trim());
    if (!m) continue;
    const tutar = money(m[6]);
    if (PAYMENT.test(m[4])) { odeme += tutar; continue; }
    satirlar.push({ tarih: `${m[3]}-${m[2]}-${m[1]}`, aciklama: m[4].trim().slice(0, 60), tutar, tur: m[5] ? 'iade' : 'harcama', masraf: FEE.test(m[4]) });
  }
  // Devreden − ödemeler + işlemler ekstre toplamını tutmalı; tutmuyorsa bir satır okunamamıştır
  const devreden = /Devreden Tutar\s+([\d,]+\.\d{2})/.exec(text);
  const toplam = /^Toplam\s+([\d,]+\.\d{2})/m.exec(text);
  const net = satirlar.reduce((t, s) => t + (s.tur === 'iade' ? -s.tutar : s.tutar), 0);
  return {
    kart: /Kart Numarası\s+\d{4} \d{2}\*\* \*{4} (\d{4})/.exec(text)?.[1] ?? '',
    satirlar,
    tutarli: !!devreden && !!toplam && round(money(devreden[1]) - odeme + net) === money(toplam[1]),
  };
}

/** Aynı işlem anlık mailde ve ekstrede farklı günlerde görünebilir (işleme alınma gecikmesi) */
export function sameTransaction(a: { tarih: string; tutar: number; tur: string; kart?: string }, b: { tarih: string; tutar: number; tur: string; kart?: string }): boolean {
  if (a.kart && b.kart && a.kart !== b.kart) return false;
  const days = Math.abs(Date.parse(a.tarih) - Date.parse(b.tarih)) / 86_400_000;
  return a.tur === b.tur && a.tutar === b.tutar && days <= 3;
}
