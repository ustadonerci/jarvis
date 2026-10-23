import { useEffect, useState } from 'react';
import { canPrompt, isIOS, isMobile, isStandalone, onInstallChange, promptInstall } from '../lib/install';

const KEY = 'jarvis.anaekran.kapali';
const dismissed = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

/** Telefonda tarayıcıdan açılınca: "Jarvis'i ana ekrana ekle" şeridi (uygulama gibi simgeyle açılsın) */
export function AnaEkran() {
  const [show, setShow] = useState(() => isMobile() && !isStandalone() && !dismissed());
  const [, rerender] = useState(0);
  const [help, setHelp] = useState(false);
  useEffect(() => onInstallChange(() => rerender(n => n + 1)), []);
  if (!show) return null;

  const close = () => { try { localStorage.setItem(KEY, '1'); } catch { /* yok say */ } setShow(false); };
  const add = async () => {
    if (canPrompt()) { if (await promptInstall()) setShow(false); }
    else setHelp(true);
  };
  return (
    <div className="anaekran" role="dialog" aria-label="Ana ekrana ekle">
      <img src="/icon-192.png" alt="" />
      <div className="ae-text">
        {help
          ? isIOS()
            ? <>Safari'de alttaki <b>Paylaş</b> düğmesine (kare ve yukarı ok) dokunun, sonra <b>Ana Ekrana Ekle</b> → <b>Ekle</b>.</>
            : <>Tarayıcının sağ üstteki <b>⋮</b> menüsünden <b>Ana ekrana ekle</b> (ya da <b>Uygulamayı yükle</b>) seçin.</>
          : <><b>Jarvis'i ana ekrana ekleyin</b><br />Telefonunuzda uygulama gibi simgesiyle açılır.</>}
      </div>
      {!help && <button className="ae-add" onClick={add}>Ekle</button>}
      <button className="ae-close" onClick={close} aria-label="Kapat">✕</button>
    </div>
  );
}
