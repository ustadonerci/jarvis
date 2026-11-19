// Google Gemini'nin kendi API'si (generativelanguage v1beta, streamGenerateContent). OpenAI uyumlu uç yeni "AQ." biçimli
// anahtarlarla "Missing or invalid Authorization header" (400/401) verdiği için sohbet buradan yapılır; anahtar Google'ın
// önerdiği x-goog-api-key başlığıyla gider. OpenAI biçimindeki mesajlar ve araçlar Gemini biçimine çevrilir, akıştaki
// metin ve araç çağrıları Jarvis'in beklediği StreamResult'a dönüştürülür.
import { randomUUID } from 'node:crypto';
import { RouteLLMError, FIRST_TOKEN_MS, linkAbort, type ChatMessage, type ContentPart, type StreamCtl, type StreamResult } from './routellm.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Gemini 2.5+ araç çağrılarındaki "thoughtSignature": aynı çağrı geri gönderilirken eklenir */
const signatures = new Map<string, string>();

/** OpenAPI alt kümesi: Gemini'nin kabul etmediği alanlar (additionalProperties, $schema, default…) atılır */
function schema(s: any): any {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(schema);
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (!['type', 'description', 'properties', 'required', 'enum', 'items', 'format', 'nullable', 'minimum', 'maximum', 'minItems', 'maxItems'].includes(k)) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, schema(pv)])) : k === 'items' ? schema(v) : v;
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

function parts(c: ChatMessage['content']): any[] {
  if (c == null) return [];
  if (typeof c === 'string') return c ? [{ text: c }] : [];
  const out: any[] = [];
  for (const p of c as ContentPart[]) {
    if (p.type === 'text' && p.text) out.push({ text: p.text });
    else if (p.type === 'image_url') {
      const m = /^data:([^;]+);base64,(.+)$/.exec(p.image_url.url);
      if (m) out.push({ inlineData: { mimeType: m[1], data: m[2] } });
    } else if (p.type === 'input_audio') out.push({ inlineData: { mimeType: `audio/${p.input_audio.format}`, data: p.input_audio.data } });
  }
  return out;
}

/** OpenAI biçimi istek → Gemini isteği */
/**
 * Sesli asistan hızlı cevap vermeli: Gemini 2.5 Flash varsayılan olarak cevaptan önce uzun "düşünüyor"du.
 * Flash'ta düşünme kapatılır, Pro'da en aza (128) indirilir, Gemini 3'te düşük seviyeye alınır.
 */
function thinkingFor(model: string): { thinkingConfig?: Record<string, unknown> } {
  const m = model.toLowerCase();
  if (/gemini-3/.test(m)) return { thinkingConfig: { thinkingLevel: 'low' } };
  if (/2\.5-flash|flash-latest|flash-lite/.test(m)) return { thinkingConfig: { thinkingBudget: 0 } };
  if (/2\.5-pro|pro-latest/.test(m)) return { thinkingConfig: { thinkingBudget: 128 } };
  return {};
}

export function toGemini(body: any, model = '') {
  const msgs: ChatMessage[] = body.messages ?? [];
  const system = msgs.filter(m => m.role === 'system').map(m => (typeof m.content === 'string' ? m.content : parts(m.content).map(p => p.text ?? '').join('\n'))).join('\n\n');
  const names = new Map<string, string>(); // tool_call_id → araç adı
  const contents: { role: 'user' | 'model'; parts: any[] }[] = [];
  const push = (role: 'user' | 'model', ps: any[]) => {
    if (!ps.length) return;
    const last = contents[contents.length - 1];
    if (last?.role === role) last.parts.push(...ps); else contents.push({ role, parts: ps });
  };
  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'user') push('user', parts(m.content));
    else if (m.role === 'assistant') {
      const ps = parts(m.content);
      for (const tc of m.tool_calls ?? []) {
        names.set(tc.id, tc.function.name);
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* boş */ }
        const sig = signatures.get(tc.id);
        ps.push({ functionCall: { name: tc.function.name, args }, ...(sig ? { thoughtSignature: sig } : {}) });
      }
      push('model', ps);
    } else if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      push('user', [{ functionResponse: { name: names.get(m.tool_call_id ?? '') ?? 'arac', response: { content } } }]);
    }
  }
  const decls = (body.tools ?? []).map((t: any) => ({ name: t.function.name, description: String(t.function.description ?? '').slice(0, 4000), parameters: schema(t.function.parameters ?? { type: 'object', properties: {} }) }));
  const forced = body.tool_choice?.function?.name as string | undefined;
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: contents.length ? contents : [{ role: 'user', parts: [{ text: '.' }] }],
    ...(decls.length ? { tools: [{ functionDeclarations: decls }], toolConfig: { functionCallingConfig: forced ? { mode: 'ANY', allowedFunctionNames: [forced] } : { mode: 'AUTO' } } } : {}),
    generationConfig: { maxOutputTokens: body.max_tokens ?? 8192, ...thinkingFor(model) },
  };
}

/** Akışlı Gemini sohbeti; sonuç OpenAI akışıyla aynı biçimde */
export async function geminiStream(key: string, model: string, body: any, onContent?: (d: string, full: string) => void, ad = 'Google Gemini', ctl?: StreamCtl): Promise<StreamResult> {
  const t0 = performance.now();
  const ac = new AbortController();
  linkAbort(ac, ctl?.signal);
  let idle = setTimeout(() => ac.abort(new Error(`Gemini ${FIRST_TOKEN_MS / 1000} sn içinde cevap vermedi`)), FIRST_TOKEN_MS);
  let gotFirst = false;
  const bump = () => { clearTimeout(idle); idle = gotFirst ? setTimeout(() => ac.abort(new Error('Gemini 60 sn sessiz kaldı')), 60_000) : setTimeout(() => ac.abort(new Error(`Gemini ${FIRST_TOKEN_MS / 1000} sn içinde yazmaya başlamadı`)), FIRST_TOKEN_MS); };
  const first = () => { if (!gotFirst) { gotFirst = true; bump(); ctl?.onFirst?.(); } };
  const m = model.replace(/^models\//, '');
  let res: Response;
  try {
    res = await fetch(`${BASE}/models/${m}:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(toGemini(body, m)), signal: ac.signal,
    });
  } catch (e) { clearTimeout(idle); throw ac.signal.aborted ? ac.signal.reason : e; }
  if (!res.ok || !res.body) { clearTimeout(idle); throw new RouteLLMError(res.status, await res.text(), ad); }
  bump();
  const dec = new TextDecoder();
  let buf = '', content = '', firstTokenMs: number | null = null, served: string | null = null;
  const calls: StreamResult['tool_calls'] = [];
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bump();
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let j: any;
        try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
        served ??= j.modelVersion ?? null;
        for (const p of j.candidates?.[0]?.content?.parts ?? []) {
          if (p.thought) continue; // düşünce özeti seslendirilmez
          if (typeof p.text === 'string' && p.text) {
            firstTokenMs ??= Math.round(performance.now() - t0);
            first();
            content += p.text;
            onContent?.(p.text, content);
          }
          if (p.functionCall) {
            firstTokenMs ??= Math.round(performance.now() - t0);
            first();
            const id = `gem_${randomUUID().slice(0, 12)}`;
            if (p.thoughtSignature) signatures.set(id, p.thoughtSignature);
            calls.push({ id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } });
          }
        }
      }
    }
  } catch (e) { throw ac.signal.aborted ? ac.signal.reason : e; } finally { clearTimeout(idle); }
  if (signatures.size > 500) signatures.delete(signatures.keys().next().value!);
  return { content, tool_calls: calls, model: served ?? m, firstTokenMs, totalMs: Math.round(performance.now() - t0) };
}
