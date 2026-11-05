// Kelime kelime vurgulu altyazı (Reels/Shorts): seslendirmenin kelime zamanları OpenAI Whisper'dan (word
// timestamps) alınır; anahtar yoksa ya da olmazsa süre metne göre orantılı bölünür. Altyazı ASS dosyası olarak yazılır
// ve ffmpeg "subtitles" süzgeciyle videoya basılır: üçerli kelime grupları, o an söylenen kelime sarı.
import fs from 'node:fs';
import path from 'node:path';

export interface Word { w: string; s: number; e: number }

/** OpenAI Whisper ile kelime zamanları (whisper-1, verbose_json + word). Olmazsa null. */
export async function whisperWords(file: string): Promise<Word[] | null> {
  const key = (process.env.OPENAI_API_KEY || '').replace(/^["']|["']$/g, '').trim();
  if (!key) return null;
  try {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
    fd.append('model', 'whisper-1');
    fd.append('language', 'tr');
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'word');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const words: Word[] = (j.words ?? []).map((x: any) => ({ w: String(x.word).trim(), s: Number(x.start), e: Number(x.end) })).filter((x: Word) => x.w && Number.isFinite(x.s));
    return words.length ? words : null;
  } catch { return null; }
}

/** Metnin kelimelerini zamanlara oturtur: Whisper kelime sayısı tutuyorsa metnin kendi yazımı kullanılır */
export function alignWords(text: string, dur: number, heard: Word[] | null): Word[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  if (heard && heard.length === words.length) return words.map((w, i) => ({ w, s: heard[i].s, e: heard[i].e }));
  // Orantılı: uzun kelime daha uzun sürer; Whisper başlangıç/bitişi varsa o aralığa sığdırılır
  const start = heard?.[0]?.s ?? 0.05, end = heard?.at(-1)?.e ?? Math.max(0.5, dur - 0.2);
  const weights = words.map(w => w.length + 2), total = weights.reduce((a, b) => a + b, 0);
  let t = start;
  return words.map((w, i) => { const d = (end - start) * weights[i] / total; const o = { w, s: t, e: t + d }; t += d; return o; });
}

const ts = (x: number) => { const h = Math.floor(x / 3600), m = Math.floor(x / 60) % 60, s = x % 60; return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`; };
const esc = (s: string) => s.replace(/[{}\\]/g, '');

/** ASS altyazı: 3'erli gruplar, o an söylenen kelime sarı ve biraz büyük */
export function buildAss(words: Word[], o: { W: number; H: number; font?: string; size?: number; y?: number; group?: number }): string {
  const size = o.size ?? 86, group = o.group ?? 3, y = Math.round((o.y ?? 0.66) * o.H);
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${o.W}\nPlayResY: ${o.H}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: K,${o.font ?? 'Arial'},${size},&H00FFFFFF,&H0000FFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,2,5,60,60,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const lines: string[] = [];
  for (let g = 0; g < words.length; g += group) {
    const chunk = words.slice(g, g + group);
    chunk.forEach((cur, i) => {
      const end = i < chunk.length - 1 ? chunk[i + 1].s : (words[g + group]?.s ?? cur.e + 0.25);
      const text = chunk.map((x, k) => (k === i ? `{\\c&H00FFFF&\\fscx110\\fscy110}${esc(x.w)}{\\r}` : esc(x.w))).join(' ');
      lines.push(`Dialogue: 0,${ts(cur.s)},${ts(Math.max(end, cur.s + 0.08))},K,,0,0,0,,{\\pos(${o.W / 2},${y})}${text}`);
    });
  }
  return head + lines.join('\n') + '\n';
}
