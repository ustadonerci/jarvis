// Soruya göre araç ve talimat seçimi. Her soruda 65 araç (~10 bin token) ve tüm talimat bölümleri (~9 bin token)
// gönderiliyordu: cevap geç başlıyor, model alakasız araç ve becerilere sapıyordu. Artık temel araçlar (hava, piyasa,
// arama, YouTube, hafıza, kitaplık…) her zaman, diğer gruplar yalnızca soruda (ya da kısa bir onay/devam cevabında,
// önceki mesajlarda) ilgili bir kelime geçerse gönderilir. Talimatların o gruplara ait bölümleri de aynı şekilde.

export type Group = 'gundem' | 'fal' | 'medya' | 'ses' | 'satin' | 'finans' | 'mesaj' | 'eposta' | 'github' | 'ajan' | 'sistem' | 'otomasyon' | 'telefon' | 'sms' | 'sosyal' | 'android' | 'site' | 'yetenek' | 'mcp' | 'marka';

const fold = (s: string) => s.toLocaleLowerCase('tr')
  .replace(/[çğıöşü]/g, c => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c] ?? c);

// Kelimeler Türkçe karakterleri sadeleştirilmiş hâliyle (ç→c, ş→s…) ve kök olarak yazılır
const RULES: [Group, RegExp][] = [
  ['finans', /\b(borsa|hisse|bist|nasdaq|dolar|euro|avro|sterlin|doviz|(dolar|euro|avro|doviz) kuru|kurlar\b|altin|gumus|petrol|brent|kripto|bitcoin|btc|ethereum|eth|coin|portfoy|yatirim|fiyat|alarm|rsi|macd|teknik analiz|al(sam|ayim|mali)|sat(sam|ayim|mali)|thyao|aselsan|garanti|robot|alim ?satim|al-?sat|trading|trade|backtest|geriye donuk test|kagit (ustu|islem|mod)|binance)/],
  ['mesaj', /(whatsapp|watsap|vatsap|telegram|mesaj|yaz(ar misin|sana|in|di|dim|digim)|gonder|okunmamis|kim(ler)? (aradi|yazdi)|sohbet|geri al|herkesten sil|benden sil|duzelt)/],
  ['eposta', /(e-?posta|\bmail|maillerim|gmail|outlook|gelen kutu|taslak|arsivle|cop kutu|abonelik(ten|lerden)? cik|spam|reklam (mail|e-?posta)|bulten)/],
  ['github', /(github|\brepo|trend|kesif|kesfet|yeni yetenek|yeni beceri)/],
  ['ajan', /(uzman|ajan|detayli arastir|derinlemesine|rapor|strateji|plan hazirla|arka planda|tasarim|dashboard|panel tasarla)/],
  ['sistem', /(bilgisayar|programi?|uygulama(yi|lari)? (kur|ac|kapat|kaldir|guncelle)|winget|komut|powershell|terminal|dosya|klasor|masaustu|\bdisk\b|\bram\b|islemci|sistem bilgi|kendi kod|mikrofon|beni (yanlis )?(duy|anla)|sesimi (duy|alg)|ses ayar)/],
  ['otomasyon', /(webhook|n8n|zapier|make\.com|otomasyon|is akisi|kanala? paylas|paylasim yap|kendi kodunu|kodunu (duzelt|duzenle|oku))/],
  ['telefon', /(telefonla ara|\bara(r misin|yin|sana|\b)|arama yap|telefon et|arama kayit|kim aradi|twilio|beni ara|hatirlat|uyandir|planli arama|rehber|kisilerim|numarasi (ne|kac)|numarasini)/],
  ['sms', /(\bsms|kisa mesaj)/],
  ['sosyal', /(youtube|youtu\.be|instagram|insta\b|tiktok|twitter|x\.com|takip|kanal|reels|shorts|video(yu|lari)? (ozetle|ac))/],
  ['android', /(telefonuma|telefonumdan|telefonumda|play store|google play|apk|android|uygulama(yi)? (yukle|indir|sil|kaldir))/],
  ['medya', /(resm(i|in)|resim|foto|gorsel(i|in)? (kirp|boyut|filtre|donustur)|boyutlandir|kirp|filtre|siyah beyaz|\.(jpe?g|png|webp|mp3|wav|m4a|mp4|mov|mkv|webm)\b|ses(i|ini)? (temizle|cikar)|gurultu|video(yu|nun)? (kes|kirp|sikistir|donustur)|gif|altyazi|ffmpeg|reels?\b|shorts|tiktok video|dikey video|video (yap|hazirla|olustur|uret|kurgula)|videosu (yap|hazirla|olustur|uret))/],
  ['ses', /(voicestudio|voice studio|ses(imi|ini)? (klonla|kopyala|degistir)|klon ses|ses klon|sesin(i)? (degistir|ayarla)|sesle konus|ses profil|ses modeli)/],
  ['satin', /(satin al|satın al|abonelik|abone ol|hostinger|hosting|alan adi|domain|vps|siparis|odeme yap|paket al|fatura|yenile)/],
  ['site', /(site(yi|sini)? (indir|arsivle|kaydet)|web sitesi(ni)? (indir|kaydet))/],
  ['yetenek', /(yetenek|beceri|skill|is akisi|workflow|repo|github\.com|ogren|seo|reklam|pazarlama|icerik|post|kampanya|tasarim|logo|marka|kurgu|montaj|senaryo|metin yaz|baslik yaz|analiz et|hazirla|olustur)/],
  ['mcp', /(\bmcp|topview|sunucu araci)/],
  ['marka', /(brand24|marka(m|mizi|yi)? (takip|izle|hakkinda|analiz)|bahset(me|en|ti)|mention|sosyal dinleme|itibar|olumsuz yorum|hakkimda ne (konusuluyor|diyorlar))/],
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
  'Satın alma': ['satin'],
  'Medya işleme': ['medya'],
  'Ses klonlama (VoiceStudio)': ['ses'],
  'Mesajlar (Telegram ve WhatsApp)': ['mesaj'],
  'Sosyal medya (YouTube, Instagram, TikTok, X)': ['sosyal'],
  'Android telefon (Google Play)': ['android'],
  'Yetenekler': ['yetenek', 'mcp'],
  'Kendini geliştirme': ['yetenek'],
  'Borsa robotu': ['finans'],
  'Reels video': ['medya'],
  'Marka takibi (Brand24)': ['marka'],
};

/** Seçilmeyen grupların talimat bölümlerini çıkarır ("# Başlık" ile başlayan bölümler) */
export function trimPrompt(prompt: string, groups: Set<Group>): string {
  return prompt.split(/\n(?=# )/).filter(sec => {
    const title = /^# (.+)/.exec(sec)?.[1]?.trim() ?? '';
    const g = SECTION_GROUP[title];
    return !g || g.some(x => groups.has(x));
  }).join('\n');
}
