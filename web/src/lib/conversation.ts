// Sohbet modu (ChatGPT sesli sohbeti gibi): tarayıcının ses tanıması sürekli açık kalır.
//  - Uyandırma: "Merhaba Jarvis", "Selam Jarvis", "Hey Jarvis", "Jarvis …" ya da cümle başında "Selam / Merhaba".
//    Uyandırma sözünden sonra bir istek varsa ("Jarvis yarın hava nasıl") doğrudan o istek gönderilir.
//  - Sohbet: Jarvis cevabını bitirince yeniden dinler; kullanıcı susunca söylediği gönderilir. 30 sn konuşma
//    olmazsa ya da "görüşürüz / teşekkürler bu kadar" denince uyandırma sözü beklemeye döner.
//  - Söze girme: Jarvis konuşurken kullanıcı konuşursa Jarvis durur ve dinler. Jarvis'in kendi sesi hoparlörden
//    mikrofona geri gelebildiği için, duyulan sözcüklerin çoğu Jarvis'in o an söylediği cümlede geçiyorsa (yankı)
//    yok sayılır.
// Yalnızca bu tarayıcıda çalışır (Chrome/Edge masaüstü ve Android Chrome; iPhone Safari'de sürekli dinleme yok).
import { fold } from './wake';

// ---------------------------------------------------------------- Sözcük kuralları (test edilebilir)

const NAME = '(?:jarvis|carvis|cervis|jervis|carviz|jarviz|carvıs|jarvıs)';
const WAKE_RE = new RegExp(`^(?:.*?\\b)?(?:(?:merhaba|selam|hey|hi|alo|gunaydin|iyi aksamlar|iyi gunler)\\s+${NAME}|${NAME})\\b\\s*(.*)$`);
const GREET_ONLY = /^(?:merhaba|selam|selamlar|selamun aleykum|hey)\b\s*(.*)$/;

/** Uyandırma sözü var mı; sonrasındaki istek (rest) */
export function parseWake(text: string, allowBareGreeting = true): { wake: boolean; rest: string } {
  const t = fold(text);
  const m = WAKE_RE.exec(t);
  if (m) return { wake: true, rest: restOf(text, m[1]) };
  if (allowBareGreeting) {
    const g = GREET_ONLY.exec(t);
    if (g) return { wake: true, rest: restOf(text, g[1]) };
  }
  return { wake: false, rest: '' };
}
/** fold edilmiş kalanı, asıl (Türkçe harfli) metinden aynı uzunlukta geri almaya çalışır */
function restOf(original: string, foldedRest: string): string {
  if (!foldedRest.trim()) return '';
  const words = original.trim().split(/\s+/);
  const n = foldedRest.trim().split(/\s+/).length;
  return words.slice(-n).join(' ').replace(/^[,.!?;:\s]+/, '').trim();
}

export type Intent = 'devam' | 'dur' | 'bitir' | 'evet' | 'hayir' | 'soru';
export function classify(text: string): Intent {
  const t = fold(text);
  if (/^(?:evet\s+)?(?:devam(?:\s+et(?:in)?)?|kaldigin yerden devam(?:\s+et)?|devam edebilirsin|devam edelim|surdur)$/.test(t)) return 'devam';
  if (/^(?:dur|sus|bekle|kes|yeter|tamam yeter|bir dakika|dur bir dakika|durdur|sessiz ol)$/.test(t)) return 'dur';
  if (/(?:gorusuruz|hosca kal|hoscakal|sohbeti bitir|bu kadar yeter|bu kadar|tesekkurler (?:jarvis )?bu kadar|kapat sohbeti|iyi geceler)/.test(t)) return 'bitir';
  if (/^(?:evet|olur|tabi|tabii|tamam|lutfen|evet lutfen)$/.test(t)) return 'evet';
  if (/^(?:hayir|gerek yok|istemiyorum|yok)$/.test(t)) return 'hayir';
  return 'soru';
}

/**
 * Yankı mı: duyulan sözcüklerin çoğu Jarvis'in o an (ya da az önce) söylediği metinde geçiyorsa evet.
 * Tek sözcük yalnız Jarvis'in cümlesinde geçiyorsa yankıdır; "dur", "jarvis" gibi kesme sözleri hiçbir zaman.
 */
export function isEcho(heard: string, spoken: string[]): boolean {
  const h = fold(heard).split(' ').filter(w => w.length > 1);
  if (!h.length) return true;
  if (/\b(?:dur|sus|bekle|jarvis|carvis|devam)\b/.test(h.join(' '))) return false;
  const bag = new Set(spoken.flatMap(s => fold(s).split(' ')));
  const hit = h.filter(w => bag.has(w)).length;
  // Tek sözcük: yalnız Jarvis'in cümlesinde geçiyorsa yankı ("evet", "görüşürüz" gibi kısa cevaplar kaybolmasın)
  if (h.length === 1) return hit === 1;
  return hit / h.length >= 0.6;
}

// ---------------------------------------------------------------- Motor

export type ConvState = 'kapali' | 'uyandirma' | 'dinliyor' | 'konusuyor' | 'dusunuyor' | 'hata';

export interface ConvHooks {
  /** Jarvis şu an sesli konuşuyor mu */
  speaking(): boolean;
  /** Cevap bekleniyor mu (düşünüyor) */
  thinking(): boolean;
  /** Yankı süzgeci için: şu an ve az önce seslendirilen metinler */
  spokenTexts(): string[];
  /** Uyandırma sözü duyuldu; rest: sonrasındaki istek (boş olabilir) */
  onWake(rest: string): void;
  /** Sohbette kullanıcı bir şey söyledi (konuşma bitti) */
  onUtterance(text: string): void;
  /** Jarvis konuşurken kullanıcı söze girdi (ilk anlamlı sözcüklerde) */
  onInterrupt(): void;
  onState(s: ConvState, heard: string): void;
}

export class Conversation {
  private rec: any = null;
  private on = false;
  private suspended = false;
  /** Sohbette mi (uyandırma sözü gerekmez) */
  active = false;
  private lastActivity = 0;
  private interrupted = false;
  private errors = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Jarvis'in son söyledikleri ve susma anı: hoparlörde kalan son sözcükler kullanıcı sorusu sanılmasın */
  private recent: string[] = [];
  private spokeEndAt = 0;
  /** Sohbet bu kadar sessiz kalırsa uyandırma sözü beklemeye döner */
  idleMs = 30_000;
  /** Cümle başındaki tek başına "selam / merhaba" da uyandırsın mı */
  bareGreeting = true;
  /** Jarvis konuşurken söze girilebilsin mi */
  bargeIn = true;

  constructor(private h: ConvHooks) {}

  static supported() { return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition); }

  start() {
    if (this.on || !Conversation.supported()) return;
    this.on = true;
    this.errors = 0;
    this.open();
    this.timer = setInterval(() => this.tick(), 1000);
    this.emit('');
  }
  stop() {
    this.on = false;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.rec?.abort(); } catch { /* yok */ }
    this.rec = null;
    this.h.onState('kapali', '');
  }
  /** Mikrofon düğmesiyle kayıt gibi başka bir dinleme sürerken geçici olarak sus */
  suspend() { this.suspended = true; try { this.rec?.abort(); } catch { /* yok */ } }
  resume() { if (!this.suspended) return; this.suspended = false; if (this.on && !this.rec) this.open(); }
  /** Dışarıdan sohbeti başlat (ör. mikrofon düğmesi ya da uyanış) */
  begin() { this.active = true; this.lastActivity = Date.now(); this.emit(''); }
  end() { this.active = false; this.emit(''); }
  /** Jarvis konuşmayı bitirdi: dinleme süresi yeniden başlar */
  touched() { this.lastActivity = Date.now(); this.interrupted = false; this.emit(''); }

  private emit(heard: string) {
    const s: ConvState = !this.on ? 'kapali' : this.h.speaking() ? 'konusuyor' : this.h.thinking() ? 'dusunuyor' : this.active ? 'dinliyor' : 'uyandirma';
    this.h.onState(s, heard);
  }

  /** Jarvis bir cümleyi/cevabı bitirdi (yankı süzgeci kısa bir süre daha açık kalır) */
  spokeEnded() { this.recent = [...this.recent, ...this.h.spokenTexts()].slice(-6); this.spokeEndAt = Date.now(); this.touched(); }

  private tick() {
    if (this.h.speaking()) this.recent = [...this.h.spokenTexts()];
    if (this.active && !this.h.speaking() && !this.h.thinking() && Date.now() - this.lastActivity > this.idleMs) {
      this.active = false;
      this.emit('');
    }
  }

  private open() {
    if (!this.on || this.suspended) return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = 'tr-TR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      this.errors = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = String(r[0]?.transcript ?? '').trim();
        if (!t) continue;
        r.isFinal ? this.final(t) : this.interim(t);
      }
    };
    rec.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
        this.on = false;
        this.h.onState('hata', e.error === 'audio-capture' ? 'Mikrofon bulunamadı' : 'Mikrofon izni verilmedi');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') this.errors++;
    };
    rec.onend = () => {
      if (this.rec === rec) this.rec = null;
      // Tarayıcı sürekli dinlemeyi zaman zaman kendisi kapatır: hemen yeniden aç (hata üst üste gelirse yavaşla)
      if (this.on && !this.suspended) setTimeout(() => this.on && !this.suspended && !this.rec && this.open(), this.errors > 3 ? 3000 : 150);
    };
    try { rec.start(); this.rec = rec; } catch { setTimeout(() => this.open(), 1000); }
  }

  private interim(t: string) {
    if (this.h.speaking()) {
      if (!this.bargeIn || this.interrupted || (!this.active && !parseWake(t, false).wake)) return;
      if (isEcho(t, this.h.spokenTexts())) return;
      this.interrupted = true;
      this.lastActivity = Date.now();
      this.h.onInterrupt();
      this.emit(t);
      return;
    }
    if (this.active || parseWake(t, this.bareGreeting).wake) this.emit(t);
  }

  private final(t: string) {
    if (this.h.speaking()) this.recent = [...this.h.spokenTexts()];
    // Jarvis az önce sustuysa ve duyulan onun son cümlesiyse yankıdır
    if (!this.h.speaking() && Date.now() - this.spokeEndAt < 3500 && isEcho(t, this.recent)) return;
    // Jarvis konuşurken (söze girilmediyse) gelen sonuç büyük olasılıkla kendi yankısıdır
    if (this.h.speaking() && !this.interrupted) {
      if (!this.bargeIn || isEcho(t, this.h.spokenTexts())) return;
      if (!this.active && !parseWake(t, false).wake) return;
      this.interrupted = true;
      this.h.onInterrupt();
    }
    if (!this.active) {
      const w = parseWake(t, this.bareGreeting);
      if (!w.wake) return;
      this.active = true;
      this.lastActivity = Date.now();
      this.interrupted = false;
      this.h.onWake(w.rest);
      this.emit('');
      return;
    }
    this.lastActivity = Date.now();
    this.interrupted = false;
    // Sohbetteyken "Jarvis, …" diye başlanırsa isim atılır
    const w = parseWake(t, false);
    const text = (w.wake ? w.rest : t).trim();
    if (!text) { this.h.onWake(''); return; }
    if (classify(text) === 'bitir') this.active = false;
    this.h.onUtterance(text);
    this.emit('');
  }
}
