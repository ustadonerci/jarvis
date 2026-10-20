import { useEffect, useState } from 'react';
import { addPortfolio, deleteAlarm, deletePortfolio, getAlarms, getPortfolio, type AlarmView, type PortfolioData } from '../lib/api';

const tl = (v?: number | null) => (v === undefined || v === null ? '—' : `${v.toLocaleString('tr-TR', { maximumFractionDigits: 0 })} ₺`);
const pct = (v?: number | null) => (v === undefined || v === null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}%`);

/**
 * Ayarlar → Portföy: varlıkları elle ekleme, TL bazında kâr/zarar ve sinyal; fiyat alarmları.
 * Jarvis'e de söylenebilir: "Portföyüme 10 THYAO ekle, maliyet 300", "portföyüm nasıl", "bitcoin 100 bini geçerse haber ver".
 */
export function PortfolioSettings({ flash }: { flash(t: string): void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PortfolioData | null>(null);
  const [alarms, setAlarms] = useState<AlarmView[]>([]);
  const [form, setForm] = useState({ sembol: '', adet: '', maliyet: '' });

  const load = () => {
    setData(null);
    getPortfolio().then(setData).catch(e => setData({ hata: e.message }));
    getAlarms().then(r => setAlarms(r.alarmlar.filter(a => !a.tetiklendi))).catch(() => {});
  };
  useEffect(() => { if (open) load(); }, [open]);

  const num = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));
  const add = () => {
    addPortfolio(form.sembol, num(form.adet), num(form.maliyet))
      .then(() => { setForm({ sembol: '', adet: '', maliyet: '' }); flash('Portföye eklendi'); load(); })
      .catch(e => flash(e.message));
  };

  return (
    <>
      <label>Portföy</label>
      {!open ? (
        <button className="profile-peek" onClick={() => setOpen(true)}>
          <span>Varlıklarınız, kâr/zarar, Al/Sat/Tut sinyalleri ve fiyat alarmları</span>
          <em>aç</em>
        </button>
      ) : (
        <div className="keys">
          {!data ? <p className="muted small">fiyatlar alınıyor…</p> : data.hata ? <p className="small warn">{data.hata}</p> : data.bos ? (
            <p className="muted small">Portföy boş. Aşağıdan ekleyin ya da Jarvis'e "portföyüme 10 THYAO ekle, maliyet 300" deyin.</p>
          ) : (
            <>
              <div className="pf-total">
                <b>{tl(data.toplam_deger_tl)}</b>
                <span className={(data.toplam_kar_tl ?? 0) >= 0 ? 'up' : 'down'}>{tl(data.toplam_kar_tl)} · {pct(data.toplam_kar_yuzde)}</span>
                <em>yıllık oynaklık {pct(data.risk?.yillik_oynaklik)} · en büyük düşüş {pct(data.risk?.en_buyuk_dusus_1y)}</em>
              </div>
              <ul className="memory ext-list">
                {data.varliklar?.map(v => (
                  <li key={v.id}>
                    <span>
                      <div className="ext-title"><b>{v.ad ?? v.sembol}</b><i className="tag">{v.sembol}</i>{v.sinyal && <i className={`tag ${v.sinyal === 'AL' ? 'ok' : v.sinyal === 'TUT' ? '' : 'bad'}`}>{v.sinyal}</i>}</div>
                      {v.hata ? <small className="warn">{v.hata}</small> : (
                        <small>{v.adet} × {v.fiyat?.toLocaleString('tr-TR')} {v.para} · {tl(v.deger_tl)} · <span className={(v.kar_tl ?? 0) >= 0 ? 'up' : 'down'}>{pct(v.kar_yuzde)}</span> · %{v.agirlik_yuzde}</small>
                      )}
                    </span>
                    <button aria-label="Çıkar" onClick={() => confirm(`${v.sembol} portföyden çıkarılsın mı?`) && deletePortfolio(v.id).then(load).catch(e => flash(e.message))}>✕</button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <form className="pf-add" onSubmit={e => { e.preventDefault(); add(); }}>
            <input value={form.sembol} onChange={e => setForm(f => ({ ...f, sembol: e.target.value }))} placeholder="THYAO, bitcoin, gram altın" />
            <input value={form.adet} onChange={e => setForm(f => ({ ...f, adet: e.target.value }))} placeholder="Adet" inputMode="decimal" />
            <input value={form.maliyet} onChange={e => setForm(f => ({ ...f, maliyet: e.target.value }))} placeholder="Alış fiyatı" inputMode="decimal" />
            <button type="submit" disabled={!form.sembol.trim() || !(num(form.adet) > 0) || !(num(form.maliyet) >= 0) || !form.maliyet}>Ekle</button>
          </form>
          <p className="muted small">Alış fiyatı varlığın kendi para biriminde: BIST ve gram altın için TL, kripto ve ABD hisseleri için dolar. Sinyaller teknik göstergelerden hesaplanır, yatırım tavsiyesi değildir.</p>
          {alarms.length > 0 && (
            <ul className="memory">
              {alarms.map(a => (
                <li key={a.id}>
                  <span>🔔 {a.sembol} {a.kosul === 'ust' ? '≥' : '≤'} {a.fiyat.toLocaleString('tr-TR')}</span>
                  <button aria-label="Alarmı sil" onClick={() => deleteAlarm(a.id).then(load).catch(e => flash(e.message))}>✕</button>
                </li>
              ))}
            </ul>
          )}
          <div className="seg"><button onClick={load}>Yenile</button><button onClick={() => setOpen(false)}>Kapat</button></div>
        </div>
      )}
    </>
  );
}
