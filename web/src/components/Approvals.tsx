import { useEffect, useState } from 'react';
import { decideAction, getActions, type ActionView } from '../lib/api';

const TUR = { komut: 'Bilgisayarda komut', uygulama: 'Uygulama', paylasim: 'Paylaşım', webhook: 'İş akışı (webhook)', kod: "Jarvis'in kendi kodu", arama: 'Telefon araması' } as const;

/**
 * Onay kartları: Jarvis'in önerdiği riskli işlemler (komut, uygulama kurma, paylaşım, webhook, kod değişikliği)
 * burada birebir gösterilir ve yalnızca "Çalıştır" ile yürütülür. Onay yetkisi olmayan cihazlarda (ör. telefon,
 * ACCESS_TOKEN yoksa) görünmez. version: SSE "onay" olayıyla artar.
 */
export function ApprovalCards({ version }: { version: number }) {
  const [list, setList] = useState<ActionView[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(() => { getActions().then(r => setList(r.islemler)).catch(() => setList([])); }, [version]);

  const decide = (id: string, onay: boolean) => {
    setList(l => l.map(a => (a.id === id ? { ...a, durum: onay ? 'calisiyor' : 'reddedildi' } : a)));
    decideAction(id, onay).then(a => setList(l => l.map(x => (x.id === id ? a : x)))).catch(() => {});
  };
  // Bekleyenler ve son 2 dakikada biten (sonucu görülsün diye) kartlar
  const shown = list.filter(a => !hidden.has(a.id) && (a.durum === 'bekliyor' || a.durum === 'calisiyor' || (a.bitti && Date.now() - Date.parse(a.bitti) < 120_000)));
  if (!shown.length) return null;
  return (
    <div className="approvals">
      {shown.map(a => (
        <div key={a.id} className={`approval ${a.durum}`}>
          <div className="approval-head">
            <i className="tag">{TUR[a.tur]}</i>
            <b>{a.baslik}</b>
            {a.durum !== 'bekliyor' && a.durum !== 'calisiyor' && <button className="close" aria-label="Kapat" onClick={() => setHidden(h => new Set(h).add(a.id))}>✕</button>}
          </div>
          {a.aciklama && <p className="small">{a.aciklama}</p>}
          <pre className={a.tur === 'kod' ? 'diff' : ''}>{a.tur === 'kod'
            ? a.ayrinti.split('\n').map((l, i) => <span key={i} className={l.startsWith('+ ') ? 'add' : l.startsWith('- ') ? 'del' : ''}>{l}{'\n'}</span>)
            : a.ayrinti}</pre>
          {a.durum === 'bekliyor' ? (
            <>
              <p className="small warn">Bu işlemi Jarvis önerdi. Ne yaptığından emin değilseniz reddedin.</p>
              <div className="seg">
                <button className="on" onClick={() => decide(a.id, true)}>Çalıştır</button>
                <button onClick={() => decide(a.id, false)}>Reddet</button>
              </div>
            </>
          ) : a.durum === 'calisiyor' ? <p className="small muted">çalışıyor…</p> : (
            <>
              <p className={`small ${a.durum === 'tamam' ? 'up' : a.durum === 'hata' ? 'down' : 'muted'}`}>{{ tamam: '✓ Tamamlandı', hata: '✕ Hata', reddedildi: 'Reddedildi', dustu: 'Süresi doldu' }[a.durum]}</p>
              {a.sonuc && <pre className="result">{a.sonuc.slice(-3000)}</pre>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
