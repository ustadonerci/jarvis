// Azure Speech seslendirme (isteğe bağlı): Türkçe sinir ağı sesleri, erkek (Ahmet) ve kadın (Emel).
// Anahtar: AZURE_SPEECH_KEY + AZURE_SPEECH_REGION (ör. westeurope). Ücretsiz katman: ayda 500 bin karakter.
export const AZURE_MODEL = 'azure-tts';
export const AZURE_VOICES = [
  { voice: 'tr-TR-AhmetNeural', label: 'Ahmet · Azure', gender: 'erkek' as const },
  { voice: 'tr-TR-EmelNeural', label: 'Emel · Azure', gender: 'kadin' as const },
];
export const isAzure = (model: string) => model === AZURE_MODEL;
export const azureReady = () => !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION;

const esc = (s: string) => s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export async function azureSpeak(text: string, voice: string, speed = 1): Promise<Buffer> {
  if (!AZURE_VOICES.some(v => v.voice === voice)) throw new Error(`Azure sesi tanınmıyor: ${voice}`);
  const rate = `${Math.round((Math.min(1.3, Math.max(0.8, speed || 1)) - 1) * 100)}%`;
  const ssml = `<speak version="1.0" xml:lang="tr-TR"><voice name="${voice}"><prosody rate="${rate}">${esc(text)}</prosody></voice></speak>`;
  const r = await fetch(`https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY!,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
      'User-Agent': 'jarvis',
    },
    body: ssml,
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`Azure ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return Buffer.from(await r.arrayBuffer());
}
