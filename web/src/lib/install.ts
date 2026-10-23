// Telefonda "Ana ekrana ekle": Android Chrome kurulum penceresini (beforeinstallprompt) yakalar; iPhone'da bu yok,
// kullanıcıya Paylaş → Ana Ekrana Ekle anlatılır. Olay sayfa açılır açılmaz gelebildiği için main.tsx bunu en başta yükler.
let deferred: any = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach(f => f());

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; notify(); });
window.addEventListener('appinstalled', () => { deferred = null; notify(); });

export const canPrompt = () => !!deferred;
export const onInstallChange = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** Android'in kendi "Uygulamayı yükle" penceresini açar; kurulduysa true */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  e.prompt();
  const r = await e.userChoice.catch(() => null);
  notify();
  return r?.outcome === 'accepted';
}

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isMobile = () => isIOS() || /Android|Mobi/i.test(navigator.userAgent);
/** Ana ekrandan (uygulama olarak) mı açıldı? */
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
