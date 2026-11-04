import { useEffect, useRef, useState } from 'react';
import { xttsAddOwnVoice, xttsInstall, xttsStatus, type XttsState } from '../lib/api';

/**
 * Ayarlar → XTTS: internetsiz çok sesli Türkçe ses. Kurulum (onay kartı) ve KENDİ sesinizi ekleme: 10-25 sn'lik net bir
 * kayıt (telefon ya da bilgisayar) yüklenir; Jarvis o sesle konuşur. Yalnızca kendi sesiniz ("Bu benim sesim" onayı).
 */
export function XttsSettings({ flash }: { flash(t: string): void }) {
  const [st, setSt] = useState<XttsState | null>(null);
  const [ad, setAd] = useState('Benim sesim');
  const [benim, setBenim] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const load = () => xttsStatus().then(setSt).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!st) return null;
  const upload = (f?: File) => {
    if (!f) return;
    setBusy(true);
    xttsAddOwnVoice(f, ad).then(r => { flash(`Kendi sesiniz eklendi ve Jarvis'in sesi yapıldı (${r.voice})`); load(); }).catch(e => flash(e.message)).finally(() => setBusy(false));
  };
  return (
    <>
      <label>XTTS · internetsiz çok sesli Türkçe {st.kurulu ? (st.acik ? '· ✅ açık' : '· kurulu (açılıyor…)') : ''}</label>
      <p className="muted small">Bilgisayarda çalışır, internet/anahtar gerekmez. Onlarca hazır yapay ses Ayarlar → Ses listesinde "XTTS" olarak görünür. Kendi sesinizi de ekleyebilirsiniz.</p>
      {!st.kurulu && <button onClick={() => xttsInstall().then(r => flash(r.onay_bekliyor ? 'Ekrandaki onay kartından kurulumu onaylayın (~3-4 GB, 10-30 dk)' : 'Zaten kurulu')).catch(e => flash(e.message))}>⬇️ XTTS'i kur</button>}
      {st.kurulu && (
        <>
          <p className="small"><b>Kendi sesimi ekle:</b> sessiz bir ortamda 10-25 saniye normal konuşun (telefonun ses kaydediciyle ya da bilgisayarda), dosyayı seçin.</p>
          <div className="row">
            <input value={ad} onChange={e => setAd(e.target.value)} placeholder="Sesin adı" style={{ flex: 1 }} />
          </div>
          <label className="small"><input type="checkbox" checked={benim} onChange={e => setBenim(e.target.checked)} /> Bu kayıt <b>benim kendi sesim</b> (başkasının sesi eklenemez)</label>
          <button className="save" disabled={!benim || busy || !st.acik} onClick={() => file.current?.click()}>{busy ? '⏳ Ekleniyor…' : '🎙️ Ses kaydımı seç ve ekle'}</button>
          <input ref={file} type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm" hidden onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} />
          {st.sesler.kendi.length > 0 && <p className="small">Kendi sesleriniz: {st.sesler.kendi.join(', ')}</p>}
        </>
      )}
    </>
  );
}
