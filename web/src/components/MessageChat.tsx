import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { getChat, sendChatReply, type ChatData } from '../lib/api';

const saat = (iso: string) => {
  const d = new Date(iso);
  const bugun = d.toDateString() === new Date().toDateString();
  return bugun ? d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/**
 * Ana ekranda bir mesaja (ya da yeni mesaj bildirimine) tıklayınca açılan sohbet penceresi:
 * o kişinin/grubun son mesajları görünür, gelenler okundu sayılır, kullanıcı isterse kendi cevabını yazıp gönderir.
 */
export function MessageChat({ id, onClose, onChanged }: { id: string; onClose(): void; /** Okundu/gönderildi: ana ekrandaki liste yenilensin */ onChanged?(): void }) {
  const [data, setData] = useState<ChatData | null>(null);
  const [err, setErr] = useState('');
  const [metin, setMetin] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const load = () => getChat(id).then(d => { setData(d); setErr(''); onChanged?.(); }).catch(e => setErr(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [id]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [data]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const send = async () => {
    const t = metin.trim();
    if (!t || busy) return;
    setBusy(true); setNote('');
    try { await sendChatReply(id, t); setMetin(''); setNote('✓ Gönderildi'); await load(); }
    catch (e) { setNote(`Gönderilemedi: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  return createPortal(
    <div className="live-sheet-bg" onClick={onClose}>
      <div className="msgc" onClick={e => e.stopPropagation()} role="dialog" aria-label="Sohbet">
        <div className="msgf-head">
          <b>{data ? `${data.platform === 'whatsapp' ? '🟢' : data.platform === 'telegram' ? '🔵' : '📞'} ${data.grup ? '👥 ' : ''}${data.ad}` : '💬 Sohbet'}</b>
          <button className="live-sheet-x" onClick={onClose} aria-label="Kapat">✕</button>
        </div>
        <div className="msgc-list">
          {err && <div className="msg-empty">{err}</div>}
          {!data && !err && <div className="msg-empty">Yükleniyor…</div>}
          {data?.mesajlar.map(m => (
            <div key={m.id} className={`msgc-b ${m.gelen ? 'in' : 'out'}`}>
              {data.grup && m.gelen && <i className="msgc-who">{m.kisi}</i>}
              <span className="msgc-t">{m.arama ? '📞 aradı' : m.metin}</span>
              <span className="msgc-at">{m.otomatik ? '🤖 ' : ''}{saat(m.at)}</span>
            </div>
          ))}
          <div ref={end} />
        </div>
        {data && data.platform !== 'telefon' && (
          data.cevaplanabilir ? (
            <form className="msgc-send" onSubmit={e => { e.preventDefault(); send(); }}>
              <textarea value={metin} onChange={e => setMetin(e.target.value)} placeholder="Cevabınızı yazın…" rows={2}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button type="submit" disabled={busy || !metin.trim()}>{busy ? '…' : '➤ Gönder'}</button>
            </form>
          ) : <div className="msgc-note">{data.platform === 'whatsapp' ? 'WhatsApp' : 'Telegram'} şu an bağlı değil; buradan cevap yazılamıyor.</div>
        )}
        {note && <div className="msgc-note">{note}</div>}
      </div>
    </div>
  , document.body);
}
