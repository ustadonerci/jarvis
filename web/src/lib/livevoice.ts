// Canlı ses modu istemcisi: mikrofon → 16 kHz PCM16 → sunucu (/api/canli-ses) → Gemini Live; gelen 24 kHz PCM16 ses
// kuyruğa alınıp kesintisiz çalınır. Kullanıcı konuşmaya başlayınca Gemini "kesildi" der: çalan ses hemen susturulur.
import { token } from './api';
import { micBoostOn, micConstraints } from './recorder';

export type LiveEvent =
  | { type: 'durum'; metin: string } | { type: 'hazir'; model: string } | { type: 'kesildi' }
  | { type: 'yazi'; kim: 'sen' | 'jarvis'; metin: string } | { type: 'gorev'; metin: string } | { type: 'gorev_bitti' }
  | { type: 'tur_bitti' } | { type: 'hata'; metin: string } | { type: 'kapandi'; neden: string } | { type: 'konusuyor' };

// Mikrofon örneklerini 16 kHz'e indirip 100 ms'lik Int16 paketler halinde gönderen işleyici
const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.ratio = sampleRate / 16000; this.pos = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (; this.pos < ch.length; this.pos += this.ratio) this.buf.push(ch[Math.floor(this.pos)]);
    this.pos -= ch.length;
    if (this.buf.length >= 1600) {
      const out = new Int16Array(this.buf.length);
      for (let i = 0; i < this.buf.length; i++) { const s = Math.max(-1, Math.min(1, this.buf[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
      this.port.postMessage(out.buffer, [out.buffer]);
      this.buf = [];
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm16);`;

export class LiveVoice {
  private ws: WebSocket | null = null;
  private mic: MediaStream | null = null;
  private inCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private playAt = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private lastSpeak = 0;
  private on: (e: LiveEvent) => void;
  constructor(on: (e: LiveEvent) => void) { this.on = on; }

  get active() { return !!this.ws; }

  async start() {
    if (this.ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/canli-ses${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.outCtx = new AudioContext({ sampleRate: 24000 });
    ws.onmessage = ev => {
      if (ev.data instanceof ArrayBuffer) return this.play(ev.data);
      let m: LiveEvent; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'kesildi') this.flush();
      if (m.type === 'hazir') this.startMic().catch(err => { this.on({ type: 'hata', metin: `Mikrofon açılamadı: ${err?.message ?? err}` }); this.stop(); });
      this.on(m);
    };
    ws.onclose = () => { if (this.ws === ws) { this.on({ type: 'kapandi', neden: '' }); this.stop(); } };
    ws.onerror = () => this.on({ type: 'hata', metin: 'Canlı ses bağlantısı kurulamadı' });
  }

  private async startMic() {
    // Ayarlar'da seçilen mikrofon (kablolu vb.); yoksa varsayılan
    try { this.mic = await navigator.mediaDevices.getUserMedia({ audio: { ...micConstraints(), channelCount: 1 } }); }
    catch { this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }); }
    this.inCtx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.inCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.inCtx.createMediaStreamSource(this.mic);
    this.node = new AudioWorkletNode(this.inCtx, 'pcm16');
    this.node.port.onmessage = e => { if (this.ws?.readyState === 1) this.ws.send(e.data as ArrayBuffer); };
    // Kısık mikrofon: sabit güçlendirme + sınırlayıcı (Gemini kısık sesi duymuyordu)
    if (micBoostOn()) {
      const g = this.inCtx.createGain(); g.gain.value = 5;
      const lim = this.inCtx.createDynamicsCompressor();
      lim.threshold.value = -10; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.25;
      src.connect(g); g.connect(lim); lim.connect(this.node);
    } else src.connect(this.node);
  }

  private play(ab: ArrayBuffer) {
    const ctx = this.outCtx;
    if (!ctx) return;
    const pcm = new Int16Array(ab);
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, this.playAt);
    s.start(at);
    this.playAt = at + buf.duration;
    this.sources.add(s);
    s.onended = () => this.sources.delete(s);
    if (Date.now() - this.lastSpeak > 400) { this.lastSpeak = Date.now(); this.on({ type: 'konusuyor' }); }
  }

  /** Söz kesildi: çalmakta ve sırada bekleyen ses hemen susar */
  private flush() {
    for (const s of this.sources) { try { s.stop(); } catch { /* */ } }
    this.sources.clear();
    this.playAt = 0;
  }

  /** Yazıyla soru (canlı oturum açıkken) */
  sendText(t: string) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'metin', metin: t })); }

  stop() {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* */ }
    this.flush();
    this.node?.disconnect(); this.node = null;
    this.mic?.getTracks().forEach(t => t.stop()); this.mic = null;
    this.inCtx?.close().catch(() => {}); this.inCtx = null;
    this.outCtx?.close().catch(() => {}); this.outCtx = null;
  }
}
