// Office dosyası üretimi (Orkas'taki PptMaker / OfficeWorker'dan uyarlandı; kod alınmadı): sunum (.pptx), Word belgesi
// (.docx), Excel tablosu (.xlsx) ve tek dosyalık HTML arayüz taslağı Belgeler\Jarvis Dosyalar'a yazılır. Bilgisayarda Office olmasa da çalışır: Python
// kütüphaneleri (python-pptx, python-docx, openpyxl) kullanılır; eksikse kurulumu onay kartıyla önerilir.
// Yalnız yeni dosya yazar; var olan dosyanın üzerine yazmaz (adına sayı eklenir).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { propose } from './approvals.js';

const KLASOR = path.join(os.homedir(), 'Documents', 'Jarvis Dosyalar');
const UZANTI = { sunu: 'pptx', belge: 'docx', tablo: 'xlsx', sayfa: 'html' } as const;
type Tur = keyof typeof UZANTI;

// Girdi stdin'den JSON; çıktı yolu argümanda. Metinler yalnız veri olarak yazılır.
const PY = String.raw`
import json, sys
d = json.loads(sys.stdin.buffer.read().decode('utf-8'))
out, tur = sys.argv[1], d['tur']
if tur == 'sunu':
    from pptx import Presentation
    from pptx.util import Pt
    p = Presentation()
    s = p.slides.add_slide(p.slide_layouts[0])
    s.shapes.title.text = d.get('baslik') or ''
    if d.get('alt_baslik'): s.placeholders[1].text = d['alt_baslik']
    for sl in d.get('slaytlar', []):
        s = p.slides.add_slide(p.slide_layouts[1])
        s.shapes.title.text = sl.get('baslik', '')
        tf = s.placeholders[1].text_frame
        for i, m in enumerate(sl.get('maddeler', [])):
            para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            para.text = str(m); para.font.size = Pt(20)
        if sl.get('not'): s.notes_slide.notes_text_frame.text = sl['not']
    p.save(out)
elif tur == 'belge':
    from docx import Document
    doc = Document()
    if d.get('baslik'): doc.add_heading(d['baslik'], 0)
    for b in d.get('bolumler', []):
        if b.get('baslik'): doc.add_heading(b['baslik'], 1)
        for t in b.get('paragraflar', []): doc.add_paragraph(str(t))
        for m in b.get('maddeler', []): doc.add_paragraph(str(m), style='List Bullet')
    doc.save(out)
else:
    from openpyxl import Workbook
    from openpyxl.styles import Font
    wb = Workbook(); wb.remove(wb.active)
    for sh in d.get('sayfalar', []) or [{'ad': 'Sayfa1', 'satirlar': []}]:
        ws = wb.create_sheet(str(sh.get('ad') or 'Sayfa')[:31])
        for r in sh.get('satirlar', []): ws.append(list(r))
        for c in ws[1] if ws.max_row else []: c.font = Font(bold=True)
        for col in ws.columns:
            ws.column_dimensions[col[0].column_letter].width = min(60, max(10, *(len(str(c.value or '')) + 2 for c in col)))
    wb.save(out)
print(out)
`;

const run = (args: string[], stdin?: string) => new Promise<{ ok: boolean; out: string }>(resolve => {
  const p = execFile('python', args, { timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}`.trim() || `${stderr}`.trim() }));
  if (stdin !== undefined) { p.stdin?.end(Buffer.from(stdin, 'utf8')); }
});

/** Var olan dosyanın üzerine yazmamak için boş ad */
export function bosAd(klasor: string, ad: string, uzanti: string): string {
  const temiz = ad.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Jarvis';
  for (let i = 1; ; i++) {
    const f = path.join(klasor, `${temiz}${i > 1 ? ` (${i})` : ''}.${uzanti}`);
    if (!fs.existsSync(f)) return f;
  }
}

export const OFIS_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ofis_dosyasi',
      description: "PowerPoint sunumu (.pptx), Word belgesi (.docx) ya da Excel tablosu (.xlsx) dosyası üretir; Belgeler\\Jarvis Dosyalar'a yazar. 'X hakkında 8 slaytlık sunum hazırla', 'bu raporu Word yap', 'harcamaları Excel'e dök', 'tasarım uzmanının ekranını dosya yap'. tur: sayfa → html: tek dosyalık tam HTML (tasarım uzmanının ürettiği);  sunu → baslik, alt_baslik?, slaytlar: [{baslik, maddeler: [3-6 kısa madde], not?: konuşmacı notu}]; belge → baslik, bolumler: [{baslik?, paragraflar: [], maddeler?: []}]; tablo → sayfalar: [{ad, satirlar: [[başlık satırı], [değerler]...]}] (sayılar sayı olarak). İçeriği SEN hazırla (gerekirse önce araştır); gerçek olmayan rakam uydurma.",
      parameters: {
        type: 'object',
        properties: {
          tur: { type: 'string', enum: ['sunu', 'belge', 'tablo', 'sayfa'] }, html: { type: 'string' },
          ad: { type: 'string', description: 'Dosya adı (uzantısız)' },
          baslik: { type: 'string' }, alt_baslik: { type: 'string' },
          slaytlar: { type: 'array', items: { type: 'object', properties: { baslik: { type: 'string' }, maddeler: { type: 'array', items: { type: 'string' } }, not: { type: 'string' } } } },
          bolumler: { type: 'array', items: { type: 'object', properties: { baslik: { type: 'string' }, paragraflar: { type: 'array', items: { type: 'string' } }, maddeler: { type: 'array', items: { type: 'string' } } } } },
          sayfalar: { type: 'array', items: { type: 'object', properties: { ad: { type: 'string' }, satirlar: { type: 'array', items: { type: 'array', items: {} } } } } },
        },
        required: ['tur', 'ad'],
      },
    },
  },
] as const;
export const isOfisTool = (n: string) => n === 'ofis_dosyasi';

const PAKET: Record<Exclude<Tur, 'sayfa'>, [string, string]> = { sunu: ['pptx', 'python-pptx'], belge: ['docx', 'python-docx'], tablo: ['openpyxl', 'openpyxl'] };

export async function runOfisTool(a: any, progress: (l: string) => void): Promise<string> {
  const j = (v: unknown) => JSON.stringify(v);
  const tur = a.tur as Tur;
  if (!(tur in UZANTI)) return j({ hata: 'tur: sunu, belge, tablo ya da sayfa' });
  if (tur === 'sayfa') {
    const html = String(a.html ?? '');
    if (!/<html|<body|<div/i.test(html)) return j({ hata: 'html alanında tam bir HTML sayfası gerekli' });
    fs.mkdirSync(KLASOR, { recursive: true });
    const out = bosAd(KLASOR, String(a.ad ?? 'Arayüz taslağı'), 'html');
    fs.writeFileSync(out, html.slice(0, 2_000_000));
    return j({ ok: true, dosya: out, not: 'Tarayıcıda açılarak görülebilir.' });
  }
  const [modul, paket] = PAKET[tur];
  const var_ = await run(['-E', '-P', '-c', `import ${modul}`]);
  if (!var_.ok) {
    if (/not recognized|ENOENT|bulunamadı/i.test(var_.out)) return j({ hata: 'Python bulunamadı', not: 'uygulama_yonet ile Python.Python.3 kurulumunu öner.' });
    return propose('uygulama', `Office dosyası için Python kütüphanesi kur (${paket})`, `python -m pip install --user python-pptx python-docx openpyxl`,
      'Sunum, Word ve Excel dosyası üretmek için gereken üç küçük Python kütüphanesi (bir kez kurulur).',
      async () => { const r = await run(['-m', 'pip', 'install', '--user', 'python-pptx', 'python-docx', 'openpyxl']); if (!r.ok) throw new Error(r.out.slice(-400)); return 'Kuruldu; dosyayı şimdi üretebilirim.'; });
  }
  fs.mkdirSync(KLASOR, { recursive: true });
  const out = bosAd(KLASOR, String(a.ad ?? a.baslik ?? 'Jarvis'), UZANTI[tur]);
  progress(`${path.basename(out)} hazırlanıyor`);
  const veri = { tur, baslik: a.baslik, alt_baslik: a.alt_baslik, slaytlar: a.slaytlar, bolumler: a.bolumler, sayfalar: a.sayfalar };
  const r = await run(['-E', '-P', '-c', PY, out], JSON.stringify(veri));
  if (!r.ok || !fs.existsSync(out)) return j({ hata: 'Dosya üretilemedi', ayrinti: r.out.slice(-500) });
  return j({ ok: true, dosya: out, klasor: KLASOR, not: 'Dosyanın adını ve yerini söyle.' });
}
