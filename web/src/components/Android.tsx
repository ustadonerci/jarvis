import { useEffect, useState } from 'react';
import { connectAndroid, getAndroid, importAndroidContacts, pairAndroid, setupAdb, type AndroidData } from '../lib/api';

/**
 * Ayarlar → Android telefon: kablosuz ADB eşleştirmesi. Bağlanınca Jarvis telefona Google Play'den uygulama yükler ve
 * uygulama kaldırır (her seferinde onay kartıyla).
 */
export function AndroidSettings({ flash }: { flash(t: string): void }) {
  const [d, setD] = useState<AndroidData | null>(null);
  const [adres, setAdres] = useState('');
  const [kod, setKod] = useState('');
  const [baglanti, setBaglanti] = useState('');
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  useEffect(() => { getAndroid().then(setD).catch(() => {}); }, []);
  const act = (p: Promise<AndroidData>) => {
    setBusy(true);
    p.then(r => { setD(r); if (r.mesaj) flash(r.mesaj); }).catch(e => flash(e.message)).finally(() => setBusy(false));
  };
  if (!d) return null;
  return (
    <>
      <label>Android telefon · {d.bagli ? `bağlı (${d.cihaz}${d.usb ? ', USB' : ''})` : d.yetkisiz ? 'USB kablo takılı, telefonda izin bekleniyor' : d.sonAdres ? 'eşleştirildi, şu an bağlı değil' : 'bağlı değil'}</label>
      <p className="muted small">Bağlanınca Jarvis'e "telefonuma X'i yükle" ya da "telefonumdan X'i sil" diyebilirsiniz: Google Play sayfasını telefonda açıp Yükle'ye basar ya da uygulamayı kaldırır. Her işlem onay kartıyla yapılır; ücretli uygulama satın almaz, sistem uygulamalarını kaldırmaz.</p>
      {!d.adb && (
        <div className="seg"><button disabled={busy} onClick={() => act(setupAdb())}>{busy ? 'Kuruluyor…' : 'Gerekli aracı kur (adb, bir kez)'}</button></div>
      )}
      <div className="seg">
        <button className={help ? 'on' : ''} onClick={() => setHelp(h => !h)}>Nasıl bağlarım?</button>
        {d.bagli && <button disabled={busy} onClick={() => act(importAndroidContacts())}>{busy ? 'Okunuyor…' : '📇 Rehberi telefondan al'}</button>}
        <button disabled={busy} onClick={() => act(getAndroid())}>Yenile</button>
      </div>
      {help && (
        <ol className="muted small android-help">
          <li><b>USB kabloyla (en kolayı):</b> Geliştirici seçenekleri → <b>USB hata ayıklama</b> açık olsun, telefonu kabloyla bilgisayara takın, telefonda çıkan soruda <b>"Bu bilgisayara her zaman izin ver"</b>i işaretleyip <b>İzin ver</b>'e dokunun ve Yenile'ye basın. Eşleştirme kodu gerekmez.</li>
          <li><b>Kablosuz için:</b> telefon ve bilgisayar aynı Wi-Fi'ye bağlı olsun.</li>
          <li>Telefonda <b>Ayarlar → Telefon hakkında</b> → <b>Yapı numarası</b>'na 7 kez dokunun ("Artık geliştiricisiniz" yazar).</li>
          <li><b>Ayarlar → Sistem → Geliştirici seçenekleri</b> → <b>Kablosuz hata ayıklama</b>'yı açın ve üstüne dokunun.</li>
          <li><b>Cihazı eşleştirme koduyla eşle</b>'ye dokunun. Çıkan <b>IP adresi ve bağlantı noktası</b> (ör. 192.168.1.23:37155) ile <b>6 haneli kodu</b> aşağıya yazıp Eşleştir'e basın.</li>
          <li>Bir kez eşleştirmek yeterli; telefon yeniden başlarsa Kablosuz hata ayıklamayı tekrar açmanız gerekebilir.</li>
        </ol>
      )}
      {!d.bagli && (
        <form className="memory-add" onSubmit={e => { e.preventDefault(); act(pairAndroid(adres, kod)); }}>
          <input value={adres} onChange={e => setAdres(e.target.value.trim())} placeholder="Eşleştirme adresi (192.168.1.23:37155)" disabled={busy} inputMode="url" />
          <input value={kod} onChange={e => setKod(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 haneli kod" disabled={busy} inputMode="numeric" style={{ maxWidth: 130 }} />
          <button type="submit" disabled={busy || !adres || kod.length !== 6}>{busy ? '…' : 'Eşleştir'}</button>
        </form>
      )}
      {!d.bagli && (
        <form className="memory-add" onSubmit={e => { e.preventDefault(); act(connectAndroid(baglanti)); }}>
          <input value={baglanti} onChange={e => setBaglanti(e.target.value.trim())} placeholder="Gerekirse bağlantı adresi (Kablosuz hata ayıklama ekranının üstündeki IP:port)" disabled={busy} inputMode="url" />
          <button type="submit" disabled={busy || !baglanti}>Bağlan</button>
        </form>
      )}
      {d.hata && <p className="warn small">{d.hata}</p>}
    </>
  );
}
