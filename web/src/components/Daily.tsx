import { useEffect, useState } from 'react';
import { deleteExpense, downloadExpensesCsv, finishLogin, getDaily, getExpenses, getKeys, openJarvisBrowser, saveKeys, showJarvisBrowser, runDaily, saveDaily, type DailyCfg, type DailyData, type DailyKind, type ExpensesData } from '../lib/api';

const ADI = { aksam: '📋 Günlük rapor', eposta: '📧 E-posta', github: '🐙 GitHub', harcama: '💳 Kart harcamaları', ay: '💳 Ay sonu gider tablosu' } as const;
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
  const now = (is: DailyKind) => {
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
        <button className={a.harcamaOto ? 'on' : ''} onClick={() => set({ harcamaOto: !a.harcamaOto })}>{a.harcamaOto ? '✅' : '⬜'} Kart harcama tablosu</button>
        <button className={a.gonder ? 'on' : ''} onClick={() => set({ gonder: !a.gonder })}>{a.gonder ? '✅' : '⬜'} Telegram/WhatsApp'a gönder</button>
      </div>
      <div className="seg">
        <span className="small">Sabah işleri:</span>
        <select value={a.sabahSaati} onChange={e => set({ sabahSaati: Number(e.target.value) })}>{hours.map(h => <option key={h} value={h}>{h}:00</option>)}</select>
        <span className="small">Akşam raporu:</span>
        <select value={a.raporSaati} onChange={e => set({ raporSaati: Number(e.target.value) })}>{hours.map(h => <option key={h} value={h}>{h}:00</option>)}</select>
      </div>
      {!d.eposta && <GmailConnect flash={flash} reddedildi={!!d.epostaSifreReddedildi} onSaved={load} />}
      <p className="muted small">E-posta düzenleme: tanıtım/reklam, bülten ve spam Çöp'e taşınır (30 gün geri alınabilir), aboneliklerden çıkılır; kişisel, fatura, kargo ve güvenlik e-postaları silinmez, önemliler özetlenir. Repolar: beceri içeren ve en az 25 yıldızlı olanlar kurulur (günde en fazla 5); MCP içerenler güvenlik için kapalı eklenir.</p>
      <div className="seg">
        <span className="small">Jarvis'in tarayıcısı arka planda (küçültülmüş) çalışır:</span>
        <button onClick={() => showJarvisBrowser(true).then(() => flash('Tarayıcı öne getirildi')).catch(e => flash(e.message))}>🪟 Göster</button>
        <button onClick={() => showJarvisBrowser(false).then(() => flash('Tarayıcı arka plana alındı')).catch(e => flash(e.message))}>Arka plana al</button>
      </div>
      <div className="seg">
        <button disabled={!!busy || !!d.calisiyor} onClick={() => now('eposta')}>{busy === 'eposta' ? 'Düzenleniyor…' : '📧 E-postaları şimdi düzenle'}</button>
        <button disabled={!!busy || !!d.calisiyor} onClick={() => now('github')}>{busy === 'github' ? 'Taranıyor…' : '🐙 Repoları şimdi tara'}</button>
        <button disabled={!!busy || !!d.calisiyor} onClick={() => now('aksam')}>{busy === 'aksam' ? 'Hazırlanıyor…' : '📋 Şimdi rapor ver'}</button>
      </div>
      {d.raporlar.length > 0 && (
        <div className="ext-boxes">
          {d.raporlar.map(r => (['aksam', 'harcama', 'ay', 'eposta', 'github'] as const).filter(k => r[k]).map(k => (
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

const tl = (n: number) => n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthName = (ay: string) => new Date(`${ay}-15T12:00:00`).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });

/** Ayarlar → Kart harcamaları: ayın gider tablosu (tarih, saat, işyeri, kategori, tutar), kategori toplamları, Excel */
export function ExpenseSettings({ flash }: { flash(t: string): void }) {
  const [d, setD] = useState<ExpensesData | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (ay?: string) => getExpenses(ay).then(setD).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!d) return null;
  const update = () => {
    setBusy(true);
    flash('Banka e-postaları okunuyor; birkaç dakika sürebilir');
    runDaily('harcama').then(() => load(d.ay)).then(() => flash('Gider tablosu güncellendi')).catch(e => flash(e.message)).finally(() => setBusy(false));
  };
  return (
    <>
      <label>Kart harcamaları · gider tablosu</label>
      <p className="muted small">Bankaların "kartınızla … TL harcama" e-postalarından çıkarılır. Her akşam günün tablosu, ay sonunda toplam gönderilir. Kart numarasının yalnız son 4 hanesi tutulur. Excel dosyası ayrıca Belgeler klasörüne yazılır: {d.klasor}</p>
      <div className="seg">
        <select value={d.ay} onChange={e => load(e.target.value)}>{d.aylar.map(a => <option key={a} value={a}>{monthName(a)}</option>)}</select>
        <button disabled={busy} onClick={update}>{busy ? 'Okunuyor…' : '🔄 Şimdi güncelle'}</button>
        <button onClick={() => downloadExpensesCsv(d.ay).catch(e => flash(e.message))}>📥 Excel indir</button>
      </div>
      <p className="small"><b>{monthName(d.ay)} toplamı: {tl(d.toplam)} TL</b> · {d.harcamalar.length} işlem</p>
      {d.kategori.length > 0 && <p className="small">{d.kategori.map(([k, v]) => `${k}: ${tl(v)} TL`).join(' · ')}</p>}
      {d.harcamalar.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th align="left">Tarih</th><th align="left">Saat</th><th align="left">İşyeri</th><th align="left">Kategori</th><th align="right">Tutar</th><th align="left">Kart</th><th /></tr></thead>
            <tbody>
              {d.harcamalar.slice().reverse().map(e => (
                <tr key={e.id}>
                  <td>{e.tarih.split('-').reverse().join('.')}</td><td>{e.saat}</td><td>{e.isyeri}</td><td>{e.kategori}</td>
                  <td align="right">{e.tur === 'iade' ? '−' : ''}{tl(e.tutar)} {e.para === 'TRY' ? 'TL' : e.para}</td>
                  <td>{e.kart ? `*${e.kart}` : ''} {e.banka}</td>
                  <td><button aria-label="Satırı sil" title="Yanlış satırı sil" onClick={() => confirm(`${e.isyeri} ${tl(e.tutar)} satırı tablodan silinsin mi?`) && deleteExpense(e.id).then(() => load(d.ay))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * Gmail bağlantısı. En kolay ve kalıcı yol: Google uygulama şifresi (Jarvis her seferinde kendisi girer, pencere
 * gerekmez). Yedek: normal Chrome penceresinde kullanıcının kendisi girmesi + "Girişi bitirdim".
 */
function GmailConnect({ flash, reddedildi, onSaved }: { flash(t: string): void; reddedildi: boolean; onSaved(): void }) {
  const [adres, setAdres] = useState('');
  const [adresVar, setAdresVar] = useState(true);
  const [sifre, setSifre] = useState('');
  useEffect(() => { getKeys().then(k => { const f = k.fields.find(x => x.name === 'EMAIL_ADDRESS'); setAdresVar(!!f?.set); }).catch(() => {}); }, []);
  const kaydet = () => {
    const temiz = sifre.replace(/\s+/g, '');
    if (!/^[a-z]{16}$/i.test(temiz)) return flash('Uygulama şifresi 16 harftir (ör. abcd efgh ijkl mnop). Normal Gmail şifreniz burada çalışmaz.');
    if (!adresVar && !/^[^@\s]+@[^@\s]+$/.test(adres.trim())) return flash('Gmail adresinizi yazın');
    saveKeys({ EMAIL_APP_PASSWORD: temiz, ...(!adresVar ? { EMAIL_ADDRESS: adres.trim() } : {}) })
      .then(() => { setSifre(''); flash('Kaydedildi · Jarvis yeniden başlıyor; artık Gmail\'e kendisi girer'); setTimeout(onSaved, 6000); })
      .catch(e => flash(e.message));
  };
  return (
    <div className="ext-box" style={{ padding: 10 }}>
      <p className="small"><b>📧 Gmail'i bağla: Jarvis her seferinde kendisi girsin (en kolay, 2 dakika)</b></p>
      {reddedildi && <p className="warn small">Kayıtlı şifre Gmail tarafından reddedildi (normal Gmail şifresi çalışmaz; uygulama şifresi gerekir).</p>}
      <ol className="small" style={{ margin: '4px 0 8px 18px', padding: 0 }}>
        <li><a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noopener noreferrer">2 Adımlı Doğrulama</a> açık değilse açın.</li>
        <li><a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">Uygulama şifreleri</a> sayfasında ad olarak "Jarvis" yazıp <b>Oluştur</b>'a basın.</li>
        <li>Çıkan 16 harfli şifreyi aşağıya yapıştırıp <b>Kaydet</b>'e basın.</li>
      </ol>
      <div className="seg">
        {!adresVar && <input className="ext-input" value={adres} onChange={e => setAdres(e.target.value)} placeholder="Gmail adresiniz" autoComplete="off" />}
        <input className="ext-input" type="password" value={sifre} onChange={e => setSifre(e.target.value)} placeholder="16 harfli uygulama şifresi" autoComplete="off" spellCheck={false} />
        <button className="on" disabled={!sifre.trim()} onClick={kaydet}>💾 Kaydet</button>
      </div>
      <p className="muted small">Bu şifre normal Gmail şifreniz değildir, yalnız Jarvis içindir ve istediğiniz zaman aynı sayfadan iptal edilebilir. Yalnız bu bilgisayara kaydedilir.</p>
      <details>
        <summary className="small">Uygulama şifresi istemiyorum: tarayıcıyla bağlan</summary>
        <p className="small">Normal bir Chrome penceresi açılır (Jarvis o pencereye dokunmaz). Gmail'e kendiniz girin, sonra <b>✅ Girişi bitirdim</b>'e basın.</p>
        <div className="seg">
          <button onClick={() => openJarvisBrowser().then(() => flash('Chrome penceresi açıldı: Gmail\'e girin, sonra "Girişi bitirdim"e basın')).catch(e => flash(e.message))}>🌐 Gmail giriş penceresini aç</button>
          <button className="on" onClick={() => finishLogin().then(() => flash('Tamam: Jarvis arka planda devam ediyor')).catch(e => flash(e.message))}>✅ Girişi bitirdim</button>
        </div>
      </details>
    </div>
  );
}
