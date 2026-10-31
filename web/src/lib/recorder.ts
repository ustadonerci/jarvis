// Mikrofon kaydı (MediaRecorder) → sunucuda RouteLLM ile yazıya çevrilir. iPhone'da Web Speech API güvenilir
// olmadığı için asıl yol bu; Web Speech yalnızca yedek. Konuşma bitince (sessizlik) kendiliğinden durur.

export interface Recording { stop(): void }

export function recorderSupported() {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** Tarayıcının kaydedebildiği ilk biçim: Chrome/Android webm, iPhone mp4. */
function pickMime(): string | undefined {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return undefined;
}

// Mikrofon akışı bir süre açık tutulur: her basışta yeniden izin/başlatma (Windows'ta 0,3–1 sn) olmaz, ilk hece
// kaçmaz. Son kullanımdan 2 dk sonra kapatılır (tarayıcının mikrofon işareti de söner).
const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

// Seçili mikrofon (Ayarlar → Mikrofon testi). Windows bazen "Stereo Karışımı" gibi bilgisayarın kendi sesini kaydeden
// bir girişi varsayılan yapıyor: Jarvis kullanıcı yerine çalan videoyu/sesi duyuyordu. Seçim bu tarayıcıda saklanır.
const MIC_KEY = 'jarvis-mic';
export function micDevice(): string {
  try { return localStorage.getItem(MIC_KEY) || ''; } catch { return ''; }
}
/** Seçili cihaz (varsa) + verilen işleme ayarları */
export function micConstraints(extra: MediaTrackConstraints = MIC): MediaTrackConstraints {
  const id = micDevice();
  return { ...extra, ...(id ? { deviceId: { exact: id } } : {}) };
}
/** Bluetooth hoparlör/kulaklığın "Hands-Free" mikrofonu: uzakta, telefon kalitesinde; açılınca hoparlörün sesi de bozulur */
export const isBluetoothMic = (label: string) => /hands-?free|bluetooth|\bbt\b|bth|headset|airpods|buds|eller serbest/i.test(label);

async function openMic(): Promise<MediaStream> {
  let s: MediaStream;
  try { s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() }); }
  catch (e: any) {
    // Seçili cihaz takılı değilse varsayılana dön
    if (micDevice() && /Overconstrained|NotFound/i.test(String(e?.name))) s = await navigator.mediaDevices.getUserMedia({ audio: MIC });
    else throw e;
  }
  // Mikrofon elle seçilmediyse ve Windows varsayılanı bir Bluetooth Hands-Free girişiyse (Bluetooth hoparlör bağlanınca
  // Windows bunu yapıyor), kablolu / dahili bir mikrofon varsa o kullanılır.
  const label = s.getAudioTracks()[0]?.label ?? '';
  if (!micDevice() && isBluetoothMic(label)) {
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    const wired = all.find(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label && !isBluetoothMic(d.label) && !suspiciousMic(d.label));
    if (wired) {
      try {
        const w = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC, deviceId: { exact: wired.deviceId } } });
        s.getTracks().forEach(t => t.stop());
        return w;
      } catch { /* Bluetooth girişiyle devam */ }
    }
  }
  return s;
}
export function setMicDevice(id: string) {
  try { id ? localStorage.setItem(MIC_KEY, id) : localStorage.removeItem(MIC_KEY); } catch { /* yok */ }
  if (warmUsers === 0) { warm?.getTracks().forEach(t => t.stop()); warm = null; }
}
/** Bilgisayarın kendi sesini kaydeden (mikrofon olmayan) girişler */
export const suspiciousMic = (label: string) => /stereo|karışım|karisim|\bmix\b|mixage|cable|virtual|sanal|loopback|voicemeeter|what u hear|wave out|monitor of/i.test(label);
export async function listMics(): Promise<{ id: string; ad: string; supheli: boolean }[]> {
  await warmMic(); // izin verilmeden cihaz adları boş gelir
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications')
    .map(d => ({ id: d.deviceId === 'default' ? '' : d.deviceId, ad: d.label || 'Mikrofon', supheli: suspiciousMic(d.label) }));
}
/** Açık mikrofon akışının ayarları (test ekranı için) */
export function micInfo(): MediaTrackSettings & { label?: string } | null {
  const t = warm?.getAudioTracks()[0];
  return t ? { ...t.getSettings(), label: t.label } : null;
}
let warm: MediaStream | null = null;
let warmUsers = 0;
let warmTimer: ReturnType<typeof setTimeout> | undefined;
// Sessiz (muted) iz de ölü sayılır: hoparlör/kulaklık takılınca Windows girişi değiştirir, eski iz açık kalıp ses vermez
const live = (s: MediaStream | null) => !!s && s.getAudioTracks().some(t => t.readyState === 'live' && !t.muted);

// Ses cihazı takılıp çıkarılınca (hoparlör, kulaklık, USB) açık tutulan mikrofon akışı bırakılır; sonraki kayıt güncel
// cihazla açılır.
try {
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (warmUsers === 0) { warm?.getTracks().forEach(t => t.stop()); warm = null; }
  });
} catch { /* eski tarayıcı */ }

/**
 * Ses vermeyen mikrofon yerine çalışan bir giriş arar: her girişi ~0,7 sn açıp ölçer. Takılı olmayan/kapalı bir
 * giriş tam sessizlik (0) verir; gerçek bir mikrofonda her zaman biraz oda sesi olur. Bilgisayarın kendi sesini
 * kaydeden girişler (Stereo Karışımı) atlanır. Bulunursa seçilir.
 */
export async function findWorkingMic(): Promise<{ id: string; ad: string } | null> {
  const cur = micDevice();
  // Bluetooth Hands-Free girişleri en sona (yalnız başka mikrofon yoksa)
  const mics = (await listMics().catch(() => [])).filter(m => !m.supheli && m.id !== cur).sort((a, b) => Number(isBluetoothMic(a.ad)) - Number(isBluetoothMic(b.ad)));
  if (cur) mics.unshift({ id: '', ad: 'Varsayılan mikrofon', supheli: false });
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    if (ctx.state !== 'running') return null;
    for (const m of mics) {
      let s: MediaStream | null = null;
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC, ...(m.id ? { deviceId: { exact: m.id } } : {}) } });
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        const src = ctx.createMediaStreamSource(s);
        src.connect(an);
        const buf = new Uint8Array(an.fftSize);
        let max = 0;
        for (let i = 0; i < 14; i++) {
          await new Promise(r => setTimeout(r, 50));
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (let k = 0; k < buf.length; k++) { const v = (buf[k] - 128) / 128; sum += v * v; }
          max = Math.max(max, Math.sqrt(sum / buf.length));
        }
        src.disconnect();
        if (max > 0.0008) { setMicDevice(m.id); return { id: m.id, ad: m.ad }; }
      } catch { /* bu giriş açılamadı */ } finally { s?.getTracks().forEach(t => t.stop()); }
    }
    return null;
  } finally {
    ctx.close().catch(() => {});
  }
}

/** Mikrofonu önceden aç (ör. düğmeye basılırken); başarısızsa sessizce geçer */
export async function warmMic(): Promise<MediaStream | null> {
  clearTimeout(warmTimer);
  if (!live(warm)) warm = await openMic().catch(() => null);
  scheduleRelease();
  return warm;
}
function scheduleRelease() {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    if (warmUsers > 0) return scheduleRelease();
    warm?.getTracks().forEach(t => t.stop());
    warm = null;
  }, 120_000);
}

export interface RecordingInfo {
  /** Konuşma (gürültü tabanının belirgin üstünde ses) algılandı mı */
  heard: boolean;
  /** Kayıttaki en yüksek ses seviyesi (0–1 arası RMS). Çok düşükse mikrofon seviyesi kısık ya da yanlış mikrofon. */
  peak: number;
  /** Kaydın süresi (ms): ses tanımanın uydurduğu uzun metni ayıklamak için */
  ms: number;
}

export async function startRecording(h: {
  /** Kayıt; konuşma algılanmadıysa null (sendSilent ise yine de kayıt). info: algılama ve en yüksek seviye */
  onStop(blob: Blob | null, info: RecordingInfo): void;
  onLevel?(level: number): void;
  /** Konuşma başladıktan sonra bu kadar sessizlikte dur (varsayılan 1400 ms) */
  silenceMs?: number;
  /** Hiç konuşma yoksa bu sürede vazgeç (varsayılan 6000 ms) */
  noSpeechMs?: number;
  /** En uzun kayıt (varsayılan 15000 ms) */
  maxMs?: number;
  /** Kullanıcı durdurana kadar kayıt: sessizlikte ya da konuşma yokken kendiliğinden kapanmaz (yalnızca maxMs) */
  manual?: boolean;
  /**
   * Konuşma algılanmasa da kaydı gönder (mikrofon düğmesi). Masaüstü mikrofonları çoğu zaman kısık çeker; seviye
   * eşiğin altında kalınca kayıt eskiden sessizce atılıyordu ve Jarvis hiç cevap vermiyordu.
   */
  sendSilent?: boolean;
  /** Açık bir mikrofon akışı (alkış dinleyicisininki): yeniden izin/başlatma gecikmesi olmaz, kapatılmaz */
  stream?: MediaStream;
  /** Kullanıcı dokunuşuyla açılmış ses bağlamı. Dokunuşsuz (alkışla) başlayan kayıtta yeni bağlam askıda kalır ve
   *  seviye ölçülemez; verilmezse yenisi açılır. Verilen bağlam kapatılmaz. */
  ctx?: AudioContext;
}): Promise<Recording> {
  const silenceMs = h.silenceMs ?? 1400, noSpeechMs = h.noSpeechMs ?? 6000, maxMs = h.maxMs ?? 15000;
  const shared = h.stream ? null : await warmMic();
  const ownStream = !h.stream && !shared;
  const stream = h.stream ?? shared ?? (await openMic());
  if (shared) warmUsers++;
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);

  // Sessizlik algılama. Eşik sabit değil: ortamın gürültü tabanına göre (kısık masaüstü mikrofonunda da konuşma
  // seçilsin, gürültülü odada da kayıt bitebilsin). Ölçüm requestAnimationFrame yerine zamanlayıcıyla yapılır:
  // pencere arka plana geçince ya da küçültülünce rAF durur ve kayıt hiç bitmiyordu.
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = h.ctx ?? new AC();
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const source = ctx.createMediaStreamSource(stream);
  source.connect(analyser);
  // Bağlam hâlâ askıdaysa seviye hep sıfır görünür: o durumda konuşma "duyulmuş" sayılır, kayıt süre sonunda gönderilir.
  const blind = ctx.state !== 'running';
  const buf = new Uint8Array(analyser.fftSize);
  const t0 = performance.now();
  let heard = blind;
  let lastVoice = t0;
  // Gürültü tabanı: yumuşatılmış seviyenin en düşüğü, ama sürekli bir uğultu (fan, oda, mikrofonun otomatik
  // kazancı) varsa birkaç saniyede ona doğru yükselir. Eskiden yalnız en düşük değer tutuluyordu: uğultu eşiğin
  // üstünde kalınca kullanıcı hiç "susmuyor" sayılıyor, kayıt süre sonuna (60 sn) kadar sürüyordu.
  let floor = Infinity;
  /** Konuşmanın ulaştığı (yavaş sönen) seviye: bunun üçte birinin altı da sessizlik sayılır */
  let speech = 0;
  let smooth = 0;
  let peak = 0;
  let stopped = false;

  const finish = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(hardStop);
    if (rec.state !== 'inactive') rec.stop();
  };
  rec.onstop = () => {
    source.disconnect();
    if (ownStream) stream.getTracks().forEach(t => t.stop());
    if (shared) { warmUsers--; scheduleRelease(); }
    if (!h.ctx) ctx.close().catch(() => {});
    const has = chunks.length > 0 && (heard || !!h.sendSilent);
    h.onStop(has ? new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }) : null, { heard, peak, ms: Math.round(performance.now() - t0) });
  };

  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    peak = Math.max(peak, rms);
    smooth = smooth ? smooth * 0.7 + rms * 0.3 : rms;
    floor = smooth < floor ? smooth : floor + (smooth - floor) * 0.012;
    h.onLevel?.(Math.min(1, rms * 4));
    const now = performance.now();
    // Konuşma: gürültü tabanının ~3 katı (en az 0,012). Eski sabit eşik (0,035) kısık mikrofonlarda hiç aşılmıyordu.
    const thr = Math.max(0.012, Math.min(0.08, floor * 2.5));
    speech = Math.max(speech * 0.995, heard ? smooth : 0);
    const loud = smooth > thr && !(heard && smooth < speech * 0.33);
    if (!blind && now - t0 > 150 && loud && rms > thr) { if (!heard) speech = smooth; heard = true; lastVoice = now; }
    if (h.manual) return;
    if ((heard && !blind && now - lastVoice > silenceMs) || (!heard && now - t0 > noSpeechMs) || (blind && now - t0 > noSpeechMs)) finish();
  };
  rec.start(250);
  const timer = setInterval(tick, 50);
  const hardStop = setTimeout(finish, maxMs);
  return { stop: finish };
}
