import { useEffect, useState } from 'react';
import { headers } from '../lib/api';

/** Ayarlar → Canlı sohbet: gerçek zamanlı sesli sohbetin durumu ve gereksinimi (OpenAI anahtarı) */
export function LiveSettings({ onStart, active }: { onStart(): void; active: boolean }) {
  const [d, setD] = useState<{ hazir: boolean; model: string; ses: string } | null>(null);
  useEffect(() => { fetch('/api/canli', { headers: headers() }).then(r => r.json()).then(setD).catch(() => {}); }, []);
  return (
    <>
      <label>Canlı sohbet (telefonda konuşur gibi, gerçek zamanlı)</label>
      <p className="muted small">Sesiniz yazıya çevrilmeden doğrudan yapay zekâya gider, Jarvis anında sesle cevap verir: bekleme yok, araya girince hemen susar, doğal Türkçe konuşur. Hava, borsa, e-posta, robot gibi işlerde Jarvis'in kendi beynine sorar ve sonucu söyler (onay kartları aynen geçerli). Alttaki 📞 düğmesiyle başlar/biter; 2 dakika kimse konuşmazsa kendiliğinden kapanır.</p>
      {d && !d.hazir && <p className="warn small">Canlı sohbet için OpenAI API anahtarı gerekir: Ayarlar → Yapay zeka sağlayıcıları → OpenAI kartındaki "anahtar al" linkinden alıp kaydedin.</p>}
      {d?.hazir && <p className="small">Hazır · model: <b>{d.model}</b> · ses: <b>{d.ses}</b> (OpenAI kartından değiştirilebilir)</p>}
      <p className="muted small">Ücret: OpenAI dakika başına ses ücreti alır (konuşulan dakika başına yaklaşık birkaç sent; güncel fiyat OpenAI sayfasında). Kullanmadığınızda 📞 ile kapatın.</p>
      <div className="seg"><button className={active ? 'on' : ''} disabled={!d?.hazir} onClick={onStart}>{active ? '🔴 Canlı sohbeti kapat' : '📞 Canlı sohbeti başlat'}</button></div>
    </>
  );
}
