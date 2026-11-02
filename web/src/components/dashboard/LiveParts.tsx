import { fmt } from '../../lib/format';
import type { PortfolioData, RecentMsg } from '../../lib/api';

/** Göreli zaman: "şimdi", "5 dk", "2 sa", "dün" */
export function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m) || m < 1) return 'şimdi';
  if (m < 60) return `${m} dk`;
  if (m < 24 * 60) return `${Math.round(m / 60)} sa`;
  return m < 48 * 60 ? 'dün' : `${Math.round(m / 1440)} g`;
}
const sign = (n?: number) => (n === undefined ? '' : n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const tl = (n?: number, d = 0) => (n === undefined ? '—' : `₺${fmt(n, d)}`);

/** Portföy özeti (Piyasalar kartının içinde ve telefondaki sayfada) */
export function PortfolioBox({ p, limit = 3 }: { p: PortfolioData | null; limit?: number }) {
  if (!p) return null;
  if (p.bos || !p.varliklar?.length) return <div className="pf-box pf-empty">💼 Portföy boş · Ayarlar → Portföy'den ekleyin</div>;
  const list = [...p.varliklar].sort((a, b) => (b.deger_tl ?? 0) - (a.deger_tl ?? 0)).slice(0, limit);
  return (
    <div className="pf-box">
      <div className="pf-head">
        <span className="pf-title">💼 Portföyüm</span>
        <b className="pfx-total">{tl(p.toplam_deger_tl)}</b>
        <span className={'pf-pl ' + sign(p.toplam_kar_tl)}>{(p.toplam_kar_tl ?? 0) >= 0 ? '▲' : '▼'} {tl(Math.abs(p.toplam_kar_tl ?? 0))} · %{fmt(Math.abs(p.toplam_kar_yuzde ?? 0), 1)}</span>
      </div>
      <ul className="pf-list">
        {list.map(h => (
          <li key={h.id}>
            <span className="pf-sym">{h.sembol.replace(/\.IS$|-USD$|=X$/, '')}</span>
            <span className="pf-val">{tl(h.deger_tl)}</span>
            <span className={'pf-chg ' + sign(h.gunluk_degisim ?? h.kar_yuzde)}>{(() => { const v = h.gunluk_degisim ?? h.kar_yuzde; return v === undefined ? '' : `${h.gunluk_degisim !== undefined ? 'bugün ' : ''}${v > 0 ? '▲' : v < 0 ? '▼' : ''} %${fmt(Math.abs(v), 1)}`; })()}</span>
            <i className="pf-bar" style={{ width: `${Math.min(100, h.agirlik_yuzde ?? 0)}%` }} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const ICON: Record<RecentMsg['platform'], string> = { whatsapp: '🟢', telegram: '🔵', telefon: '📞' };

/** Son gelen mesajlar (Gündem kartının içinde ve telefondaki sayfada) */
export function MessagesBox({ list, unread, limit = 5 }: { list: RecentMsg[] | null; unread: number; limit?: number }) {
  if (!list) return null;
  return (
    <div className="msg-box">
      <div className="msg-head"><span>💬 Mesajlar</span>{unread > 0 && <b className="msg-badge">{unread} yeni</b>}</div>
      {list.length === 0 ? <div className="msg-empty">Yeni mesaj yok</div> : (
        <ul className="msg-list">
          {list.slice(0, limit).map(m => (
            <li key={m.id} className={`msg-${m.platform}${m.okundu ? '' : ' unread'}`}>
              <span className="msg-ic">{m.arama ? '📞' : ICON[m.platform]}</span>
              <span className="msg-body"><b>{m.grup ? '👥 ' : ''}{m.kisi}</b><span>{m.arama ? 'aradı' : m.metin}</span></span>
              <span className="msg-at">{ago(m.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Telefonda: şeritteki 💼 / 💬 düğmesine dokununca alttan açılan sayfa */
export function LiveSheet({ open, onClose, portfoy, mesajlar, okunmamis }: { open: '' | 'portfoy' | 'mesaj'; onClose(): void; portfoy: PortfolioData | null; mesajlar: RecentMsg[] | null; okunmamis: number }) {
  if (!open) return null;
  return (
    <div className="live-sheet-bg" onClick={onClose}>
      <div className="live-sheet" onClick={e => e.stopPropagation()}>
        <button className="live-sheet-x" onClick={onClose} aria-label="Kapat">✕</button>
        {open === 'portfoy' ? <PortfolioBox p={portfoy} limit={12} /> : <MessagesBox list={mesajlar} unread={okunmamis} limit={15} />}
      </div>
    </div>
  );
}
