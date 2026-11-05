import { useEffect, useState } from 'react';
import { addMemory, deleteHafiza, deleteMemory, getHafiza, getProfile, installOllama, saveProfile, setHafizaAcik, type HafizaState, type MemoryItem } from '../lib/api';

/**
 * Ayarlar → Hakkımda: Jarvis'in sizi tanıdığı metin ve konuşmalarda not ettikleri (hafıza).
 * İkisi de yalnızca bu bilgisayardaki sunucuda saklanır; her istekte modele gönderilir.
 */
export function ProfileSettings({ flash }: { flash(t: string): void }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [updated, setUpdated] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryItem[]>([]);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    getProfile()
      .then(d => { setText(d.profile.text); setSaved(d.profile.text); setUpdated(d.profile.updated_at); setMemory(d.memory); })
      .catch(() => setText(''));
  }, []);

  const save = () => {
    if (text === null) return;
    saveProfile(text)
      .then(r => { setSaved(r.profile.text); setUpdated(r.profile.updated_at); flash('Tanıtım kaydedildi · Jarvis bir sonraki cevaptan itibaren bunu biliyor'); })
      .catch(e => flash(e.message));
  };
  const add = () => {
    if (!note.trim()) return;
    addMemory(note).then(r => { setMemory(r.memory); setNote(''); }).catch(e => flash(e.message));
  };

  const dirty = text !== null && text !== saved;
  return (
    <>
      <label>Hakkımda (Jarvis sizi bununla tanır)</label>
      {text === null ? <p className="muted small">yükleniyor…</p> : (
        <>
          {!open ? (
            <button className="profile-peek" onClick={() => setOpen(true)}>
              <span>{saved.split('\n').find(l => l.trim() && !l.startsWith('━')) ?? 'Tanıtım boş'}</span>
              <em>{saved.length} karakter{updated ? ` · ${new Date(updated).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })}` : ''} · düzenle</em>
            </button>
          ) : (
            <>
              <textarea className="profile-text" value={text} onChange={e => setText(e.target.value)} rows={14} maxLength={8000} />
              <div className="seg">
                <button className={dirty ? 'on' : ''} disabled={!dirty} onClick={save}>Kaydet</button>
                <button onClick={() => { setText(saved); setOpen(false); }}>{dirty ? 'Vazgeç' : 'Kapat'}</button>
              </div>
            </>
          )}
          <p className="muted small">Yalnızca bu bilgisayarda saklanır, GitHub'a gitmez. Her soruda modele (RouteLLM) gönderilir; TC no, adres, sağlık gibi hassas bilgileri yazmayın.</p>
        </>
      )}

      <label>Jarvis'in hafızası · {memory.length} not</label>
      <p className="muted small">Konuşurken "Jarvis, unutma: …" derseniz kendisi not eder; "bunu unut" derseniz siler.</p>
      {memory.length > 0 && (
        <ul className="memory">
          {memory.map(m => (
            <li key={m.id}>
              <span>{m.text}</span>
              <em>{new Date(m.at).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })}</em>
              <button aria-label="Notu sil" onClick={() => deleteMemory(m.id).then(r => setMemory(r.memory)).catch(e => flash(e.message))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <form className="memory-add" onSubmit={e => { e.preventDefault(); add(); }}>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Elle not ekle (ör. Cuma günleri çekim yapıyorum)" maxLength={300} />
        <button type="submit" disabled={!note.trim()}>Ekle</button>
      </form>
      <LongMemory flash={flash} />
    </>
  );
}

/** Uzun hafıza (geçmiş konuşmalar) ve yerel model (Ollama): görülür, tek tek ya da hepsi silinir */
function LongMemory({ flash }: { flash(t: string): void }) {
  const [h, setH] = useState<HafizaState | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => getHafiza().then(setH).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!h) return null;
  return (
    <>
      <label>Uzun hafıza · {h.sayi} konuşma{h.vektorlu ? ` (${h.vektorlu} anlamca aranabilir)` : ''}</label>
      <p className="muted small">Konuşmalar bu bilgisayarda saklanır; "geçen hafta X hakkında ne konuşmuştuk" diye sorabilirsiniz. Şifre, kart, IBAN içeren konuşmalar kaydedilmez.</p>
      <div className="seg">
        <button className={h.acik ? 'on' : ''} onClick={() => setHafizaAcik(!h.acik).then(() => { load(); flash(h.acik ? 'Konuşmalar artık kaydedilmeyecek' : 'Konuşmalar uzun hafızaya kaydedilecek'); }).catch(e => flash(e.message))}>{h.acik ? '✅' : '⬜'} Konuşmaları hatırla</button>
        <button onClick={() => setOpen(o => !o)}>{open ? 'Kayıtları gizle' : 'Kayıtları göster'}</button>
        {h.sayi > 0 && <button onClick={() => { if (confirm('Uzun hafızadaki bütün konuşmalar silinsin mi?')) deleteHafiza('hepsi').then(() => { load(); flash('Uzun hafıza temizlendi'); }).catch(e => flash(e.message)); }}>🗑️ Hepsini sil</button>}
      </div>
      {open && h.son.length > 0 && (
        <ul className="memory">
          {h.son.map(k => (
            <li key={k.id}>
              <span><b>{k.soru.slice(0, 120)}</b> — {k.cevap.slice(0, 160)}</span>
              <em>{new Date(k.at).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })}</em>
              <button aria-label="Kaydı sil" onClick={() => deleteHafiza(k.id).then(load).catch(e => flash(e.message))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <label>Yerel yapay zekâ (Ollama) {h.ollama.hazir ? '· ✅ hazır' : h.ollama.kurulu ? '· kurulu, model eksik' : ''}</label>
      <p className="muted small">Bilgisayarda ücretsiz çalışan model ({h.ollama.yerel_model}). Kuruluysa kısa işler (özet, çeviri) ona gider, uzun hafıza anlamca aranır; zor işler yine buluttaki beyinde.</p>
      {!h.ollama.hazir && <button className="save" onClick={() => installOllama().then(r => flash(r.onay_bekliyor ? 'Ekrandaki onay kartından kurulumu onaylayın (~2,5 GB)' : 'Zaten kurulu')).catch(e => flash(e.message))}>⬇️ Ollama'yı kur</button>}
    </>
  );
}
