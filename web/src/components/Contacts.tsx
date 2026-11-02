import { useEffect, useRef, useState } from 'react';
import { getContactCount, uploadFile } from '../lib/api';

/**
 * Ayarlar → Rehber: telefon rehberini (.vcf ya da .csv) Jarvis'e yükler. Kişiler yalnız bu bilgisayarda saklanır;
 * "Ahmet'i ara", "Ayşe'ye WhatsApp yaz" gibi isteklerde kullanılır. Aynı kişi tekrar yüklenirse güncellenir.
 */
export function ContactsSettings({ flash }: { flash(t: string): void }) {
  const [sayi, setSayi] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { getContactCount().then(r => setSayi(r.sayi)).catch(() => {}); }, []);
  const upload = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await uploadFile(f, p => flash(`Rehber yükleniyor… %${Math.round(p * 100)}`));
      if (r.rehber) { setSayi(r.rehber.toplam); flash(`Rehber yüklendi: ${r.rehber.eklenen} yeni, ${r.rehber.guncellenen} güncellendi · toplam ${r.rehber.toplam} kişi`); }
      else flash('Dosyada kişi bulunamadı: telefonun Kişiler uygulamasından dışa aktarılan .vcf dosyasını seçin.');
    } catch (e: any) { flash(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      <label>Rehber{sayi !== null ? ` · ${sayi} kişi` : ''}</label>
      <p className="muted small">Telefonunuzdaki kişileri isim ve numaralarıyla Jarvis'e yükleyin; "Ahmet'i ara", "Ayşe'ye WhatsApp'tan yaz" deyince buradan bulur. Kişiler yalnız bu bilgisayarda saklanır.</p>
      <button className="save" disabled={busy} onClick={() => file.current?.click()}>{busy ? '⏳ Yükleniyor…' : '📇 Rehber dosyası yükle (.vcf / .csv)'}</button>
      <input ref={file} type="file" accept=".vcf,.csv,text/vcard,text/x-vcard,text/csv" hidden onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} />
      <details className="small">
        <summary>Rehber dosyası nasıl alınır?</summary>
        <p><b>Android:</b> Kişiler (Rehber) uygulaması → ⋮ menü → Ayarlar → <i>Kişileri dışa aktar</i> → "Dahili depolama" → .vcf dosyası kaydedilir. Sonra Jarvis'i telefonda açıp bu düğmeyle o dosyayı seçin.</p>
        <p><b>Google hesabındaki kişiler:</b> contacts.google.com → sol menü <i>Dışa aktar</i> → <i>vCard</i> → indirilen dosyayı bu düğmeyle seçin.</p>
        <p><b>iPhone:</b> bilgisayarda icloud.com → Kişiler → hepsini seçin (Ctrl+A) → ⚙️ → <i>vCard'ı Dışa Aktar</i> → indirilen dosyayı bu düğmeyle seçin.</p>
        <p>Android telefon USB ile bağlıysa Ayarlar → Android bölümündeki "📇 Rehberi telefondan al" düğmesi dosyasız da alır.</p>
      </details>
    </>
  );
}
