import { useEffect, useState } from 'react';
import { getDaily, openJarvisBrowser, runDaily, saveDaily, type DailyCfg, type DailyData } from '../lib/api';

const ADI = { aksam: '📋 Günlük rapor', eposta: '📧 E-posta', github: '🐙 GitHub' } as const;
/** Rapordaki https linkleri tıklanabilir */
const linkify = (t: string) => t.split(/(https:\/\/[^\s]+)/g).map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p}</a> : p));
const hours = Array.from({ length: 24 }, (_, i) => i);

/**
 * Ayarlar → Günlük rapor: sabah e-posta düzenleme + yeni GitHub repoları, akşam "bugün ne yaptım" raporu.
 * Raporlar Telegram/WhatsApp'a gider ve burada son 14 gün okunabilir.
 */
export function DailySettings({ flash }: { flash(t: string): void }) {
  const [d, setD] = useState<DailyData | null>(null);
  const [busy, setBusy] = useState('');
  const load = () => getDaily().then(setD).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!d) return null;

  const set = (patch: Partial<DailyCfg>) => saveDaily(patch).then(setD).catch(e => flash(e.message));
  const now = (is: 'aksam' | 'eposta' | 'github') => {
    setBusy(is);
    flash(is === 'eposta' ? 'E-postalar düzenleniyor; birkaç dakika sürebilir' : is === 'github' ? 'GitHub taranıyor; birkaç dakika sürebilir' : 'Rapor hazırlanıyor');
    runDaily(is).then(r => { setD(r); flash('Hazır · aşağıda ve Telegram/WhatsApp\'ta'); }).catch(e => flash(e.message)).finally(() => setBusy(''));
  };
  const a = d.ayar;
  return (
    <>
      <label>Günlük rapor</label>
      <p className="muted small">Her sabah {a.sabahSaati}:00'da e-postalarınızı düzenler ve yeni GitHub repolarını tarar; her akşam {a.raporSaati}:00'da gün içinde yaptıklarını raporlar. Raporlar Telegram'a ve WhatsApp'ta kendinize gelir (bilgisayar o saatte kapalıysa açılınca).</p>
      <div className="seg">
        <button className={a.epostaOto ? 'on' : ''} onClick={() => set({ epostaOto: !a.epostaOto })}>{a.epostaOto ? '✅' : '⬜'} E-postaları her gün düzenle</button>
        <button className={a.epostaGrupla ? 'on' : ''} onClick={() => set({ epostaGrupla: !a.epostaGrupla })}>{a.epostaGrupla ? '✅' : '⬜'} Sosyal/bildirimleri klasörle</button>
        <button className={a.repoOto ? 'on' : ''} onClick={() => set({ repoOto: !a.repoOto })}>{a.repoOto ? '✅' : '⬜'} Uygun repoları kendisi kursun</button>
        <button className={a.gonder ? 'on' : ''} onClick={() => set({ gonder: !a.gonder })}>{a.gonder ? '✅' : '⬜'} Telegram/WhatsApp'a gönder</button>
      </div>
      <div className="seg">
        <span className="small">Sabah işleri:</span>
        <select value={a.sabahSaati} onChange={e => set({ sabahSaati: Number(e.target.value) })}>{hours.map(h => <option key={h} value={h}>{h}:00</option>)}</select>
        <span className="small">Akşam raporu:</span>
        <select value={a.raporSaati} onChange={e => set({ raporSaati: Number(e.target.value) })}>{hours.map(h => <option key={h} value={h}>{h}:00</option>)}</select>
      </div>
      {!d.eposta && (
        <>
          <p className="small">🌐 Uygulama şifresi girilmemiş: Jarvis Gmail'i <b>kendi tarayıcı penceresinden</b> düzenler. Aşağıdaki düğmeyle pencereyi açın ve Gmail'e <b>bir kez kendiniz</b> giriş yapın (şifrenizi Jarvis'e söylemeyin). Sonra pencereyi açık bırakabilir ya da kapatabilirsiniz; oturum hatırlanır.</p>
          <div className="seg"><button onClick={() => openJarvisBrowser().then(() => flash('Jarvis tarayıcısı açıldı: Gmail\'e giriş yapın')).catch(e => flash(e.message))}>🌐 Jarvis tarayıcısını aç (Gmail girişi)</button></div>
        </>
      )}
      <p className="muted small">E-posta düzenleme: tanıtım/reklam, bülten ve spam Çöp'e taşınır (30 gün geri alınabilir), aboneliklerden çıkılır; kişisel, fatura, kargo ve güvenlik e-postaları silinmez, önemliler özetlenir. Repolar: beceri içeren ve en az 25 yıldızlı olanlar kurulur (günde en fazla 5); MCP içerenler güvenlik için kapalı eklenir.</p>
      <div className="seg">
        <button disabled={!!busy || !!d.calisiyor} onClick={() => now('eposta')}>{busy === 'eposta' ? 'Düzenleniyor…' : '📧 E-postaları şimdi düzenle'}</button>
        <button disabled={!!busy || !!d.calisiyor} onClick={() => now('github')}>{busy === 'github' ? 'Taranıyor…' : '🐙 Repoları şimdi tara'}</button>
        <button disabled={!!busy || !!d.calisiyor} onClick={() => now('aksam')}>{busy === 'aksam' ? 'Hazırlanıyor…' : '📋 Şimdi rapor ver'}</button>
      </div>
      {d.raporlar.length > 0 && (
        <div className="ext-boxes">
          {d.raporlar.map(r => (['aksam', 'eposta', 'github'] as const).filter(k => r[k]).map(k => (
            <details key={`${r.tarih}-${k}`} className="ext-box">
              <summary><span>{ADI[k]} · {new Date(`${r.tarih}T12:00:00`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })}</span><em className="muted">{r.gonderildi?.[k]?.length ? `gönderildi: ${r.gonderildi[k]!.join(', ')}` : 'yalnız burada'}</em></summary>
              <pre className="small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{linkify(r[k]!)}</pre>
            </details>
          )))}
        </div>
      )}
    </>
  );
}
