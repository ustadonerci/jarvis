import { useEffect, useState, type MutableRefObject } from 'react';
import { checkWindowsMic, openMicSettings, type MicReport } from '../lib/api';
import type { Conversation, ConvStats } from '../lib/conversation';

const HATA: Record<string, string> = {
  'not-allowed': 'Tarayıcı mikrofon iznini vermedi: adres çubuğundaki kilit/mikrofon simgesinden "İzin ver" seçin, sayfayı yenileyin.',
  'service-not-allowed': 'Tarayıcı ses tanımaya izin vermedi (Chrome ya da Edge kullanın).',
  'audio-capture': 'Mikrofon bulunamadı: Windows\'ta mikrofon takılı ve etkin olmalı.',
  network: 'Ses tanıma internete ulaşamadı (Chrome/Edge sesi Google/Microsoft sunucusunda yazıya çevirir): internet bağlantısını kontrol edin.',
  'language-not-supported': 'Bu tarayıcı Türkçe ses tanımayı desteklemiyor: Chrome ya da Edge kullanın.',
};

/**
 * Sohbet modu sorun giderme: tanıma çalışıyor mu, en son ne duydu, son hata; Windows'un varsayılan kayıt cihazı
 * (sohbet modu tarayıcının ses tanımasını kullanır ve o da HER ZAMAN Windows'un varsayılan mikrofonunu dinler —
 * Ayarlar → Mikrofon · test'te seçilen mikrofonu değil).
 */
export function ConvDiagnostics({ conv, flash }: { conv: MutableRefObject<Conversation | null>; flash(t: string): void }) {
  const [st, setSt] = useState<ConvStats | null>(null);
  const [win, setWin] = useState<MicReport | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setSt(conv.current ? { ...conv.current.stats } : null), 700);
    return () => clearInterval(t);
  }, [conv]);
  const ago = (t: number) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} sn önce` : '');
  const check = () => { setBusy(true); checkWindowsMic().then(setWin).catch(e => flash(e.message)).finally(() => setBusy(false)); };
  const def = win?.cihazlar.find(c => c.varsayilan);
  return (
    <div className="mic-result">
      <p className="small"><b>Jarvis beni duyuyor mu?</b> Şimdi bir şey söyleyin; aşağıda duyduğu yazı belirmeli.</p>
      <p className="small">🎙️ Son duyulan: <b>{st?.sonDuyulan ? `“${st.sonDuyulan}” (${ago(st.sonDuyulanAt)})` : 'henüz hiçbir şey duymadı'}</b></p>
      <p className="muted small">Ses tanıma {st?.basladi ? `çalışıyor (${st.basladi} kez başladı, ${st.sonuc} sonuç)` : 'başlamadı'}</p>
      {st?.sonHata && <p className="warn small">⚠️ Son hata ({ago(st.sonHataAt)}): {HATA[st.sonHata] ?? st.sonHata}</p>}
      <p className="small">Sohbet modu <b>Windows'un varsayılan mikrofonunu</b> dinler (yukarıdaki "Mikrofon · test"te seçtiğinizi değil). Hiçbir şey duymuyorsa ya da söylemediğiniz şeyleri duyuyorsa varsayılan cihaz yanlıştır.</p>
      <div className="seg">
        <button disabled={busy} onClick={check}>{busy ? 'Okunuyor…' : '🖥️ Windows varsayılan mikrofonunu kontrol et'}</button>
        <button onClick={() => openMicSettings('kayit').then(() => flash('Windows Ses → Kayıt açıldı: mikrofonunuza sağ tıklayıp "Varsayılan Cihaz Olarak Ayarla" deyin')).catch(e => flash(e.message))}>Kayıt ayarlarını aç</button>
      </div>
      {win && (win.windows ? (
        <>
          <p className={def?.supheli || !def ? 'warn small' : 'small'}>
            {def ? `Varsayılan kayıt cihazı: ${def.ad}${def.supheli ? ' — BU BİR MİKROFON DEĞİL, bilgisayarın kendi sesini kaydeder. Jarvis sizi duyamaz.' : ' ✓'}` : 'Varsayılan kayıt cihazı bulunamadı.'}
          </p>
          {win.sorunlar.map((x, i) => <p key={i} className="warn small">⚠️ {x}</p>)}
          {(def?.supheli || win.sorunlar.length > 0) && win.oneriler.map((x, i) => <p key={`o${i}`} className="small">👉 {x}</p>)}
        </>
      ) : <p className="muted small">{win.oneriler[0]}</p>)}
    </div>
  );
}
