import { useEffect, useState } from 'react';
import {
  clearErrorLog, getErrors, type ErrorView, addWebhook, deleteWebhook, getWebhooks, type WebhookView,
  addServer, addSkill, deleteServer, deleteSkill, getExtensions, getKeys, installGitHub, removeRepo, tidyRepos, installBulk, removeBroken, retryServer, setAutoOpen, logoutServer, saveKeys, toggleServer, toggleSkill,
  type ExtensionsData, type KeysData, type KeyView,
  addTakip, checkTakip, getTakip, removeTakip, type SosyalPlatform, type TakipData,
} from '../lib/api';

/**
 * Ayarlar → API anahtarları: server/.env'i arayüzden düzenler. Gizli anahtarlar geri gösterilmez ("••••1a2b");
 * alan boş bırakılırsa dokunulmaz. Kaydedince sunucu yeniden başlar ve sayfa kendini yeniler.
 */
export function KeySettings({ flash }: { flash(t: string): void }) {
  const [data, setData] = useState<KeysData | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  // Bölüm açık başlar: anahtarı girilecek yer ilk bakışta görünsün
  const [open, setOpen] = useState(true);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  // Gizli alanlarda yazılanı göster (varsayılan: noktalarla gizli)
  const [shown, setShown] = useState<Set<string>>(new Set());

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
      <div className="key-input">
        <input
          type={f.secret && !shown.has(f.name) ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          value={draft[f.name] ?? (f.secret ? '' : f.value)}
          placeholder={f.secret ? (f.set ? 'Değiştirmek için yeni anahtarı yapıştırın' : 'Anahtarı buraya yapıştırın (Ctrl+V)') : ''}
          onChange={e => set(f.name, e.target.value)}
        />
        {f.secret && (
          <button type="button" onClick={() => setShown(s => { const n = new Set(s); n.has(f.name) ? n.delete(f.name) : n.add(f.name); return n; })}>
            {shown.has(f.name) ? 'gizle' : 'göster'}
          </button>
        )}
      </div>
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
        error ? (
          <p className="small warn">
            {/bilgisayardan|403|yetkisiz/i.test(error)
              ? "Anahtarlar yalnızca Jarvis'in çalıştığı bilgisayardan değiştirilebilir. Bu sayfayı o bilgisayarda http://localhost:5173 adresinden açın."
              : error}
          </p>
        ) : <p className="muted small">yükleniyor…</p>
      ) : (
        <div className="keys">
          {data.fields.filter(f => !f.borsa && !f.saglayici).map(field)}
          {data.custom.map(field)}
          <form className="memory-add" onSubmit={e => { e.preventDefault(); addCustom(); }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Başka anahtar ekle (ör. GITHUB_TOKEN)" maxLength={64} />
            <button type="submit" disabled={!newName.trim()}>Ekle</button>
          </form>
          <div className="seg">
            <button className={dirty ? 'on' : ''} disabled={!dirty} onClick={save}>{dirty ? '💾 Kaydet' : 'Kaydet (önce bir alana yazın)'}</button>
            <button onClick={() => { setDraft({}); setOpen(false); }}>{dirty ? 'Vazgeç' : 'Kapat'}</button>
          </div>
          {/* Liste uzun: değişiklik varken Kaydet ekranın altında hep görünür */}
          {dirty && (
            <div className="save-bar">
              <span>Kaydedilmemiş {Object.keys(draft).length} değişiklik</span>
              <button className="on" onClick={save}>💾 Kaydet</button>
              <button onClick={() => setDraft({})}>Vazgeç</button>
            </div>
          )}
          <p className="muted small">Anahtarlar yalnızca bu bilgisayardaki server/.env dosyasına yazılır, GitHub'a gitmez ve tarayıcıya geri gönderilmez.</p>
        </div>
      )}
    </>
  );
}

const TUR = { beceri: 'beceri', is_akisi: 'iş akışı' } as const;

/**
 * RIFKI repo listesinden (110 repo) Jarvis'e beceri olarak yarayanlar: pazarlama, SEO, reklam, sosyal medya, video,
 * finans araştırması, tasarım ve genel ajan becerileri. Uygulamaların kendi geliştirici becerileri, binlerce
 * becerilik dev paketler ve güvenlik kısıtlarını aşmaya yönelik içerikler bilerek dışarıda bırakıldı.
 */
const RIFKI_PAKETI = [
  'coreyhaines31/marketingskills', 'AgriciDaniel/claude-seo', 'AgriciDaniel/claude-ads', 'Ryze-AI-Adgent/open-seo-mcp-skills',
  'fajrisilmi12-cyber/hermes-socmed-function', 'hardikpandya/stop-slop', 'calesthio/OpenMontage', 'heygen-com/hyperframes',
  'haidrrrry/claude-remotion-skill', 'AI4Finance-Foundation/FinRobot', 'xbtlin/ai-berkshire', 'obra/superpowers',
  'muratcankoylan/agent-skills-for-context-engineering', 'nextlevelbuilder/ui-ux-pro-max-skill', 'vercel-labs/skills', 'cloudflare/security-audit-skill',
].join('\n');
const BULK_ICON = { bekliyor: '·', kuruluyor: '…', tamam: '✓', 'atlandı': '–', hata: '✕' } as const;

/** Açılıp kapanan kutu (uzun listeler için). ac true olunca (ör. toplu kurulum başlayınca) kendiliğinden açılır. */
function Kutu({ baslik, ozet, ac = false, children }: { baslik: string; ozet?: string; ac?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(ac);
  useEffect(() => { if (ac) setOpen(true); }, [ac]);
  return (
    <details className="ext-box" open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary><span>{baslik}</span>{ozet && <em>{ozet}</em>}</summary>
      {open && children}
    </details>
  );
}

/**
 * Ayarlar → Yetenekler: GitHub reposundan kurulum, beceri / iş akışı (Markdown talimat) ve MCP sunucuları.
 * Jarvis yalnızca adları ve açıklamaları her istekte görür; ihtiyaç duyunca tam talimatı okur.
 */
export function ExtensionSettings({ flash }: { flash(t: string): void }) {
  const [data, setData] = useState<ExtensionsData | null>(null);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<null | 'beceri' | 'mcp' | 'webhook'>(null);
  const [hooks, setHooks] = useState<WebhookView[]>([]);
  const [hook, setHook] = useState({ ad: '', url: '', aciklama: '' });
  const loadHooks = () => getWebhooks().then(r => setHooks(r.webhooklar)).catch(() => {});
  useEffect(() => { loadHooks(); }, []);
  const [skill, setSkill] = useState({ ad: '', aciklama: '', icerik: '', tur: 'beceri' as 'beceri' | 'is_akisi' });
  const [mcp, setMcp] = useState({ ad: '', hedef: '', env: '' });
  const [error, setError] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');

  const load = () => getExtensions().then(setData).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);
  // Kurulan ya da bağlanan sunucu varken durumu tazele
  const pending = data?.toplu?.calisiyor || data?.servers.some(s => s.durum === 'kuruluyor' || s.durum === 'bağlanıyor' || s.durum === 'giriş gerekli');
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [pending]);

  const [busyTidy, setBusyTidy] = useState(false);
  const act = (p: Promise<ExtensionsData>, ok?: string) => p.then(d => { setData(d); if (ok) flash(ok); }).catch(e => flash(e.message));

  const install = () => {
    if (!repo.trim() || busy) return;
    setBusy(true);
    installGitHub(repo.trim())
      .then(r => {
        setData(r);
        setRepo('');
        const parts = [r.beceri && `${r.beceri} beceri`, r.is_akisi && `${r.is_akisi} iş akışı`, r.mcp && `${r.mcp} MCP sunucusu (kapalı, aşağıdan açın)`].filter(Boolean);
        flash(r.bilgi ? 'Uygulama reposu: README bilgi kaynağı olarak eklendi (kod çalıştırılmaz)' : `Kuruldu · ${parts.join(', ')}`);
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
        <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="https://github.com/kullanici/repo  ya da  gh repo clone kullanici/repo" disabled={busy} />
        <button type="submit" disabled={!repo.trim() || busy}>{busy ? 'Kuruluyor…' : 'Kur'}</button>
      </form>

      <div className="seg">
        <button className={bulkOpen ? 'on' : ''} onClick={() => setBulkOpen(v => !v)}>Toplu kur (liste)</button>
      </div>
      {bulkOpen && (
        <div className="keys">
          <textarea className="profile-text mono" rows={6} value={bulkText} onChange={e => setBulkText(e.target.value)}
            placeholder={'Her satıra bir repo:\nkullanici/repo\nhttps://github.com/kullanici/repo\ngh repo clone kullanici/repo\ngit clone https://github.com/kullanici/repo.git'} />
          <div className="seg">
            <button onClick={() => setBulkText(RIFKI_PAKETI)}>RIFKI önerilen paketi (16 repo)</button>
            <button className="on" disabled={!bulkText.trim() || data.toplu?.calisiyor}
              onClick={() => act(installBulk(bulkText), 'Toplu kurulum başladı; birkaç dakika sürebilir')}>{data.toplu?.calisiyor ? 'Kuruluyor…' : 'Hepsini kur'}</button>
          </div>
          <p className="muted small">Repolar sırayla kurulur. Beceri/iş akışı içermeyenler atlanır; MCP sunucuları güvenlik için kapalı eklenir.</p>
        </div>
      )}
      {data.toplu && data.toplu.liste.length > 0 && (() => {
        const l = data.toplu.liste;
        const say = (d: keyof typeof BULK_ICON) => l.filter(i => i.durum === d).length;
        const ozet = [`✓ ${say('tamam')}`, say('atlandı') && `– ${say('atlandı')} atlandı`, say('hata') && `✕ ${say('hata')} hata`,
          data.toplu.calisiyor && `${say('kuruluyor') + say('bekliyor')} sırada`].filter(Boolean).join(' · ');
        return (
          <Kutu baslik={`Toplu kurulum sonucu (${l.length} repo)`} ozet={ozet} ac={data.toplu.calisiyor}>
            <ul className="memory bulk">
              {l.map(i => (
                <li key={i.url} className={i.durum}>
                  <span><b>{BULK_ICON[i.durum]}</b> {i.url.replace('https://github.com/', '')}{i.mesaj ? <small> · {i.mesaj}</small> : null}</span>
                </li>
              ))}
            </ul>
          </Kutu>
        );
      })()}

      {data.repos.length > 0 && (
        <Kutu baslik={`Kurulu repolar (${data.repos.length})`}>
        <button className="save" disabled={busyTidy} onClick={() => { setBusyTidy(true); act(tidyRepos(), 'Repolar başlıklara ayrıldı, güncellemeler yapıldı').finally(() => setBusyTidy(false)); }}>{busyTidy ? '⏳ Düzenleniyor (biraz sürebilir)…' : '🗂️ Başlıklara ayır ve güncelle'}</button>
        {Object.entries(data.repos.reduce<Record<string, typeof data.repos>>((g, r) => { (g[r.kategori ?? 'Başlıksız'] ??= []).push(r); return g; }, {})).sort(([a], [b]) => (a === 'Başlıksız' ? 1 : b === 'Başlıksız' ? -1 : a.localeCompare(b, 'tr'))).map(([k, list]) => (
          <div key={k}>
            <h4 className="small">{k} ({list.length})</h4>
            <ul className="memory">
              {list.map(r => (
                <li key={r.slug}>
                  <span>📦 {r.url.replace('https://github.com/', '')}</span>
                  <em>{data.skills.filter(s => s.repo === r.slug).length + data.servers.filter(s => s.repo === r.slug).length} öğe</em>
                  <button aria-label="Repoyu kaldır" onClick={() => confirm(`${r.url} ve ondan gelen tüm yetenekler kaldırılsın mı?`) && act(removeRepo(r.slug), 'Repo kaldırıldı')}>✕</button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        </Kutu>
      )}

      {data.skills.length > 0 && (
        <Kutu baslik={`Beceriler ve iş akışları (${data.skills.length})`} ozet={`${data.skills.filter(x => x.aktif).length} açık`}>
        <ul className="memory ext-list">
          {data.skills.map(s => (
            <li key={s.id} className={s.aktif ? '' : 'off'}>
              <span>
                <div className="ext-title"><b>{s.ad}</b><i className="tag">{TUR[s.tur]}</i>{s.kaynak === 'jarvis' && <i className="tag ok">Jarvis öğrendi</i>}{s.kaynak === 'takip' && <i className="tag">{s.aktif ? 'Takipten' : 'Takipten öneri'}</i>}</div>
                <small>{s.aciklama}</small>
                {s.kaynak === 'takip' && s.kaynakUrl && <small><a href={s.kaynakUrl} target="_blank" rel="noopener noreferrer">kaynak video</a>{!s.aktif && ' · açarsanız Jarvis bu yöntemi kullanır'}</small>}
              </span>
              <button className="toggle" onClick={() => act(toggleSkill(s.id, !s.aktif))}>{s.aktif ? 'açık' : 'kapalı'}</button>
              {!s.repo && <button aria-label="Sil" onClick={() => act(deleteSkill(s.id))}>✕</button>}
            </li>
          ))}
        </ul>
        </Kutu>
      )}

      {data.servers.length > 0 && (
        <Kutu baslik={`MCP sunucuları (${data.servers.length})`} ozet={`${data.servers.filter(x => x.durum === 'bağlı').length} bağlı`}
          ac={data.servers.some(x => x.durum === 'giriş gerekli' || x.durum === 'hata')}>
        <div className="seg">
          <button className={data.otoAc ? 'on' : ''} onClick={() => act(setAutoOpen(!data.otoAc), data.otoAc ? 'Otomatik açma kapatıldı' : 'MCP sunucuları otomatik açılıyor')}>{data.otoAc ? '✅ Otomatik aç: açık' : 'Otomatik aç: kapalı'}</button>
          <button disabled={!data.bozuk && !data.toplu?.liste.some(i => i.durum === 'hata')}
            onClick={() => confirm('Kurulamayan ve bağlanamayan (hatalı) MCP sunucuları silinsin mi? Gerekirse repoyu tekrar kurabilirsiniz.') && removeBroken().then(r => { setData(r); flash(r.silinen.length ? `Silindi: ${r.silinen.join(', ')}` : 'Silinecek bozuk sunucu yok'); }).catch(e => flash(e.message))}
          >🗑️ Bozukları sil{data.bozuk ? ` (${data.bozuk})` : ''}</button>
        </div>
        <p className="muted small">Otomatik açık olunca yeni eklenen MCP'ler kendiliğinden kurulup bağlanır (elle kapattıklarınız kapalı kalır). Bağlanamayanlar kırmızı "hata" görünür.</p>
        <ul className="memory ext-list">
          {data.servers.map(s => (
            <li key={s.id} className={s.aktif ? '' : 'off'}>
              <span>
                <div className="ext-title"><b>{s.ad}</b><i className={`tag ${s.durum === 'bağlı' ? 'ok' : s.durum === 'hata' ? 'bad' : ''}`}>MCP · {s.durum}</i></div>
                <small className="mono">{s.hedef}</small>
                {s.durum === 'bağlı' && <small>{s.araclar.length} araç: {s.araclar.slice(0, 8).join(', ')}{s.araclar.length > 8 ? '…' : ''}</small>}
                {s.hata && s.durum !== 'giriş gerekli' && <small className="warn">{s.hata}</small>}
                {s.durum === 'giriş gerekli' && <small>Bu sunucu hesabınızla giriş istiyor. "Giriş yap"a basın, açılan sayfada izin verin; sonra bu ekrana dönün.</small>}
                {!s.aktif && s.repo && <small>{repoName(s.repo)} reposundan · açınca bu bilgisayarda program çalıştırır{s.kurulum ? ' (önce npm install)' : ''}</small>}
              </span>
              {s.durum === 'giriş gerekli' && s.girisAdresi && <a className="toggle login" href={s.girisAdresi} target="_blank" rel="noopener noreferrer">Giriş yap</a>}
              {s.durum === 'bağlı' && s.tur === 'http' && <button className="toggle" title="Hesaptan çıkış" onClick={() => confirm(`${s.ad} hesabından çıkılsın mı?`) && act(logoutServer(s.id))}>çıkış</button>}
              {(s.durum === 'hata' || s.durum === 'giriş gerekli') && <button className="toggle" onClick={() => act(retryServer(s.id))}>tekrar</button>}
              <button
                className="toggle"
                disabled={s.durum === 'kuruluyor'}
                onClick={() => (s.aktif || confirm(`"${s.ad}" bu bilgisayarda şu komutu çalıştıracak:\n\n${s.hedef}\n\nRepoya güveniyor musunuz?`)) && act(toggleServer(s.id, !s.aktif))}
              >{s.aktif ? 'açık' : 'kapalı'}</button>
              <button aria-label="Sil" title="Sil" onClick={() => confirm(`"${s.ad}" silinsin mi?`) && act(deleteServer(s.id), 'Silindi')}>✕</button>
            </li>
          ))}
        </ul>
        </Kutu>
      )}

      <div className="seg">
        <button className={form === 'beceri' ? 'on' : ''} onClick={() => setForm(f => (f === 'beceri' ? null : 'beceri'))}>+ Beceri / iş akışı yaz</button>
        <button className={form === 'mcp' ? 'on' : ''} onClick={() => setForm(f => (f === 'mcp' ? null : 'mcp'))}>+ MCP sunucusu</button>
        <button className={form === 'webhook' ? 'on' : ''} onClick={() => setForm(f => (f === 'webhook' ? null : 'webhook'))}>+ n8n / webhook</button>
      </div>

      {hooks.length > 0 && (
        <ul className="memory ext-list">
          {hooks.map(h => (
            <li key={h.id}>
              <span>
                <div className="ext-title"><b>{h.ad}</b><i className="tag">webhook</i></div>
                <small>{h.aciklama || 'açıklama yok'}</small>
                <small className="mono">{h.url}</small>
              </span>
              <button aria-label="Sil" onClick={() => deleteWebhook(h.id).then(loadHooks).catch(e => flash(e.message))}>✕</button>
            </li>
          ))}
        </ul>
      )}

      {form === 'webhook' && (
        <div className="keys">
          <input className="ext-input" value={hook.ad} onChange={e => setHook(h => ({ ...h, ad: e.target.value }))} placeholder="Ad (ör. Instagram paylaş)" maxLength={60} />
          <input className="ext-input mono" value={hook.url} onChange={e => setHook(h => ({ ...h, url: e.target.value }))} placeholder="https://n8n.siteniz.com/webhook/…" />
          <input className="ext-input" value={hook.aciklama} onChange={e => setHook(h => ({ ...h, aciklama: e.target.value }))} placeholder="Ne yapar, hangi verileri bekler? (ör. platform, metin, gorsel_url alır; gönderiyi paylaşır)" maxLength={300} />
          <p className="muted small">n8n'de "Webhook" düğümüyle başlayan bir iş akışı kurun ve adresini buraya yapıştırın. Jarvis içeriği hazırlar ve her tetiklemede onay kartı açar.</p>
          <div className="seg"><button className="on" disabled={!hook.ad.trim() || !/^https?:\/\//.test(hook.url)} onClick={() => addWebhook(hook).then(() => { setHook({ ad: '', url: '', aciklama: '' }); setForm(null); loadHooks(); flash('Webhook eklendi'); }).catch(e => flash(e.message))}>Ekle</button></div>
        </div>
      )}

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

const PLATFORM_AD = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', x: 'X' } as const;

/** Ayarlar → Takip: Jarvis'in izlediği kanal/hesaplar ve onlardan gelen yetenek önerileri */
export function TakipSettings({ flash }: { flash(t: string): void }) {
  const [data, setData] = useState<TakipData | null>(null);
  const [kim, setKim] = useState('');
  const [platform, setPlatform] = useState<SosyalPlatform>('youtube');
  const [busy, setBusy] = useState(false);
  const load = () => getTakip().then(setData).catch(() => {});
  useEffect(() => { load(); }, []);
  const act = (p: Promise<TakipData>, ok?: string) => {
    setBusy(true);
    return p.then(d => { setData(d); flash(d.not || ok || 'Tamam'); }).catch(e => flash(e.message)).finally(() => setBusy(false));
  };
  if (!data) return null;
  return (
    <>
      <label>Takip · {data.kanallar.length} kanal/hesap{data.oneriler.length ? ` · ${data.oneriler.length} yetenek önerisi` : ''}</label>
      <p className="muted small">Kanal adı, @kullanıcı adı ya da link yazın. YouTube kanallarının yeni videolarından Jarvis kendine yetenek önerisi çıkarır; öneriler Yetenekler listesinde kapalı gelir, açınca kullanılır. Instagram, TikTok ve X hesapları listede tutulur (giriş yapmadan yeni gönderileri alınamıyor).</p>
      <form className="memory-add" onSubmit={e => { e.preventDefault(); if (kim.trim()) act(addTakip(kim.trim(), platform)).then(() => setKim('')); }}>
        <select value={platform} onChange={e => setPlatform(e.target.value as SosyalPlatform)} disabled={busy}>
          {(Object.keys(PLATFORM_AD) as SosyalPlatform[]).map(p => <option key={p} value={p}>{PLATFORM_AD[p]}</option>)}
        </select>
        <input value={kim} onChange={e => setKim(e.target.value)} placeholder="ör. Ali Usta, @kullanici ya da https://youtube.com/@kanal" disabled={busy} />
        <button type="submit" disabled={!kim.trim() || busy}>{busy ? '…' : 'Takip et'}</button>
      </form>
      {data.kanallar.length > 0 && (
        <Kutu baslik={`Takip edilenler (${data.kanallar.length})`} ozet={`${data.kanallar.reduce((t, k) => t + k.ogrenilen_yetenek, 0)} yetenek önerisi çıkarıldı`}>
          <ul className="memory">
            {data.kanallar.map(k => (
              <li key={k.id}>
                <span><i className="tag">{PLATFORM_AD[k.platform]}</i> <a href={k.url} target="_blank" rel="noopener noreferrer">{k.ad}</a></span>
                <em>{k.ogrenilen_yetenek ? `${k.ogrenilen_yetenek} öneri` : k.platform === 'youtube' ? 'izleniyor' : 'listede'}</em>
                <button aria-label="Takipten çık" onClick={() => act(removeTakip(k.id), 'Takipten çıkarıldı')}>✕</button>
              </li>
            ))}
          </ul>
        </Kutu>
      )}
      {data.kanallar.some(k => k.platform === 'youtube') && (
        <div className="seg"><button disabled={busy} onClick={() => act(checkTakip(), 'Yeni videolar kontrol edildi')}>{busy ? 'Kontrol ediliyor…' : 'Yeni videolara şimdi bak'}</button></div>
      )}
    </>
  );
}
