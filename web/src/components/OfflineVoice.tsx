import { useEffect, useState } from 'react';
import { offlineVoice, type OfflineVoiceState } from '../lib/api';

/** Ayarlar → İnternetsiz ses: Piper Türkçe sesi kur, önceliğe al; Jarvis'in ses dosyalarını İndirilenler'e kaydet */
export function OfflineVoice({ flash }: { flash(t: string): void }) {
  const [st, setSt] = useState<OfflineVoiceState | null>(null);
  useEffect(() => { offlineVoice('').then(setSt).catch(() => {}); }, []);
  if (!st) return null;
  return (
    <>
      <label>İnternetsiz ses {st.kurulu ? '· ✅ kurulu' : ''}</label>
      <p className="muted small">Bilgisayarda çalışan Türkçe ses (Piper): anahtar, kredi ya da internet gerektirmez. Asıl ses alınamazsa Jarvis bu sesle konuşur.</p>
      <div className="seg">
        {!st.kurulu && <button onClick={() => offlineVoice('kur').then(r => flash(r.onay_bekliyor ? 'Ekrandaki onay kartından kurulumu onaylayın (≈90 MB)' : 'Zaten kurulu')).catch(e => flash(e.message))}>⬇️ Bilgisayara indir ve kur</button>}
        {st.kurulu && <button className={st.oncelik ? 'on' : ''} onClick={() => offlineVoice('oncelik', { ac: !st.oncelik }).then(r => { setSt(r); flash(r.oncelik ? 'Jarvis artık hep internetsiz sesle konuşacak' : 'Asıl ses kullanılacak; yalnız alınamazsa internetsiz ses'); }).catch(e => flash(e.message))}>{st.oncelik ? '✅' : '⬜'} Hep internetsiz sesle konuş</button>}
        <button onClick={() => offlineVoice('kaydet').then(r => flash(`Kaydedildi: ${r.ornek} örnek kayıt, ${r.konusma} konuşma → ${r.klasor}`)).catch(e => flash(e.message))}>💾 Ses dosyalarını İndirilenler'e kaydet</button>
      </div>
    </>
  );
}
