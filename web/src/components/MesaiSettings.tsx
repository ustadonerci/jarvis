import { useEffect, useState } from 'react';
import { deleteMesai, getMesai, saveMesaiAyar, sendMesai, type MesaiData } from '../lib/api';

/** Ayarlar → Fazla mesai: maaş, çarpan, ay sonu gönderimi ve bu ayın kayıtları (silinebilir) */
export function MesaiSettings({ flash }: { flash(t: string): void }) {
  const [m, setM] = useState<MesaiData | null>(null);
  const [maas, setMaas] = useState('');
  useEffect(() => { getMesai().then(d => { setM(d); setMaas(String(d.ayar.maas)); }).catch(() => {}); }, []);
  if (!m) return null;
  const save = (a: Parameters<typeof saveMesaiAyar>[0], ok: string) => saveMesaiAyar(a).then(d => { setM(d); flash(ok); }).catch(e => flash(e.message));
  return (
    <>
      <label>Fazla mesai · {m.ay_adi}: {m.toplam_saat} saat · ₺{m.toplam_tutar.toLocaleString('tr-TR')}</label>
      <p className="muted small">Jarvis'e "bugün 2 saat mesai yaptım" demeniz yeter. Hesap: maaş ÷ {m.ayar.aylikSaat} saat × {m.ayar.carpan} = saati ₺{m.saatlik.toLocaleString('tr-TR')}.</p>
      <div className="row">
        <input value={maas} onChange={e => setMaas(e.target.value)} inputMode="numeric" placeholder="Aylık maaş (TL)" style={{ flex: 1 }} />
        <button onClick={() => save({ maas: Number(maas.replace(/\D/g, '')) }, 'Maaş kaydedildi')}>Maaşı kaydet</button>
      </div>
      <div className="seg">
        {[1.5, 2].map(c => <button key={c} className={m.ayar.carpan === c ? 'on' : ''} onClick={() => save({ carpan: c }, `Mesai çarpanı ${c}`)}>×{c}</button>)}
        <button className={m.ayar.aySonuGonder ? 'on' : ''} onClick={() => save({ aySonuGonder: !m.ayar.aySonuGonder }, m.ayar.aySonuGonder ? 'Ay sonu gönderimi kapalı' : 'Ay sonu gönderimi açık')}>{m.ayar.aySonuGonder ? '✅' : '⬜'} Ay sonu WhatsApp + Telegram</button>
        <button onClick={() => sendMesai().then(r => flash(r.gonderildi.length ? `Özet gönderildi: ${r.gonderildi.join(' + ')}` : 'Gönderilemedi: WhatsApp/Telegram bağlı değil')).catch(e => flash(e.message))}>📤 Şimdi gönder</button>
      </div>
      {m.kayitlar.length > 0 && (
        <ul className="memory">
          {m.kayitlar.map(k => (
            <li key={k.id}><span>{k.tarih.slice(8, 10)}.{k.tarih.slice(5, 7)} · {k.saat} saat · ₺{k.tutar.toLocaleString('tr-TR')}{k.not ? ` · ${k.not}` : ''}</span>
              <button aria-label="Sil" onClick={() => deleteMesai(k.id).then(d => { setM(d); flash('Kayıt silindi'); }).catch(e => flash(e.message))}>✕</button></li>
          ))}
        </ul>
      )}
    </>
  );
}
