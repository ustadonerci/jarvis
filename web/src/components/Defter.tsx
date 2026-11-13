import { useEffect, useState } from 'react';
import { getDefter } from '../lib/api';

interface DefterData {
  tarih: string; gunun_3_isi: string[]; donulecekler: string[]; aliskanliklar: string[]; hedefler: string[];
  gorevler: { id: string; metin: string; tarih?: string }[];
  para: { ay: string; gider: number; gelir: number; bana_borclu: { kisi: string; tutar: number }[]; benim_borcum: { kisi: string; tutar: number }[] };
}

/** Ayarlar → Defter: görevler, dönülecekler, alışkanlıklar, hedefler, para özeti (sesle/yazıyla doldurulur) */
export function DefterSettings() {
  const [d, setD] = useState<DefterData | null>(null);
  useEffect(() => { getDefter().then(setD).catch(() => {}); }, []);
  if (!d) return null;
  const tl = (n: number) => `${n.toLocaleString('tr-TR')} TL`;
  return (
    <>
      <label>Defter · {d.tarih}</label>
      <p className="muted small">Jarvis'e konuşur gibi söyleyin: "ekle: kargo firmasını ara, cuma", "bitti: kargo", "300 TL un aldım", "Ahmet 2.000 borçlu", "Selin hanım numune istedi, yarın ararım", "her gün yürüyüş takip et", "Günaydın", "Günü kapat".</p>
      <ul className="memory">
        <li><span><b>Bugünün işleri:</b> {d.gunun_3_isi.length ? d.gunun_3_isi.join(' · ') : 'yok'}</span></li>
        {d.donulecekler.length > 0 && <li><span><b>Dönülecekler:</b> {d.donulecekler.join(' · ')}</span></li>}
        {d.aliskanliklar.length > 0 && <li><span><b>Alışkanlıklar:</b> {d.aliskanliklar.join(' · ')}</span></li>}
        {d.hedefler.length > 0 && <li><span><b>Hedefler:</b> {d.hedefler.join(' · ')}</span></li>}
        <li><span><b>Bu ay:</b> gider {tl(d.para.gider)} · gelir {tl(d.para.gelir)}{d.para.bana_borclu.length ? ` · bana borçlu: ${d.para.bana_borclu.map(x => `${x.kisi} ${tl(x.tutar)}`).join(', ')}` : ''}{d.para.benim_borcum.length ? ` · borcum: ${d.para.benim_borcum.map(x => `${x.kisi} ${tl(x.tutar)}`).join(', ')}` : ''}</span></li>
      </ul>
      {d.gorevler.length > 3 && <p className="muted small">Açık görev: {d.gorevler.length} · tamamı için "ne kaldı" deyin.</p>}
    </>
  );
}
