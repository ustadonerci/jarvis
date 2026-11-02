import { useRef, useState } from 'react';
import { fmt } from '../../lib/format';
import type { MesaiData, PortfolioData, RecentMsg } from '../../lib/api';

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
function HoldingAdd({ onAdd }: { onAdd(sembol: string, adet: number, maliyet: number): void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button className="pf-plus" onClick={() => setOpen(true)} title="Portföye ekle">＋ Ekle</button>;
  const num = (v: FormDataEntryValue | null) => Number(String(v ?? '').replace(/\./g, '').replace(',', '.'));
  return (
    <form className="pf-add-mini" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); const s = String(f.get('s') ?? '').trim(); if (s && num(f.get('a')) > 0) { onAdd(s, num(f.get('a')), num(f.get('m')) || 0); setOpen(false); } }}>
      <input name="s" placeholder="THYAO, BTC…" autoFocus />
      <input name="a" placeholder="Adet" inputMode="decimal" />
      <input name="m" placeholder="Maliyet ₺" inputMode="decimal" />
      <button type="submit">✓</button>
      <button type="button" onClick={() => setOpen(false)}>✕</button>
    </form>
  );
}

export function PortfolioBox({ p, limit = 3, onAdd }: { p: PortfolioData | null; limit?: number; onAdd?(sembol: string, adet: number, maliyet: number): void }) {
  if (!p) return null;
  if (p.bos || !p.varliklar?.length) return <div className="pf-box pf-empty">💼 Portföy boş {onAdd ? <HoldingAdd onAdd={onAdd} /> : "· Ayarlar → Portföy'den ekleyin"}</div>;
  const list = [...p.varliklar].sort((a, b) => (b.deger_tl ?? 0) - (a.deger_tl ?? 0)).slice(0, limit);
  return (
    <div className="pf-box">
      <div className="pf-head">
        <span className="pf-title">💼 Portföyüm {onAdd && <HoldingAdd onAdd={onAdd} />}</span>
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
const SHEET_KEY = 'jarvis.sayfaYuksekligi';
export function LiveSheet({ open, onClose, portfoy, mesajlar, okunmamis, mesai, onAddMesai, onAddHolding }: { open: '' | 'portfoy' | 'mesaj' | 'mesai'; onClose(): void; portfoy: PortfolioData | null; mesajlar: RecentMsg[] | null; okunmamis: number; mesai: MesaiData | null; onAddMesai(saat: number): void; onAddHolding?(sembol: string, adet: number, maliyet: number): void }) {
  // Üstteki tutamaç parmakla/fareyle sürüklenerek sayfa büyür/küçülür (aşağı çok çekilirse kapanır); yükseklik hatırlanır
  const [h, setH] = useState(() => { try { return Number(localStorage.getItem(SHEET_KEY)) || 60; } catch { return 60; } });
  const drag = useRef<{ y: number; h: number } | null>(null);
  if (!open) return null;
  const vh = window.innerHeight / 100;
  return (
    <div className="live-sheet-bg" onClick={onClose}>
      <div className="live-sheet" style={{ height: `${h}dvh` }} onClick={e => e.stopPropagation()}>
        <div className="live-sheet-grip"
          onPointerDown={e => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { y: e.clientY, h }; }}
          onPointerMove={e => { if (drag.current) setH(Math.min(92, Math.max(20, drag.current.h - (e.clientY - drag.current.y) / vh))); }}
          onPointerUp={() => { drag.current = null; if (h <= 22) onClose(); try { localStorage.setItem(SHEET_KEY, String(Math.max(30, Math.round(h)))); } catch { /* yok */ } }}
          onPointerCancel={() => { drag.current = null; }}><i /></div>
        <button className="live-sheet-x" onClick={onClose} aria-label="Kapat">✕</button>
        {open === 'portfoy' ? <PortfolioBox p={portfoy} limit={12} onAdd={onAddHolding} /> : open === 'mesai' ? <MesaiBox m={mesai} onAdd={onAddMesai} limit={31} /> : <MessagesBox list={mesajlar} unread={okunmamis} limit={15} />}
      </div>
    </div>
  );
}

/** Fazla mesai kartı (Piyasalar kartında portföyün altında; telefonda ⏱️ düğmesiyle) */
export function MesaiBox({ m, onAdd, limit = 2 }: { m: MesaiData | null; onAdd?(saat: number): void; limit?: number }) {
  if (!m) return null;
  const add = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const inp = e.currentTarget.elements.namedItem('saat') as HTMLInputElement;
    const v = Number(inp.value.replace(',', '.'));
    if (v > 0) { onAdd?.(v); inp.value = ''; }
  };
  return (
    <div className="ms-box">
      <div className="ms-head">
        <span className="ms-title">⏱️ Fazla mesai · {m.ay_adi}</span>
        <b className="ms-total">₺{fmt(m.toplam_tutar, 0)}</b>
        <span className="ms-sub">{fmt(m.toplam_saat, 1)} saat · {m.gun} gün · saati ₺{fmt(m.saatlik, 0)}</span>
      </div>
      {m.kayitlar.length > 0 && (
        <ul className="ms-list">
          {m.kayitlar.slice(0, limit).map(k => (
            <li key={k.id}><span className="ms-date">{k.tarih.slice(8, 10)}.{k.tarih.slice(5, 7)}</span><span className="ms-h">{fmt(k.saat, 1)} sa</span><span className="ms-amt">₺{fmt(k.tutar, 0)}</span></li>
          ))}
        </ul>
      )}
      {onAdd && (
        <form className="ms-add" onSubmit={add}>
          <input name="saat" inputMode="decimal" placeholder="Bugün kaç saat?" aria-label="Mesai saati" />
          <button type="submit">+ Ekle</button>
        </form>
      )}
    </div>
  );
}
