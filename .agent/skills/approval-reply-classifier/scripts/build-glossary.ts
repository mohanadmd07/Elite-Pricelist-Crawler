/**
 * Seeds resources/medical-glossary.json.
 *   npx tsx .agent/skills/approval-reply-classifier/scripts/build-glossary.ts
 *
 * = curated core procedures (below) + up to 200 hospital procedures from the 2026 pricelist.
 * THE OUTPUT MUST BE REVIEWED BY A CLINICIAN BEFORE USE. Entries get `"reviewed": false`.
 *
 * Note: there is no usage data to rank "top 200" yet (history is ~5 days). Until
 * there is, the 200 are taken from the clinical sections in priority order
 * (Procedures, Endoscopy, Cath lab, Intervention radiology, Dialysis, Open heart, IPD, Medical devices).
 * Re-run once approval_outcomes holds enough history to rank by frequency.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractAttributes } from '../../../../src/classifier/glossary';

type E = {
  canonical_en: string;
  aliases: string[];
  category: string;
  code: string | null;
  laterality: 'left' | 'right' | 'bilateral' | null;
  approach: string | null;
  contrast: 'with' | 'without' | null;
  tags?: string[];
  reviewed?: boolean;
};

const core = (
  canonical_en: string,
  aliases: string[],
  category: string,
  o: Partial<Pick<E, 'laterality' | 'approach' | 'contrast' | 'tags'>> = {}
): E => ({ canonical_en, aliases, category, code: null, laterality: o.laterality ?? null, approach: o.approach ?? null, contrast: o.contrast ?? null, ...(o.tags ? { tags: o.tags } : {}), reviewed: false });

const CORE: E[] = [
  core('Laparoscopic cholecystectomy', ['lap chole', 'LC', 'lap cholecystectomy', 'استئصال المرارة بالمنظار', 'عملية المرارة منظار', 'عمليه المراره بالمنظار', 'lap chole operation'], 'PROCEDURE', { approach: 'laparoscopic' }),
  core('Open cholecystectomy', ['open chole', 'استئصال المرارة جراحة مفتوحة', 'عملية المرارة مفتوحة'], 'PROCEDURE', { approach: 'open' }),
  core('Appendectomy (open)', ['open appendectomy', 'appendicectomy', 'استئصال الزائدة الدودية', 'عملية الزايدة', 'عملية الزائدة', 'appendix operation'], 'PROCEDURE', { approach: 'open' }),
  core('Laparoscopic appendectomy', ['lap appendectomy', 'lap appendicectomy', 'استئصال الزائدة بالمنظار', 'عملية الزايدة منظار'], 'PROCEDURE', { approach: 'laparoscopic' }),
  core('Inguinal hernia repair with mesh', ['inguinal hernia mesh', 'inguinal hernioplasty', 'اصلاح فتق اربي بشبكة', 'عملية فتق اربي بالشبكة', 'فتق اربي ميش'], 'PROCEDURE', { tags: ['mesh'] }),
  core('Inguinal hernia repair without mesh', ['inguinal herniorrhaphy', 'inguinal hernia no mesh', 'اصلاح فتق اربي بدون شبكة', 'فتق اربي بدون شبكه'], 'PROCEDURE'),
  core('Umbilical hernia repair with mesh', ['umbilical hernia mesh', 'اصلاح فتق سري بشبكة', 'فتق سري بالشبكة'], 'PROCEDURE', { tags: ['mesh'] }),
  core('Umbilical hernia repair without mesh', ['umbilical hernia', 'اصلاح فتق سري', 'فتق سري بدون شبكة'], 'PROCEDURE'),
  core('Incisional hernia repair with mesh', ['incisional hernia mesh', 'ventral hernia mesh', 'اصلاح فتق جراحي بشبكة', 'فتق في موضع الجرح بالشبكة'], 'PROCEDURE', { tags: ['mesh'] }),
  core('Incisional hernia repair without mesh', ['incisional hernia', 'اصلاح فتق جراحي بدون شبكة'], 'PROCEDURE'),
  core('Cesarean section', ['C-section', 'CS', 'c/s', 'caesarean', 'LSCS', 'ولادة قيصرية', 'عملية قيصرية', 'قيصرية', 'عملية ولادة قيصري'], 'PROCEDURE'),
  core('Transurethral resection of the prostate (TURP)', ['TURP', 'TUR-P', 'استئصال البروستاتا بالمنظار', 'تقشير البروستاتا', 'عملية البروستاتا منظار'], 'PROCEDURE', { approach: 'endoscopic' }),
  core('Ureteroscopy', ['URS', 'URS stone', 'ureteroscopic lithotripsy', 'منظار الحالب', 'تفتيت حصوات الحالب بالمنظار', 'منظار حالب'], 'PROCEDURE', { approach: 'endoscopic' }),
  core('Extracorporeal shock wave lithotripsy (ESWL)', ['ESWL', 'SWL', 'lithotripsy', 'تفتيت الحصوات بالموجات', 'تفتيت حصوات بالموجات التصادمية', 'تفتيت حصوات الكلى بالموجات'], 'PROCEDURE'),
  core('Cystoscopy', ['cysto', 'مناظير المثانة', 'منظار مثانة', 'منظار المثانة'], 'PROCEDURE', { approach: 'endoscopic' }),
  core('ERCP', ['endoscopic retrograde cholangiopancreatography', 'ERCP stone extraction', 'ERCP stent', 'منظار القنوات المرارية', 'ايرسي بي'], 'PROCEDURE', { approach: 'endoscopic' }),
  core('Diagnostic cardiac catheterization', ['cardiac cath', 'coronary angiography', 'CAG', 'diagnostic cath', 'قسطرة قلب تشخيصية', 'قسطرة تشخيصية', 'قسطرة القلب', 'قسطره تشخيصيه'], 'PROCEDURE'),
  core('Coronary angioplasty with stent (PCI)', ['PCI', 'PTCA', 'stent', 'coronary stent', 'DES', 'تركيب دعامة', 'دعامة تاجية', 'قسطرة علاجية', 'قسطرة وتركيب دعامه', 'قسطرة علاجية بدعامة'], 'PROCEDURE', { tags: ['implant:stent'] }),
  core('CT scan with contrast', ['CT with contrast', 'CT w contrast', 'CT with dye', 'اشعة CT بالصبغة', 'اشعه مقطعية بالصبغة', 'اشعة مقطعية بالصبغه', 'مقطعية بالصبغة', 'CT بالصبغة', 'c.t with contrast'], 'INVESTIGATION', { contrast: 'with' }),
  core('CT scan without contrast', ['CT without contrast', 'CT plain', 'non contrast CT', 'CT بدون صبغة', 'اشعة مقطعية بدون صبغة', 'مقطعية بدون صبغه', 'اشعه CT بدون صبغه'], 'INVESTIGATION', { contrast: 'without' }),
  core('MRI with contrast', ['MRI with contrast', 'MRI w contrast', 'MRI with gado', 'رنين مغناطيسي بالصبغة', 'رنين بالصبغه', 'MRI بالصبغة'], 'INVESTIGATION', { contrast: 'with' }),
  core('MRI without contrast', ['MRI without contrast', 'MRI plain', 'MRI non contrast', 'رنين مغناطيسي بدون صبغة', 'رنين بدون صبغه', 'MRI بدون صبغة'], 'INVESTIGATION', { contrast: 'without' }),
  core('Hemodialysis session', ['dialysis', 'HD', 'HD session', 'dialysis session', 'غسيل كلوي', 'جلسة غسيل كلى', 'جلسة غسيل كلوي', 'غسيل كلى'], 'PROCEDURE'),
  core('ICU day', ['ICU', 'ICU stay', 'ICU day', 'intensive care', 'العناية المركزة', 'رعاية مركزة', 'ايام عناية مركزة', 'اقامة عناية مركزة', 'يوم عناية مركزة'], 'ICU_DAYS'),
  core('CCU day', ['CCU', 'CCU stay', 'cardiac care unit', 'عناية القلب', 'رعاية قلب', 'اقامة عناية قلب', 'عناية قلبية'], 'ICU_DAYS'),
  core('NICU day', ['NICU', 'NICU stay', 'incubator', 'neonatal ICU', 'حضانة', 'عناية اطفال حديثي الولادة', 'اقامة حضانة', 'حضانات'], 'ICU_DAYS'),
  core('Open reduction and internal fixation (ORIF)', ['ORIF', 'ORIF fracture', 'internal fixation', 'تثبيت كسر بالمسامير والشرائح', 'تثبيت داخلي للكسر', 'عملية تثبيت كسر', 'تثبيت كسر بشريحة'], 'PROCEDURE', { approach: 'open', tags: ['implant:plate'] }),
  core('Total knee replacement', ['TKR', 'TKA', 'total knee arthroplasty', 'knee replacement', 'تغيير مفصل الركبة', 'استبدال مفصل الركبة', 'مفصل ركبة صناعي', 'تغيير ركبة'], 'PROCEDURE', { tags: ['implant:prosthesis'] }),
  core('Total hip replacement', ['THR', 'THA', 'total hip arthroplasty', 'hip replacement', 'تغيير مفصل الفخذ', 'استبدال مفصل الورك', 'مفصل فخذ صناعي', 'تغيير مفصل الورك'], 'PROCEDURE', { tags: ['implant:prosthesis'] }),
  core('Inpatient admission', ['admission', 'inpatient admission', 'ward admission', 'حجز', 'اقامة بالقسم الداخلي', 'دخول مستشفى', 'اقامة داخلية', 'حجز داخلي', 'اقامه'], 'ADMISSION'),
  core('Consultant observation (daily round)', ['consultant visit', 'consultant round', 'مرور استشاري', 'كشف استشاري', 'مرور'], 'CONSULTATION'),
  core('Anesthesia', ['anaesthesia', 'general anesthesia', 'GA', 'تخدير', 'تخدير عام', 'مصاريف تخدير', 'التخدير'], 'OTHER'),
  core('Upper GI endoscopy', ['OGD', 'EGD', 'upper endoscopy', 'gastroscopy', 'منظار المعدة', 'منظار علوي', 'منظار على المعدة'], 'PROCEDURE', { approach: 'endoscopic' }),
  core('Colonoscopy', ['colono', 'lower GI endoscopy', 'منظار القولون', 'منظار القولون السفلي'], 'PROCEDURE', { approach: 'endoscopic' }),
  core('Echocardiography', ['echo', 'ECHO', 'cardiac echo', 'اشعة تلفزيونية على القلب', 'موجات صوتية على القلب', 'ايكو على القلب', 'ايكو'], 'INVESTIGATION'),
  core('Thyroidectomy', ['total thyroidectomy', 'استئصال الغدة الدرقية', 'عملية الغدة الدرقية'], 'PROCEDURE'),
  core('Tonsillectomy', ['T&A', 'tonsils', 'استئصال اللوز', 'عملية اللوز'], 'PROCEDURE'),
  core('Hysterectomy', ['TAH', 'استئصال الرحم', 'عملية استئصال الرحم'], 'PROCEDURE'),
  core('Cataract surgery with IOL (phacoemulsification)', ['phaco', 'phaco IOL', 'cataract', 'ازالة المياه البيضاء', 'عملية مياه بيضاء', 'عملية الميه البيضا', 'فاكو'], 'PROCEDURE', { tags: ['implant:iol'] }),
];

const SECTION_PRIORITY = ['Procedures', 'Endoscopy & GIT', 'Cathlab unit', 'Intervention radiology', 'Dialysis unit', 'Open heart', 'IPD Services', 'Medical devices'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(HERE, '../../../..');
const pl: Array<{ nameEnglish: string; nameArabic: string; price: string; sectionName: string; code?: string }> = JSON.parse(
  fs.readFileSync(path.join(root, 'public/2026_cash.json'), 'utf8')
);

const seen = new Set(CORE.flatMap((c) => [c.canonical_en.toLowerCase(), ...c.aliases.map((a) => a.toLowerCase())]));
const auto: E[] = [];
for (const sec of SECTION_PRIORITY) {
  for (const r of pl.filter((x) => x.sectionName === sec)) {
    if (auto.length >= 200) break;
    const en = (r.nameEnglish || '').trim();
    if (!en || seen.has(en.toLowerCase())) continue;
    seen.add(en.toLowerCase());
    const a = extractAttributes(`${en} ${r.nameArabic || ''}`);
    auto.push({
      canonical_en: en,
      aliases: [r.nameArabic].filter(Boolean).map((s) => s.trim()),
      category: sec === 'Medical devices' ? 'IMPLANT_DEVICE' : sec === 'IPD Services' ? 'ROOM_CLASS' : 'PROCEDURE',
      code: r.code || null,
      laterality: a.laterality,
      approach: a.approach,
      contrast: a.contrast,
      reviewed: false,
    });
  }
}

const out = {
  _note: 'SEEDED. A clinician must review every entry (set "reviewed": true) before relying on it. Auto entries come from the 2026 hospital pricelist.',
  generated_at: new Date().toISOString(),
  entries: [...CORE, ...auto],
};
const target = path.join(HERE, '../resources/medical-glossary.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`glossary: ${CORE.length} curated + ${auto.length} from pricelist -> ${target}`);
