import { useEffect, useState } from 'react';
import { getKeys, getProviders, saveKeys, setBrain, testProvider, type KeyView, type ProvidersData } from '../lib/api';

const LOGO: Record<string, string> = { perplexity: '🔎', cohere: '🟣', together: '🤝', fireworks: '🎆', cerebras: '🧠', sambanova: '🔶', deepinfra: '🌊', huggingface: '🤗', nvidia: '🟩', qwen: '🐉', moonshot: '🌙', zhipu: '🔷', minimax: '🔺', ai21: '🔵', novita: '✨', hyperbolic: '🌀', stability: '🖼️', replicate: '🔁', fal: '⚡', runway: '🎬', luma: '🎥', heygen: '🧑‍💼', assemblyai: '🎙️', elevenlabs: '🔊', deepgram: '👂', openai: '🟢', anthropic: '🟠', gemini: '🔷', xai: '✖️', deepseek: '🐋', mistral: '🌬️', groq: '⚡', openrouter: '🔀' };

/**
 * Ayarlar → Yapay zeka sağlayıcıları: her sağlayıcı açılır bir kart (API anahtarı + model). "Beyin yap" seçilen
 * sağlayıcıyı Jarvis'in ana sohbetine bağlar; o sağlayıcı hata verirse tur RouteLLM ile tamamlanır. Anahtarlar yalnız
 * bu bilgisayardaki server/.env'e yazılır, geri gösterilmez.
 */
/** Sağlayıcı kartlarında gösterilen alanlar (ElevenLabs/Deepgram genel listede de durur) */
const SHARED = ['ELEVENLABS_API_KEY', 'DEEPGRAM_API_KEY'];
const mine = (f: KeyView) => !!f.saglayici || SHARED.includes(f.name);
const cardOf = (f: KeyView) => f.saglayici ?? (f.name === 'ELEVENLABS_API_KEY' ? 'elevenlabs' : f.name === 'DEEPGRAM_API_KEY' ? 'deepgram' : '');

export function ProviderSettings({ flash }: { flash(t: string): void }) {
  const [data, setData] = useState<ProvidersData | null>(null);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<Record<string, { modeller?: string[]; hata?: string }>>({});

  const load = () => {
    getProviders().then(setData).catch(e => setError(e.message));
    getKeys().then(k => setKeys(k.fields.filter(mine))).catch(e => setError(e.message));
  };
  useEffect(load, []);

  const save = (id?: string) => {
    const vals = Object.fromEntries(Object.entries(draft).filter(([k]) => !id || (() => { const f = keys.find(x => x.name === k); return !!f && cardOf(f) === id; })()));
    if (!Object.keys(vals).length) return flash('Önce bir alana yazın');
    saveKeys(vals).then(r => {
      setDraft(d => Object.fromEntries(Object.entries(d).filter(([k]) => !(k in vals))));
      setKeys(r.fields.filter(mine));
      flash(r.restarting ? 'Kaydedildi · Jarvis yeniden başlıyor; birkaç saniye sonra "Bağlantıyı test et"e basın' : r.changed ? 'Kaydedildi' : 'Değişiklik yok');
      setTimeout(load, 6000);
    }).catch(e => flash(e.message));
  };
  const test = (id: string) => {
    setBusy(id);
    testProvider(id).then(r => setResult(x => ({ ...x, [id]: { modeller: r.modeller } }))).catch(e => setResult(x => ({ ...x, [id]: { hata: e.message } }))).finally(() => setBusy(''));
  };
  const brain = (id: string) => setBrain(id).then(d => {
    setData(d);
    flash(id === 'routellm' ? 'Beyin: RouteLLM' : `Beyin: ${d.saglayicilar.find(p => p.id === id)?.ad} · bir sonraki cevaptan itibaren`);
  }).catch(e => flash(e.message));

  if (error) return (
    <>
      <label>Yapay zeka sağlayıcıları</label>
      <p className="small warn">{/bilgisayardan|403|yetkisiz/i.test(error) ? 'Sağlayıcı anahtarları yalnızca Jarvis\'in çalıştığı bilgisayardan girilebilir (http://localhost:5173).' : error}</p>
    </>
  );
  if (!data) return null;
  return (
    <>
      <label>Yapay zeka sağlayıcıları (beyin)</label>
      <p className="muted small">Kendi API anahtarınızı girip bir sağlayıcıyı "beyin" yapın: Jarvis'in sohbeti (ekran, Telegram, WhatsApp) o yapay zekayla çalışır. Hata verirse o cevap RouteLLM ile tamamlanır. Anahtarları sohbete yazmayın.</p>
      <div className="seg">
        <button className={data.beyin === 'routellm' ? 'on' : ''} onClick={() => brain('routellm')}>RouteLLM (varsayılan)</button>
        {data.saglayicilar.filter(p => p.hazir && p.tur === 'sohbet').map(p => (
          <button key={p.id} className={data.beyin === p.id ? 'on' : ''} onClick={() => brain(p.id)}>{LOGO[p.id] ?? '🤖'} {p.ad}</button>
        ))}
      </div>
      {data.beyin !== 'routellm' && data.aktif === 'routellm' && <p className="warn small">⚠️ Seçili sağlayıcının anahtarı yok; şimdilik RouteLLM kullanılıyor.</p>}
      {([['sohbet', 'Sohbet yapay zekaları (beyin yapılabilir)'], ['medya', 'Görsel / video / ses yapay zekaları (anahtar kaydı)']] as const).map(([tur, baslik]) => (
      <div key={tur}>
      <p className="small"><b>{baslik}</b> · {data.saglayicilar.filter(p => p.tur === tur && p.hazir).length}/{data.saglayicilar.filter(p => p.tur === tur).length} kayıtlı</p>
      <div className="ext-boxes">
        {data.saglayicilar.filter(p => p.tur === tur).map(p => {
          const fields = keys.filter(f => cardOf(f) === p.id);
          const r = result[p.id];
          return (
            <details key={p.id} className="ext-box borsa-card">
              <summary>
                <span>{LOGO[p.id] ?? '🤖'} <b>{p.ad}</b>{data.aktif === p.id ? ' · BEYİN' : ''} <a href={p.anahtarUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="small">🔑 anahtar al</a></span>
                <em className={p.hazir ? 'ok' : 'muted'}>{p.hazir ? `anahtar kayıtlı · ${p.model}` : 'anahtar yok'}</em>
              </summary>
              <p className="small">🔑 Anahtarı buradan alın: <a href={p.anahtarUrl} target="_blank" rel="noopener noreferrer">{p.anahtarUrl}</a> (giriş yapın → yeni anahtar oluşturun → kopyalayıp aşağıya yapıştırın)</p>
              {p.not && <p className="muted small">{p.not}</p>}
              {fields.map(f => (
                <div key={f.name} className="key-row">
                  <div className="key-head"><span>{f.label}</span><em className={f.set ? 'ok' : ''}>{f.set ? (f.secret ? `kayıtlı ${f.value}` : 'kayıtlı') : 'boş'}</em></div>
                  <div className="key-input">
                    <input
                      type={f.secret && !shown.has(f.name) ? 'password' : 'text'} autoComplete="off" spellCheck={false}
                      value={draft[f.name] ?? (f.secret ? '' : f.value)}
                      placeholder={f.secret ? (f.set ? 'Değiştirmek için yenisini yapıştırın' : 'Buraya yapıştırın (Ctrl+V)') : p.model}
                      onChange={ev => setDraft(d => ({ ...d, [f.name]: ev.target.value }))}
                    />
                    {f.secret && <button type="button" onClick={() => setShown(s => { const n = new Set(s); n.has(f.name) ? n.delete(f.name) : n.add(f.name); return n; })}>{shown.has(f.name) ? 'gizle' : 'göster'}</button>}
                  </div>
                  <div className="key-foot">
                    <p className="muted small">{f.hint}</p>
                    {f.set && f.secret && draft[f.name] !== '' && <button onClick={() => setDraft(d => ({ ...d, [f.name]: '' }))}>Sil</button>}
                    {draft[f.name] === '' && f.set && <em className="warn">silinecek</em>}
                  </div>
                </div>
              ))}
              <div className="seg">
                <button className={fields.some(f => f.name in draft) ? 'on' : ''} onClick={() => save(p.id)}>💾 Kaydet</button>
                {p.tur === 'sohbet' && <><button disabled={!p.hazir || busy === p.id} onClick={() => test(p.id)}>{busy === p.id ? 'Bağlanıyor…' : 'Bağlantıyı test et'}</button>
                <button disabled={!p.hazir || data.beyin === p.id} onClick={() => brain(p.id)}>{data.beyin === p.id ? '🧠 Beyin bu' : '🧠 Beyin yap'}</button></>}
              </div>
              {r?.hata && <p className="warn small">⚠️ {r.hata}</p>}
              {r?.modeller && (
                <>
                  <p className="small">✅ Anahtar çalışıyor · {r.modeller.length} model. Birini "Model" alanına yazabilirsiniz:</p>
                  <p className="muted small">{r.modeller.slice(0, 40).join(' · ')}</p>
                </>
              )}
            </details>
          );
        })}
      </div>
      </div>
      ))}
      {Object.keys(draft).length > 0 && (
        <div className="save-bar">
          <span>Kaydedilmemiş sağlayıcı anahtarı</span>
          <button className="on" onClick={() => save()}>💾 Kaydet</button>
          <button onClick={() => setDraft({})}>Vazgeç</button>
        </div>
      )}
    </>
  );
}
