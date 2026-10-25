import { useEffect, useRef, useState } from 'react';
import { checkWindowsMic, openMicSettings, stt, type MicReport } from '../lib/api';
import { listMics, micDevice, micInfo, setMicDevice, startRecording } from '../lib/recorder';
import { createRecognizer } from '../lib/speech';

type Mic = { id: string; ad: string; supheli: boolean };
interface Result { peak: number; ms: number; url: string; sunucu: string; tarayici: string; hata?: string; ayar: string }

/**
 * Ayarlar → Mikrofon: hangi girişin kullanılacağını seçer ve 4 saniyelik bir test kaydı yapar. Sonuçta ses seviyesi,
 * kaydın kendisi (dinlenebilir) ve iki ses tanımanın (sunucu, tarayıcı) ne duyduğu görünür. Telefonda doğru, bilgisayarda
 * yanlış anlıyorsa sebep çoğunlukla yanlış giriş ("Stereo Karışımı" gibi bilgisayarın kendi sesini kaydeden) ya da kısık
 * mikrofondur.
 */
export function MicTest({ flash }: { flash(t: string): void }) {
  const [mics, setMics] = useState<Mic[] | null>(null);
  const [sel, setSel] = useState(micDevice());
  const [busy, setBusy] = useState<'' | 'kayit' | 'tanima'>('');
  const [level, setLevel] = useState(0);
  const [live, setLive] = useState('');
  const [r, setR] = useState<Result | null>(null);
  const urlRef = useRef('');
  const [win, setWin] = useState<MicReport | null>(null);
  const [winBusy, setWinBusy] = useState(false);
  const checkWin = () => { setWinBusy(true); checkWindowsMic().then(setWin).catch(e => flash(e.message)).finally(() => setWinBusy(false)); };
  const open = (ne: 'kayit' | 'gizlilik') => openMicSettings(ne).then(() => flash(ne === 'kayit' ? 'Windows Ses → Kayıt penceresi açıldı' : 'Mikrofon gizlilik ayarı açıldı')).catch(e => flash(e.message));
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const load = () => listMics().then(setMics).catch(() => flash('Mikrofon listesi alınamadı: tarayıcıda mikrofon izni verilmeli.'));
  const choose = (id: string) => { setSel(id); setMicDevice(id); setR(null); flash('Mikrofon seçildi; test edebilirsiniz.'); };

  const test = async () => {
    setR(null); setLive(''); setBusy('kayit');
    let web = '';
    let done: () => void = () => {};
    const ended = new Promise<void>(res => { done = res; });
    const side = createRecognizer({ continuous: true, onInterim: t => setLive(t), onFinal: t => { web = t; }, onEnd: () => done(), onError: () => done() });
    try { side?.start(); } catch { done(); }
    if (!side) done();
    try {
      await startRecording({
        manual: true, maxMs: 4000, sendSilent: true, onLevel: setLevel,
        onStop: async (blob, info) => {
          setLevel(0);
          try { side?.stop(); } catch { /* bitti */ }
          await Promise.race([ended, new Promise(res => setTimeout(res, 1500))]);
          const m = micInfo();
          const ayar = m ? `${m.label || 'mikrofon'} · ${m.sampleRate ?? '?'} Hz · ${m.channelCount ?? '?'} kanal · yankı engelleme ${m.echoCancellation ? 'açık' : 'kapalı'} · gürültü azaltma ${m.noiseSuppression ? 'açık' : 'kapalı'}` : '';
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = blob ? URL.createObjectURL(blob) : '';
          setBusy('tanima');
          let sunucu = '', hata: string | undefined;
          try { sunucu = blob ? await stt(blob, info.ms) : ''; } catch (e: any) { hata = e.message; }
          setR({ peak: info.peak, ms: info.ms, url: urlRef.current, sunucu, tarayici: web.trim(), hata, ayar });
          setBusy('');
        },
      });
    } catch (e: any) {
      setBusy('');
      flash(`Mikrofon açılamadı: ${e?.message || e}`);
    }
  };

  const verdict = (x: Result): { ok: boolean; text: string } => {
    const chosen = mics?.find(m => m.id === sel);
    if (chosen?.supheli || /stereo|karışım|mix|cable|virtual/i.test(x.ayar)) return { ok: false, text: 'Seçili giriş bir mikrofon değil, bilgisayarın kendi sesini kaydediyor. Listeden gerçek mikrofonunuzu seçin.' };
    if (x.peak < 0.004) return { ok: false, text: 'Mikrofondan hiç ses gelmiyor. Başka bir mikrofon seçin ya da Windows → Ayarlar → Ses → Giriş\'te mikrofonun açık olduğuna bakın.' };
    if (x.peak < 0.02) return { ok: false, text: 'Ses çok kısık. Mikrofona yaklaşın ya da Windows → Ses → Giriş → mikrofon ses düzeyini artırın.' };
    if (!x.sunucu && !x.tarayici) return { ok: false, text: 'Ses geliyor ama tanınmadı. Kaydı dinleyin: sizin sesiniz mi, net mi?' };
    return { ok: true, text: 'Mikrofon çalışıyor. Duyulanı kontrol edin: söylediğinizle aynıysa sorun yok.' };
  };

  return (
    <>
      <label>Mikrofon · test</label>
      <p className="muted small">Telefonda doğru anlayıp bilgisayarda yanlış anlıyorsa sebep çoğunlukla yanlış giriş ya da kısık mikrofondur. Mikrofonu seçin, "Test et"e basıp 4 saniye konuşun (ör. "yarın hava nasıl").</p>
      {!mics ? (
        <div className="seg"><button onClick={load}>Mikrofonları göster</button></div>
      ) : (
        <div className="seg mic-list">
          <button className={sel === '' ? 'on' : ''} onClick={() => choose('')}>Varsayılan</button>
          {mics.filter(m => m.id).map(m => (
            <button key={m.id} className={sel === m.id ? 'on' : ''} onClick={() => choose(m.id)} title={m.supheli ? 'Bu giriş bilgisayarın kendi sesini kaydeder' : ''}>
              {m.supheli ? '⚠️ ' : '🎤 '}{m.ad}
            </button>
          ))}
        </div>
      )}
      <div className="seg">
        <button disabled={winBusy} onClick={checkWin}>{winBusy ? 'Okunuyor…' : '🖥️ Windows mikrofon ayarlarını kontrol et'}</button>
        <button onClick={() => open('kayit')}>Kayıt ayarlarını aç</button>
      </div>
      {win && (
        <div className="mic-result">
          {!win.windows && <p className="muted small">{win.oneriler[0]}</p>}
          {win.windows && <p className="small">Varsayılan kayıt cihazı: <b>{win.varsayilan ?? 'bulunamadı'}</b> · uygulama erişimi: <b>{win.erisim.uygulamalar ?? '?'}</b> · masaüstü uygulamaları: <b>{win.erisim.masaustu_uygulamalari ?? '?'}</b></p>}
          {win.cihazlar.map((c, i) => (
            <p key={i} className={c.supheli && c.durum === 'etkin' ? 'warn small' : 'small'}>{c.varsayilan ? '⭐' : c.supheli ? '⚠️' : '🎤'} {c.ad}{c.arayuz ? ` (${c.arayuz})` : ''} · {c.durum}{c.varsayilan ? ' · VARSAYILAN' : ''}{c.supheli ? ' · mikrofon değil, bilgisayarın sesini kaydeder' : ''}</p>
          ))}
          {win.sorunlar.map((s, i) => <p key={`s${i}`} className="warn small">⚠️ {s}</p>)}
          {win.oneriler.map((s, i) => <p key={`o${i}`} className="small">👉 {s}</p>)}
          {win.windows && (win.erisim.uygulamalar === 'KAPALI' || win.erisim.masaustu_uygulamalari === 'KAPALI' || win.erisim.sistem === 'KAPALI') && <div className="seg"><button onClick={() => open('gizlilik')}>Mikrofon izinlerini aç</button></div>}
        </div>
      )}
      <div className="seg">
        <button disabled={!!busy} onClick={test}>{busy === 'kayit' ? 'Konuşun… (4 sn)' : busy === 'tanima' ? 'Tanınıyor…' : '🎙️ Test et'}</button>
      </div>
      {busy === 'kayit' && (
        <div className="mic-meter" aria-label="Ses seviyesi"><i style={{ width: `${Math.round(level * 100)}%` }} /></div>
      )}
      {busy === 'kayit' && live && <p className="small">Tarayıcı duyuyor: “{live}”</p>}
      {r && (() => {
        const v = verdict(r);
        return (
          <div className="mic-result">
            <p className={v.ok ? 'small' : 'warn small'}>{v.ok ? '✅' : '⚠️'} {v.text}</p>
            <p className="small">Ses seviyesi: <b>%{Math.min(100, Math.round(r.peak * 400))}</b> · kayıt {Math.round(r.ms / 100) / 10} sn</p>
            <p className="small">Jarvis'in duyduğu (sunucu): <b>{r.hata ? `hata: ${r.hata}` : r.sunucu ? `“${r.sunucu}”` : '(boş)'}</b></p>
            <p className="small">Tarayıcının duyduğu: <b>{r.tarayici ? `“${r.tarayici}”` : '(boş ya da desteklenmiyor)'}</b></p>
            {r.url && <audio controls src={r.url} style={{ width: '100%' }} />}
            {r.ayar && <p className="muted small">{r.ayar}</p>}
          </div>
        );
      })()}
    </>
  );
}
