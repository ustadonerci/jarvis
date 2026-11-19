import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { getMsgSenders, type MsgSender } from '../lib/api';
import type { MesajFiltre } from '../lib/types';

const fold = (s: string) => s.toLocaleLowerCase('tr').normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * Ana ekrandaki "💬 Mesajlar" başlığına tıklayınca açılan pencere: son 60 günde yazan kişiler ve gruplar listelenir,
 * işaretlenenlerin mesajları kartta görünür. Hiçbiri işaretli değilse herkes görünür.
 */
export function MessageFilter({ filtre, onSave, onClose }: { filtre?: MesajFiltre; onSave(kisiler: string[]): void; onClose(): void }) {
  const [list, setList] = useState<MsgSender[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [secili, setSecili] = useState<string[]>(() => filtre?.kisiler ?? []);
  useEffect(() => { getMsgSenders().then(r => setList(r.kisiler)).catch(e => setErr(e.message)); }, []);

  // Kayıtlı filtre ad parçası olabilir ("Hatun" → "Hatun Teyze"): listedeki adla eşleşen işaretli sayılır
  const isOn = (ad: string) => secili.some(k => fold(ad).includes(fold(k)));
  const toggle = (ad: string) => setSecili(s => (isOn(ad) ? s.filter(k => !fold(ad).includes(fold(k))) : [...s, ad]));
  // Listede olmayan (henüz yazmamış) ama kayıtlı kişiler de görünsün
  const extra = useMemo(() => secili.filter(k => !(list ?? []).some(x => fold(x.ad).includes(fold(k)))), [secili, list]);
  const shown = (list ?? []).filter(x => !q || fold(x.ad).includes(fold(q)));

  return createPortal(
    <div className="live-sheet-bg" onClick={onClose}>
      <div className="msgf" onClick={e => e.stopPropagation()}>
        <div className="msgf-head">
          <b>💬 Ekranda kimin mesajları görünsün?</b>
          <button className="live-sheet-x" onClick={onClose} aria-label="Kapat">✕</button>
        </div>
        <p className="muted small">İşaretlediklerinizin mesajları ana ekranda görünür. Hiçbirini işaretlemezseniz herkesinki görünür.</p>
        <input className="msgf-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Kişi ya da grup ara…" />
        <div className="seg">
          <button className={secili.length === 0 ? 'on' : ''} onClick={() => setSecili([])}>👥 Herkes</button>
          <span className="muted small">{secili.length ? `${secili.length} seçili` : 'filtre yok'}</span>
        </div>
        {err && <p className="warn small">{err}</p>}
        {!list && !err && <p className="muted small">yükleniyor…</p>}
        <ul className="msgf-list">
          {extra.map(k => (
            <li key={`x-${k}`} className="on" onClick={() => toggle(k)}>
              <span className="msgf-ck">✅</span><span className="msgf-ad">{k}</span><span className="muted small">son 60 günde mesaj yok</span>
            </li>
          ))}
          {shown.map(x => (
            <li key={`${x.platform}-${x.grup ? 'g' : 'k'}-${x.ad}`} className={isOn(x.ad) ? 'on' : ''} onClick={() => toggle(x.ad)}>
              <span className="msgf-ck">{isOn(x.ad) ? '✅' : '⬜'}</span>
              <span className="msgf-ad">{x.platform === 'whatsapp' ? '🟢' : '🔵'} {x.grup ? '👥 ' : ''}{x.ad}</span>
              <span className="muted small">{x.adet} mesaj</span>
            </li>
          ))}
          {list && !shown.length && !extra.length && <li className="muted small">Kimse bulunamadı</li>}
        </ul>
        <div className="seg">
          <button className="on" onClick={() => { onSave(secili); onClose(); }}>💾 Kaydet</button>
          <button onClick={onClose}>Vazgeç</button>
        </div>
      </div>
    </div>
  , document.body);
}
