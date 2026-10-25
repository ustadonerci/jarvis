// Beyin (sohbet modeli) seçimi. "route-llm" yönlendiricisi zor gördüğü soruları uzun düşünen (akıl yürüten) modellere
// gönderebiliyor: cevap 15-30 sn gecikiyordu. Hızlı modda hızlı bir model (araç çağırmayı iyi yapan küçük model) doğrudan
// kullanılır; Dengeli modda eskisi gibi CHAT_MODEL. Hızlı model RouteLLM hesabında yoksa ya da hata verirse kendiliğinden
// CHAT_MODEL'e dönülür. FAST_MODEL ile model elle seçilebilir.
import { CHAT_MODEL, MOCK, routellm } from './routellm.js';

export type Hiz = 'hizli' | 'dengeli';
const CANDIDATES = [...(process.env.FAST_MODEL ? [process.env.FAST_MODEL] : []), 'gpt-4.1-mini', 'gemini-2.5-flash', 'gpt-5-mini', 'claude-haiku-4-5', 'gpt-4o-mini'];

let mode: Hiz = 'dengeli';
let available: Set<string> | null = null;
const broken = new Set<string>();

/** Varsayılan dengeli (route-llm): hızlı model bazı sorularda aracı çağırmadan alakasız cevap verdi; Ayarlar'dan açılır */
export const defaultHiz = (): Hiz => 'dengeli';
export const setHiz = (h: Hiz) => { mode = h; };
export const getHiz = () => mode;

export async function initBrain() {
  if (MOCK) return;
  try {
    const r = await routellm<{ data: { id: string }[] }>('/models');
    available = new Set((r.data ?? []).map(m => m.id));
  } catch { /* liste alınamazsa aday sırasıyla denenir */ }
  console.log(`[beyin] hız: ${mode} · hızlı model: ${fastModel() ?? 'yok'} · dengeli: ${CHAT_MODEL}`);
}

export function fastModel(): string | null {
  return CANDIDATES.find(m => !broken.has(m) && (!available || available.has(m))) ?? null;
}

/** Bu tur için kullanılacak sohbet modeli */
export const chatModel = (): string => (mode === 'hizli' ? fastModel() ?? CHAT_MODEL : CHAT_MODEL);

/** Hızlı model istek hatası verdi (model yok, araç desteklemiyor…): bir daha seçilmez */
export function markBroken(model: string) {
  if (model === CHAT_MODEL) return false;
  broken.add(model);
  console.warn(`[beyin] ${model} kullanılamadı; sıradaki: ${chatModel()}`);
  return true;
}
