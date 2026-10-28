import { useEffect, useState } from 'react';
import { deleteTgChannel, getTgChannels, openMiniApp, openTelegramWeb, saveTgChannel, type TgChannelView } from '../lib/api';

const ago = (iso?: string) => {
  if (!iso) return 'henüz okunmadı';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${s} sn önce` : s < 3600 ? `${Math.round(s / 60)} dk önce` : new Date(iso).toLocaleString('tr-TR');
};
const linkify = (t: string) => t.split(/(https?:\/\/[^\s]+)/g).map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p}</a> : p));

/** Ayarlar → Telegram kanalları: herkese açık kanalları canlı izleme (t.me/s önizlemesi), son mesajlar, bildirim */
export function TgChannelSettings({ flash }: { flash(t: string): void }) {
  const [list, setList] = useState<TgChannelView[] | null>(null);
  const [yeni, setYeni] = useState('');
  const [kelime, setKelime] = useState<Record<string, string>>({});
  const load = () => getTgChannels().then(r => setList(r.kanallar)).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);
  if (!list) return null;
  const upd = (b: Parameters<typeof saveTgChannel>[0], ok?: string) => saveTgChannel(b).then(r => { setList(r.kanallar); if (ok) flash(ok); }).catch(e => flash(e.message));
  return (
    <>
      <label>Telegram kanalları · canlı veri</label>
      <p className="muted small">Herkese açık kanalların mesajları dakikada bir okunur; Jarvis'e "Alpha finans kanalında ne var?", "kanaldaki son veriler" diye sorabilirsiniz. Kanal verisi üçüncü kişi bilgisidir, yatırım tavsiyesi değildir; robot buna göre kendiliğinden işlem yapmaz.</p>
      <p className="small">Özel / önizlemesi kapalı kanallar ve bot mini uygulamaları (ör. derinlik) için Jarvis kendi Chrome penceresinde Telegram Web kullanır. Telegram Masaüstü uygulamasını dışarıdan bir program yönetemez. Bir kez giriş: pencerede çıkan QR kodu telefondaki Telegram → Ayarlar → Cihazlar → "Masaüstü cihazı bağla" ile okutun.</p>
      <div className="seg">
        <button onClick={() => openTelegramWeb().then(r => flash(r.girisli ? 'Telegram Web hazır' : 'Jarvis\'in Chrome penceresinde QR kodu telefonla okutun')).catch(e => flash(e.message))}>🌐 Telegram Web'i aç (giriş)</button>
        <button onClick={() => { flash('Derinlik uygulaması açılıyor…'); openMiniApp('ucretsizderinlikbot').then(r => flash(r.acildi ? 'Derinlik uygulaması açıldı; Jarvis\'e "THYAO derinliği" diye sorabilirsiniz' : 'Pencerede "Aç / Başlat"a basın')).catch(e => flash(e.message)); }}>📊 Derinlik uygulamasını aç</button>
      </div>
      <div className="seg">
        <input className="ext-input" value={yeni} onChange={e => setYeni(e.target.value)} placeholder="Kanal adı ya da https://t.me/… linki" />
        <button className="on" disabled={!yeni.trim()} onClick={() => upd({ kanal: yeni }, 'Kanal eklendi').then(() => setYeni(''))}>+ Takip et</button>
      </div>
      <div className="ext-boxes">
        {list.map(c => (
          <details key={c.ad} className="ext-box">
            <summary>
              <span>📡 <b>{c.baslik || c.ad}</b> · @{c.ad}</span>
              <em className={c.hata ? 'warn' : 'ok'}>{c.hata ? `hata: ${c.hata}` : `${c.mesajSayisi} mesaj · ${ago(c.sonKontrol)}`}</em>
            </summary>
            <div className="seg">
              <button className={c.bildir ? 'on' : ''} onClick={() => upd({ kanal: c.ad, bildir: !c.bildir }, c.bildir ? 'Bildirim kapatıldı' : 'Yeni mesajlar Telegram/WhatsApp\'a gelecek')}>{c.bildir ? '🔔 Bildirim açık' : '🔕 Bildirim kapalı'}</button>
              <select value={c.aralikSn} onChange={e => upd({ kanal: c.ad, aralikSn: Number(e.target.value) })}>
                {[30, 60, 300, 900, 3600].map(s => <option key={s} value={s}>{s < 60 ? `${s} sn` : `${s / 60} dk`}'da bir</option>)}
              </select>
              <a className="toggle" href={`https://t.me/${c.ad}`} target="_blank" rel="noopener noreferrer">Kanalı aç</a>
              <button aria-label="Kaldır" onClick={() => confirm(`@${c.ad} takipten çıkarılsın mı?`) && deleteTgChannel(c.ad).then(r => setList(r.kanallar))}>✕</button>
            </div>
            {c.bildir && (
              <div className="seg">
                <input className="ext-input" value={kelime[c.ad] ?? c.kelimeler.join(', ')} onChange={e => setKelime(k => ({ ...k, [c.ad]: e.target.value }))} placeholder="Yalnız şu kelimeler geçince bildir (boş: her mesaj), ör. THYAO, altın" />
                <button onClick={() => upd({ kanal: c.ad, kelimeler: (kelime[c.ad] ?? '').split(',').map(s => s.trim()).filter(Boolean) }, 'Kelimeler kaydedildi')}>💾</button>
              </div>
            )}
            {c.son.map(m => (
              <div key={m.id} className="small" style={{ borderTop: '1px solid color-mix(in srgb, currentColor 15%, transparent)', padding: '6px 0' }}>
                <span className="muted">{new Date(m.tarih).toLocaleString('tr-TR')}{m.gorsel ? ' · 🖼️' : ''}{m.goruntulenme ? ` · 👁 ${m.goruntulenme}` : ''} · <a href={m.link} target="_blank" rel="noopener noreferrer">aç</a></span>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{linkify(m.metin) || '(yalnız görsel)'}</div>
              </div>
            ))}
          </details>
        ))}
      </div>
    </>
  );
}
