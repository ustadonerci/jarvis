// Uzaktan komut: kullanıcı WhatsApp'ta kendine yazdığı sohbetten ("Kendime mesaj") ya da eşleştirilmiş Telegram
// sohbetinden Jarvis'e yazar; mesaj Jarvis'in ana sohbetine gider (ekranlarda da görünür), cevabın metni aynı sohbete
// "🤖 " ile döner. Onay kartı açan işlemler uzaktan "onayla" / "reddet" ile karara bağlanır; para harcayan işlemler
// (satın alma, borsa) yalnızca Jarvis ekranından onaylanır.
import { actionList, decideAction } from './approvals.js';

export type Kanal = 'whatsapp' | 'telegram';
type Ask = (text: string, kanal: Kanal) => Promise<string>;
let ask: Ask | null = null;
export const setRemoteAsk = (fn: Ask) => { ask = fn; };

const MONEY = new Set(['satin_alma', 'borsa']);
const pending = new Map<Kanal, string[]>();
const fold = (s: string) => s.toLocaleLowerCase('tr').replace(/[çğıöşü]/g, c => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c] ?? c).replace(/[^a-z0-9 ]+/g, ' ').trim();

export const HELP = [
  'Jarvis uzaktan komut 🤖',
  '• Bana normal konuşur gibi yazın: "yarın hava nasıl", "maillerimi özetle", "Bilal\'i ara", "dolar kaç".',
  '• Onay isteyen işlemlerde "onayla" ya da "reddet" yazın (satın alma ve borsa işlemleri yalnız Jarvis ekranından onaylanır).',
  '• Jarvis\'e gitmesini istemediğiniz notların başına # koyun.',
].join('\n');

/** Bir uzaktan mesajı işler ve cevabı send ile gönderir */
export async function handleRemote(kanal: Kanal, text: string, send: (t: string) => Promise<unknown>) {
  const t = fold(text);
  try {
    if (/^(\/?yardim|\/help|\/start|komutlar)$/.test(t)) { await send(`🤖 ${HELP}`); return; }
    const waiting = (pending.get(kanal) ?? []).map(id => actionList().find(a => a.id === id)).filter(a => a && a.durum === 'bekliyor');
    const yes = /^(evet )?(onayla|onayliyorum|onay|calistir|tamam onayla)$/.test(t), no = /^(reddet|iptal|vazgec|hayir)$/.test(t);
    if ((yes || no) && waiting.length) {
      const out: string[] = [];
      for (const a of waiting) {
        if (yes && MONEY.has(a!.tur)) { out.push(`⛔ "${a!.baslik}" para içerdiği için yalnızca Jarvis ekranından onaylanabilir.`); continue; }
        const r = await decideAction(a!.id, yes);
        out.push(r ? `${yes ? (r.durum === 'tamam' ? '✅' : '⚠️') : '❌'} ${r.baslik}${r.sonuc ? `\n${r.sonuc.slice(0, 1500)}` : ''}` : `"${a!.baslik}" artık beklemiyor.`);
      }
      pending.set(kanal, []);
      await send(`🤖 ${out.join('\n\n')}`);
      return;
    }
    if (!ask) { await send('🤖 Jarvis henüz hazır değil, birazdan tekrar deneyin.'); return; }
    const before = new Set(actionList().map(a => a.id));
    const reply = (await ask(text.slice(0, 2000), kanal)).trim();
    const fresh = actionList().filter(a => !before.has(a.id) && a.durum === 'bekliyor');
    pending.set(kanal, fresh.map(a => a.id));
    const cards = fresh.map(a => `⏳ Onay bekliyor: ${a.baslik}\n${a.ayrinti.slice(0, 600)}\n${MONEY.has(a.tur) ? '(Para içeren işlem: yalnızca Jarvis ekranından onaylanır.)' : '→ "onayla" ya da "reddet" yazın.'}`);
    await send(`🤖 ${[reply || 'Tamam.', ...cards].join('\n\n')}`.slice(0, 4000));
  } catch (e: any) {
    await send(`🤖 Bir sorun oldu: ${String(e?.message || e).slice(0, 200)}`).catch(() => {});
  }
}
