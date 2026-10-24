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
let warm: MediaStream | null = null;
let warmUsers = 0;
let warmTimer: ReturnType<typeof setTimeout> | undefined;
const live = (s: MediaStream | null) => !!s && s.getAudioTracks().some(t => t.readyState === 'live');

/** Mikrofonu önceden aç (ör. düğmeye basılırken); başarısızsa sessizce geçer */
export async function warmMic(): Promise<MediaStream | null> {
  clearTimeout(warmTimer);
  if (!live(warm)) warm = await navigator.mediaDevices.getUserMedia({ audio: MIC }).catch(() => null);
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
  const stream = h.stream ?? shared ?? (await navigator.mediaDevices.getUserMedia({ audio: MIC }));
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
  let floor = Infinity; // gürültü tabanı: yumuşatılmış seviyenin şimdiye kadarki en düşüğü
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
    h.onStop(has ? new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }) : null, { heard, peak });
  };

  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    peak = Math.max(peak, rms);
    smooth = smooth ? smooth * 0.7 + rms * 0.3 : rms;
    floor = Math.min(floor, smooth);
    h.onLevel?.(Math.min(1, rms * 4));
    const now = performance.now();
    // Konuşma: gürültü tabanının ~3 katı (en az 0,012). Eski sabit eşik (0,035) kısık mikrofonlarda hiç aşılmıyordu.
    const thr = Math.max(0.012, Math.min(0.05, floor * 3));
    if (!blind && now - t0 > 150 && rms > thr) { heard = true; lastVoice = now; }
    if (h.manual) return;
    if ((heard && !blind && now - lastVoice > silenceMs) || (!heard && now - t0 > noSpeechMs) || (blind && now - t0 > noSpeechMs)) finish();
  };
  rec.start(250);
  const timer = setInterval(tick, 50);
  const hardStop = setTimeout(finish, maxMs);
  return { stop: finish };
}
