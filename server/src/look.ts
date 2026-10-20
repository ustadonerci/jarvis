// Görünüm: renk temaları ve seslerin cinsiyeti (Ayarlar → Ses → "Erkek ses / Kadın ses" hızlı seçimi).
export const THEMES = [
  { id: 'jarvis', ad: 'Jarvis Mavi' },
  { id: 'iron', ad: 'Iron Kırmızı' },
  { id: 'matrix', ad: 'Matrix Yeşil' },
  { id: 'neon', ad: 'Neon Mor' },
  { id: 'altin', ad: 'Altın' },
  { id: 'buz', ad: 'Buz Beyazı' },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];
export const isTheme = (v: unknown): v is ThemeId => THEMES.some(t => t.id === v);

// Ses adları sağlayıcıların kendi belgelerindeki cinsiyetlere göre (OpenAI ve Gemini TTS sesleri)
const MALE = /^(onyx|echo|fable|ash|ballad|verse|cedar|puck|charon|fenrir|orus|enceladus|iapetus|umbriel|algieba|algenib|rasalgethi|alnilam|schedar|achird|zubenelgenubi|sadachbia|sadaltager)$/i;
const FEMALE = /^(nova|shimmer|coral|sage|marin|alloy|zephyr|kore|leda|aoede|callirrhoe|autonoe|despina|erinome|laomedeia|achernar|gacrux|pulcherrima|vindemiatrix|sulafat)$/i;

/** Bilinen ad → etiket (ElevenLabs) → ölçülen perde (f0 < 165 Hz erkek) sırasıyla; bilinmiyorsa null */
export function voiceGender(voice: string, f0: number | null, label?: string): 'erkek' | 'kadin' | null {
  const v = voice.trim().split(/[\s:]/).pop() ?? voice;
  if (MALE.test(v)) return 'erkek';
  if (FEMALE.test(v)) return 'kadin';
  if (label) return /^(male|man)$/i.test(label) ? 'erkek' : /^(female|woman)$/i.test(label) ? 'kadin' : null;
  if (f0 !== null) return f0 < 165 ? 'erkek' : 'kadin';
  return null;
}
