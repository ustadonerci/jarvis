import { useEffect, useState } from 'react';
import { connectWhatsApp, getMessaging, getVersion, logoutWhatsApp, saveMessaging, testTelegram, type MessagingCfg, type MessagingData } from '../lib/api';

/**
 * Ayarlar → Bağlantılar: Telegram botu ve WhatsApp (QR ile). Jarvis gelen mesajları okur, özetler, onayınızla
 * cevap yazar; isterseniz siz bakamıyorken otomatik cevap verir ve WhatsApp aramalarına mesajla döner.
 */
export function MessagingSettings({ flash }: { flash(t: string): void }) {
  const [data, setData] = useState<MessagingData | null>(null);
  const [error, setError] = useState('');
  const [aramaMetni, setAramaMetni] = useState('');
  const [talimat, setTalimat] = useState('');
  const [surum, setSurum] = useState('');
  useEffect(() => { getVersion().then(v => setSurum(v.kod === 'bilinmiyor' ? 'bilinmiyor' : `${v.kod} · ${v.tarih ? new Date(v.tarih).toLocaleString('tr-TR') : ''}`)).catch(() => {}); }, []);
  const tgTest = () => testTelegram().then(() => { flash('Deneme mesajı gönderildi: Telegram\'a bakın'); load(); }).catch(e => flash(e.message));

  const load = () => getMessaging().then(d => {
    setData(d);
    setAramaMetni(t => t || d.ayar.aramaMetni);
    setTalimat(t => t || d.ayar.talimat);
  }).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);
  // QR beklerken ve bağlanırken durumu tazele (QR ~20 sn'de bir yenilenir)
  const waiting = data?.whatsapp.durum === 'qr' || data?.whatsapp.durum === 'bağlanıyor';
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [waiting]);

  const set = (patch: Partial<MessagingCfg>, ok?: string) => saveMessaging(patch).then(d => { setData(d); if (ok) flash(ok); }).catch(e => flash(e.message));

  if (!data) return (<><label>Bağlantılar</label><p className="muted small">{error || 'yükleniyor…'}</p></>);
  const { telegram: tg, whatsapp: wa, ayar } = data;
  const onOff = (on: boolean, fn: (v: boolean) => void) => (
    <div className="seg">
      <button className={on ? 'on' : ''} onClick={() => fn(true)}>Açık</button>
      <button className={!on ? 'on' : ''} onClick={() => fn(false)}>Kapalı</button>
    </div>
  );

  return (
    <>
      <label>Bağlantılar{data.okunmamis ? ` · ${data.okunmamis} okunmamış mesaj` : ''}</label>
      {surum && <p className="muted small">Jarvis sürümü: <b>{surum}</b></p>}
      <p className="muted small">Bağladıktan sonra "Jarvis, mesajlarımı özetle", "kim aradı", "Ahmet'e yarın gelirim yaz" diyebilirsiniz. Jarvis mesaj göndermeden önce her zaman onay ister.</p>

      <div className="conn">
        <div className="conn-head">
          <b>Telegram</b>
          <i className={`tag ${tg.durum === 'bağlı' ? 'ok' : tg.durum === 'hata' ? 'bad' : ''}`}>{tg.durum === 'bağlı' ? `bağlı · @${tg.bot}` : tg.durum}</i>
        </div>
        {tg.durum === 'anahtar yok' && (
          <p className="muted small">Telegram'da <b>@BotFather</b>'a yazın → <code>/newbot</code> → bota bir ad verin → size verdiği anahtarı yukarıdaki <b>API anahtarları → Telegram bot anahtarı</b> alanına yapıştırın. Sonra mesajlarınızı bu bota iletin ya da botu gruplarınıza ekleyin.</p>
        )}
        {tg.hata && <p className="small warn">{tg.hata}</p>}
        {tg.durum !== 'anahtar yok' && (
          <div className="tg-diag small">
            <p>Uzaktan komut: <b>{tg.eslesme ?? '?'}</b> · son gelen mesaj: <b>{tg.sonMesaj || 'yok'}</b> · son cevap: <b>{tg.sonCevap || 'yok'}</b></p>
            <div className="seg"><button onClick={tgTest}>Telegram'a deneme mesajı gönder</button><button onClick={load}>Yenile</button></div>
          </div>
        )}
        {tg.durum === 'bağlı' && (
          <>
            <p className="muted small">Bot yalnızca kendisine yazılan mesajları ve eklendiği grupları görür (Telegram kişisel sohbetlerinizi botlara açmıyor).</p>
            <div className="conn-row"><span>Otomatik cevap</span>{onOff(ayar.telegramOto, v => set({ telegramOto: v }))}</div>
          </>
        )}
      </div>

      <div className="conn">
        <div className="conn-head">
          <b>WhatsApp</b>
          <i className={`tag ${wa.durum === 'bağlı' ? 'ok' : wa.durum === 'hata' ? 'bad' : ''}`}>{wa.durum === 'bağlı' ? `bağlı · +${wa.numara}` : wa.durum === 'qr' ? 'QR bekleniyor' : wa.durum}</i>
        </div>
        {wa.durum === 'kapalı' || wa.durum === 'hata' ? (
          <>
            <p className="muted small">WhatsApp Web gibi bağlanır: telefonunuzda <b>WhatsApp → Ayarlar → Bağlı cihazlar → Cihaz bağla</b> ile çıkan QR kodu okutun.</p>
            <p className="small warn">Bu bağlantı WhatsApp'ın resmî bir hizmeti değildir. Çok sayıda otomatik mesaj göndermek hesabın kısıtlanmasına yol açabilir; otomatik cevabı ölçülü kullanın.</p>
            {wa.hata && <p className="small warn">{wa.hata}</p>}
            <div className="seg"><button className="on" onClick={() => connectWhatsApp().then(setData).catch(e => flash(e.message))}>Bağlan (QR göster)</button></div>
          </>
        ) : wa.durum === 'qr' ? (
          <div className="qr">
            <img src={wa.qr} alt="WhatsApp QR kodu" width={240} height={240} />
            <p className="muted small">Telefonunuzda WhatsApp → Ayarlar → Bağlı cihazlar → Cihaz bağla → bu kodu okutun.</p>
          </div>
        ) : wa.durum === 'bağlanıyor' ? (
          <p className="muted small">bağlanıyor…</p>
        ) : (
          <>
            <div className="conn-row"><span>Otomatik cevap</span>{onOff(ayar.whatsappOto, v => set({ whatsappOto: v }))}</div>
            <div className="conn-row"><span>Gelen aramaya mesajla dön</span>{onOff(ayar.aramaMesaji, v => set({ aramaMesaji: v }))}</div>
            {ayar.aramaMesaji && (
              <form className="memory-add" onSubmit={e => { e.preventDefault(); set({ aramaMetni }, 'Arama mesajı kaydedildi'); }}>
                <input value={aramaMetni} onChange={e => setAramaMetni(e.target.value)} maxLength={500} />
                <button type="submit" disabled={!aramaMetni.trim() || aramaMetni === ayar.aramaMetni}>Kaydet</button>
              </form>
            )}
            <p className="muted small">Açıkken gelen arama reddedilir ve arayana bu mesaj gider. Aramayı sesli cevaplamak mümkün değil: WhatsApp buna izin vermiyor.</p>
            <div className="seg"><button onClick={() => confirm('WhatsApp bağlantısı kaldırılsın mı?') && logoutWhatsApp().then(setData).catch(e => flash(e.message))}>Bağlantıyı kaldır</button></div>
          </>
        )}
      </div>

      {data.whatsappCloud?.hazir && (
        <div className="conn">
          <div className="conn-head"><b>WhatsApp Business API</b><i className={`tag ${data.whatsappCloud.imza ? 'ok' : 'bad'}`}>{data.whatsappCloud.imza ? 'ayarlı' : 'uygulama gizli anahtarı eksik'}</i></div>
          <p className="muted small">Meta → WhatsApp → Configuration → Webhook: aşağıdaki adres ve API anahtarlarına yazdığınız doğrulama anahtarı; "messages" alanına abone olun.</p>
          {data.whatsappCloud.webhook ? <code className="copy">{data.whatsappCloud.webhook}</code> : <p className="small warn">Önce API anahtarlarına PUBLIC_URL (https tünel adresi) girin.</p>}
          <p className="muted small">Meta kuralı: size son 24 saatte yazmamış birine serbest mesaj gönderilemez.</p>
        </div>
      )}

      <div className="conn">
        <div className="conn-head"><b>Telefon (Twilio)</b><i className={`tag ${data.telefon?.hazir ? 'ok' : ''}`}>{data.telefon?.hazir ? `ayarlı · ${data.telefon.numara}` : 'ayarlı değil'}</i></div>
        {!data.telefon?.hazir ? (
          <p className="muted small">Jarvis'in telefonla konuşması için: twilio.com'da hesap açıp bir numara alın; API anahtarlarına <b>TWILIO_ACCOUNT_SID</b>, <b>TWILIO_AUTH_TOKEN</b>, <b>TWILIO_PHONE_NUMBER</b> ve <b>PUBLIC_URL</b> (https tünel adresi) girin. Jarvis bu numaraya gelen aramaları karşılar, sizin adınıza (onayınızla) arama yapar ve görüşmeleri özetler.</p>
        ) : (
          <>
            <p className="muted small">Twilio → Phone Numbers → numaranız → "A call comes in" → Webhook (POST):</p>
            <code className="copy">{data.telefon.webhook}</code>
            <p className="muted small">Kendi cep telefonunuza gelen aramaları da Jarvis'e bırakmak için operatörünüzün "cevap yoksa / meşgulse yönlendir" özelliğini bu numaraya ayarlayabilirsiniz (ücretli olabilir). Jarvis her görüşmede yapay zeka olduğunu ve not aldığını söyler.</p>
            {data.telefon.son.length > 0 && (
              <ul className="memory ext-list">
                {data.telefon.son.map(c => (
                  <li key={c.sid}>
                    <span>
                      <div className="ext-title"><b>{c.numara}</b><i className="tag">{c.yon === 'gelen' ? 'gelen' : 'giden'}</i><i className="tag">{new Date(c.basla).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</i></div>
                      <small>{c.ozet}</small>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {(ayar.telegramOto || ayar.whatsappOto) && (
        <>
          <label>Otomatik cevap notu</label>
          <textarea className="profile-text" rows={3} value={talimat} onChange={e => setTalimat(e.target.value)} maxLength={1000}
            placeholder="Ör. Bu hafta izindeyim, acil işler için Mehmet'i arayın. Resmî ama sıcak bir dille yaz." />
          <div className="seg"><button className={talimat !== ayar.talimat ? 'on' : ''} disabled={talimat === ayar.talimat} onClick={() => set({ talimat }, 'Not kaydedildi')}>Kaydet</button></div>
          <p className="muted small">Otomatik cevaplar 🤖 ile başlar, kişisel bilgi paylaşmaz, söz vermez ve aynı kişiye 30 saniyede en fazla bir kez gider. Grup mesajlarına otomatik cevap verilmez.</p>
        </>
      )}
    </>
  );
}
