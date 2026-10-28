import { useEffect, useState } from 'react';
import { calcIndicators, getIndicators, importIndicatorChannel, testIndicators, type IndicatorInfo, type IndicatorSignal, type IndicatorTest } from '../lib/api';

const RENK = { AL: 'ok', SAT: 'warn', BEKLE: 'muted' } as const;

/** Ayarlar → İndikatörler: 25 indikatörün stratejileri, bir sembolde anlık sinyal tablosu ve geçmiş testi, Telegram kanalından alma */
export function IndicatorSettings({ flash }: { flash(t: string): void }) {
  const [list, setList] = useState<IndicatorInfo[]>([]);
  const [fav, setFav] = useState<string[]>([]);
  const [notlar, setNotlar] = useState<{ ad: string; ozet: string; link: string; kanal: string }[]>([]);
  const [sembol, setSembol] = useState('XU100');
  const [kanal, setKanal] = useState('');
  const [busy, setBusy] = useState('');
  const [sig, setSig] = useState<{ ad: string; fiyat: number; para: string; oylama?: { AL: number; SAT: number; BEKLE: number; genel: string }; sinyaller: IndicatorSignal[] } | null>(null);
  const [tests, setTests] = useState<IndicatorTest[] | null>(null);
  const load = () => getIndicators().then(r => { setList(r.indikatorler); setFav(r.favoriler); setNotlar(r.notlar); }).catch(() => {});
  useEffect(() => { load(); }, []);
  const run = <T,>(k: string, p: Promise<T>, ok: (v: T) => void) => { setBusy(k); p.then(ok).catch(e => flash(e.message)).finally(() => setBusy('')); };
  const testOf = (id: string) => tests?.find(t => t.indikator === list.find(i => i.id === id)?.ad);

  return (
    <>
      <label>İndikatörler · stratejiler</label>
      <p className="muted small">25 indikatör (OTT, MOST, PMax, AlphaTrend, Tillson T3, SuperTrend, UT Bot, Squeeze, WaveTrend, Ichimoku…) günlük mumlarla hesaplanır. Jarvis'e "THYAO'da OTT ne diyor", "Bitcoin'de hangi indikatörler AL veriyor" diye sorabilirsiniz. Robotun stratejisi de bunlardan biri yapılabilir. Yatırım tavsiyesi değildir.</p>
      <div className="seg">
        <input className="ext-input" value={sembol} onChange={e => setSembol(e.target.value)} placeholder="Sembol: THYAO, XU100, BTC-USD, GC=F…" />
        <button disabled={!!busy || !sembol.trim()} onClick={() => run('h', calcIndicators(sembol), r => { setSig(r); setTests(null); })}>{busy === 'h' ? 'Hesaplanıyor…' : '📈 Sinyalleri hesapla'}</button>
        <button disabled={!!busy || !sig} onClick={() => run('t', testIndicators(sembol), r => setTests(r.testler))}>{busy === 't' ? 'Test ediliyor…' : '🧪 Son 1 yılda test et'}</button>
      </div>
      {sig && (
        <div style={{ overflowX: 'auto' }}>
          <p className="small"><b>{sig.ad}</b> · {sig.fiyat} {sig.para}{sig.oylama ? ` · AL ${sig.oylama.AL} / SAT ${sig.oylama.SAT} / BEKLE ${sig.oylama.BEKLE} → ${sig.oylama.genel}` : ''}</p>
          <table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th align="left">İndikatör</th><th align="left">Sinyal</th><th align="left">Başlangıç</th><th align="left">Değerler</th>{tests && <><th align="right">1 yıl getiri</th><th align="right">İşlem / kazanma</th><th align="right">En büyük düşüş</th></>}</tr></thead>
            <tbody>
              {sig.sinyaller.map(s => { const t = testOf(s.id); return (
                <tr key={s.id}>
                  <td>{fav.includes(s.id) ? '⭐ ' : ''}{s.indikator}</td>
                  <td className={RENK[s.sinyal]}><b>{s.sinyal}</b>{s.yeni_sinyal ? ' 🆕' : ''}</td>
                  <td>{s.sinyal_baslangici ?? ''}</td>
                  <td className="muted">{Object.entries(s.degerler).map(([k, v]) => `${k}: ${v ?? '-'}`).join(' · ')}</td>
                  {tests && <><td align="right">{t ? `%${t.toplam_getiri_yuzde} (al-tut %${t.al_tut_yuzde})` : ''}</td><td align="right">{t ? `${t.islem} / %${t.kazanma_orani_yuzde ?? '-'}` : ''}</td><td align="right">{t ? `%${t.en_buyuk_dusus_yuzde}` : ''}</td></>}
                </tr>
              ); })}
            </tbody>
          </table>
          {tests && <p className="muted small">Test: günlük mumlar, yalnız alış, komisyon %0,2. Geçmiş sonuç geleceği göstermez.</p>}
        </div>
      )}
      <div className="seg">
        <input className="ext-input" value={kanal} onChange={e => setKanal(e.target.value)} placeholder="Telegram indikatör kanalı linki (https://t.me/…)" />
        <button disabled={!!busy || !kanal.trim()} onClick={() => run('k', importIndicatorChannel(kanal), r => { flash(`${r.baslik}: ${r.taranan} mesaj tarandı, ${r.taninan.length} indikatör tanındı`); load(); })}>{busy === 'k' ? 'Taranıyor…' : '📡 Kanaldan al'}</button>
      </div>
      <div className="ext-boxes">
        {list.map(i => (
          <details key={i.id} className="ext-box">
            <summary><span>{fav.includes(i.id) ? '⭐ ' : ''}<b>{i.ad}</b></span><em className="muted">{i.yazar}</em></summary>
            <p className="small"><b>Ne ölçer:</b> {i.olcer}</p>
            <p className="small"><b>Strateji:</b> {i.strateji}</p>
            <p className="small warn"><b>Zayıf yanı:</b> {i.zayif}</p>
            <p className="muted small">Robotta kullanmak için Jarvis'e: "robotun stratejisini {i.id} yap"</p>
          </details>
        ))}
      </div>
      {notlar.length > 0 && (
        <>
          <p className="small"><b>Kanallardan not alınan diğer indikatörler</b> (Jarvis'te hesaplanmaz, yalnız açıklama):</p>
          {notlar.map(n => <p key={n.link} className="small">• <b>{n.ad}</b>: {n.ozet} <a href={n.link} target="_blank" rel="noopener noreferrer">mesaj</a></p>)}
        </>
      )}
    </>
  );
}
