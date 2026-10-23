// Soruya göre araç ve talimat seçimi. Her soruda 65 araç (~10 bin token) ve tüm talimat bölümleri (~9 bin token)
// gönderiliyordu: cevap geç başlıyor, model alakasız araç ve becerilere sapıyordu. Artık temel araçlar (hava, piyasa,
// arama, YouTube, hafıza, kitaplık…) her zaman, diğer gruplar yalnızca soruda (ya da kısa bir onay/devam cevabında,
// önceki mesajlarda) ilgili bir kelime geçerse gönderilir. Talimatların o gruplara ait bölümleri de aynı şekilde.

export type Group = 'gundem' | 'fal' | 'finans' | 'mesaj' | 'eposta' | 'github' | 'ajan' | 'sistem' | 'otomasyon' | 'telefon' | 'sms' | 'sosyal' | 'android' | 'site' | 'yetenek' | 'mcp';

const fold = (s: string) => s.toLocaleLowerCase('tr')
  .replace(/[çğıöşü]/g, c => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c] ?? c);

// Kelimeler Türkçe karakterleri sadeleştirilmiş hâliyle (ç→c, ş→s…) ve kök olarak yazılır
const RULES: [Group, RegExp][] = [
  ['finans', /\b(borsa|hisse|bist|nasdaq|dolar|euro|avro|sterlin|doviz|(dolar|euro|avro|doviz) kuru|kurlar\b|altin|gumus|petrol|brent|kripto|bitcoin|btc|ethereum|eth|coin|portfoy|yatirim|fiyat|alarm|rsi|macd|teknik analiz|al(sam|ayim|mali)|sat(sam|ayim|mali)|thyao|aselsan|garanti)/],
  ['mesaj', /(whatsapp|watsap|vatsap|telegram|mesaj|yaz(ar misin|sana|in|di|dim|digim)|gonder|okunmamis|kim(ler)? (aradi|yazdi)|sohbet|geri al|herkesten sil|benden sil|duzelt)/],
  ['eposta', /(e-?posta|\bmail|gmail|outlook|gelen kutu|taslak|arsivle|cop kutu)/],
  ['github', /(github|\brepo|trend)/],
  ['ajan', /(uzman|ajan|detayli arastir|derinlemesine|rapor hazirla|strateji|plan hazirla)/],
  ['sistem', /(bilgisayar|programi?|uygulama(yi|lari)? (kur|ac|kapat|kaldir|guncelle)|winget|komut|powershell|terminal|dosya|klasor|masaustu|\bdisk\b|\bram\b|islemci|sistem bilgi|kendi kod)/],
  ['otomasyon', /(webhook|n8n|zapier|make\.com|otomasyon|is akisi|kanala? paylas|paylasim yap|kendi kodunu|kodunu (duzelt|duzenle|oku))/],
  ['telefon', /(telefonla ara|\bara(r misin|yin|sana|\b)|arama yap|telefon et|arama kayit|kim aradi|twilio)/],
  ['sms', /(\bsms|kisa mesaj)/],
  ['sosyal', /(youtube|youtu\.be|instagram|insta\b|tiktok|twitter|x\.com|takip|kanal|reels|shorts|video(yu|lari)? (ozetle|ac))/],
  ['android', /(telefonuma|telefonumdan|telefonumda|play store|google play|apk|android|uygulama(yi)? (yukle|indir|sil|kaldir))/],
  ['site', /(site(yi|sini)? (indir|arsivle|kaydet)|web sitesi(ni)? (indir|kaydet))/],
  ['yetenek', /(yetenek|beceri|skill|is akisi|workflow|repo|github\.com|ogren|seo|reklam|pazarlama|icerik|post|kampanya|tasarim|logo|marka|kurgu|montaj|senaryo|metin yaz|baslik yaz|analiz et|hazirla|olustur)/],
  ['mcp', /(\bmcp|topview|sunucu araci)/],
];

/** Kısa onay/devam cevabı mı ("evet", "gönder", "onayla", "tamam devam")? O zaman önceki mesajların grupları da gerekir. */
const FOLLOW_UP = /^(evet|hayir|tamam|olur|peki|gonder|onayla|onayliyorum|devam|yap|baslat|sil|iptal|vazgec|tabi|tabii|aynen|dogru|yanlis|bu|sunu|onu|hepsi|hepsini)\b/;

export function detectGroups(text: string, history: { role: string; text: string }[]): Set<Group> {
  const t = fold(text);
  const out = new Set<Group>();
  const scan = (s: string) => { for (const [g, re] of RULES) if (re.test(s)) out.add(g); };
  scan(t);
  // Önceki kullanıcı mesajı her zaman, kısa onay/devam cevabında son 4 mesaj (asistanınki dahil) da taranır
  const prevUser = [...history].reverse().find(m => m.role === 'user');
  if (prevUser) scan(fold(prevUser.text));
  if (t.split(/\s+/).length <= 6 || FOLLOW_UP.test(t)) history.slice(-4).forEach(m => scan(fold(m.text.slice(0, 2000))));
  // Mesaj silme/düzeltme ve e-posta kendi gruplarında; "sil" tek başına bir şey ifade etmez
  if (out.has('mcp')) out.add('yetenek');
  return out;
}

/** Talimat bölümü → grup (listede olmayan bölümler her zaman gönderilir) */
const SECTION_GROUP: Record<string, Group[]> = {
  'Gündem özeti protokolü': ['gundem'],
  'Kahve falı (eğlence)': ['fal'],
  'Finans ve portföy': ['finans'],
  'E-posta': ['eposta'],
  'GitHub takibi': ['github'],
  'Uzman ajanlar': ['ajan', 'otomasyon'],
  'Bilgisayar kontrolü, otomasyon ve kendi kodun (ONAY KARTIYLA)': ['sistem', 'otomasyon', 'telefon', 'sms'],
  'Site indirme': ['site'],
  'Mesajlar (Telegram ve WhatsApp)': ['mesaj'],
  'Sosyal medya (YouTube, Instagram, TikTok, X)': ['sosyal'],
  'Android telefon (Google Play)': ['android'],
  'Yetenekler': ['yetenek', 'mcp'],
  'Kendini geliştirme': ['yetenek'],
};

/** Seçilmeyen grupların talimat bölümlerini çıkarır ("# Başlık" ile başlayan bölümler) */
export function trimPrompt(prompt: string, groups: Set<Group>): string {
  return prompt.split(/\n(?=# )/).filter(sec => {
    const title = /^# (.+)/.exec(sec)?.[1]?.trim() ?? '';
    const g = SECTION_GROUP[title];
    return !g || g.some(x => groups.has(x));
  }).join('\n');
}
