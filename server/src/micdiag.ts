// Bilgisayarın (Windows) mikrofon ayarlarını okur: kayıt cihazları (etkin/devre dışı/takılı değil), varsayılan kayıt
// cihazı, "Stereo Karışımı" gibi bilgisayarın kendi sesini kaydeden girişler ve Windows gizlilik ayarı (uygulamaların
// mikrofona erişimi). Yalnızca okur; değiştirmez. Kayıt ayarları penceresini açabilir (mmsys.cpl → Kayıt sekmesi).
// Kaynak: HKLM\…\MMDevices\Audio\Capture (DeviceState: 1 etkin, 2 devre dışı, 4 yok, 8 takılı değil; "Role:0" en
// yeni olan varsayılandır) ve HKCU/HKLM\…\CapabilityAccessManager\ConsentStore\microphone.
import { execFile, spawn } from 'node:child_process';

export interface MicDevice { ad: string; arayuz: string; durum: string; varsayilan: boolean; supheli: boolean }
export interface MicReport { windows: boolean; cihazlar: MicDevice[]; varsayilan?: string; erisim: { uygulamalar?: string; masaustu_uygulamalari?: string; sistem?: string }; sorunlar: string[]; oneriler: string[] }

const PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
# Türkçe cihaz adları (Stereo Karışımı) bozulmasın: çıktı UTF-8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
$out = @()
foreach ($k in Get-ChildItem $base) {
  $st = (Get-ItemProperty $k.PSPath).DeviceState
  $p = Get-ItemProperty (Join-Path $k.PSPath 'Properties')
  $name = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
  $if = $p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
  $role = (Get-ItemProperty $k.PSPath).'Role:0'
  $t = 0
  if ($role -is [byte[]] -and $role.Length -ge 16) {
    # SYSTEMTIME (16 bayt): yıl, ay, haftanın günü, gün, saat, dakika, saniye, ms
    $v = @(); for ($i = 0; $i -lt 16; $i += 2) { $v += [BitConverter]::ToUInt16($role, $i) }
    $t = [int64]($v[0] * 1e10 + $v[1] * 1e8 + $v[3] * 1e6 + $v[4] * 1e4 + $v[5] * 1e2 + $v[6])
  }
  $out += [pscustomobject]@{ ad = [string]$name; arayuz = [string]$if; durum = [int]$st; rol = $t }
}
$c = 'Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
$acc = [pscustomobject]@{
  uygulamalar = (Get-ItemProperty "HKCU:\$c").Value
  masaustu = (Get-ItemProperty "HKCU:\$c\NonPackaged").Value
  sistem = (Get-ItemProperty "HKLM:\$c").Value
}
[pscustomobject]@{ cihazlar = $out; erisim = $acc } | ConvertTo-Json -Depth 4 -Compress
`;

const DURUM: Record<number, string> = { 1: 'etkin', 2: 'devre dışı', 4: 'yok', 8: 'takılı değil' };
export const suspicious = (s: string) => /stereo|karışım|karisim|\bmix\b|mixage|what u hear|cable|virtual|sanal|voicemeeter|loopback|wave out/i.test(s);
const erisimTr = (v?: string) => (v === 'Allow' ? 'açık' : v === 'Deny' ? 'KAPALI' : v ? v : undefined);

/** PowerShell çıktısından rapor (test edilebilsin diye ayrı) */
export function buildReport(raw: any): MicReport {
  const list: any[] = Array.isArray(raw?.cihazlar) ? raw.cihazlar : raw?.cihazlar ? [raw.cihazlar] : [];
  const active = list.filter(d => d.durum === 1);
  const def = active.reduce((a: any, d: any) => (!a || d.rol > a.rol ? d : a), null);
  const cihazlar: MicDevice[] = list.filter(d => d.ad || d.arayuz).map(d => ({
    ad: d.ad || 'Ses girişi', arayuz: d.arayuz || '', durum: DURUM[d.durum] ?? String(d.durum),
    varsayilan: d === def && d.rol > 0, supheli: suspicious(`${d.ad} ${d.arayuz}`),
  })).sort((a, b) => Number(b.varsayilan) - Number(a.varsayilan) || Number(b.durum === 'etkin') - Number(a.durum === 'etkin'));
  const erisim = { uygulamalar: erisimTr(raw?.erisim?.uygulamalar), masaustu_uygulamalari: erisimTr(raw?.erisim?.masaustu), sistem: erisimTr(raw?.erisim?.sistem) };
  const sorunlar: string[] = [], oneriler: string[] = [];
  const varsayilan = cihazlar.find(c => c.varsayilan);
  if (!active.length) { sorunlar.push('Etkin hiçbir kayıt cihazı (mikrofon) yok.'); oneriler.push('Mikrofonu takın; Kayıt ayarlarında devre dışı mikrofona sağ tıklayıp "Etkinleştir" deyin.'); }
  if (varsayilan?.supheli) { sorunlar.push(`Varsayılan kayıt cihazı "${varsayilan.ad}" bir mikrofon değil: bilgisayarın kendi sesini kaydediyor. Jarvis sizin yerinize bilgisayarda çalan sesi duyuyor.`); oneriler.push('Kayıt ayarlarında gerçek mikrofonunuza sağ tıklayıp "Varsayılan Cihaz Olarak Ayarla" deyin; Stereo Karışımı\'na sağ tıklayıp "Devre Dışı Bırak" deyin. Ya da Jarvis → Ayarlar → Mikrofon · test\'ten mikrofonu seçin.'); }
  else if (cihazlar.some(c => c.supheli && c.durum === 'etkin')) oneriler.push('"Stereo Karışımı" gibi bir giriş etkin; kullanmıyorsanız Kayıt ayarlarından devre dışı bırakın (yanlışlıkla seçilmesin).');
  if (erisim.sistem === 'KAPALI' || erisim.uygulamalar === 'KAPALI') { sorunlar.push('Windows gizlilik ayarında mikrofon erişimi KAPALI.'); oneriler.push('Windows Ayarlar → Gizlilik ve güvenlik → Mikrofon → "Mikrofon erişimi" ve "Uygulamaların mikrofonunuza erişmesine izin verin"i açın.'); }
  if (erisim.masaustu_uygulamalari === 'KAPALI') { sorunlar.push('Masaüstü uygulamalarının (tarayıcı dahil) mikrofona erişimi KAPALI.'); oneriler.push('Windows Ayarlar → Gizlilik ve güvenlik → Mikrofon → "Masaüstü uygulamalarının mikrofonunuza erişmesine izin verin"i açın.'); }
  if (!sorunlar.length) oneriler.push('Windows ayarlarında sorun görünmüyor. Ses seviyesini ve tanımayı Jarvis → Ayarlar → Mikrofon · test ile deneyin; seviye düşükse Kayıt ayarları → mikrofon → Özellikler → Düzeyler\'den artırın.');
  return { windows: true, cihazlar, varsayilan: varsayilan?.ad, erisim, sorunlar, oneriler };
}

export function checkMic(): Promise<MicReport> {
  if (process.platform !== 'win32') return Promise.resolve({ windows: false, cihazlar: [], erisim: {}, sorunlar: [], oneriler: ['Bu kontrol yalnızca Windows bilgisayarda çalışır.'] });
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS], { timeout: 20_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(new Error(`Windows ses ayarları okunamadı: ${err.message.slice(0, 120)}`));
      try { resolve(buildReport(JSON.parse(String(stdout).trim() || '{}'))); } catch (e: any) { reject(new Error(`Windows ses ayarları okunamadı: ${e.message}`)); }
    });
  });
}

/** Windows Ses → Kayıt sekmesi (mikrofonu varsayılan yapma / Stereo Karışımı'nı kapatma / düzey) */
export function openRecordingSettings(): boolean {
  if (process.platform !== 'win32') return false;
  spawn('control.exe', ['mmsys.cpl,,1'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return true;
}
export function openPrivacySettings(): boolean {
  if (process.platform !== 'win32') return false;
  spawn('cmd.exe', ['/c', 'start', '', 'ms-settings:privacy-microphone'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

export const MICDIAG_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'mikrofon_kontrol',
      description: "Bilgisayarın Windows mikrofon ayarlarını okur: kayıt cihazları, varsayılan mikrofon, 'Stereo Karışımı' gibi yanlış girişler, Windows gizlilik izinleri; sorunları ve çözümleri söyler. ac: 'kayit' Windows Kayıt ayarları penceresini, 'gizlilik' mikrofon gizlilik ayarını açar. 'Mikrofonuma bak', 'beni yanlış duyuyorsun', 'mikrofon ayarlarını kontrol et' isteklerinde.",
      parameters: { type: 'object', properties: { ac: { type: 'string', enum: ['kayit', 'gizlilik'] } } },
    },
  },
] as const;
export const isMicDiagTool = (n: string) => n === 'mikrofon_kontrol';
export async function runMicDiagTool(a: any, progress: (l: string) => void): Promise<string> {
  try {
    if (a.ac === 'kayit') return JSON.stringify({ ok: openRecordingSettings(), not: 'Windows Ses → Kayıt penceresi açıldı.' });
    if (a.ac === 'gizlilik') return JSON.stringify({ ok: openPrivacySettings(), not: 'Windows mikrofon gizlilik ayarı açıldı.' });
    progress('mikrofon ayarları okunuyor');
    return JSON.stringify({ ...(await checkMic()), not: 'Sorunları ve önerileri kısa ve adım adım söyle. Kayıt ayarlarını açmayı teklif edebilirsin (ac: kayit). Ayrıca Ayarlar → Mikrofon · test ile ses seviyesi ve tanıma denenebilir.' });
  } catch (e: any) {
    return JSON.stringify({ hata: String(e?.message || e).slice(0, 200) });
  }
}
