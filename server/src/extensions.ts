// Yetenekler: kullanıcının eklediği beceriler (SKILL.md), iş akışları ve MCP sunucuları.
// - Beceri / iş akışı: Markdown talimat. Sistem prompt'unda yalnızca adı ve açıklaması durur; model ihtiyaç duyunca
//   `yetenek_kullan` aracıyla tam metni okur (her istekte uzun talimatlar gönderilmesin).
// - MCP sunucusu: araçları Jarvis'in araçlarına "mcp_<sunucu>_<araç>" adıyla eklenir.
// - GitHub'dan kurulum: repo server/data/eklentiler altına klonlanır, içindeki SKILL.md, commands/ ve workflows/
//   Markdown'ları, .mcp.json ve Node MCP paketleri bulunur. MCP sunucuları bilgisayarda program çalıştırdığı için
//   kapalı eklenir; kullanıcı Ayarlar'dan açar.
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express, { type Router } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { adminOnly } from './keys.js';
import { logError } from './errors.js';
import { propose } from './approvals.js';
import { logActivity } from './activity.js';

const run = promisify(execFile);
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DATA, 'extensions.json');
const REPOS = path.join(DATA, 'eklentiler');
const WIN = process.platform === 'win32';

export type SkillKind = 'beceri' | 'is_akisi';
export interface Skill {
  id: string; ad: string; aciklama: string; tur: SkillKind; icerik: string; aktif: boolean; repo?: string; dosya?: string;
  /** 'jarvis': Jarvis'in kendi yazdığı (yetenek_olustur); 'takip': takip edilen bir kanaldan çıkarılan öneri */
  kaynak?: 'jarvis' | 'takip';
  /** 'takip' önerisinin geldiği video/gönderi adresi */
  kaynakUrl?: string;
  /** Becerinin repo içindeki klasörü (references/ gibi ek dosyaları yetenek_kullan ile okunabilir) */
  klasor?: string;
}
export interface McpServer {
  id: string; ad: string; aktif: boolean; repo?: string;
  tur: 'stdio' | 'http';
  komut?: string; argumanlar?: string[]; cwd?: string; env?: Record<string, string>;
  url?: string; basliklar?: Record<string, string>;
  /** OAuth kapsamları (ör. ["mcp:tools"]) */
  kapsam?: string[];
  /** Açılmadan önce repoda çalıştırılacak kurulum (Node paketi: npm install [+ build]) */
  kurulum?: 'npm';
  /** Kullanıcı elle kapattı: otomatik açma bunu açmaz */
  elleKapali?: boolean;
}
interface Repo { slug: string; url: string; at: string }
interface Store { skills: Skill[]; servers: McpServer[]; repos: Repo[]; /** Yeni ve kapalı MCP sunucuları kendiliğinden açılsın (varsayılan: evet) */ otoAc?: boolean }

const MAX_SKILL = 40_000;
const MAX_TOOL_OUT = 8_000;
const MAX_MCP_TOOLS = 80;

function load(): Store {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { skills: s.skills ?? [], servers: s.servers ?? [], repos: s.repos ?? [], otoAc: s.otoAc };
  } catch {
    return { skills: [], servers: [], repos: [] };
  }
}
let store = load();
function save() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

let broadcast: (e: object) => void = () => {};
const changed = () => broadcast({ type: 'extensions' });

const norm = (t: string) => t.toLocaleLowerCase('tr').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
// Türkçe küçük harf kuralı kullanılmaz: 'AI4Finance' → 'aı4finance' → 'a-4finance' oluyordu
const slugify = (s: string) => s.replace(/ı/g, 'i').replace(/İ/g, 'I').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'yetenek';

// ---------------------------------------------------------------- Markdown → beceri

/** Basit YAML ön bölümü: yalnızca "anahtar: değer" satırları (name, description). */
function frontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    // Çok satırlı değer ("description: >" ya da "|"): girintili satırlar tek satırda birleşir
    if (/^[>|][-+]?$/.test(v)) {
      const more: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
      v = more.join(' ');
    }
    meta[kv[1].toLowerCase()] = v.replace(/^(["'])(.*)\1$/, '$2').trim();
  }
  return { meta, body: md.slice(m[0].length) };
}

function skillFrom(md: string, fallbackName: string, tur: SkillKind, extra: Partial<Skill> = {}): Skill {
  const { meta, body } = frontmatter(md);
  const firstLine = body.split(/\r?\n/).map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return {
    id: randomUUID().slice(0, 8),
    ad: (meta.name || fallbackName).slice(0, 80),
    aciklama: (meta.description || firstLine).slice(0, 400),
    tur,
    icerik: md.slice(0, MAX_SKILL),
    aktif: true,
    ...extra,
  };
}

// ---------------------------------------------------------------- MCP bağlantıları

interface Live { client: Client; tools: { name: string; description?: string; inputSchema: any }[]; error?: undefined; girisGerekli?: undefined }
interface Dead { error: string; client?: undefined; tools?: undefined; girisGerekli?: boolean }
const live = new Map<string, Live | Dead>();
/** Modelin gördüğü araç adı → (sunucu, araç) */
const toolIndex = new Map<string, { server: string; tool: string }>();
const installing = new Set<string>();

// ---------------------------------------------------------------- MCP OAuth (uzak sunucularda giriş)
// Tarayıcıda yetki verildikten sonra sağlayıcı http://localhost:<PORT>/api/extensions/oauth/callback adresine döner.
// İstemci kaydı, anahtarlar ve PKCE doğrulayıcısı server/data/mcp-oauth/<id>.json'da (git'e girmez).
const OAUTH_DIR = path.join(DATA, 'mcp-oauth');
const pendingAuth = new Map<string, string>();
const authTransports = new Map<string, StreamableHTTPClientTransport>();
const oauthState = new Map<string, string>();
interface OAuthStore { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string }
const oauthFile = (id: string) => path.join(OAUTH_DIR, `${id.replace(/[^\w-]/g, '')}.json`);
const readOAuth = (id: string): OAuthStore => { try { return JSON.parse(fs.readFileSync(oauthFile(id), 'utf8')); } catch { return {}; } };
const writeOAuth = (id: string, patch: Partial<OAuthStore>) => {
  fs.mkdirSync(OAUTH_DIR, { recursive: true });
  fs.writeFileSync(oauthFile(id), JSON.stringify({ ...readOAuth(id), ...patch }, null, 2));
};
const redirectUrl = () => `http://localhost:${process.env.PORT || 8787}/api/extensions/oauth/callback`;

function oauthProvider(s: McpServer): OAuthClientProvider {
  return {
    get redirectUrl() { return redirectUrl(); },
    get clientMetadata() {
      return { client_name: 'Jarvis', redirect_uris: [redirectUrl()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(s.kapsam?.length ? { scope: s.kapsam.join(' ') } : {}) };
    },
    state: () => {
      const st = randomUUID();
      oauthState.set(st, s.id);
      return st;
    },
    clientInformation: () => readOAuth(s.id).client,
    saveClientInformation: client => writeOAuth(s.id, { client }),
    tokens: () => readOAuth(s.id).tokens,
    saveTokens: tokens => writeOAuth(s.id, { tokens }),
    redirectToAuthorization: url => { pendingAuth.set(s.id, url.href); },
    saveCodeVerifier: verifier => writeOAuth(s.id, { verifier }),
    codeVerifier: () => {
      const v = readOAuth(s.id).verifier;
      if (!v) throw new Error('PKCE doğrulayıcısı yok; girişi baştan başlatın');
      return v;
    },
    invalidateCredentials: scope => {
      const cur = readOAuth(s.id);
      if (scope === 'all') fs.rmSync(oauthFile(s.id), { force: true });
      else if (scope === 'tokens') writeOAuth(s.id, { ...cur, tokens: undefined });
      else if (scope === 'client') writeOAuth(s.id, { ...cur, client: undefined });
      else if (scope === 'verifier') writeOAuth(s.id, { ...cur, verifier: undefined });
    },
  };
}

async function finishOAuth(state: string, code: string): Promise<McpServer> {
  const id = oauthState.get(state);
  const s = store.servers.find(x => x.id === id);
  const t = id ? authTransports.get(id) : undefined;
  if (!s || !t) throw new Error('Giriş oturumu bulunamadı ya da süresi doldu; Ayarlar\'dan yeniden "Giriş yap"a basın.');
  oauthState.delete(state);
  await t.finishAuth(code);
  pendingAuth.delete(s.id);
  await connect(s);
  changed();
  return s;
}

/** ${VAR} ve ${CLAUDE_PLUGIN_ROOT} yer tutucuları (.mcp.json'larda yaygın) */
function expand(v: string, root?: string): string {
  return v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => (k === 'CLAUDE_PLUGIN_ROOT' && root ? root : process.env[k] ?? ''));
}

/**
 * MCP SDK'sı alt sürece yalnızca güvenli bir değişken alt kümesi verir; proxy ve sertifika ayarları da düşer ve
 * şirket ağında "npx -y …" paketi indiremez. Ağ ayarları geçirilir; Jarvis'in kendi anahtarları geçirilmez.
 */
function netEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v && /^(https?_proxy|no_proxy|all_proxy|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|npm_config_.*)$/i.test(k)) out[k] = v;
  }
  return out;
}

function rebuildIndex() {
  toolIndex.clear();
  for (const s of store.servers) {
    const l = live.get(s.id);
    if (!s.aktif || !l?.tools) continue;
    for (const t of l.tools) {
      if (toolIndex.size >= MAX_MCP_TOOLS) return;
      // OpenAI uyumlu araç adı: ^[a-zA-Z0-9_-]{1,64}$
      let name = `mcp_${slugify(s.ad).replace(/-/g, '_')}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      while (toolIndex.has(name)) name = name.slice(0, 60) + '_' + toolIndex.size;
      toolIndex.set(name, { server: s.id, tool: t.name });
    }
  }
}

async function disconnect(id: string) {
  const l = live.get(id);
  live.delete(id);
  await l?.client?.close().catch(() => {});
}

async function connect(s: McpServer) {
  await disconnect(s.id);
  let stderr = '';
  try {
    const client = new Client({ name: 'jarvis', version: '1.0.0' });
    if (s.tur === 'http') {
      if (!s.url) throw new Error('adres yok');
      const headers = Object.fromEntries(Object.entries(s.basliklar ?? {}).map(([k, v]) => [k, expand(String(v))]));
      // Sunucu giriş isterse (OAuth) yetki adresi kaydedilir; kullanıcı Ayarlar'dan "Giriş yap" ile tamamlar
      const url = new URL(expand(s.url));
      const sseOnly = /\/sse\/?$/.test(url.pathname);
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider: oauthProvider(s) });
      authTransports.set(s.id, transport);
      try {
        if (sseOnly) throw new Error('SSE adresi');
        await client.connect(transport);
      } catch (e) {
        if (e instanceof UnauthorizedError || pendingAuth.has(s.id)) {
          live.set(s.id, { error: 'Giriş gerekli: Ayarlar → Yetenekler → "Giriş yap"', girisGerekli: true });
          console.log(`[yetenek] MCP giriş bekliyor: ${s.ad}`);
          changed();
          return;
        }
        // Eski tür sunucular yalnız SSE konuşur ("Bad Request", 404/405): aynı adresle (ve …/sse ile) SSE dene
        const first = String((e as any)?.message || e);
        await client.close().catch(() => {});
        let ok = false;
        for (const u of sseOnly ? [url] : [url, new URL(url.pathname.replace(/\/(mcp)?\/?$/, '') + '/sse' + url.search, url)]) {
          try {
            // Başlık (anahtar) varsa SSE bağlantısına da eklenir; Headers nesnesi düz nesneye yayılamaz
            const sseFetch = (i: any, init: any) => { const h = new Headers(init?.headers); for (const [k, v] of Object.entries(headers)) h.set(k, v); return fetch(i, { ...init, headers: h }); };
            await client.connect(new SSEClientTransport(u, { requestInit: { headers }, ...(Object.keys(headers).length ? { eventSourceInit: { fetch: sseFetch } as any } : {}) }));
            console.log(`[yetenek] MCP SSE ile bağlandı: ${s.ad} (${u.pathname})`);
            ok = true;
            break;
          } catch (e2: any) {
            await client.close().catch(() => {}); // başarısız denemeden kalan bağlantı sonraki adresi engellemesin
            console.warn(`[yetenek] ${s.ad}: SSE ${u.pathname} olmadı · ${String(e2?.message || e2).slice(0, 80)}`);
          }
        }
        if (!ok) throw new Error(/400|Bad Request/i.test(first)
          ? `Sunucu isteği reddetti (${first.slice(0, 120)}). Adres yanlış olabilir (çoğunlukla …/mcp ya da …/sse ile biter) ya da sunucu bir anahtar/başlık istiyor; sunucunun kurulum sayfasına bakın.`
          : first);
      }
      pendingAuth.delete(s.id);
    } else {
      if (!s.komut) throw new Error('komut yok');
      await resolveCommand(s);
      const env = { ...getDefaultEnvironment(), ...netEnv(), ...Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, expand(v, s.cwd)])) };
      const transport = new StdioClientTransport({
        command: expand(s.komut, s.cwd),
        args: (s.argumanlar ?? []).map(a => expand(a, s.cwd)),
        cwd: s.cwd,
        env,
        stderr: 'pipe',
      });
      // Sunucunun son çıktısı hata mesajına eklenir (eksik anahtar, Python yok vb. buradan anlaşılır)
      transport.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-400); });
      await client.connect(transport);
    }
    const { tools } = await Promise.race([
      client.listTools(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('araç listesi 20 sn içinde gelmedi')), 20_000)),
    ]);
    live.set(s.id, { client, tools });
    console.log(`[yetenek] MCP bağlandı: ${s.ad} · ${tools.length} araç`);
  } catch (e: any) {
    const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' · ');
    live.set(s.id, { error: `${String(e?.message || e).slice(0, 200)}${tail ? ` — ${tail}` : ''}` });
    console.warn(`[yetenek] MCP bağlanamadı: ${s.ad} · ${String(e?.message || e).slice(0, 160)}`);
    logError(`mcp:${s.ad}`, live.get(s.id)?.error ?? e);
  }
  rebuildIndex();
}

// ---------------------------------------------------------------- Komut bulunamazsa ("'mcptoon' is not recognized")

const onPath = (cmd: string) => spawnSync(WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true }).status === 0;

/** Çalışan bir Python (Windows'ta Microsoft Store kısayolu sahte "python" olabilir: sürümü sorulur) */
function findPython(): string[] | null {
  // Yeni kurulan Python bu süreçte PATH'te olmayabilir: kullanıcı kurulum klasörü de denenir
  const local = WIN ? (() => { try { const d = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python'); return fs.readdirSync(d).filter(x => /^Python3\d+$/.test(x)).sort().reverse().map(x => [path.join(d, x, 'python.exe')]); } catch { return []; } })() : [];
  for (const c of WIN ? [['py', '-3'], ['python'], ['python3'], ...local] : [['python3'], ['python']]) {
    const r = spawnSync(c[0], [...c.slice(1), '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (r.status === 0 && /Python 3\.(1\d|[89])/.test(`${r.stdout}${r.stderr}`)) return c;
  }
  return null;
}

/** pip'in kurduğu komutun tam yolu (Scripts klasörleri PATH'te olmayabilir) */
function pythonScript(py: string[], name: string): string | null {
  const r = spawnSync(py[0], [...py.slice(1), '-c', "import sysconfig,os;print(sysconfig.get_path('scripts'));print(sysconfig.get_path('scripts', os.name+'_user'))"], { encoding: 'utf8', windowsHide: true });
  for (const dir of String(r.stdout ?? '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    for (const f of WIN ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name]) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

async function registryHas(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  return !!r?.ok;
}

/**
 * MCP sunucusunun komutu bilgisayarda yoksa (ör. "mcptoon serve", "uvx …"): Python paketi ise pip ile kurulur ve tam
 * yolu kullanılır; npm paketi ise npx ile çalıştırılır. Kullanıcı sunucuyu kendisi açtığı için kurulum (npm install
 * gibi) ayrıca sorulmaz. Bulunan yol kaydedilir; sonraki açılışta tekrar aranmaz.
 */
export async function resolveCommand(s: McpServer) {
  const cmd = s.komut!;
  if (path.isAbsolute(cmd) ? fs.existsSync(cmd) : onPath(cmd)) return;
  // uvx yoksa: uv'yi pip ile kurup "python -m uv tool run …"
  if (cmd === 'uvx' || cmd === 'uv') {
    const py = findPython();
    if (!py) { offerPython(s); throw new Error(`"${cmd}" (uv) için Python gerekiyor ve bilgisayarda yok. Ekrandaki onay kartını onaylarsanız Jarvis Python'un en son sürümünü kurar ve sunucuyu kendisi açar.`); }
    installing.add(s.id); changed();
    try {
      console.log(`[yetenek] ${s.ad}: uv kuruluyor (pip)`);
      await run(py[0], [...py.slice(1), '-m', 'pip', 'install', '--user', '--quiet', 'uv'], { timeout: 10 * 60_000, windowsHide: true });
    } finally { installing.delete(s.id); }
    s.argumanlar = [...py.slice(1), '-m', 'uv', ...(cmd === 'uvx' ? ['tool', 'run'] : []), ...(s.argumanlar ?? [])];
    s.komut = py[0];
    save();
    return;
  }
  if (!/^[\w.-]+$/.test(cmd)) throw new Error(`"${cmd}" komutu bulunamadı.`);
  // Dil/çalışma ortamı komutları paket deposunda aranmaz (PyPI'de "php" adlı alakasız bir paket bile var)
  const RUNTIME: Record<string, string> = {
    php: 'PHP gerekiyor ve bu sunucu bir PHP/Laravel projesinin içinde çalışır (ör. "php artisan …"); Jarvis için uygun değil. Ayarlar → Yetenekler\'den kaldırabilirsiniz.',
    composer: 'PHP Composer gerekiyor; bu sunucu bir PHP projesi içindir.', docker: 'Docker Desktop gerekiyor (https://www.docker.com/products/docker-desktop). Kurduktan sonra sunucuyu tekrar açın.',
    java: 'Java gerekiyor (winget install EclipseAdoptium.Temurin.21.JRE).', ruby: 'Ruby gerekiyor.', go: 'Go gerekiyor.', dotnet: '.NET gerekiyor (winget install Microsoft.DotNet.SDK.8).',
    cargo: 'Rust gerekiyor.', deno: 'Deno gerekiyor (winget install DenoLand.Deno).', bun: 'Bun gerekiyor (winget install Oven-sh.Bun).', bash: 'Bu sunucu Linux/macOS kabuğu (bash) içindir.', sh: 'Bu sunucu Linux/macOS kabuğu içindir.',
  };
  if (RUNTIME[cmd.toLowerCase()]) throw new Error(`"${cmd}" bulunamadı: ${RUNTIME[cmd.toLowerCase()]}`);
  // Paket deposunda aynı adlı başka (kötü niyetli) bir paket olabilir: yalnızca reponun kendisi o paketi işaret ediyorsa kur
  const evidence = repoMentions(s, cmd);
  const py = findPython();
  const already = py && pythonScript(py, cmd);
  if (already) { s.komut = already; save(); return; }
  if (evidence.pip && await registryHas(`https://pypi.org/pypi/${encodeURIComponent(cmd)}/json`)) {
    if (!py) { offerPython(s); throw new Error(`"${cmd}" bir Python programı ama bilgisayarda Python yok. Ekrandaki onay kartını onaylarsanız Jarvis Python'u kurar ve sunucuyu kendisi açar.`); }
    installing.add(s.id); changed();
    try {
      console.log(`[yetenek] ${s.ad}: pip install ${cmd}`);
      await run(py[0], [...py.slice(1), '-m', 'pip', 'install', '--user', '--quiet', '--disable-pip-version-check', cmd], { timeout: 10 * 60_000, windowsHide: true });
    } finally { installing.delete(s.id); }
    const p = pythonScript(py, cmd);
    if (!p) throw new Error(`"${cmd}" kuruldu ama komutu bulunamadı; Jarvis'i yeniden başlatıp tekrar deneyin.`);
    s.komut = p;
    save();
    console.log(`[yetenek] ${s.ad}: ${cmd} → ${p}`);
    return;
  }
  if (evidence.npm && await registryHas(`https://registry.npmjs.org/${encodeURIComponent(cmd)}`)) {
    s.argumanlar = ['-y', cmd, ...(s.argumanlar ?? [])];
    s.komut = 'npx';
    save();
    return;
  }
  throw new Error(`"${cmd}" komutu bu bilgisayarda yok${evidence.pip || evidence.npm ? ' ve paket deposunda bulunamadı' : '; reponun talimatında nasıl kurulacağı yazmıyor'}. Sunucunun kurulum sayfasına bakın.`);
}

/** Repo (README, pyproject, package.json, kurulum dosyaları) bu komutun paketini nasıl kurduğunu söylüyor mu? Elle eklenen sunucuda kullanıcı yazdığı için kabul. */
export function repoMentions(s: McpServer, cmd: string): { pip: boolean; npm: boolean } {
  const dir = s.repo ? path.join(REPOS, s.repo) : s.cwd;
  if (!dir || !fs.existsSync(dir)) return { pip: true, npm: true };
  const e = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let text = '';
  for (const f of walk(dir).filter(f => /(readme[^/\\]*|pyproject\.toml|package\.json|setup\.(py|cfg)|\.mcp\.json|mcp\.json|install[^/\\]*\.md)$/i.test(f)).slice(0, 40)) {
    try { text += fs.readFileSync(f, 'utf8').slice(0, 200_000) + '\n'; } catch { /* atla */ }
  }
  return {
    pip: new RegExp(`(pip3? install( -U| --upgrade| --user)* ${e}\\b|pipx install ${e}\\b|uv tool install ${e}\\b|uvx ${e}\\b|name\\s*=\\s*["']${e}["'])`, 'i').test(text),
    npm: new RegExp(`(npm (i|install)( -g| --global)* ${e}\\b|npx( -y)? ${e}\\b|"name"\\s*:\\s*"${e}")`, 'i').test(text),
  };
}

/** winget'teki en yeni kararlı Python 3 sürümü (ör. Python.Python.3.14); bulunamazsa 3.13 */
export function latestPythonId(): string {
  const r = spawnSync('winget', ['search', '--id', 'Python.Python.3', '--source', 'winget', '--accept-source-agreements', '--disable-interactivity'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const n = [...String(r.stdout ?? '').matchAll(/\bPython\.Python\.3\.(\d+)\b/g)].map(m => Number(m[1])).filter(x => x >= 10 && x < 40);
  return `Python.Python.3.${n.length ? Math.max(...n) : 13}`;
}

/** Python kurulumu için onay kartı (aynı sunucu için bu çalışmada bir kez) */
const pythonOffered = new Set<string>();
function offerPython(s: McpServer) {
  if (!WIN || pythonOffered.has(s.id)) return;
  pythonOffered.add(s.id);
  const id = latestPythonId();
  propose('uygulama', `Python ${id.replace('Python.Python.', '')} kur (${s.ad} MCP sunucusu için)`, `winget install -e --id ${id} --scope user`, `"${s.ad}" bir Python programı. Onaylarsanız Python'un en son sürümü (${id.replace('Python.Python.', '')}, python.org, resmî) kurulur ve sunucu kendiliğinden açılır. Birkaç dakika sürer.`, async () => {
    await run('winget', ['install', '-e', '--id', id, '--scope', 'user', '--accept-package-agreements', '--accept-source-agreements', '--silent'], { timeout: 20 * 60_000, windowsHide: true });
    if (!findPython()) return 'Python kuruldu ama henüz bulunamadı; Jarvis\'i yeniden başlatıp sunucuyu tekrar açın.';
    if (s.aktif) enableServer(s);
    return `Python kuruldu; ${s.ad} sunucusu açılıyor.`;
  });
}

/** Derleme gereken (node-gyp) npm paketleri için C++ derleme araçları kurulum kartı */
const buildToolsOffered = new Set<string>();
function offerBuildTools(s: McpServer) {
  if (!WIN || buildToolsOffered.has(s.id)) return;
  buildToolsOffered.add(s.id);
  propose('uygulama', `C++ derleme araçlarını kur (${s.ad} için)`, 'winget install Microsoft.VisualStudio.2022.BuildTools (C++ masaüstü geliştirme)', `"${s.ad}" kurulurken derleme gereken bir paket var (ör. better-sqlite3) ve bilgisayarda derleme araçları yok. Onaylarsanız Microsoft'un resmî Build Tools paketi kurulur (yaklaşık 2-4 GB, 10-20 dakika) ve sunucu tekrar kurulur.`, async () => {
    await run('winget', ['install', '-e', '--id', 'Microsoft.VisualStudio.2022.BuildTools', '--accept-package-agreements', '--accept-source-agreements', '--override', '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'], { timeout: 60 * 60_000, windowsHide: true });
    s.kurulum = 'npm';
    save();
    if (s.aktif) enableServer(s);
    return `Derleme araçları kuruldu; ${s.ad} tekrar kuruluyor.`;
  });
}

/** Node MCP paketi: bağımlılıkları kur, gerekiyorsa derle. */
async function installNode(s: McpServer) {
  if (!s.cwd) return;
  installing.add(s.id);
  changed();
  try {
    console.log(`[yetenek] ${s.ad}: npm install`);
    await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: s.cwd, shell: WIN, timeout: 10 * 60_000 });
    const entry = s.argumanlar?.[0] ? path.resolve(s.cwd, s.argumanlar[0]) : '';
    const pkg = JSON.parse(fs.readFileSync(path.join(s.cwd, 'package.json'), 'utf8'));
    if (entry && !fs.existsSync(entry) && pkg.scripts?.build) {
      console.log(`[yetenek] ${s.ad}: npm run build`);
      await run('npm', ['run', 'build'], { cwd: s.cwd, shell: WIN, timeout: 10 * 60_000 });
    }
    delete s.kurulum;
    save();
  } finally {
    installing.delete(s.id);
  }
}

async function enableServer(s: McpServer) {
  try {
    if (s.kurulum === 'npm') await installNode(s);
    await connect(s);
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e);
    if (/gyp ERR|node-gyp|MSBuild|Visual Studio|prebuild-install/i.test(msg)) {
      offerBuildTools(s);
      live.set(s.id, { error: 'kurulum başarısız: derleme gereken bir paket var (ör. better-sqlite3) ve bilgisayarda C++ derleme araçları yok. Ekrandaki onay kartıyla kurulabilir (2-4 GB) ya da bu sunucuyu kaldırabilirsiniz.' });
    } else live.set(s.id, { error: `kurulum başarısız: ${msg.slice(-300)}` });
  }
  changed();
}

/**
 * Kullanıcının istediği hazır paketler: Jarvis açılışta, daha önce kurulmadıysa bir kez kendiliğinden kurar
 * (MCP sunucuları yine kapalı gelir). Kurulum bitince işaret dosyası yazılır; kullanıcı bir repoyu kaldırırsa
 * tekrar kurulmaz. RIFKI: kullanıcının 110 repoluk listesinden Jarvis'e beceri olarak yarayan 16 repo.
 */
const AUTO_PACKAGES: Record<string, string[]> = {
  rifki: [
    'coreyhaines31/marketingskills', 'AgriciDaniel/claude-seo', 'AgriciDaniel/claude-ads', 'Ryze-AI-Adgent/open-seo-mcp-skills',
    'fajrisilmi12-cyber/hermes-socmed-function', 'hardikpandya/stop-slop', 'calesthio/OpenMontage', 'heygen-com/hyperframes',
    'haidrrrry/claude-remotion-skill', 'AI4Finance-Foundation/FinRobot', 'xbtlin/ai-berkshire', 'obra/superpowers',
    'muratcankoylan/agent-skills-for-context-engineering', 'nextlevelbuilder/ui-ux-pro-max-skill', 'vercel-labs/skills', 'cloudflare/security-audit-skill',
  ],
  // Ramazan'ın istediği Claude Code eklentileri: yalnızca beceri/komut klasörleri (uygulamanın tamamı değil)
  'claude-eklentileri': [
    'obra/superpowers',
    'JuliusBrussee/caveman/tree/main/skills',
    'anthropics/claude-plugins-official/tree/main/plugins/claude-code-setup',
    'anthropics/claude-plugins-official/tree/main/plugins/claude-security',
    'anthropics/claude-code-security-review',
    'diegosouzapw/OmniRoute/tree/main/skills',
  ],
  // skills.sh arama becerisi (yetenek_bul aracıyla birlikte: "şunun için beceri var mı?")
  'find-skills': ['vercel-labs/skills/tree/main/skills/find-skills'],
  // YouTube kanalı becerileri (senaryo, başlık/küçük resim, SEO, Shorts, bölümler, izlenme analizi…); yalnız talimat + yerel Python araçları
  youtube: ['Jakeschincariol/youtube-agent-skill'],
  // Yapay zeka kokan metni ("sadece X değil, Y", tumturaklı kapanışlar…) insan yazısı gibi düzeltir; yalnız talimat
  humanizer: ['blader/humanizer'],
  // Video: Remotion'un resmî becerileri; After Effects'i yöneten MCP (After Effects kurulu olmalı; MCP kapalı gelir)
  video: ['remotion-dev/skills', 'TheLlamainator/after-effects-mcp'],
};

/**
 * Kullanıcının istediği uzak (barındırılan) MCP sunucuları: bir kez, KAPALI eklenir. Açınca hesapla giriş istenir
 * (Ayarlar → Yetenekler → "Giriş yap"); üretimler o hesabın kredisinden düşer.
 */
const AUTO_SERVERS: { key: string; ad: string; url: string }[] = [
  // Resmî: https://docs.heygen.com/docs/heygen-remote-mcp-server
  { key: 'heygen', ad: 'HeyGen', url: 'https://mcp.heygen.com/mcp/v1/' },
  // Higgsfield'ın barındırılan bağlantısı (OAuth)
  { key: 'higgsfield', ad: 'Higgsfield', url: 'https://mcp.higgsfield.ai/mcp' },
];
function autoAddServers() {
  let added = 0;
  for (const a of AUTO_SERVERS) {
    const mark = path.join(DATA, `sunucu-${a.key}.eklendi`);
    if (fs.existsSync(mark)) continue;
    if (!store.servers.some(x => x.url === a.url)) {
      store.servers.push({ id: randomUUID().slice(0, 8), ad: a.ad, aktif: false, tur: 'http', url: a.url });
      added++;
    }
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(mark, new Date().toISOString());
  }
  if (added) { save(); changed(); console.log(`[yetenek] ${added} uzak MCP sunucusu eklendi`); }
}
const packageMark = (name: string) => path.join(DATA, `paket-${name}.kuruldu`);

async function autoInstallPackages() {
  for (const [name, repos] of Object.entries(AUTO_PACKAGES)) {
    if (fs.existsSync(packageMark(name))) continue;
    const have = new Set(store.repos.map(r => r.url.replace('https://github.com/', '').toLowerCase()));
    const todo = repos.filter(r => !have.has(r.toLowerCase()));
    console.log(`[yetenek] "${name}" paketi kuruluyor (${todo.length} repo; arka planda, birkaç dakika)…`);
    if (todo.length) await runBulk(todo.map(r => `https://github.com/${r}`));
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(packageMark(name), new Date().toISOString());
  }
}

const otoAc = () => store.otoAc !== false;

/**
 * Otomatik açma: elle kapatılmamış bütün sunucular açılır ve bağlanır. Aynı anda en fazla 3 sunucu kurulur/bağlanır
 * (npm install'lar bilgisayarı kilitlemesin). Açılamayanlar "hata" olarak kalır; Ayarlar'dan tek tuşla silinebilir.
 */
async function startServers(list: McpServer[]) {
  const queue = [...list];
  const worker = async () => { for (let s = queue.shift(); s; s = queue.shift()) await enableServer(s); };
  await Promise.all([worker(), worker(), worker()]);
}
function autoEnable(): McpServer[] {
  if (!otoAc()) return [];
  const opened = store.servers.filter(s => !s.aktif && !s.elleKapali);
  for (const s of opened) s.aktif = true;
  if (opened.length) { save(); console.log(`[yetenek] ${opened.length} MCP sunucusu otomatik açıldı: ${opened.map(s => s.ad).join(', ')}`); }
  return opened;
}

/** Bozuk sayılan: açık ama bağlanamamış / kurulamamış (giriş bekleyen, kurulan ve bağlanmakta olan değil) */
const isBroken = (s: McpServer) => {
  const l = live.get(s.id);
  return s.aktif && !installing.has(s.id) && !!l?.error && !l.girisGerekli;
};

/** Sunucuyu kaldırır; repodan geldiyse ve repoda başka bir şey kalmadıysa repo klasörü de silinir */
async function deleteServer(id: string) {
  const s = store.servers.find(x => x.id === id);
  await disconnect(id);
  store.servers = store.servers.filter(x => x.id !== id);
  rebuildIndex();
  save();
  if (s?.repo && !store.servers.some(x => x.repo === s.repo) && !store.skills.some(x => x.repo === s.repo)) await removeRepo(s.repo);
  changed();
}

/** Bozuk sunucuları ve toplu kurulumda kurulamayan repo satırlarını temizler */
export async function removeBroken(): Promise<string[]> {
  const broken = store.servers.filter(isBroken);
  for (const s of broken) await deleteServer(s.id);
  const failed = bulk.liste.filter(i => i.durum === 'hata');
  if (failed.length && !bulk.calisiyor) bulk.liste = bulk.liste.filter(i => i.durum !== 'hata');
  if (broken.length || failed.length) console.log(`[yetenek] bozuk temizlendi: ${broken.map(s => s.ad).join(', ') || '-'} · ${failed.length} kurulamayan repo satırı`);
  changed();
  return [...broken.map(s => s.ad), ...failed.map(i => i.url.replace('https://github.com/', ''))];
}

export function initExtensions(b: (e: object) => void) {
  broadcast = b;
  autoAddServers();
  autoEnable();
  startServers(store.servers.filter(s => s.aktif));
  // Sunucu açılışını bekletmesin
  setTimeout(() => autoInstallPackages().catch(e => console.warn('[yetenek] paket kurulamadı:', e)), 5000);
}

// ---------------------------------------------------------------- Model tarafı

const active = () => store.skills.filter(s => s.aktif);

/** Sistem prompt'una eklenen kısa liste (tam metin yetenek_kullan ile okunur) */
/** Sistem prompt'unda adıyla listelenen en fazla yetenek: yüzlerce beceri her istekte gönderilmesin */
const PROMPT_LIMIT = 25;

/**
 * Takip edilen kanallardan çıkarılan yetenek ÖNERİSİ: kapalı eklenir (internetten gelen içerik Jarvis'in davranışını
 * kullanıcı onaylamadan değiştirmesin). Aynı kaynaktan aynı adla ikinci kez eklenmez.
 */
export function addSuggestedSkill(o: { ad: string; aciklama: string; icerik: string; tur: SkillKind; kaynakUrl: string; aktif?: boolean }): Skill | null {
  const ad = o.ad.trim().slice(0, 80);
  if (!ad || store.skills.some(x => x.kaynakUrl === o.kaynakUrl || (x.kaynak === 'takip' && x.ad === ad))) return null;
  const sk: Skill = { ...skillFrom(o.icerik.slice(0, MAX_SKILL), ad, o.tur), ad, aciklama: o.aciklama.slice(0, 400) || ad, kaynak: 'takip', kaynakUrl: o.kaynakUrl, aktif: !!o.aktif };
  store.skills.push(sk);
  save();
  changed();
  return sk;
}

/** Takip önerilerini açar (ada göre; 'hepsi' ile tümü). Açılanların adlarını döndürür. */
export function activateSuggestions(names: string[] | 'hepsi'): string[] {
  const want = names === 'hepsi' ? null : names.map(n => n.toLocaleLowerCase('tr'));
  const list = store.skills.filter(x => x.kaynak === 'takip' && !x.aktif && (!want || want.some(w => x.ad.toLocaleLowerCase('tr').includes(w))));
  list.forEach(x => { x.aktif = true; });
  if (list.length) { save(); changed(); }
  return list.map(x => x.ad);
}

/** Kurulu repoların owner/name listesi (küçük harf) */
export const installedRepos = () => new Set(store.repos.map(r => r.url.replace('https://github.com/', '').split('/tree/')[0].toLowerCase()));

export const pendingSuggestions = () => store.skills.filter(x => x.kaynak === 'takip' && !x.aktif).map(x => ({ ad: x.ad, aciklama: x.aciklama, kaynak: x.kaynakUrl }));

export function extensionsForPrompt(): string {
  const list = active();
  const mcp = store.servers.filter(s => s.aktif && live.get(s.id)?.tools?.length);
  if (!list.length && !mcp.length) return '(Yüklü yetenek yok.)';
  const line = (s: Skill) => `- ${s.ad} [${s.tur === 'is_akisi' ? 'iş akışı' : 'beceri'}]: ${s.aciklama.slice(0, 160)}`;
  let lines: string[];
  if (list.length <= PROMPT_LIMIT) lines = list.map(line);
  else {
    // Önce kullanıcının ve Jarvis'in kendi yazdıkları, sonra repolar yalnızca adı ve beceri sayısıyla
    const own = list.filter(s => !s.repo).slice(0, PROMPT_LIMIT);
    const byRepo = new Map<string, number>();
    for (const s of list) if (s.repo) byRepo.set(s.repo, (byRepo.get(s.repo) ?? 0) + 1);
    const repoName = (slug: string) => store.repos.find(r => r.slug === slug)?.url.replace('https://github.com/', '') ?? slug;
    lines = [
      ...own.map(line),
      `- Ayrıca GitHub'dan kurulu ${list.length - own.length} beceri/iş akışı var (${[...byRepo].map(([r, n]) => `${repoName(r)}: ${n}`).join(', ')}). Bunların adlarını bilmiyorsun: uygun olanı \`yetenek_ara\` ile anahtar kelimeyle bul, sonra \`yetenek_kullan\` ile oku.`,
    ];
  }
  if (mcp.length) lines.push(`- Bağlı MCP sunucuları: ${mcp.map(s => s.ad).join(', ')} (araçları "mcp_" ile başlar)`);
  return lines.join('\n');
}

export const YETENEK_TOOL = {
  type: 'function',
  function: {
    name: 'yetenek_kullan',
    description: 'Yüklü bir becerinin ya da iş akışının tam talimatlarını getirir. İstek "Yetenekler" listesindeki bir yeteneğe uyuyorsa önce bunu çağır, sonra talimatlara göre çalış.',
    parameters: {
      type: 'object',
      properties: {
        ad: { type: 'string', description: 'Yeteneğin listedeki adı' },
        dosya: { type: 'string', description: 'İsteğe bağlı: becerinin ek dosyası (ek_dosyalar listesindeki yol, ör. references/catalog.md)' },
      },
      required: ['ad'],
    },
  },
} as const;

/** Kendini geliştirme: Jarvis kendine beceri yazar ya da GitHub'dan yetenek kurar (MCP sunucuları yine kapalı gelir). */
/** Beceriler çoğunlukla İngilizce: sık kullanılan Türkçe kelimeler İngilizce karşılıklarıyla da aranır */
const TR_EN: Record<string, string[]> = {
  reklam: ['ads', 'ad', 'advertising'], reklamlar: ['ads'], pazarlama: ['marketing'], tanitim: ['marketing', 'promotion'],
  arama: ['search', 'seo'], sosyal: ['social'], medya: ['media'], gonderi: ['post'], paylasim: ['post', 'posting'],
  icerik: ['content'], metin: ['copy', 'copywriting', 'text'], yazi: ['writing', 'copy'], baslik: ['headline', 'title'],
  eposta: ['email'], 'e-posta': ['email'], mail: ['email'], bulten: ['newsletter'], musteri: ['customer'],
  satis: ['sales'], fiyat: ['pricing', 'price'], rakip: ['competitor', 'competitive'], analiz: ['analysis', 'audit'],
  tasarim: ['design', 'ui', 'ux'], logo: ['brand', 'logo'], marka: ['brand'], gorsel: ['image', 'visual'], resim: ['image'],
  video: ['video'], kurgu: ['edit', 'editing'], montaj: ['edit', 'editing'], ses: ['audio', 'voice'], muzik: ['music'],
  animasyon: ['animation', 'motion'], altyazi: ['subtitle', 'caption'],
  finans: ['finance', 'financial'], hisse: ['stock', 'equity'], borsa: ['stock', 'market', 'trading'], alim: ['trading', 'buy'], satim: ['trading', 'sell'], ticaret: ['trading'], kripto: ['crypto'], ajan: ['agent'], yatirim: ['investment', 'invest'],
  bilanco: ['earnings', 'financial statements'], kazanc: ['earnings'], sirket: ['company'], portfoy: ['portfolio'],
  guvenlik: ['security'], kod: ['code', 'coding'], test: ['test', 'testing'], hata: ['debug', 'bug'],
  web: ['web', 'website'], site: ['website', 'site'], sayfa: ['page', 'landing'], uygulama: ['app'],
};

export const EXT_TOOLS = [
  YETENEK_TOOL,
  {
    type: 'function',
    function: {
      name: 'yetenek_ara',
      description: 'Kurulu beceri ve iş akışları arasında anahtar kelimeyle arar (ad ve açıklamada). Çok sayıda yetenek kuruluyken isteğe uygun olanı bulmak için önce bunu kullan; sonra yetenek_kullan ile oku. İngilizce kelimeler de dene (beceriler çoğunlukla İngilizce).',
      parameters: { type: 'object', properties: { sorgu: { type: 'string', description: 'Ör. "seo", "instagram reklam", "video edit", "earnings"' } }, required: ['sorgu'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'yetenek_olustur',
      description: "Kendine yeni bir beceri ya da iş akışı yazar veya aynı adlı, senin yazdığın bir yeteneği günceller. Kullanıcı 'bunu öğren', 'bundan sonra şöyle yap', 'bunu iş akışı yap', 'kendini geliştir' dediğinde ya da tekrar eden bir isteği kalıcı hale getirmek istediğinde kullanılır.",
      parameters: {
        type: 'object',
        properties: {
          ad: { type: 'string', description: 'Kısa ad, ör. "Sabah rutini"' },
          aciklama: { type: 'string', description: 'Ne zaman kullanılacağı, tek cümle (listede bu görünür)' },
          tur: { type: 'string', enum: ['beceri', 'is_akisi'], description: 'is_akisi: sırayla uygulanacak adımlar; beceri: bir konuda nasıl davranılacağı' },
          icerik: { type: 'string', description: 'Markdown talimat ya da numaralı adımlar. Hangi araçların çağrılacağını açıkça yaz.' },
        },
        required: ['ad', 'aciklama', 'tur', 'icerik'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'yetenek_kur',
      description: "Bir GitHub reposundaki becerileri, iş akışlarını ve MCP sunucularını kurar. Kullanıcı bir GitHub linki verip 'bunu kur', 'bu yeteneği ekle' dediğinde kullanılır. MCP sunucuları (otomatik açma açıksa) kendiliğinden açılıp bağlanır; bağlanamayanlar Ayarlar → Yetenekler'de 'hata' görünür ve mcp_yonet ile silinebilir.",
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'https://github.com/kullanici/repo' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'yetenek_bul',
      description: "İnternetteki açık beceri kataloğunda (skills.sh, find-skills) kurulmamış yeni beceri arar: kurulum sayısı ve kaynak repoyla. 'Şunun için beceri/yetenek var mı', 'kendini geliştir', 'X yapmayı öğren' isteklerinde ve yetenek_ara kurulu becerilerde bir şey bulamadığında kullan. Sonuçları söyle; kullanıcı isterse yetenek_kur ile kur.",
      parameters: { type: 'object', properties: { sorgu: { type: 'string', description: 'İngilizce anahtar kelimeler, ör. "instagram reels", "trading bot", "seo audit"' } }, required: ['sorgu'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_yonet',
      description: "Kurulu MCP sunucularının durumunu söyler (bağlı / hata / giriş gerekli / kapalı) ya da bozuk olanları (kurulamayan, bağlanamayan) siler. 'MCP'ler çalışıyor mu', 'bozuk MCP'leri sil', 'hatalı eklentileri temizle' isteklerinde.",
      parameters: { type: 'object', properties: { islem: { type: 'string', enum: ['durum', 'bozuklari_sil', 'hepsini_ac'] } }, required: ['islem'] },
    },
  },
] as const;

/** skills.sh arama API'si (npx skills find ile aynı); güvenilirlik için kurulum sayısı ve bilinen kaynaklar öne alınır */
const TRUSTED = /^(anthropics|vercel-labs|microsoft|openai|google|cloudflare|supabase|obra)\//i;
async function findSkills(q: string) {
  const r = await fetch(`${process.env.SKILLS_API_URL || 'https://skills.sh'}/api/search?${new URLSearchParams({ q, limit: '15' })}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`skills.sh ${r.status}`);
  const data: any = await r.json();
  const have = installedRepos();
  return (Array.isArray(data?.skills) ? data.skills : []).map((x: any) => {
    const source = String(x.source ?? '').replace(/[^\w./-]/g, '');
    return {
      ad: String(x.name ?? x.id ?? '').slice(0, 80), kaynak: source, kurulum: Number(x.installs) || 0,
      guvenilir: TRUSTED.test(source) || (Number(x.installs) || 0) >= 1000,
      kurulu: have.has(source.toLowerCase()),
      kur_url: source ? `https://github.com/${source}` : undefined,
      sayfa: x.id ? `https://skills.sh/${String(x.id).replace(/[^\w./@-]/g, '')}` : undefined,
    };
  }).sort((a: any, b: any) => Number(b.guvenilir) - Number(a.guvenilir) || b.kurulum - a.kurulum).slice(0, 8);
}

export function mcpTools() {
  const out: any[] = [];
  for (const [name, ref] of toolIndex) {
    const t = (live.get(ref.server) as Live | undefined)?.tools.find(x => x.name === ref.tool);
    if (!t) continue;
    const { $schema, ...schema } = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} };
    out.push({ type: 'function', function: { name, description: (t.description || t.name).slice(0, 1000), parameters: { type: 'object', properties: {}, ...schema } } });
  }
  return out;
}

export const isExtensionTool = (name: string) => EXT_TOOLS.some(t => t.function.name === name) || toolIndex.has(name);

export async function runExtensionTool(name: string, args: any, progress: (l: string) => void): Promise<string> {
  if (name === 'mcp_yonet') {
    if (args.islem === 'bozuklari_sil') {
      progress('bozuk MCP sunucuları siliniyor');
      const silinen = await removeBroken();
      return JSON.stringify({ silinen, not: silinen.length ? 'Silinenleri söyle; istenirse aynı repo tekrar kurulabilir.' : 'Silinecek bozuk sunucu yoktu.' });
    }
    if (args.islem === 'hepsini_ac') {
      store.otoAc = true;
      for (const s of store.servers) delete s.elleKapali;
      const acilan = autoEnable();
      startServers(acilan);
      changed();
      return JSON.stringify({ acilan: acilan.map(s => s.ad), not: 'Sunucular arka planda kuruluyor/bağlanıyor; birkaç dakika sürebilir.' });
    }
    return JSON.stringify({ otomatik_ac: otoAc(), sunucular: view().servers.map(s => ({ ad: s.ad, durum: s.durum, hata: s.hata?.slice(0, 160), arac: s.araclar.length })) });
  }
  if (name === 'yetenek_ara') {
    const words = [...new Set(norm(String(args.sorgu ?? '')).split(/\s+/).filter(w => w.length > 1).flatMap(w => [w, ...(TR_EN[w] ?? [])]))];
    if (!words.length) return JSON.stringify({ hata: 'sorgu boş' });
    const scored = active().map(s => {
      const ad = norm(s.ad), ac = norm(s.aciklama);
      const puan = words.reduce((t, w) => t + (ad.includes(w) ? 3 : 0) + (ac.includes(w) ? 1 : 0), 0);
      return { s, puan };
    }).filter(x => x.puan > 0).sort((a, b) => b.puan - a.puan).slice(0, 12);
    progress(`yetenek arandı: ${args.sorgu} · ${scored.length} sonuç`);
    return JSON.stringify(scored.length
      ? { sonuclar: scored.map(({ s }) => ({ ad: s.ad, tur: s.tur, aciklama: s.aciklama.slice(0, 300) })) }
      : { sonuc: 'Uygun yetenek bulunamadı; başka (İngilizce) kelimelerle dene ya da kendin yap.' });
  }
  if (name === 'yetenek_bul') {
    const q = String(args.sorgu ?? '').trim().slice(0, 100);
    if (!q) return JSON.stringify({ hata: 'sorgu boş' });
    progress(`skills.sh: ${q}`);
    try {
      const list = await findSkills(q);
      return JSON.stringify(list.length
        ? { sonuclar: list, not: 'Kurulum sayısı 100\'ün altındaki ve bilinmeyen kaynaklı becerileri önerirken dikkatli ol. Kullanıcı isterse yetenek_kur ile kur_url\'yi kur.' }
        : { sonuc: 'Katalogda uygun beceri bulunamadı; başka İngilizce kelimeler dene ya da yetenek_olustur ile kendin yaz.' });
    } catch (e: any) {
      return JSON.stringify({ hata: `Beceri kataloğuna ulaşılamadı: ${String(e?.message || e).slice(0, 120)}` });
    }
  }
  if (name === 'yetenek_kullan') {
    const q = String(args.ad ?? '').toLocaleLowerCase('tr').trim();
    const s = active().find(x => x.ad.toLocaleLowerCase('tr') === q) ?? active().find(x => x.ad.toLocaleLowerCase('tr').includes(q));
    if (!s) return JSON.stringify({ hata: `"${args.ad}" adında aktif yetenek yok.`, mevcut: active().map(x => x.ad) });
    // Beceri klasöründeki ek dosyalar (references/ vb.): talimatlar bunlara atıf yapıyorsa dosya ile okunur
    const dir = s.repo && s.klasor !== undefined ? path.join(REPOS, s.repo, s.klasor) : null;
    if (dir && args.dosya) {
      const f = path.resolve(dir, String(args.dosya));
      if (!f.startsWith(dir + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return JSON.stringify({ hata: `"${args.dosya}" bu becerinin klasöründe yok` });
      progress(`yetenek: ${s.ad} · ${args.dosya}`);
      return JSON.stringify({ ad: s.ad, dosya: args.dosya, icerik: fs.readFileSync(f, 'utf8').slice(0, MAX_SKILL) });
    }
    const ekler = dir && fs.existsSync(dir) ? walk(dir).map(f => path.relative(dir, f).split(path.sep).join('/')).filter(f => f !== 'SKILL.md' && /\.(md|txt|json|ya?ml)$/i.test(f)).slice(0, 60) : [];
    progress(`yetenek: ${s.ad}`);
    return JSON.stringify({ ad: s.ad, tur: s.tur, talimatlar: s.icerik, ek_dosyalar: ekler.length ? ekler : undefined, not: `Talimatları uygula; cevabı yine sahne JSON şemasında ver.${ekler.length ? ' Talimat bir ek dosyaya atıf yaparsa yetenek_kullan\'ı aynı adla ve dosya ile çağır.' : ''}` });
  }
  if (name === 'yetenek_olustur') {
    const icerik = String(args.icerik ?? '').trim().slice(0, MAX_SKILL);
    const ad = String(args.ad ?? '').trim().slice(0, 80);
    if (!icerik || !ad) return JSON.stringify({ hata: 'ad ya da içerik boş' });
    const tur: SkillKind = args.tur === 'is_akisi' ? 'is_akisi' : 'beceri';
    const aciklama = String(args.aciklama ?? '').trim().slice(0, 400);
    // Yalnızca kendi yazdığı yeteneği günceller; kullanıcının ya da repoların yeteneklerine dokunmaz
    const mine = store.skills.find(x => x.kaynak === 'jarvis' && x.ad.toLocaleLowerCase('tr') === ad.toLocaleLowerCase('tr'));
    if (mine) Object.assign(mine, { aciklama, tur, icerik, aktif: true });
    else store.skills.push({ ...skillFrom(icerik, ad, tur), ad, aciklama: aciklama || ad, kaynak: 'jarvis' });
    save();
    changed();
    progress(`${mine ? 'yetenek güncellendi' : 'yeni yetenek'}: ${ad}`);
    console.log(`[yetenek] Jarvis ${mine ? 'güncelledi' : 'öğrendi'}: ${ad} (${tur})`);
    return JSON.stringify({ ok: true, ad, tur, guncellendi: !!mine });
  }
  if (name === 'yetenek_kur') {
    progress(`GitHub'dan kuruluyor: ${String(args.url ?? '').replace('https://github.com/', '')}`);
    try {
      const r = await installFromGitHub(String(args.url ?? ''));
      return JSON.stringify({ ok: true, ...r, not: r.mcp ? 'MCP sunucuları kapalı eklendi; kullanıcı Ayarlar → Yetenekler bölümünden açmalı.' : undefined, yetenekler: store.skills.filter(s => s.repo === r.slug).map(s => s.ad).slice(0, 30) });
    } catch (e: any) {
      return JSON.stringify({ hata: String(e?.message || e) });
    }
  }
  const ref = toolIndex.get(name)!;
  const l = live.get(ref.server);
  const srv = store.servers.find(s => s.id === ref.server);
  if (!l?.client) return JSON.stringify({ hata: `${srv?.ad ?? 'MCP'} bağlı değil.` });
  progress(`${srv?.ad ?? 'mcp'}: ${ref.tool}`);
  try {
    const r: any = await l.client.callTool({ name: ref.tool, arguments: args ?? {} }, undefined, { timeout: 120_000 });
    const text = (r.content ?? []).map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n') || JSON.stringify(r.structuredContent ?? {});
    return JSON.stringify({ sonuc: text.slice(0, MAX_TOOL_OUT), hata: r.isError ? true : undefined });
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 300) });
  }
}

// ---------------------------------------------------------------- GitHub'dan kurulum

const GH = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w./-]+?))?\/?$/;

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Tek bir parçayı (link, git@ adresi, kullanici/repo) https://github.com/kullanici/repo[/tree/…] biçimine çevirir */
function toRepoUrl(token: string, bare: boolean): string | null {
  const t = token.trim().replace(/^[<("'`]+|[>)"'`.,;]+$/g, '');
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(t);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  const web = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:(\/tree\/[^?#\s]*[^?#\s/])\/?(?:[?#].*)?|(?:[/?#].*)?)$/i.exec(t);
  // Linkte kodlanmış "/" (skills%2Ffind-skills) ya da boşluk olabilir
  if (web) return `https://github.com/${web[1]}/${web[2]}${web[3] ? safeDecode(web[3]) : ''}`;
  if (bare && /^[\w.-]+\/[\w.-]+$/.test(t) && !t.startsWith('.')) return `https://github.com/${t.replace(/\.git$/, '')}`;
  return null;
}

/** Metindeki GitHub repolarını bulur: düz linkler, "gh repo clone kullanici/repo", "git clone https://….git",
 *  git@github.com:… adresleri, /blob/… ya da ?tab=… ekli linkler ve satırda tek başına "kullanici/repo". */
export function extractRepoUrls(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n|,/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
      .replace(/([^\s(<"'`])(https?:\/\/)/gi, '$1 $2').trim(); // madde işaretleri; yazıya yapışık link ("Brand24https://…")
    if (!line) continue;
    const tokens = line.split(/\s+/);
    const cmd = /^(?:gh\s+repo\s+clone|git\s+clone)\s+/i.test(line);
    // Komutta "kullanici/repo" kısa yazımı da olabilir (gh repo clone); komut dışında yalnızca satırda tek başınaysa
    const skip = cmd ? (/^gh$/i.test(tokens[0]) ? 3 : 2) : 0;
    tokens.forEach((tk, i) => {
      const u = i >= skip && !tk.startsWith('-') ? toRepoUrl(tk, cmd || tokens.length === 1) : null;
      if (u) out.push(u);
    });
  }
  return [...new Set(out)];
}
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__']);

function walk(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 2000) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !(e.name === '.github' && depth === 0)) walk(path.join(dir, e.name), depth + 1, out);
    } else out.push(path.join(dir, e.name));
  }
  return out;
}

/** Repodaki yetenekleri bulur; hiçbir şey eklemez. */
function scan(root: string, slug: string) {
  const files = walk(root);
  const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
  const skills: Skill[] = [];
  const servers: McpServer[] = [];

  // Beceri klasörleri: içlerindeki references/, workflows/ gibi .md'ler becerinin parçasıdır, ayrı iş akışı sayılmaz
  const skillDirs = files.filter(f => path.basename(f) === 'SKILL.md').map(f => path.dirname(f));
  const inSkill = (f: string) => skillDirs.some(d => f !== path.join(d, 'SKILL.md') && f.startsWith(d + path.sep));
  for (const f of files) {
    const r = rel(f);
    const base = path.basename(f);
    if (base === 'SKILL.md') {
      skills.push(skillFrom(fs.readFileSync(f, 'utf8'), path.basename(path.dirname(f)) || slug, 'beceri', { repo: slug, dosya: r, klasor: rel(path.dirname(f)) }));
    } else if (!inSkill(f) && (/(^|\/)(commands|workflows)\/[^/]+\.md$/i.test(r) || /\.workflow\.md$/i.test(base))) {
      skills.push(skillFrom(fs.readFileSync(f, 'utf8'), base.replace(/(\.workflow)?\.md$/i, ''), 'is_akisi', { repo: slug, dosya: r }));
    }
  }

  // MCP tanımları (Claude / Cursor / Codex eklentileri): repo içinde herhangi bir yerde. Aynı sunucu birden çok
  // dosyada olabilir; Claude biçimi önce gelir. İki biçim var: {"mcpServers": {...}} ve doğrudan {"ad": {...}}.
  const cfgRank = (f: string) => ['.mcp.claude.json', '.mcp.json', 'mcp.json'].indexOf(path.basename(f));
  const cfgFiles = files.filter(f => cfgRank(f) >= 0).sort((a, b) => cfgRank(a) - cfgRank(b));
  for (const f of cfgFiles) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const map = j.mcpServers ?? j.servers ?? (Object.values(j).every((v: any) => v && typeof v === 'object' && (v.url || v.command)) ? j : {});
      for (const [ad, c] of Object.entries<any>(map)) {
        const ex = servers.find(x => x.ad === ad);
        // Aynı sunucunun başka dosyadaki tanımında OAuth kapsamı varsa (Codex biçimi) onu da al
        if (ex) { if (Array.isArray(c?.scopes) && !ex.kapsam) ex.kapsam = c.scopes.map(String); continue; }
        if (!c?.url && !c?.command) continue;
        const http = typeof c.url === 'string';
        const dir = path.dirname(f);
        servers.push({
          id: randomUUID().slice(0, 8), ad, aktif: false, repo: slug,
          tur: http ? 'http' : 'stdio',
          ...(http ? { url: c.url, basliklar: c.headers ?? c.http_headers, kapsam: Array.isArray(c.scopes) ? c.scopes.map(String) : undefined } : { komut: c.command, argumanlar: c.args ?? [], env: c.env, cwd: dir }),
        });
      }
    } catch { /* bozuk dosya: atla */ }
  }

  // MCP tanımı yoksa: kökte MCP SDK'sı kullanan bir Node paketi mi?
  const pkgFile = path.join(root, 'package.json');
  if (!servers.length && fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['@modelcontextprotocol/sdk']) {
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && Object.values<string>(pkg.bin)[0];
        const entry = bin || pkg.main || 'index.js';
        servers.push({ id: randomUUID().slice(0, 8), ad: pkg.name || slug, aktif: false, repo: slug, tur: 'stdio', komut: 'node', argumanlar: [entry], cwd: root, kurulum: 'npm' });
      }
    } catch { /* bozuk package.json */ }
  }
  return { skills, servers };
}

/**
 * Reponun tamamını değil yalnızca Jarvis'in kullandığı parçalarını indirir: önce dosya listesi (içeriksiz),
 * sonra beceri klasörleri, commands/workflows Markdown'ları, MCP tanımları ve kök package.json. Kök package.json
 * MCP SDK'sı kullanıyorsa (npm install gerekecek) repo tamamen açılır. Videolu/görselli repolar yüzlerce MB
 * yerine birkaç MB tutar.
 */
async function sparseClone(url: string, dir: string, branch?: string, sub = '') {
  const git = (...a: string[]) => run('git', ['-C', dir, ...a], { timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  await run('git', ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', ...(branch ? ['--branch', branch] : []), url, dir], { timeout: 5 * 60_000 });
  const files = (await git('ls-tree', '-r', '--name-only', 'HEAD')).stdout.split('\n').filter(Boolean)
    .filter(f => !sub || f === sub || f.startsWith(sub + '/'));
  const rel = (f: string) => (sub ? f.slice(sub.length + 1) : f);
  let full = false;
  let bigApp = false;
  const rootPkg = sub ? `${sub}/package.json` : 'package.json';
  if (files.includes(rootPkg)) {
    const pkg = (await git('show', `HEAD:${rootPkg}`).catch(() => ({ stdout: '' }))).stdout;
    // MCP kütüphanesini kullanan küçük bir paket = MCP sunucusu (tamamı indirilir). Binlerce dosyalık bir uygulama
    // (ör. OmniRoute gibi bir yapay zeka ağ geçidi) MCP'yi yalnızca bir özelliği olarak kullanır: tamamı indirilmez,
    // MCP sunucusu sanılmaz; yalnızca becerileri ve README'si alınır.
    const sdk = pkg.includes('@modelcontextprotocol/sdk');
    bigApp = sdk && files.length > 3000;
    full = sdk && !bigApp;
  }
  if (!full) {
    const skillDirs = files.filter(f => /(^|\/)SKILL\.md$/.test(f)).map(f => path.posix.dirname(f));
    const keep = new Set<string>();
    for (const d of skillDirs) keep.add(d === '.' ? '/*' : `/${d}/`);
    for (const f of files) {
      const r = rel(f);
      if (/(^|\/)(commands|workflows)\/[^/]+\.md$/i.test(r) && !r.startsWith('.github/')) keep.add(`/${f}`);
      if (/\.workflow\.md$/i.test(r) || /(^|\/)(\.mcp\.claude\.json|\.mcp\.json|mcp\.json)$/.test(r) || (r === 'package.json' && !bigApp) || r === 'README.md') keep.add(`/${f}`);
    }
    // Uygulama repoları için bilgi kaynağı: kökteki README ve yapay zeka rehberleri her zaman alınır
    for (const f of ['README.md', 'readme.md', 'README_EN.md', 'CLAUDE.md', 'AGENTS.md']) if (files.includes(sub ? `${sub}/${f}` : f)) keep.add(`/${sub ? `${sub}/` : ''}${f}`);
    if (!keep.size) keep.add('/README.md');
    // Beceri klasörlerindeki örnek video/ses/arşivler Jarvis'e gerekmez (bir repoda 100 MB'ı bunlar tutuyordu)
    await git('sparse-checkout', 'set', '--no-cone', ...keep, ...['mp4', 'mov', 'webm', 'mkv', 'avi', 'mp3', 'wav', 'flac', 'ogg', 'zip', 'tar', 'gz', '7z', 'psd'].map(e => `!*.${e}`));
  }
  await git('checkout');
  // Güncelleme yeniden kurulumla yapılır; geçmiş ve nesne deposu yalnızca yer kaplar
  if (!full) fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
}

/** Uygulama reposunu tanıtan bilgi becerisi: README + CLAUDE.md/AGENTS.md (varsa) */
function referenceSkill(root: string, slug: string, repoName: string): Skill | null {
  const read = (f: string) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  const readme = read('README.md') || read('readme.md') || read('README_EN.md');
  const guides = ['CLAUDE.md', 'AGENTS.md'].map(f => [f, read(f)] as const).filter(([, t]) => t.trim());
  if (!readme.trim() && !guides.length) return null;
  // README'nin ilk anlamlı paragrafı açıklama olur (başlık, rozet ve görsel satırları atlanır)
  const intro = readme.split(/\r?\n\s*\r?\n/).map(p => p.replace(/<[^>]+>|!\[[^\]]*\]\([^)]*\)|\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim())
    .find(p => p.length > 40 && !/^[\[(!]/.test(p)) ?? '';
  const icerik = [
    `# ${repoName} (bilgi kaynağı)`,
    `Bu bir uygulama reposu; Jarvis onu çalıştırmaz. Kullanıcı bu proje hakkında soru sorarsa (ne işe yarar, nasıl kurulur, nasıl kullanılır) aşağıdaki belgelere dayanarak cevap ver. Kurulum isterse komutları açıkla; bilgisayarda çalıştırmak gerekirse bilgisayar_komut ile onay kartıyla öner. Kaynak: https://github.com/${repoName}`,
    readme && `## README\n${readme}`,
    ...guides.map(([f, t]) => `## ${f}\n${t}`),
  ].filter(Boolean).join('\n\n');
  return {
    id: randomUUID().slice(0, 8),
    ad: repoName.split('/')[1],
    aciklama: `${repoName} projesi hakkında bilgi: ${intro.slice(0, 220) || 'README'}`,
    tur: 'beceri',
    icerik: icerik.slice(0, MAX_SKILL),
    aktif: true,
    repo: slug,
    dosya: 'README.md',
    klasor: '',
  };
}

/** mcpKapali: repodaki MCP sunucuları kapalı eklenir ve otomatik açılmaz (günlük otomatik keşifte güvenlik için) */
export async function installFromGitHub(url: string, o: { mcpKapali?: boolean } = {}) {
  const m = GH.exec(extractRepoUrls(url)[0] ?? '');
  if (!m) throw new Error('Geçerli bir GitHub repo adresi değil (ör. https://github.com/kullanici/repo ya da gh repo clone kullanici/repo).');
  const [, owner, name, sub] = m;
  // Alt klasör kurulumunda klasör adı sona eklenir ve kısaltmada korunur (aynı repodaki iki eklenti çakışmasın)
  const last = sub ? slugify(sub.split('/').pop()!).slice(0, 24) : '';
  let slug = last ? `${slugify(`${owner}-${name}`).slice(0, 39 - last.length).replace(/-$/, '')}-${last}` : slugify(`${owner}-${name}`);
  if (store.repos.some(r => r.slug === slug)) throw new Error('Bu repo zaten kurulu. Güncellemek için önce kaldırın.');
  fs.mkdirSync(REPOS, { recursive: true });
  const dir = path.join(REPOS, slug);
  fs.rmSync(dir, { recursive: true, force: true });

  // Alt klasör linki: /tree/<dal>/<yol>. Dal adında "/" olabilir; önce ilk parçayı dal sayıp deneriz.
  const parts = sub?.split('/') ?? [];
  const branch = parts[0];
  try {
    await sparseClone(`https://github.com/${owner}/${name}.git`, dir, branch, parts.slice(1).join('/'));
  } catch (e: any) {
    fs.rmSync(dir, { recursive: true, force: true });
    const msg = String(e?.stderr || e?.message || e).trim();
    throw new Error(/not found|does not exist|Repository not found|could not read Username|Authentication failed/i.test(msg)
      ? `GitHub'da "${owner}/${name}" bulunamadı: adres yanlış, repo silinmiş ya da özel (gizli) olabilir.`
      : /Remote branch .* not found/i.test(msg) ? `"${branch}" dalı bulunamadı; linkteki /tree/... kısmını kontrol edin.`
      : `Repo indirilemedi: ${msg.split('\n').pop()}`);
  }
  const root = parts.length > 1 ? path.join(dir, ...parts.slice(1)) : dir;
  if (!root.startsWith(dir) || !fs.existsSync(root)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('Linkteki klasör repoda bulunamadı.');
  }

  const found = scan(root, slug);
  let bilgi = false;
  if (!found.skills.length && !found.servers.length) {
    // Beceri/MCP içermeyen bir uygulama reposu: README ve AI rehberleri bilgi kaynağı olarak eklenir; kod çalıştırılmaz
    const ref = referenceSkill(root, slug, `${owner}/${name}`);
    if (!ref) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error('Repo indirildi ama içinde ne yetenek (SKILL.md, commands/, workflows/, .mcp.json) ne de README var.');
    }
    found.skills.push(ref);
    bilgi = true;
  }
  if (o.mcpKapali) for (const x of found.servers) { x.aktif = false; x.elleKapali = true; }
  store.repos.push({ slug, url, at: new Date().toISOString() });
  store.skills.push(...found.skills);
  store.servers.push(...found.servers);
  save();
  if (found.servers.length) startServers(autoEnable());
  changed();
  console.log(`[yetenek] GitHub: ${owner}/${name} → ${found.skills.length} beceri/iş akışı, ${found.servers.length} MCP`);
  logActivity('yetenek', `GitHub'dan kuruldu: ${owner}/${name} (${bilgi ? 'bilgi kaynağı' : `${found.skills.length} beceri/iş akışı, ${found.servers.length} MCP`})`);
  return { slug, bilgi, beceri: bilgi ? 0 : found.skills.filter(s => s.tur === 'beceri').length, is_akisi: found.skills.filter(s => s.tur === 'is_akisi').length, mcp: found.servers.length };
}

async function removeRepo(slug: string) {
  // Yalnızca kayıtlı repolar (slug URL'den gelir; "..", data klasörünü sildirmesin)
  if (!store.repos.some(r => r.slug === slug)) return;
  for (const s of store.servers.filter(x => x.repo === slug)) await disconnect(s.id);
  store.skills = store.skills.filter(s => s.repo !== slug);
  store.servers = store.servers.filter(s => s.repo !== slug);
  store.repos = store.repos.filter(r => r.slug !== slug);
  rebuildIndex();
  save();
  fs.rmSync(path.join(REPOS, slug), { recursive: true, force: true });
  changed();
}

// ---------------------------------------------------------------- HTTP

// ---------------------------------------------------------------- Toplu kurulum

interface BulkItem { url: string; durum: 'bekliyor' | 'kuruluyor' | 'tamam' | 'atlandı' | 'hata'; mesaj?: string }
const bulk: { calisiyor: boolean; liste: BulkItem[] } = { calisiyor: false, liste: [] };

async function runBulk(urls: string[]) {
  bulk.calisiyor = true;
  bulk.liste = urls.map(url => ({ url, durum: 'bekliyor' }));
  changed();
  for (const item of bulk.liste) {
    item.durum = 'kuruluyor';
    changed();
    try {
      const r = await installFromGitHub(item.url);
      item.durum = 'tamam';
      item.mesaj = r.bilgi ? 'uygulama: README bilgi kaynağı olarak eklendi' : [r.beceri && `${r.beceri} beceri`, r.is_akisi && `${r.is_akisi} iş akışı`, r.mcp && `${r.mcp} MCP${otoAc() ? '' : ' (kapalı)'}`].filter(Boolean).join(', ');
    } catch (e: any) {
      const m = String(e?.message || e);
      item.durum = /zaten kurulu/i.test(m) ? 'atlandı' : 'hata';
      item.mesaj = m.slice(0, 200);
    }
    changed();
  }
  bulk.calisiyor = false;
  console.log(`[yetenek] toplu kurulum bitti: ${bulk.liste.filter(i => i.durum === 'tamam').length}/${bulk.liste.length}`);
  changed();
}

function view() {
  return {
    toplu: bulk,
    otoAc: otoAc(),
    bozuk: store.servers.filter(isBroken).length,
    repos: store.repos,
    skills: store.skills.map(({ icerik, ...s }) => ({ ...s, uzunluk: icerik.length })),
    servers: store.servers.map(s => {
      const l = live.get(s.id);
      return {
        id: s.id, ad: s.ad, aktif: s.aktif, repo: s.repo, tur: s.tur,
        hedef: s.tur === 'http' ? s.url : [s.komut, ...(s.argumanlar ?? [])].join(' '),
        durum: installing.has(s.id) ? 'kuruluyor' : !s.aktif ? 'kapalı' : l?.tools ? 'bağlı' : l?.girisGerekli ? 'giriş gerekli' : l?.error ? 'hata' : 'bağlanıyor',
        girisAdresi: l?.girisGerekli ? pendingAuth.get(s.id) : undefined,
        hata: l?.error, araclar: l?.tools?.map(t => t.name) ?? [],
        kurulum: s.kurulum,
      };
    }),
  };
}

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** "AD=değer" satırları → nesne */
function kvLines(v: unknown): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const l of str(v, 5000).split(/\r?\n/)) {
    const m = /^\s*([^=:\s]+)\s*[=:]\s*(.*)$/.exec(l);
    if (m) out[m[1]] = m[2].trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/** Argümanları boşluktan böler; tırnak içindekileri bir arada tutar. */
const splitArgs = (s: string) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(a => a.replace(/^(["'])(.*)\1$/, '$2'));

export function extensionsRouter(): Router {
  const r = express.Router();
  r.use('/api/extensions', adminOnly);

  r.get('/api/extensions', (_req, res) => res.json(view()));

  r.get('/api/extensions/oauth/callback', async (req, res) => {
    const page = (title: string, msg: string) => res.type('html').send(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;background:#04070c;color:#e8f6ff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${title}</h2><p>${msg}</p></div></body>`);
    const esc = (v: unknown) => String(v ?? '').replace(/[<>&"]/g, '');
    if (req.query.error) return page('Giriş yapılamadı', esc(req.query.error_description || req.query.error));
    try {
      const s = await finishOAuth(String(req.query.state ?? ''), String(req.query.code ?? ''));
      page('Giriş tamamlandı', `${esc(s.ad)} Jarvis'e bağlandı. Bu sekmeyi kapatabilirsiniz.`);
    } catch (e: any) {
      page('Giriş tamamlanamadı', esc(e?.message || e));
    }
  });
  r.post('/api/extensions/server/:id/cikis', async (req, res) => {
    const s = store.servers.find(x => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'bulunamadı' });
    fs.rmSync(oauthFile(s.id), { force: true });
    await disconnect(s.id);
    if (s.aktif) enableServer(s);
    res.json(view());
  });

  r.post('/api/extensions/github-toplu', (req, res) => {
    if (bulk.calisiyor) return res.status(409).json({ error: 'Bir toplu kurulum zaten sürüyor' });
    const urls = extractRepoUrls(str(req.body?.liste, 20_000)).slice(0, 60);
    if (!urls.length) return res.status(400).json({ error: 'Listede GitHub reposu bulunamadı (ör. https://github.com/kullanici/repo ya da gh repo clone kullanici/repo)' });
    runBulk(urls);
    res.json(view());
  });
  r.post('/api/extensions/github', async (req, res) => {
    try {
      // mcpKapali: telefondan (RepoSwipe) kurulanlarda MCP sunucuları kapalı eklenir
      res.json({ ok: true, ...(await installFromGitHub(str(req.body?.url), { mcpKapali: req.body?.mcpKapali === true })), ...view() });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });
  r.delete('/api/extensions/repo/:slug', async (req, res) => {
    await removeRepo(req.params.slug);
    res.json(view());
  });

  r.get('/api/extensions/skill/:id', (req, res) => {
    const s = store.skills.find(x => x.id === req.params.id);
    s ? res.json(s) : res.status(404).json({ error: 'bulunamadı' });
  });
  r.post('/api/extensions/skill', (req, res) => {
    const icerik = str(req.body?.icerik, MAX_SKILL);
    if (!icerik) return res.status(400).json({ error: 'talimat metni boş' });
    const tur: SkillKind = req.body?.tur === 'is_akisi' ? 'is_akisi' : 'beceri';
    const s = skillFrom(icerik, str(req.body?.ad, 80) || 'Yeni yetenek', tur);
    if (str(req.body?.ad)) s.ad = str(req.body.ad, 80);
    if (str(req.body?.aciklama)) s.aciklama = str(req.body.aciklama, 400);
    store.skills.push(s);
    save();
    changed();
    res.json(view());
  });
  r.post('/api/extensions/skill/:id', (req, res) => {
    const s = store.skills.find(x => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'bulunamadı' });
    if (typeof req.body?.aktif === 'boolean') s.aktif = req.body.aktif;
    save();
    changed();
    res.json(view());
  });
  r.delete('/api/extensions/skill/:id', (req, res) => {
    store.skills = store.skills.filter(x => x.id !== req.params.id);
    save();
    changed();
    res.json(view());
  });

  r.post('/api/extensions/server', (req, res) => {
    const url = str(req.body?.url);
    const komut = str(req.body?.komut);
    if (!url && !komut) return res.status(400).json({ error: 'Komut ya da adres gerekli' });
    if (url && !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Adres http(s):// ile başlamalı' });
    const parts = splitArgs(komut);
    const s: McpServer = {
      id: randomUUID().slice(0, 8),
      ad: str(req.body?.ad, 60) || (url ? new URL(url).hostname : parts[parts.length - 1] || 'mcp'),
      aktif: true,
      ...(url ? { tur: 'http' as const, url, basliklar: kvLines(req.body?.basliklar) } : { tur: 'stdio' as const, komut: parts[0], argumanlar: parts.slice(1), env: kvLines(req.body?.env) }),
    };
    store.servers.push(s);
    save();
    enableServer(s);
    changed();
    res.json(view());
  });
  r.post('/api/extensions/server/:id', async (req, res) => {
    const s = store.servers.find(x => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'bulunamadı' });
    if (typeof req.body?.aktif === 'boolean') {
      s.aktif = req.body.aktif;
      if (s.aktif) delete s.elleKapali; else s.elleKapali = true;
      save();
      if (s.aktif) enableServer(s); else { await disconnect(s.id); rebuildIndex(); }
    } else if (req.body?.yenile && s.aktif) enableServer(s);
    changed();
    res.json(view());
  });
  r.delete('/api/extensions/server/:id', async (req, res) => {
    await deleteServer(req.params.id);
    res.json(view());
  });
  r.post('/api/extensions/bozuklari-sil', async (_req, res) => {
    const silinen = await removeBroken();
    res.json({ ...view(), silinen });
  });
  r.post('/api/extensions/oto-ac', (req, res) => {
    store.otoAc = !!req.body?.otoAc;
    save();
    console.log(`[yetenek] MCP otomatik açma: ${store.otoAc ? 'açık' : 'kapalı'}`);
    if (store.otoAc) startServers(autoEnable());
    changed();
    res.json(view());
  });
  return r;
}

/** Günlük rapor için MCP durumu */
export function serverStats() {
  const v = view().servers;
  return { toplam: v.length, bagli: v.filter(s => s.durum === 'bağlı').length, hata: v.filter(s => s.durum === 'hata').map(s => s.ad), beceri: store.skills.filter(s => s.aktif).length };
}
