import type { Ekran, Kart, MesajFiltre } from '../lib/types';

const MF: MesajFiltre = { goster: true, whatsapp: true, telegram: true, arama: true, grup: true, sadeceOkunmamis: false };
const MF_AD: [keyof MesajFiltre, string][] = [['goster', 'Mesajları göster'], ['whatsapp', '🟢 WhatsApp'], ['telegram', '🔵 Telegram'], ['arama', '📞 Aramalar'], ['grup', '👥 Gruplar'], ['sadeceOkunmamis', 'Yalnız okunmamışlar']];

const KARTLAR: [Kart, string][] = [['hava', 'Hava kartı'], ['sistem', 'Sistem kartı'], ['piyasa', 'Piyasalar kartı'], ['gundem', 'Gündem kartı']];

const ROWS: { k: 'genel' | 'cekirdek' | 'yazi' | 'panel'; ad: string; min: number; max: number }[] = [
  { k: 'genel', ad: 'Genel büyüklük', min: 0.7, max: 1.5 },
  { k: 'cekirdek', ad: 'Çekirdek (halka)', min: 0.5, max: 1.6 },
  { k: 'yazi', ad: 'Yazı (altyazı)', min: 0.7, max: 2 },
  { k: 'panel', ad: 'Yan panel genişliği', min: 0.7, max: 1.5 },
];

/** Ayarlar → Ekran düzeni: ana ekranın boyutları ve yan paneller. Jarvis'e sesle de söylenebilir ("yazıları büyüt"). */
export function ScreenLayout({ ekran, onChange }: { ekran: Ekran; onChange(p: Partial<Ekran>): void }) {
  return (
    <>
      <label>Ekran düzeni</label>
      <p className="muted small">Kaydırıcılarla ayarlayın ya da Jarvis'e söyleyin: "yazıları büyüt", "çekirdeği küçült", "yan panelleri gizle".</p>
      {ROWS.map(r => (
        <div className="row layout-row" key={r.k}>
          <span className="small" style={{ minWidth: 150 }}>{r.ad}</span>
          <input type="range" min={r.min} max={r.max} step={0.05} value={ekran[r.k]} onChange={e => onChange({ [r.k]: Number(e.target.value) })} style={{ flex: 1 }} />
          <span className="small mono" style={{ minWidth: 44, textAlign: 'right' }}>%{Math.round(ekran[r.k] * 100)}</span>
        </div>
      ))}
      <div className="seg">
        {([['hepsi', 'Paneller açık'], ['sol', 'Yalnız sol'], ['sag', 'Yalnız sağ'], ['gizli', 'Paneller gizli']] as const).map(([v, ad]) => (
          <button key={v} className={ekran.paneller === v ? 'on' : ''} onClick={() => onChange({ paneller: v })}>{ad}</button>
        ))}
      </div>
      <p className="muted small">Kart yükseklikleri (aynı sütundaki kartlar alanı paylaşır; en solda gizli):</p>
      {KARTLAR.map(([k, ad]) => (
        <div className="row layout-row" key={k}>
          <span className="small" style={{ minWidth: 150 }}>{ad}</span>
          <input type="range" min={0} max={2.5} step={0.05} value={ekran.kartlar?.[k] ?? 1} onChange={e => onChange({ kartlar: { ...ekran.kartlar, [k]: Number(e.target.value) } })} style={{ flex: 1 }} />
          <span className="small mono" style={{ minWidth: 44, textAlign: 'right' }}>{(ekran.kartlar?.[k] ?? 1) === 0 ? 'gizli' : `%${Math.round((ekran.kartlar?.[k] ?? 1) * 100)}`}</span>
        </div>
      ))}
      <p className="muted small">Gündem kartında hangi mesajlar görünsün? (Jarvis'e de söyleyebilirsiniz: "sadece WhatsApp mesajları görünsün")</p>
      <div className="seg wrap">
        {MF_AD.map(([k, ad]) => {
          const f = { ...MF, ...ekran.mesajlar };
          return <button key={k} className={f[k] ? 'on' : ''} onClick={() => onChange({ mesajlar: { ...f, [k]: !f[k] } })}>{f[k] ? '✅' : '⬜'} {ad}</button>;
        })}
      </div>
      <button onClick={() => onChange({ genel: 1, cekirdek: 1, yazi: 1, panel: 1, paneller: 'hepsi', kartlar: { hava: 1, sistem: 1, piyasa: 1, gundem: 1 }, mesajlar: MF })}>↺ Varsayılana dön</button>
    </>
  );
}
