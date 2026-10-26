import { useEffect, useState } from 'react';
import { getExchanges, getKeys, saveKeys, testExchange, type ExchangeView, type KeyView } from '../lib/api';

const LOGO: Record<string, string> = { binance: '🟡', btcturk: '🔵', okx: '⚫', bitlo: '🟣' };
const fmt = (n: number) => n.toLocaleString('tr-TR', { maximumFractionDigits: 8 });

/**
 * Ayarlar → Borsalar: her borsa açılır bir kart. Kartta API anahtarları (gizli alanlar geri gösterilmez, yalnız
 * "kayıtlı ••••1a2b"), kaydetme ve bağlantı testi (bakiye okunur). Anahtarlar yalnız bu bilgisayardaki server/.env'e yazılır.
 */
export function ExchangeSettings({ flash }: { flash(t: string): void }) {
  const [list, setList] = useState<ExchangeView[] | null>(null);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<Record<string, { bakiye?: { varlik: string; serbest: number; kilitli: number }[]; hata?: string }>>({});

  const load = () => {
    getExchanges().then(r => setList(r.borsalar)).catch(e => setError(e.message));
    getKeys().then(k => setKeys(k.fields.filter(f => f.borsa))).catch(e => setError(e.message));
  };
  useEffect(load, []);

  const save = (id: string) => {
    const vals = Object.fromEntries(Object.entries(draft).filter(([k]) => keys.find(f => f.name === k)?.borsa === id));
    if (!Object.keys(vals).length) return flash('Önce bir alana yazın');
    saveKeys(vals).then(r => {
      setDraft(d => Object.fromEntries(Object.entries(d).filter(([k]) => !(k in vals))));
      setKeys(r.fields.filter(f => f.borsa));
      flash(r.restarting ? 'Kaydedildi · Jarvis yeniden başlıyor; birkaç saniye sonra "Bağlantıyı test et"e basın' : r.changed ? 'Kaydedildi' : 'Değişiklik yok');
      setTimeout(load, 6000);
    }).catch(e => flash(e.message));
  };
  const test = (id: string) => {
    setBusy(id);
    testExchange(id).then(r => setResult(x => ({ ...x, [id]: { bakiye: r.bakiye } }))).catch(e => setResult(x => ({ ...x, [id]: { hata: e.message } }))).finally(() => setBusy(''));
  };

  if (error) return (
    <>
      <label>Borsalar</label>
      <p className="small warn">{/bilgisayardan|403|yetkisiz/i.test(error) ? 'Borsa anahtarları yalnızca Jarvis\'in çalıştığı bilgisayardan girilebilir (http://localhost:5173).' : error}</p>
    </>
  );
  if (!list) return null;
  return (
    <>
      <label>Borsalar (kripto)</label>
      <p className="muted small">Anahtarları ÇEKİM izni kapalı oluşturun; bakiye görmek için "okuma" yetkisi yeterli. Anahtarlar yalnızca bu bilgisayara kaydedilir, sohbete yazmayın.</p>
      <div className="ext-boxes">
        {list.map(e => {
          const fields = keys.filter(f => f.borsa === e.id);
          const r = result[e.id];
          return (
            <details key={e.id} className="ext-box borsa-card">
              <summary>
                <span>{LOGO[e.id] ?? '🏦'} <b>{e.ad}</b>{e.deneysel ? ' · deneysel' : ''}</span>
                <em className={e.hazir ? 'ok' : 'muted'}>{e.hazir ? 'anahtar kayıtlı' : 'anahtar yok'}</em>
              </summary>
              {e.not && <p className="muted small">{e.not}</p>}
              {fields.map(f => (
                <div key={f.name} className="key-row">
                  <div className="key-head"><span>{f.label}</span><em className={f.set ? 'ok' : ''}>{f.set ? (f.secret ? `kayıtlı ${f.value}` : 'kayıtlı') : 'boş'}</em></div>
                  <div className="key-input">
                    <input
                      type={f.secret && !shown.has(f.name) ? 'password' : 'text'} autoComplete="off" spellCheck={false}
                      value={draft[f.name] ?? (f.secret ? '' : f.value)}
                      placeholder={f.secret ? (f.set ? 'Değiştirmek için yenisini yapıştırın' : 'Buraya yapıştırın (Ctrl+V)') : ''}
                      onChange={ev => setDraft(d => ({ ...d, [f.name]: ev.target.value }))}
                    />
                    {f.secret && <button type="button" onClick={() => setShown(s => { const n = new Set(s); n.has(f.name) ? n.delete(f.name) : n.add(f.name); return n; })}>{shown.has(f.name) ? 'gizle' : 'göster'}</button>}
                  </div>
                  <div className="key-foot">
                    <p className="muted small">{f.hint}</p>
                    {f.set && f.secret && draft[f.name] !== '' && <button onClick={() => setDraft(d => ({ ...d, [f.name]: '' }))}>Sil</button>}
                    {draft[f.name] === '' && f.set && <em className="warn">silinecek</em>}
                  </div>
                </div>
              ))}
              <div className="seg">
                <button onClick={() => save(e.id)}>Kaydet</button>
                <button disabled={!e.hazir || busy === e.id} onClick={() => test(e.id)}>{busy === e.id ? 'Bağlanıyor…' : 'Bağlantıyı test et'}</button>
              </div>
              {r?.hata && <p className="warn small">⚠️ {r.hata}</p>}
              {r?.bakiye && (r.bakiye.length
                ? <div className="borsa-bakiye">{r.bakiye.map(b => <p key={b.varlik} className="small"><b>{b.varlik}</b> {fmt(b.serbest)}{b.kilitli ? ` · emirde ${fmt(b.kilitli)}` : ''}</p>)}</div>
                : <p className="small">✅ Bağlantı çalışıyor · bakiye boş</p>)}
            </details>
          );
        })}
      </div>
    </>
  );
}
