import { useEffect, useState } from 'react';
import {
  clearErrorLog, getErrors, type ErrorView,
  addServer, addSkill, deleteServer, deleteSkill, getExtensions, getKeys, installGitHub, removeRepo, retryServer, saveKeys, toggleServer, toggleSkill,
  type ExtensionsData, type KeysData, type KeyView,
} from '../lib/api';

/**
 * Ayarlar → API anahtarları: server/.env'i arayüzden düzenler. Gizli anahtarlar geri gösterilmez ("••••1a2b");
 * alan boş bırakılırsa dokunulmaz. Kaydedince sunucu yeniden başlar ve sayfa kendini yeniler.
 */
export function KeySettings({ flash }: { flash(t: string): void }) {
  const [data, setData] = useState<KeysData | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { if (open && !data) getKeys().then(setData).catch(e => setError(e.message)); }, [open, data]);

  const set = (name: string, v: string) => setDraft(d => ({ ...d, [name]: v }));
  const dirty = Object.keys(draft).length > 0;
  const save = () => {
    saveKeys(draft)
      .then(r => {
        setData(r);
        setDraft({});
        if (r.restarting) flash('Kaydedildi · Jarvis yeniden başlıyor, sayfa birkaç saniye içinde yenilenecek');
        else if (r.changed) flash('Kaydedildi · Geçerli olması için sunucuyu yeniden başlatın');
        else flash('Değişiklik yok');
      })
      .catch(e => flash(e.message));
  };
  const addCustom = () => {
    const n = newName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!/_(API_KEY|KEY|TOKEN|SECRET)$/.test(n)) return flash('Ad _KEY, _API_KEY, _TOKEN ya da _SECRET ile bitmeli (ör. GITHUB_TOKEN)');
    setData(d => (d && !d.custom.some(c => c.name === n) ? { ...d, custom: [...d.custom, { name: n, label: n, hint: 'Eklenti anahtarı', secret: true, set: false, value: '' }] } : d));
    setNewName('');
  };

  const field = (f: KeyView) => (
    <div key={f.name} className="key-row">
      <div className="key-head">
        <span>{f.label}</span>
        <em className={f.set ? 'ok' : ''}>{f.set ? (f.secret ? `kayıtlı ${f.value}` : 'kayıtlı') : 'boş'}</em>
      </div>
      <input
        type={f.secret ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        value={draft[f.name] ?? (f.secret ? '' : f.value)}
        placeholder={f.secret ? (f.set ? 'Değiştirmek için yeni anahtarı yapıştırın' : 'Anahtarı yapıştırın') : ''}
        onChange={e => set(f.name, e.target.value)}
      />
      <div className="key-foot">
        <p className="muted small">{f.hint}</p>
        {f.set && f.secret && draft[f.name] !== '' && <button onClick={() => set(f.name, '')}>Sil</button>}
        {draft[f.name] === '' && f.set && <em className="warn">silinecek</em>}
      </div>
    </div>
  );

  return (
    <>
      <label>API anahtarları</label>
      {!open ? (
        <button className="profile-peek" onClick={() => setOpen(true)}>
          <span>Abacus, ElevenLabs, YouTube, Home Assistant ve eklenti anahtarları</span>
          <em>düzenle</em>
        </button>
      ) : !data ? (
        <p className="muted small">{error || 'yükleniyor…'}</p>
      ) : (
        <div className="keys">
          {data.fields.map(field)}
          {data.custom.map(field)}
          <form className="memory-add" onSubmit={e => { e.preventDefault(); addCustom(); }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Başka anahtar ekle (ör. GITHUB_TOKEN)" maxLength={64} />
            <button type="submit" disabled={!newName.trim()}>Ekle</button>
          </form>
          <div className="seg">
            <button className={dirty ? 'on' : ''} disabled={!dirty} onClick={save}>Kaydet</button>
            <button onClick={() => { setDraft({}); setOpen(false); }}>{dirty ? 'Vazgeç' : 'Kapat'}</button>
          </div>
          <p className="muted small">Anahtarlar yalnızca bu bilgisayardaki server/.env dosyasına yazılır, GitHub'a gitmez ve tarayıcıya geri gönderilmez.</p>
        </div>
      )}
    </>
  );
}

const TUR = { beceri: 'beceri', is_akisi: 'iş akışı' } as const;

/**
 * Ayarlar → Yetenekler: GitHub reposundan kurulum, beceri / iş akışı (Markdown talimat) ve MCP sunucuları.
 * Jarvis yalnızca adları ve açıklamaları her istekte görür; ihtiyaç duyunca tam talimatı okur.
 */
export function ExtensionSettings({ flash }: { flash(t: string): void }) {
  const [data, setData] = useState<ExtensionsData | null>(null);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<null | 'beceri' | 'mcp'>(null);
  const [skill, setSkill] = useState({ ad: '', aciklama: '', icerik: '', tur: 'beceri' as 'beceri' | 'is_akisi' });
  const [mcp, setMcp] = useState({ ad: '', hedef: '', env: '' });
  const [error, setError] = useState('');

  const load = () => getExtensions().then(setData).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);
  // Kurulan ya da bağlanan sunucu varken durumu tazele
  const pending = data?.servers.some(s => s.durum === 'kuruluyor' || s.durum === 'bağlanıyor');
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [pending]);

  const act = (p: Promise<ExtensionsData>, ok?: string) => p.then(d => { setData(d); if (ok) flash(ok); }).catch(e => flash(e.message));

  const install = () => {
    if (!repo.trim() || busy) return;
    setBusy(true);
    installGitHub(repo.trim())
      .then(r => {
        setData(r);
        setRepo('');
        const parts = [r.beceri && `${r.beceri} beceri`, r.is_akisi && `${r.is_akisi} iş akışı`, r.mcp && `${r.mcp} MCP sunucusu (kapalı, aşağıdan açın)`].filter(Boolean);
        flash(`Kuruldu · ${parts.join(', ')}`);
      })
      .catch(e => flash(e.message))
      .finally(() => setBusy(false));
  };

  const submitSkill = () => {
    if (!skill.icerik.trim()) return;
    act(addSkill(skill), `${TUR[skill.tur]} eklendi`).then(() => { setSkill({ ad: '', aciklama: '', icerik: '', tur: 'beceri' }); setForm(null); });
  };
  const submitMcp = () => {
    const h = mcp.hedef.trim();
    if (!h) return;
    const isUrl = /^https?:\/\//.test(h);
    act(addServer({ ad: mcp.ad, ...(isUrl ? { url: h, basliklar: mcp.env } : { komut: h, env: mcp.env }) }), 'MCP sunucusu eklendi, bağlanıyor')
      .then(() => { setMcp({ ad: '', hedef: '', env: '' }); setForm(null); });
  };

  if (!data) return (<><label>Yetenekler</label><p className="muted small">{error || 'yükleniyor…'}</p></>);
  const repoName = (slug?: string) => (slug ? data.repos.find(r => r.slug === slug)?.url.replace('https://github.com/', '') : undefined);

  return (
    <>
      <label>Yetenekler · {data.skills.filter(s => s.aktif).length} beceri/iş akışı · {data.servers.filter(s => s.durum === 'bağlı').length} MCP</label>
      <p className="muted small">GitHub reposu ekleyin; Jarvis içindeki becerileri (SKILL.md), iş akışlarını (commands/, workflows/ altında .md) ve MCP sunucularını (.mcp.json ya da MCP paketi) kendisi bulup kurar.</p>
      <form className="memory-add" onSubmit={e => { e.preventDefault(); install(); }}>
        <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="https://github.com/kullanici/repo" disabled={busy} />
        <button type="submit" disabled={!repo.trim() || busy}>{busy ? 'Kuruluyor…' : 'Kur'}</button>
      </form>

      {data.repos.length > 0 && (
        <ul className="memory">
          {data.repos.map(r => (
            <li key={r.slug}>
              <span>📦 {r.url.replace('https://github.com/', '')}</span>
              <em>{data.skills.filter(s => s.repo === r.slug).length + data.servers.filter(s => s.repo === r.slug).length} öğe</em>
              <button aria-label="Repoyu kaldır" onClick={() => confirm(`${r.url} ve ondan gelen tüm yetenekler kaldırılsın mı?`) && act(removeRepo(r.slug), 'Repo kaldırıldı')}>✕</button>
            </li>
          ))}
        </ul>
      )}

      {data.skills.length > 0 && (
        <ul className="memory ext-list">
          {data.skills.map(s => (
            <li key={s.id} className={s.aktif ? '' : 'off'}>
              <span>
                <div className="ext-title"><b>{s.ad}</b><i className="tag">{TUR[s.tur]}</i>{s.kaynak === 'jarvis' && <i className="tag ok">Jarvis öğrendi</i>}</div>
                <small>{s.aciklama}</small>
              </span>
              <button className="toggle" onClick={() => act(toggleSkill(s.id, !s.aktif))}>{s.aktif ? 'açık' : 'kapalı'}</button>
              {!s.repo && <button aria-label="Sil" onClick={() => act(deleteSkill(s.id))}>✕</button>}
            </li>
          ))}
        </ul>
      )}

      {data.servers.length > 0 && (
        <ul className="memory ext-list">
          {data.servers.map(s => (
            <li key={s.id} className={s.aktif ? '' : 'off'}>
              <span>
                <div className="ext-title"><b>{s.ad}</b><i className={`tag ${s.durum === 'bağlı' ? 'ok' : s.durum === 'hata' ? 'bad' : ''}`}>MCP · {s.durum}</i></div>
                <small className="mono">{s.hedef}</small>
                {s.durum === 'bağlı' && <small>{s.araclar.length} araç: {s.araclar.slice(0, 8).join(', ')}{s.araclar.length > 8 ? '…' : ''}</small>}
                {s.hata && <small className="warn">{s.hata}</small>}
                {!s.aktif && s.repo && <small>{repoName(s.repo)} reposundan · açınca bu bilgisayarda program çalıştırır{s.kurulum ? ' (önce npm install)' : ''}</small>}
              </span>
              {s.durum === 'hata' && <button className="toggle" onClick={() => act(retryServer(s.id))}>tekrar</button>}
              <button
                className="toggle"
                disabled={s.durum === 'kuruluyor'}
                onClick={() => (s.aktif || confirm(`"${s.ad}" bu bilgisayarda şu komutu çalıştıracak:\n\n${s.hedef}\n\nRepoya güveniyor musunuz?`)) && act(toggleServer(s.id, !s.aktif))}
              >{s.aktif ? 'açık' : 'kapalı'}</button>
              {!s.repo && <button aria-label="Sil" onClick={() => act(deleteServer(s.id))}>✕</button>}
            </li>
          ))}
        </ul>
      )}

      <div className="seg">
        <button className={form === 'beceri' ? 'on' : ''} onClick={() => setForm(f => (f === 'beceri' ? null : 'beceri'))}>+ Beceri / iş akışı yaz</button>
        <button className={form === 'mcp' ? 'on' : ''} onClick={() => setForm(f => (f === 'mcp' ? null : 'mcp'))}>+ MCP sunucusu</button>
      </div>

      {form === 'beceri' && (
        <div className="keys">
          <div className="seg">
            <button className={skill.tur === 'beceri' ? 'on' : ''} onClick={() => setSkill(s => ({ ...s, tur: 'beceri' }))}>Beceri</button>
            <button className={skill.tur === 'is_akisi' ? 'on' : ''} onClick={() => setSkill(s => ({ ...s, tur: 'is_akisi' }))}>İş akışı</button>
          </div>
          <input className="ext-input" value={skill.ad} onChange={e => setSkill(s => ({ ...s, ad: e.target.value }))} placeholder="Ad (ör. Sabah rutini)" maxLength={80} />
          <input className="ext-input" value={skill.aciklama} onChange={e => setSkill(s => ({ ...s, aciklama: e.target.value }))} placeholder="Ne zaman kullanılır? (ör. 'Sabah rutinimi başlat' dediğimde)" maxLength={400} />
          <textarea
            className="profile-text"
            rows={8}
            value={skill.icerik}
            onChange={e => setSkill(s => ({ ...s, icerik: e.target.value }))}
            placeholder={skill.tur === 'is_akisi'
              ? '1. Hava durumunu söyle\n2. Döviz kurlarını özetle\n3. Salon ışığını yüzde 60 aç\n4. Türk kahvesi pişir'
              : 'Jarvis bu konuda nasıl davranmalı? Markdown yazabilir ya da bir SKILL.md dosyasının içeriğini yapıştırabilirsiniz.'}
          />
          <div className="seg"><button className="on" disabled={!skill.icerik.trim()} onClick={submitSkill}>Ekle</button></div>
        </div>
      )}

      {form === 'mcp' && (
        <div className="keys">
          <input className="ext-input" value={mcp.ad} onChange={e => setMcp(m => ({ ...m, ad: e.target.value }))} placeholder="Ad (ör. dosyalar)" maxLength={60} />
          <input className="ext-input mono" value={mcp.hedef} onChange={e => setMcp(m => ({ ...m, hedef: e.target.value }))} placeholder="npx -y @modelcontextprotocol/server-filesystem C:\Users\Ramaz\Documents   ya da   https://…/mcp" />
          <textarea
            className="profile-text mono"
            rows={3}
            value={mcp.env}
            onChange={e => setMcp(m => ({ ...m, env: e.target.value }))}
            placeholder={/^https?:\/\//.test(mcp.hedef) ? 'Başlıklar, satır başına bir tane (ör. Authorization=Bearer ${GITHUB_TOKEN})' : 'Ortam değişkenleri, satır başına bir tane (ör. GITHUB_TOKEN=${GITHUB_TOKEN})'}
          />
          <p className="muted small">{'${AD}'} yazarsanız değer API anahtarlarından alınır; anahtarı buraya açık yazmanız gerekmez.</p>
          <div className="seg"><button className="on" disabled={!mcp.hedef.trim()} onClick={submitMcp}>Ekle ve bağlan</button></div>
        </div>
      )}
    </>
  );
}

/** Ayarlar → Sistem günlüğü: Jarvis'in kaydettiği hatalar ve olası nedenleri. "Jarvis, kendini kontrol et" de aynı listeyi okur. */
export function ErrorLog({ flash }: { flash(t: string): void }) {
  const [list, setList] = useState<ErrorView[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { getErrors().then(r => setList(r.hatalar)).catch(() => setList([])); }, [open]);
  const active = list?.filter(e => !e.cozuldu) ?? [];
  return (
    <>
      <label>Sistem günlüğü{active.length ? ` · ${active.length} hata` : ''}</label>
      {!open ? (
        <button className="profile-peek" onClick={() => setOpen(true)}>
          <span>{list === null ? 'yükleniyor…' : active.length ? `Son hata: ${active[0].kaynak} · ${active[0].mesaj}` : 'Kayıtlı hata yok, sistem sağlıklı'}</span>
          <em>aç</em>
        </button>
      ) : (
        <>
          {active.length === 0 ? <p className="muted small">Kayıtlı hata yok.</p> : (
            <ul className="memory ext-list">
              {active.map((e, i) => (
                <li key={i}>
                  <span>
                    <div className="ext-title"><b>{e.kaynak}</b><i className="tag bad">{e.adet}×</i><i className="tag">{new Date(e.son).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</i></div>
                    <small className="mono">{e.mesaj}</small>
                    {e.olasi_neden && <small>→ {e.olasi_neden}</small>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">"Jarvis, kendini kontrol et" derseniz bu hataları inceleyip çözüm önerir. Geçici ağ hataları bir kez otomatik yeniden denenir.</p>
          <div className="seg">
            {active.length > 0 && <button onClick={() => clearErrorLog().then(() => { setList([]); flash('Günlük temizlendi'); }).catch(e => flash(e.message))}>Temizle</button>}
            <button onClick={() => setOpen(false)}>Kapat</button>
          </div>
        </>
      )}
    </>
  );
}
