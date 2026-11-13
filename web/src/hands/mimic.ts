// Yüz mimikleri (El Kontrolü kamerasında): gülümseme, baş "evet"/"hayır" sallama, tek göz kırpma, kaş kaldırma,
// esneme ve uzun süre başka yere bakma. MediaPipe Face Landmarker'ın ifade katsayıları (blendshapes) ve baş açısı
// kullanılır. Görüntü bilgisayardan çıkmaz; yüz TANIMA yoktur, yalnız ifade ölçülür.
import type { FaceLandmarker, FaceLandmarkerResult } from '@mediapipe/tasks-vision';

const LOCAL_MODEL = '/models/face_landmarker.task';
const REMOTE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const WASM = '/mediapipe/wasm';

export type Mimik = 'gulumse' | 'evet' | 'hayir' | 'kirp' | 'kas' | 'esne' | 'uzak' | 'geri';
export const MIMIK_AD: Record<Mimik, string> = { gulumse: '😊 gülümseme', evet: '🙂‍↕️ evet', hayir: '🙂‍↔️ hayır', kirp: '😉 göz kırpma', kas: '🤨 kaş', esne: '🥱 esneme', uzak: '👀 başka yere bakıyor', geri: '👀 döndü' };

async function modelPath(): Promise<string> {
  try {
    const r = await fetch(LOCAL_MODEL, { method: 'HEAD' });
    if (r.ok && !(r.headers.get('content-type') || '').includes('text/html')) return LOCAL_MODEL;
  } catch { /* yerel yok */ }
  return REMOTE_MODEL;
}

export async function loadMimicModel(): Promise<FaceLandmarker> {
  const { FilesetResolver, FaceLandmarker } = await import('@mediapipe/tasks-vision');
  const files = await FilesetResolver.forVisionTasks(WASM);
  const path = await modelPath();
  const make = (delegate: 'GPU' | 'CPU') => FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: path, delegate }, runningMode: 'VIDEO', numFaces: 1,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
  });
  try { return await make('GPU'); } catch { return make('CPU'); }
}

/** Ölçümler (gösterge çubukları için) */
export interface MimicLevels { gulumse: number; solGoz: number; sagGoz: number; kas: number; agiz: number; yaw: number; pitch: number; yuz: boolean }

/** Kare kare ölçüp anlık mimik olaylarını çıkarır (her olay arasında bekleme süresi var: tekrar tekrar tetiklenmesin) */
export class MimicDetector {
  levels: MimicLevels = { gulumse: 0, solGoz: 0, sagGoz: 0, kas: 0, agiz: 0, yaw: 0, pitch: 0, yuz: false };
  private since: Partial<Record<string, number>> = {};
  private last: Partial<Record<Mimik, number>> = {};
  private baseYaw = 0; private basePitch = 0; private calib = 0;
  private yawHist: { t: number; v: number }[] = []; private pitchHist: { t: number; v: number }[] = [];
  private away = false; private lastSeen = 0;

  private hold(key: string, on: boolean, now: number, ms: number): boolean {
    if (!on) { delete this.since[key]; return false; }
    this.since[key] ??= now;
    return now - this.since[key]! >= ms;
  }
  private fire(m: Mimik, now: number, cooldown = 2500): Mimik | null {
    if (now - (this.last[m] ?? -1e9) < cooldown) return null;
    this.last[m] = now;
    return m;
  }
  /** Baş sallama: kısa sürede en az 2 kez yön değiştiren, yeterince büyük salınım */
  private shake(hist: { t: number; v: number }[], now: number, amp: number): boolean {
    const h = hist.filter(x => now - x.t < 1300);
    if (h.length < 6) return false;
    let turns = 0, dir = 0, ext = h[0].v;
    for (const x of h) {
      const d = x.v - ext;
      if (Math.abs(d) >= amp) { const s = Math.sign(d); if (dir && s !== dir) turns++; dir = s; ext = x.v; }
      else if (Math.sign(d) === dir && Math.abs(x.v) > Math.abs(ext)) ext = x.v;
    }
    return turns >= 2;
  }

  update(res: FaceLandmarkerResult | null, now: number): Mimik[] {
    const out: Mimik[] = [];
    const bs = res?.faceBlendshapes?.[0]?.categories;
    const mtx = res?.facialTransformationMatrixes?.[0]?.data;
    if (!bs || !mtx) {
      this.levels.yuz = false;
      // Yüz uzun süre görünmüyor: "başka yere bakıyor"
      if (!this.away && this.lastSeen && now - this.lastSeen > 4000) { this.away = true; out.push('uzak'); }
      return out;
    }
    this.lastSeen = now;
    const v = (n: string) => bs.find(c => c.categoryName === n)?.score ?? 0;
    const yaw = (Math.asin(Math.max(-1, Math.min(1, -mtx[2]))) * 180) / Math.PI;
    const pitch = (Math.atan2(mtx[6], mtx[10]) * 180) / Math.PI;
    // Başın "düz bakış" açısı yavaşça öğrenilir (kamera açısı farklı olabilir)
    if (this.calib < 30) { this.baseYaw = (this.baseYaw * this.calib + yaw) / (this.calib + 1); this.basePitch = (this.basePitch * this.calib + pitch) / (this.calib + 1); this.calib++; }
    const dy = yaw - this.baseYaw, dp = pitch - this.basePitch;
    const L = this.levels = {
      gulumse: (v('mouthSmileLeft') + v('mouthSmileRight')) / 2, solGoz: v('eyeBlinkLeft'), sagGoz: v('eyeBlinkRight'),
      kas: Math.max(v('browInnerUp'), (v('browOuterUpLeft') + v('browOuterUpRight')) / 2), agiz: v('jawOpen'), yaw: dy, pitch: dp, yuz: true,
    };
    // Yüz döndü / uzun süre yana bakıldı
    const looking = Math.abs(dy) < 35 && Math.abs(dp) < 30;
    if (this.hold('yana', !looking, now, 4000) && !this.away) { this.away = true; out.push('uzak'); }
    if (looking && this.away) { this.away = false; out.push('geri'); }
    if (this.away) return out;
    this.yawHist.push({ t: now, v: dy }); this.pitchHist.push({ t: now, v: dp });
    this.yawHist = this.yawHist.filter(x => now - x.t < 1500); this.pitchHist = this.pitchHist.filter(x => now - x.t < 1500);

    const add = (m: Mimik | null) => { if (m) out.push(m); };
    if (this.shake(this.pitchHist, now, 7) && Math.abs(dy) < 15) { add(this.fire('evet', now, 1800)); this.pitchHist = []; }
    else if (this.shake(this.yawHist, now, 9)) { add(this.fire('hayir', now, 1800)); this.yawHist = []; }
    if (this.hold('gul', L.gulumse > 0.6, now, 500)) add(this.fire('gulumse', now, 8000));
    // Tek göz kırpma: biri kapalı, diğeri açık; normal göz kırpması (ikisi birden) sayılmaz
    const wink = (L.solGoz > 0.55 && L.sagGoz < 0.25) || (L.sagGoz > 0.55 && L.solGoz < 0.25);
    if (this.hold('kirp', wink, now, 150)) add(this.fire('kirp', now, 1500));
    if (this.hold('kas', L.kas > 0.6 && L.agiz < 0.3, now, 350)) add(this.fire('kas', now, 3000));
    if (this.hold('esne', L.agiz > 0.65, now, 1200)) add(this.fire('esne', now, 60_000));
    return out;
  }
}
