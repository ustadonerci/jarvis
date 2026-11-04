import { useState } from 'react';
import { voiceCare } from '../lib/api';

type Row = { motor?: string; ses?: string; calisiyor?: boolean; ms?: number; neden?: string; voicestudio?: string; elevenlabs?: string };

/** Ayarlar → Ses bakımı: seçili sesi bütün motorlarla dener; kayıtlı sesleri VoiceStudio / ElevenLabs'te klonlar */
export function VoiceCare({ flash }: { flash(t: string): void }) {
  const [busy, setBusy] = useState<'' | 'test' | 'klon'>('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [baslik, setBaslik] = useState('');
  const call = (ne: 'test' | 'klonla') => {
    setBusy(ne === 'test' ? 'test' : 'klon'); setRows(null);
    voiceCare(ne)
      .then(j => { setBaslik(ne === 'test' ? `Seçili ses: ${j.secili_ses}` : `Klonlanan sesler: ${j.sesler.join(', ') || 'örnek kayıt yok'}`); setRows(j.sonuc); })
      .catch(e => flash(e.message)).finally(() => setBusy(''));
  };
  return (
    <>
      <label>Ses bakımı</label>
      <p className="muted small">Ses gelmiyorsa "Sesi test et": seçili ses Abacus.AI, OpenAI, Gemini ve klonlarla ayrı ayrı denenir. "Kayıtlı sesleri klonla": Jarvis'in sesleri (onyx, echo, fable) VoiceStudio'da ve ElevenLabs'te klonlanır; asıl sağlayıcı çalışmazsa aynı ses klondan gelir.</p>
      <div className="seg">
        <button disabled={!!busy} onClick={() => call('test')}>{busy === 'test' ? '⏳ Deneniyor…' : '🔊 Sesi test et'}</button>
        <button disabled={!!busy} onClick={() => call('klonla')}>{busy === 'klon' ? '⏳ Klonlanıyor (birkaç dakika)…' : '🧬 Kayıtlı sesleri klonla'}</button>
      </div>
      {rows && (
        <>
          <p className="small">{baslik}</p>
          <ul className="memory">
            {rows.map((r, i) => r.motor
              ? <li key={i}><span>{r.calisiyor ? '✅' : '❌'} {r.motor}{r.calisiyor ? ` · ${r.ms} ms` : ''}{r.neden ? <small> · {r.neden}</small> : null}</span></li>
              : <li key={i}><span>🎙️ {r.ses}: VoiceStudio {r.voicestudio} · ElevenLabs {r.elevenlabs}</span></li>)}
          </ul>
        </>
      )}
    </>
  );
}
