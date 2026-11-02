import { useEffect, useRef, useState } from 'react';
import type { Ekran, Kart } from '../../lib/types';

/**
 * Ana ekranda fareyle ya da dokunarak boyutlandırma (pointer olayları: fare, kalem, parmak):
 *  - her yan sütunda iki kartın arasındaki çizgi sürüklenince kartların yüksekliği değişir,
 *  - yan sütunların iç kenarı sürüklenince panel genişliği değişir.
 * Sürüklerken ekran anında değişir (setLocal), bırakınca sunucuya kaydedilir (commit) ve diğer cihazlara da geçer.
 */
type Patch = Partial<Ekran>;
interface Pos { split: { left?: number; right?: number }; edge: { left?: number; right?: number }; top: number; height: number }

const COLS: { side: 'left' | 'right'; top: Kart; bottom: Kart }[] = [
  { side: 'left', top: 'hava', bottom: 'sistem' },
  { side: 'right', top: 'piyasa', bottom: 'gundem' },
];

export function DashResizers({ ekran, setLocal, commit }: { ekran: Ekran; setLocal(p: Patch): void; commit(p: Patch): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const zoom = ekran.genel || 1;

  // Tutamaçların yeri: kartların gerçek konumundan (pencere, kart ya da yazı boyutu değişince yeniden ölçülür)
  useEffect(() => {
    const stage = ref.current?.parentElement;
    if (!stage) return;
    const measure = () => {
      const s = stage.getBoundingClientRect();
      const p: Pos = { split: {}, edge: {}, top: 0, height: s.height / zoom };
      for (const c of COLS) {
        const col = stage.querySelector<HTMLElement>(`.dash-col.${c.side}`);
        if (!col || getComputedStyle(col).display === 'none') continue;
        const r = col.getBoundingClientRect();
        const kids = [...col.children] as HTMLElement[];
        if (kids.length >= 2 && getComputedStyle(kids[0]).display !== 'none' && getComputedStyle(kids[1]).display !== 'none') {
          const a = kids[0].getBoundingClientRect(), b = kids[1].getBoundingClientRect();
          p.split[c.side] = ((a.bottom + b.top) / 2 - s.top) / zoom;
        }
        p.edge[c.side] = ((c.side === 'left' ? r.right : r.left) - s.left) / zoom;
        p.top = (r.top - s.top) / zoom;
        p.height = r.height / zoom;
      }
      setPos(p);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    stage.querySelectorAll('.dash-col, .dash-col > *').forEach(el => ro.observe(el));
    const t = setInterval(measure, 2000); // kart içerikleri sonradan yüklenince
    return () => { ro.disconnect(); clearInterval(t); };
  }, [zoom, ekran.paneller, ekran.panel, ekran.kartlar]);

  /** Sürükleme: başlangıçta ölçer, hareket ettikçe hesaplar; bırakınca kaydeder */
  const drag = (e: React.PointerEvent, onMove: (dx: number, dy: number) => Patch) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
    const x0 = e.clientX, y0 = e.clientY;
    let last: Patch = {};
    const move = (ev: PointerEvent) => { last = onMove(ev.clientX - x0, ev.clientY - y0); setLocal(last); };
    const up = () => {
      el.classList.remove('active');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (Object.keys(last).length) commit(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const startSplit = (e: React.PointerEvent, c: (typeof COLS)[number]) => {
    const col = ref.current?.parentElement?.querySelector<HTMLElement>(`.dash-col.${c.side}`);
    const kids = col ? ([...col.children] as HTMLElement[]) : [];
    if (kids.length < 2) return;
    const h1 = kids[0].getBoundingClientRect().height, h2 = kids[1].getBoundingClientRect().height;
    const min = 70 * zoom;
    drag(e, (_dx, dy) => {
      const a = Math.max(min, Math.min(h1 + h2 - min, h1 + dy)), b = h1 + h2 - a;
      // Ağırlıklar: üst kart 1×, alt kart 1,6× (CSS) — toplam 2 olacak şekilde
      const kt = Math.round((2 * a / (a + b)) * 100) / 100, kb = Math.round(((2 * b / (a + b)) / 1.6) * 100) / 100;
      return { kartlar: { ...ekran.kartlar, [c.top]: Math.max(0.05, kt), [c.bottom]: Math.max(0.05, kb) } };
    });
  };

  const startEdge = (e: React.PointerEvent, side: 'left' | 'right') => {
    const p0 = ekran.panel;
    drag(e, dx => {
      const base = side === 'left' ? 310 : 340;
      const d = (side === 'left' ? dx : -dx) / zoom;
      return { panel: Math.round(Math.min(1.5, Math.max(0.7, p0 + d / base)) * 100) / 100 };
    });
  };

  return (
    <div ref={ref} className="dash-resizers" aria-hidden="true">
      {pos && COLS.map(c => pos.split[c.side] !== undefined && (
        <div key={'s' + c.side} className={`rz-split rz-${c.side}`} style={{ top: pos.split[c.side]! - 8 }}
          title="Sürükleyerek kartların boyunu değiştirin" onPointerDown={e => startSplit(e, c)} onDoubleClick={() => commit({ kartlar: { ...ekran.kartlar, [c.top]: 1, [c.bottom]: 1 } })}><i /></div>
      ))}
      {pos && (['left', 'right'] as const).map(side => pos.edge[side] !== undefined && (
        <div key={'e' + side} className="rz-edge" style={{ left: pos.edge[side]! + (side === 'left' ? 3 : -11), top: pos.top, height: pos.height }}
          title="Sürükleyerek panel genişliğini değiştirin" onPointerDown={e => startEdge(e, side)} onDoubleClick={() => commit({ panel: 1 })}><i /></div>
      ))}
    </div>
  );
}

/** Telefonda: iki parmakla çekirdeği büyütüp küçültme (sıkıştırma hareketi) */
export function usePinch(ekran: Ekran, setLocal: (p: Patch) => void, commit: (p: Patch) => void) {
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ d: number; v: number } | null>(null);
  const last = useRef<number | null>(null);
  const dist = () => { const [a, b] = [...pts.current.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.current.size === 2) start.current = { d: dist(), v: ekran.cekirdek };
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!pts.current.has(e.pointerId)) return;
      pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.current.size === 2 && start.current) {
        const v = Math.round(Math.min(1.6, Math.max(0.5, start.current.v * (dist() / start.current.d))) * 100) / 100;
        last.current = v;
        setLocal({ cekirdek: v });
      }
    },
    onPointerUp: (e: React.PointerEvent) => {
      pts.current.delete(e.pointerId);
      if (pts.current.size < 2 && start.current) {
        start.current = null;
        if (last.current !== null) commit({ cekirdek: last.current });
        last.current = null;
      }
    },
  };
}
