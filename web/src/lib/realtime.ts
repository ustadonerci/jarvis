// Canlı sohbet (tarayıcı tarafı): OpenAI Realtime'a WebRTC ile bağlanır. Mikrofon (Ayarlar'da seçilen) doğrudan
// modele gider, Jarvis'in sesi doğrudan çalar; sıra alma ve söze girme (kullanıcı konuşunca susma) modelin kendi
// ses algılamasıyla. "jarvis_sor" aracı çağrılınca istek sunucudan Jarvis'in beynine gider, cevap modele döner.
import { headers } from './api';
import { micConstraints } from './recorder';

export type LiveState = 'baglaniyor' | 'dinliyor' | 'konusuyor' | 'dusunuyor' | 'kapali' | 'hata';
export interface LiveHooks {
  onState(s: LiveState, info?: string): void;
  onUser?(t: string): void;
  onJarvis?(t: string): void;
  /** Jarvis'in sesinin anlık seviyesi 0..1 (çekirdek animasyonu) */
  onLevel?(v: number): void;
}

export class LiveVoice {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private raf = 0;
  private lastHeard = 0;
  private idle: ReturnType<typeof setInterval> | null = null;
  private pending = new Set<string>();
  private cur = '';
  state: LiveState = 'kapali';
  /** Bu kadar süre kimse konuşmazsa (dakika ücreti boşa gitmesin) kapanır */
  idleMs = 120_000;

  constructor(private h: LiveHooks) {}

  static supported() { return typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia; }

  private set(s: LiveState, info?: string) { this.state = s; this.h.onState(s, info); }

  async start() {
    if (this.pc) return;
    this.set('baglaniyor');
    try {
      const r = await fetch('/api/canli/oturum', { method: 'POST', headers: headers() });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `sunucu ${r.status}`);
      const { token, model, legacy } = j as { token: string; model: string; legacy: boolean };

      const pc = new RTCPeerConnection();
      this.pc = pc;
      const audio = new Audio();
      audio.autoplay = true;
      this.audio = audio;
      pc.ontrack = e => { audio.srcObject = e.streams[0]; this.meter(e.streams[0]); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.stop('bağlantı koptu'); };
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
      for (const t of this.mic.getTracks()) pc.addTrack(t, this.mic);
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onmessage = e => { try { this.event(JSON.parse(e.data)); } catch { /* yok say */ } };
      dc.onopen = () => {
        this.set('dinliyor');
        // Kısa selam
        this.send({ type: 'response.create', response: { instructions: 'Kullanıcıyı tek kısa cümleyle selamla, ör. "Buyurun efendim, sizi dinliyorum."' } });
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/sdp' };
      let ans = legacy ? null : await fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST', body: offer.sdp, headers: sdpHeaders }).catch(() => null);
      if (!ans || !ans.ok) ans = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, { method: 'POST', body: offer.sdp, headers: { ...sdpHeaders, 'OpenAI-Beta': 'realtime=v1' } });
      if (!ans.ok) throw new Error(`OpenAI bağlantısı kurulamadı (${ans.status}): ${(await ans.text()).slice(0, 160)}`);
      await pc.setRemoteDescription({ type: 'answer', sdp: await ans.text() });
      this.lastHeard = Date.now();
      this.idle = setInterval(() => { if (Date.now() - this.lastHeard > this.idleMs && this.state === 'dinliyor') this.stop('2 dakika konuşulmadı'); }, 5000);
    } catch (e: any) {
      this.cleanup();
      this.set('hata', String(e?.message || e));
    }
  }

  stop(neden = '') {
    if (!this.pc) return;
    this.cleanup();
    this.set('kapali', neden);
  }

  private cleanup() {
    cancelAnimationFrame(this.raf);
    if (this.idle) clearInterval(this.idle);
    this.idle = null;
    try { this.dc?.close(); } catch { /* yok */ }
    try { this.pc?.close(); } catch { /* yok */ }
    this.mic?.getTracks().forEach(t => t.stop());
    if (this.audio) { this.audio.srcObject = null; }
    this.ctx?.close().catch(() => {});
    this.pc = null; this.dc = null; this.mic = null; this.audio = null; this.ctx = null;
    this.pending.clear();
  }

  private send(o: object) { if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(o)); }

  /** Jarvis'in sesinin seviyesi (çekirdek "konuşuyor" animasyonu) */
  private meter(stream: MediaStream) {
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AC();
      this.ctx = ctx;
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
        this.h.onLevel?.(Math.min(1, Math.sqrt(s / buf.length) * 3.2));
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* seviye yoksa animasyon sabit */ }
  }

  private async event(e: any) {
    switch (e.type) {
      case 'input_audio_buffer.speech_started':
        this.lastHeard = Date.now();
        this.set('dinliyor');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (e.transcript) this.h.onUser?.(String(e.transcript).trim());
        break;
      case 'output_audio_buffer.started':
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (this.state !== 'konusuyor') this.set('konusuyor');
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.lastHeard = Date.now();
        if (!this.pending.size) this.set('dinliyor');
        break;
      case 'response.created':
        this.cur = '';
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        this.cur += String(e.delta ?? '');
        this.h.onJarvis?.(this.cur);
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (e.transcript) this.h.onJarvis?.(String(e.transcript).trim());
        break;
      case 'response.function_call_arguments.done': {
        const id = String(e.call_id ?? '');
        if (!id || this.pending.has(id)) break;
        this.pending.add(id);
        this.set('dusunuyor', 'Jarvis\'e soruluyor');
        let output = '';
        try {
          const r = await fetch('/api/canli/arac', { method: 'POST', headers: headers(), body: JSON.stringify({ name: e.name, args: e.arguments }) });
          output = String((await r.json()).output ?? '');
        } catch (err: any) { output = `Jarvis'e ulaşılamadı: ${err?.message || err}`; }
        this.pending.delete(id);
        this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: id, output } });
        this.send({ type: 'response.create' });
        break;
      }
      case 'error':
        console.warn('[canlı]', e.error?.message ?? e);
        break;
    }
  }
}
