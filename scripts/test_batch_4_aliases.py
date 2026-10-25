#!/usr/bin/env python3
"""
Test Harness for Batch 4 Precision Laboratory Aliases
"""
import re
from typing import Tuple, List

HOMOGLYPH_MAP = {
    '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0397': 'H', '\u0399': 'I',
    '\u039a': 'K', '\u039c': 'M', '\u039d': 'N', '\u039f': 'O', '\u03a1': 'P',
    '\u03a4': 'T', '\u03a7': 'X', '\u03b1': 'a', '\u03b2': 'b', '\u03b5': 'e',
    '\u03b7': 'h', '\u03b9': 'i', '\u03ba': 'k', '\u03bc': 'm', '\u03bd': 'n',
    '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c7': 'x',
    '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041d': 'H', '\u041c': 'M',
    '\u041e': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0406': 'I',
    '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c',
    '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u043d': 'h', '\u0433': 'r',
}

def normalize_homoglyphs(text: str) -> str:
    if not text: return ''
    return re.sub(r'[\u0391-\u03c7\u0400-\u045f]', lambda m: HOMOGLYPH_MAP.get(m.group(0), m.group(0)), text)

def clean_arabic(text: str) -> str:
    if not text: return ''
    text = normalize_homoglyphs(text).lower()
    text = re.sub(r'[\u064B-\u065F\u0670]', '', text)
    text = re.sub(r'[إأآا]', 'ا', text)
    text = re.sub(r'ة\b', 'ه', text)
    text = re.sub(r'[ىي]', 'ي', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def generate_batch_4_aliases(name_en: str, name_ar: str, cat: str) -> Tuple[List[str], List[str], List[str]]:
    aliases_en = set()
    aliases_ar = set()
    abbrevs = set()

    lower_en = normalize_homoglyphs(name_en).lower().strip()
    norm_ar = clean_arabic(name_ar)

    if lower_en:
        aliases_en.add(lower_en)
        # remove punctuation versions
        clean_name = re.sub(r'[(),/:.-]', ' ', lower_en)
        clean_name = re.sub(r'\s+', ' ', clean_name).strip()
        if clean_name != lower_en:
            aliases_en.add(clean_name)
    if name_ar.strip():
        aliases_ar.add(name_ar.strip())
        if norm_ar and norm_ar != name_ar.strip():
            aliases_ar.add(norm_ar)

    # 1. Complete Blood Count & Routine Hematology
    if 'cbc' in lower_en or 'blood count' in lower_en or 'blood picture' in lower_en or 'صورة دم' in norm_ar or 'كرات دم' in norm_ar:
        aliases_en.update(['cbc', 'complete blood count', 'cbc with differential', 'full blood count', 'fbc', 'blood picture', 'complete hemogram'])
        aliases_ar.update(['صورة دم', 'صورة دم كاملة', 'تحليل صورة دم', 'عد دم كامل', 'صوره دم كامله', 'فحص دم شامل', 'تحليل cbc'])
        abbrevs.update(['CBC', 'FBC'])
    if 'esr' in lower_en or 'sedimentation rate' in lower_en or 'سرعة ترسيب' in norm_ar:
        aliases_en.update(['esr', 'erythrocyte sedimentation rate', 'sedimentation rate', 'esr 1st hour', 'esr test'])
        aliases_ar.update(['سرعة ترسيب', 'سرعه ترسيب', 'تحليل سرعة الترسيب', 'معدل ترسيب كريات الدم الحمراء', 'تحليل esr'])
        abbrevs.add('ESR')
    if 'platelet' in lower_en or 'صفائح' in norm_ar:
        aliases_en.update(['platelet count', 'plt count', 'platelets', 'thrombocyte count'])
        aliases_ar.update(['عدد الصفائح الدموية', 'صفائح دموية', 'تحليل صفائح'])
        abbrevs.add('PLT')
    if 'reticulocyte' in lower_en or 'retic' in lower_en or 'خلايا شبكية' in norm_ar:
        aliases_en.update(['reticulocyte count', 'retics count', 'reticulocytes', 'retic count'])
        aliases_ar.update(['عد الخلايا الشبكية', 'خلايا شبكية', 'تحليل شبكيات'])
        abbrevs.add('RETIC')
    if 'blood film' in lower_en or 'smear' in lower_en or 'فيلم دم' in norm_ar or 'شريحة دم' in norm_ar:
        aliases_en.update(['blood film morphology', 'peripheral blood smear', 'blood film examination', 'blood smear'])
        aliases_ar.update(['فحص فيلم دم', 'فيلم دم', 'شريحة دم محيطية', 'فحص شريحة دم'])
    if 'electrophoresis' in lower_en and ('hemoglobin' in lower_en or 'hb' in lower_en):
        aliases_en.update(['hemoglobin electrophoresis', 'hb electrophoresis', 'hemoglobin variant analysis'])
        aliases_ar.update(['فصل كهربائي للهيموجلوبين', 'فصل كهربي للهيموجلوبين', 'تحليل انيميا البحر المتوسط'])
        abbrevs.add('HB-ELFO')
    if 'g6pd' in lower_en or 'glucose-6-phosphate' in lower_en or 'انيميا الفول' in norm_ar:
        aliases_en.update(['g6pd test', 'g6pd quantitative', 'glucose 6 phosphate dehydrogenase', 'g6pd enzyme'])
        aliases_ar.update(['تحليل انيميا الفول', 'انزيم g6pd', 'انيميا الفول'])
        abbrevs.add('G6PD')
    if 'bone marrow' in lower_en or 'نخاع' in norm_ar:
        aliases_en.update(['bone marrow aspirate', 'bone marrow aspiration examination', 'bone marrow aspiration', 'bma'])
        aliases_ar.update(['فحص عينة النخاع العظمي', 'شفط سائل النخاع', 'بزل نخاع عظمي'])
        abbrevs.add('BMA')

    # 2. Coagulation & Hemostasis
    if ('prothrombin' in lower_en or re.search(r'\bpt\b', lower_en) or re.search(r'\binr\b', lower_en) or 'سيولة' in norm_ar or 'بروثرومبين' in norm_ar) and 'partial' not in lower_en:
        aliases_en.update(['prothrombin time and inr', 'pt inr', 'prothrombin time', 'international normalized ratio', 'pt and inr', 'prothrombin concentration', 'pt'])
        aliases_ar.update(['تحليل سيولة', 'سيولة الدم', 'زمن ونسبة البروثرومبين', 'تحليل inr', 'زمن البروثرومبين', 'سيولة'])
        abbrevs.update(['PT', 'INR'])
    if 'partial thromboplastin' in lower_en or re.search(r'\bptt\b', lower_en) or re.search(r'\baptt\b', lower_en) or 'تجلط جزئي' in norm_ar:
        aliases_en.update(['partial thromboplastin time', 'aptt', 'activated partial thromboplastin time', 'ptt test', 'ptt'])
        aliases_ar.update(['زمن التجلط الجزئي', 'تحليل ptt', 'زمن الثرومبوبلاستين الجزئي'])
        abbrevs.update(['PTT', 'APTT'])
    if 'fibrinogen' in lower_en or 'فيبرينوجين' in norm_ar:
        aliases_en.update(['fibrinogen level', 'serum fibrinogen', 'plasma fibrinogen', 'fibrinogen test', 'fibrinogen'])
        aliases_ar.update(['تحليل فيبرينوجين', 'مستوى الفيبرينوجين في الدم', 'فيبرينوجين'])
    if 'd-dimer' in lower_en or 'd dimer' in lower_en or 'دي دايمر' in norm_ar or 'دايمر' in norm_ar:
        aliases_en.update(['d-dimer quantitative', 'd dimer', 'd-dimer test', 'd-dimer'])
        aliases_ar.update(['تحليل دي دايمر', 'دي دايمر كمتغير للجلطات', 'دي دايمر كمي', 'دي دايمر'])
        abbrevs.add('D-DIMER')
    if 'bleeding time' in lower_en or 'clotting time' in lower_en or 'نزف' in norm_ar or 'وقت التجلط' in norm_ar:
        aliases_en.update(['bleeding time bt', 'clotting time ct', 'bleeding and clotting time', 'bleeding time'])
        aliases_ar.update(['وقت النزف والتجلط', 'زمن النزف', 'زمن التجلط', 'وقت النزف'])
        abbrevs.update(['BT', 'CT'])
    if 'protein c' in lower_en or 'protein s' in lower_en or 'protin-c' in lower_en or 'portion-c' in lower_en:
        if 'resistance' in lower_en:
            aliases_en.update(['activated protein c resistance', 'apcr'])
            aliases_ar.update(['مقاومة بروتين سي المنشط'])
            abbrevs.add('APCR')
        elif 'protein c' in lower_en or 'protin-c' in lower_en:
            aliases_en.update(['protein c activity', 'protein c antigen', 'protein c'])
            aliases_ar.update(['بروتين سي', 'تحليل بروتين سي'])
        elif 'protein s' in lower_en:
            aliases_en.update(['protein s activity', 'protein s free', 'protein s'])
            aliases_ar.update(['بروتين اس', 'تحليل بروتين اس'])
    if 'antithrombin' in lower_en or 'at iii' in lower_en:
        aliases_en.update(['antithrombin iii activity', 'at iii', 'antithrombin 3'])
        aliases_ar.update(['انتي ثرومبين 3', 'مضاد الثرومبين'])
        abbrevs.add('AT-III')
    if 'adamts13' in lower_en:
        aliases_en.update(['adamts13 activity', 'adamts13'])
        abbrevs.add('ADAMTS13')

    # 3. Blood Bank & Transfusion
    if 'abo' in lower_en or 'rh typing' in lower_en or 'فصيلة' in norm_ar or 'ريسوس' in norm_ar:
        aliases_en.update(['abo typing and rh factor', 'blood group and rh', 'abo blood group', 'rh typing', 'blood grouping'])
        aliases_ar.update(['فصيلة الدم وعامل ريسوس', 'تحديد فصيلة الدم', 'فصيلة دم', 'عامل ريسوس', 'فصيله دم'])
        abbrevs.update(['ABO', 'RH'])
    if 'cross match' in lower_en or 'توافق' in norm_ar:
        aliases_en.update(['blood cross matching', 'cross match per unit', 'compatibility testing', 'cross match'])
        aliases_ar.update(['توافق دم لوحدة', 'اختبار التوافق لنقل الدم', 'توافق دم'])
    if 'coombs' in lower_en or 'antiglobulin' in lower_en or 'كومبس' in norm_ar:
        if 'direct' in lower_en or 'مباشر' in norm_ar:
            aliases_en.update(['direct coombs test', 'direct antiglobulin test dat', 'coombs direct'])
            aliases_ar.update(['كومبس مباشر', 'تحليل كومبس المباشر'])
            abbrevs.add('DAT')
        elif 'indirect' in lower_en or 'غير مباشر' in norm_ar:
            aliases_en.update(['indirect coombs test', 'indirect antiglobulin test iat', 'coombs indirect'])
            aliases_ar.update(['كومبس غير مباشر', 'تحليل كومبس غير المباشر'])
            abbrevs.add('IAT')
        else:
            aliases_en.update(['coombs test', 'antiglobulin test'])
            aliases_ar.update(['اختبار كومبس', 'تحليل كومبس'])

    # 4. Renal Function, Urine Chemistry & Excretory
    if 'creatinine' in lower_en and 'clearance' not in lower_en and 'ratio' not in lower_en and 'urine' not in lower_en:
        aliases_en.update(['serum creatinine', 'creatinine blood', 's creatinine', 'creatinine'])
        aliases_ar.update(['كرياتينين بالدم', 'تحليل وظائف كلى كرياتينين', 'كرياتينين في السيرم', 'كرياتينين', 'وظائف كلى'])
        abbrevs.add('CREAT')
    elif 'creatinine clearance' in lower_en or ('تصفية' in norm_ar and 'كرياتينين' in norm_ar):
        aliases_en.update(['creatinine clearance rate', '24 hr creatinine clearance', 'gfr creatinine clearance'])
        aliases_ar.update(['تصفية الكرياتينين', 'كفاءة الكرياتينين 24 ساعة'])
    if ('urea' in lower_en or re.search(r'\bbun\b', lower_en) or 'يوريا' in norm_ar or 'بولينا' in norm_ar) and 'ratio' not in lower_en:
        aliases_en.update(['blood urea', 'blood urea nitrogen', 'serum urea', 'bun', 'urea'])
        aliases_ar.update(['يوريا بالدم', 'بولينا الدم', 'وظائف كلى بولينا', 'يوريا', 'بولينا'])
        abbrevs.update(['BUN', 'UREA'])
    if 'uric acid' in lower_en or 'حمض البوليك' in norm_ar or 'نقرس' in norm_ar or 'يوريك' in norm_ar:
        aliases_en.update(['serum uric acid', 'uric acid blood', 'urate', 'uric acid'])
        aliases_ar.update(['حمض البوليك بالدم', 'تحليل يوريك اسيد', 'تحليل النقرس', 'حمض البوليك'])
        abbrevs.add('UA')
    if 'albumin/creatinine' in lower_en or 'albumine/creatinine' in lower_en or re.search(r'\bacr\b', lower_en) or 'microalbumin' in lower_en or 'زلال' in norm_ar:
        aliases_en.update(['microalbuminuria', 'albumin creatinine ratio acr', 'urinary microalbumin', 'acr urine', 'microalbumin in urine'])
        aliases_ar.update(['نسبة الزلال الى الكرياتينين في البول', 'زلال ميكروني في البول', 'تحليل زلال بول', 'زلال بالبول'])
        abbrevs.add('ACR')
    if 'protein in urine' in lower_en or 'urine protein' in lower_en or 'بروتين' in norm_ar and 'بول' in norm_ar:
        if '24' in lower_en or '24' in norm_ar:
            aliases_en.update(['24 hour urine protein', 'total protein in 24 hr urine', 'quantitative urine protein', '24 hrs protein in urine'])
            aliases_ar.update(['تجميع بول 24 ساعة للبروتين', 'بروتين بالبول 24 ساعة', 'زلال البول تجميع 24 ساعة'])
        else:
            aliases_en.update(['protein in urine spot', 'urine protein test'])
            aliases_ar.update(['بروتين في البول', 'زلال البول'])
    if 'bence jones' in lower_en:
        aliases_en.update(['bence jones protein', 'bence jones urine'])
        aliases_ar.update(['بروتين بنس جونس في البول'])
    if 'acetone' in lower_en and 'urine' in lower_en:
        aliases_en.update(['acetone in urine', 'ketones in urine'])
        aliases_ar.update(['اسيتون في البول', 'كيتونات بالبول'])

    # 5. Liver Function & Enzymes
    if (re.search(r'\balt\b', lower_en) or 'sgpt' in lower_en) and 'dialysis' not in lower_en:
        aliases_en.update(['alt alanin aminotransferase', 'sgpt', 'serum alt', 'alanine transaminase', 'alt'])
        aliases_ar.update(['انزيمات كبد sgpt', 'تحليل alt', 'وظائف كبد alt', 'انزيمات كبد'])
        abbrevs.update(['ALT', 'SGPT'])
    if re.search(r'\bast\b', lower_en) or 'sgot' in lower_en:
        aliases_en.update(['ast aspartate aminotransferase', 'sgot', 'serum ast', 'aspartate transaminase', 'ast'])
        aliases_ar.update(['انزيمات كبد sgot', 'تحليل ast', 'وظائف كبد ast'])
        abbrevs.update(['AST', 'SGOT'])
    if 'bilirubin' in lower_en or 'الصفراء' in norm_ar or 'صفراء' in norm_ar or 'بيليروبين' in norm_ar:
        if 'direct' in lower_en or 'مباشر' in norm_ar:
            aliases_en.update(['direct bilirubin', 'conjugated bilirubin', 'direct bili'])
            aliases_ar.update(['صفراء مباشرة بالدم', 'بيليروبين مباشر'])
            abbrevs.add('DBIL')
        elif 'total' in lower_en or 'كلي' in norm_ar or 'كلية' in norm_ar:
            aliases_en.update(['total bilirubin', 'serum total bilirubin', 'total bili'])
            aliases_ar.update(['صفراء كلية بالدم', 'بيليروبين كلي', 'الصفراء الكلية'])
            abbrevs.add('TBIL')
        else:
            aliases_en.update(['total and direct bilirubin', 'bilirubin total and direct', 'bilirubin'])
            aliases_ar.update(['الصفراء الكلية والمباشرة', 'تحليل الصفراء بالدم'])
    if ('protein' in lower_en and 'total' in lower_en) or 'بروتين كلي' in norm_ar:
        aliases_en.update(['total protein serum', 'total protein blood', 'serum total protein', 'total protein'])
        aliases_ar.update(['بروتين كلي بالدم', 'البروتين الكلي في السيرم'])
        abbrevs.add('TP')
    if ('albumin' in lower_en or 'البيومين' in norm_ar) and 'creatinine' not in lower_en and 'micro' not in lower_en and 'ratio' not in lower_en:
        aliases_en.update(['serum albumin', 'albumin blood', 's albumin', 'albumin'])
        aliases_ar.update(['البيومين بالدم', 'زلال الدم', 'تحليل البيومين'])
        abbrevs.add('ALB')
    if 'a/g ratio' in lower_en or 'a/g' in lower_en:
        aliases_en.update(['albumin globulin ratio', 'a/g ratio'])
        aliases_ar.update(['نسبة الالبيومين للجلوبيولين'])
    if 'alkaline phosphatase' in lower_en or re.search(r'\balp\b', lower_en) or 'فوسفاتيز قلوي' in norm_ar:
        if 'bone' in lower_en:
            aliases_en.update(['bone alkaline phosphatase', 'bone specific alp'])
            aliases_ar.update(['فوسفاتيز قلوي عظمي'])
        else:
            aliases_en.update(['alkaline phosphatase alp', 'serum alkaline phosphatase', 'alkaline phosphatase'])
            aliases_ar.update(['فوسفاتيز قلوي بالدم', 'تحليل انزيم الفوسفاتيز القلوي', 'فوسفاتيز قلوي'])
            abbrevs.add('ALP')
    if re.search(r'\bggt\b', lower_en) or 'gamma gt' in lower_en or 'جاما جي تي' in norm_ar:
        aliases_en.update(['gamma glutamyl transferase', 'ggt serum', 'gamma gt', 'ggt'])
        aliases_ar.update(['انزيم جاما جي تي', 'تحليل ggt'])
        abbrevs.add('GGT')
    if re.search(r'\bldh\b', lower_en) or 'lactate dehydrogenase' in lower_en or 'ال دي اتش' in norm_ar:
        aliases_en.update(['lactate dehydrogenase ldh', 'serum ldh', 'ldh test', 'ldh'])
        aliases_ar.update(['انزيم ldh', 'تحليل ال دي اتش', 'لاكتات ديهيدروجينيز'])
        abbrevs.add('LDH')
    if 'amylase' in lower_en or 'اميليز' in norm_ar:
        if 'urine' in lower_en:
            aliases_en.update(['amylase in urine', 'urinary amylase'])
            aliases_ar.update(['اميليز في البول'])
        elif 'peritoneal' in lower_en or 'ascitic' in lower_en:
            aliases_en.update(['amylase peritoneal fluid', 'ascitic amylase'])
            aliases_ar.update(['اميليز في سائل الاستسقاء'])
        else:
            aliases_en.update(['serum amylase', 'amylase blood', 'amylase enzyme', 'amylase'])
            aliases_ar.update(['اميليز بالدم', 'انزيم الاميليز', 'تحليل اميليز'])
            abbrevs.add('AMY')
    if 'lipase' in lower_en or 'ليباز' in norm_ar:
        aliases_en.update(['serum lipase', 'lipase blood', 'lipase enzyme', 'lipase'])
        aliases_ar.update(['ليباز بالدم', 'انزيم الليباز', 'تحليل ليباز'])
        abbrevs.add('LIP')
    if '5-nucleotidase' in lower_en:
        aliases_en.update(['5-nucleotidase test', '5 nucleotidase'])
        aliases_ar.update(['انزيم 5 نيوكليوتيداز'])
    if 'bile acids' in lower_en:
        aliases_en.update(['total bile acids', 'serum bile acids'])
        aliases_ar.update(['احماض المرارة في الدم'])

    # 6. Electrolytes, Minerals & Trace Elements
    if 'sodium' in lower_en or 'صوديوم' in norm_ar:
        aliases_en.update(['serum sodium', 'na blood', 'sodium level', 'sodium'])
        aliases_ar.update(['صوديوم بالدم', 'تحليل صوديوم', 'صوديوم'])
        abbrevs.add('NA')
    if 'potassium' in lower_en or 'بوتاسيوم' in norm_ar:
        aliases_en.update(['serum potassium', 'k blood', 'potassium level', 'potassium'])
        aliases_ar.update(['بوتاسيوم بالدم', 'تحليل بوتاسيوم', 'بوتاسيوم'])
        abbrevs.add('K')
    if 'chloride' in lower_en or 'كلوريد' in norm_ar:
        aliases_en.update(['serum chloride', 'cl blood', 'chloride level', 'chloride'])
        aliases_ar.update(['كلوريد بالدم', 'تحليل كلوريد'])
        abbrevs.add('CL')
    if 'calcium' in lower_en or 'كالسيوم' in norm_ar:
        if 'ionized' in lower_en or 'متأين' in norm_ar:
            aliases_en.update(['ionized calcium', 'free calcium blood', 'serum ionized calcium'])
            aliases_ar.update(['كالسيوم متأين بالدم', 'تحليل كالسيوم متأين'])
            abbrevs.add('ICA')
        else:
            aliases_en.update(['serum calcium total', 'total calcium blood', 'calcium level', 'calcium'])
            aliases_ar.update(['كالسيوم كلي بالدم', 'تحليل كالسيوم كلي', 'كالسيوم'])
            abbrevs.add('CA')
    if 'magnesium' in lower_en or 'ماغنسيوم' in norm_ar:
        aliases_en.update(['serum magnesium', 'mg blood', 'magnesium level', 'magnesium'])
        aliases_ar.update(['ماغنسيوم بالدم', 'ماغنسيوم في السيرم', 'ماغنسيوم'])
        abbrevs.add('MG')
    if 'phosphorus' in lower_en or 'phosphate' in lower_en or 'فوسفور' in norm_ar:
        aliases_en.update(['serum inorganic phosphorus', 'phosphate level', 'phosphorus blood', 'phosphorus'])
        aliases_ar.update(['فوسفور بالدم', 'الفوسفور غير العضوي', 'فوسفور'])
        abbrevs.add('PHOS')
    if ('iron' in lower_en or 'حديد' in norm_ar) and 'binding' not in lower_en:
        aliases_en.update(['serum iron', 'iron blood', 'iron level', 'iron'])
        aliases_ar.update(['حديد بالدم', 'تحليل حديد', 'مستوى الحديد بالدم'])
        abbrevs.add('FE')
    if 'total iron binding capacity' in lower_en or re.search(r'\btibc\b', lower_en) or 'سعة الارتباط' in norm_ar:
        aliases_en.update(['total iron binding capacity tibc', 'tibc blood', 'tibc'])
        aliases_ar.update(['السعة الكلية لربط الحديد tibc', 'تحليل tibc'])
        abbrevs.add('TIBC')
    if 'transferrin' in lower_en or 'ترانسفيرين' in norm_ar:
        aliases_en.update(['serum transferrin', 'transferrin saturation'])
        aliases_ar.update(['ترانسفيرين بالدم', 'تشبع الترانسفيرين'])
    if 'ferritin' in lower_en or 'فيريتين' in norm_ar:
        aliases_en.update(['serum ferritin', 'ferritin level', 'ferritin blood', 'ferritin'])
        aliases_ar.update(['مخزون الحديد في الدم', 'تحليل فيريتين', 'فيريتين بالدم', 'مخزون الحديد'])
        abbrevs.add('FERRITIN')
    if 'copper' in lower_en or 'نحاس' in norm_ar:
        aliases_en.update(['serum copper', '24-hour urine copper', 'copper level'])
        aliases_ar.update(['نحاس في الدم', 'نحاس بالبول 24 ساعة'])
    if 'zinc' in lower_en or 'زنك' in norm_ar:
        aliases_en.update(['serum zinc', 'zinc level'])
        aliases_ar.update(['زنك في الدم', 'تحليل زنك'])
    if 'lead' in lower_en or 'رصاص' in norm_ar:
        aliases_en.update(['blood lead level', 'lead in blood'])
        aliases_ar.update(['رصاص في الدم', 'تحليل الرصاص'])

    # 7. Diabetes & Metabolic Chemistry
    if 'fasting blood sugar' in lower_en or re.search(r'\bfbs\b', lower_en) or ('glucose' in lower_en and 'fasting' in lower_en) or 'سكر صائم' in norm_ar:
        aliases_en.update(['fasting blood glucose', 'fbs', 'fasting blood sugar fbs', 'fasting plasma glucose', 'fasting blood sugar'])
        aliases_ar.update(['سكر صائم', 'سكر دم صائم', 'تحليل سكر صائم'])
        abbrevs.update(['FBS', 'FPG'])
    if 'post prandial' in lower_en or re.search(r'\b2hpp\b', lower_en) or ('glucose' in lower_en and '2' in lower_en and 'hour' in lower_en) or 'سكر فاطر' in norm_ar:
        aliases_en.update(['2 hours post prandial blood sugar', '2hpp', 'post prandial glucose', '2 hours post prandial'])
        aliases_ar.update(['سكر فاطر', 'سكر بعد الاكل بساعتين', 'سكر دم فاطر'])
        abbrevs.update(['2HPP', 'PPBS'])
    if 'random blood sugar' in lower_en or re.search(r'\brbs\b', lower_en) or ('glucose' in lower_en and 'random' in lower_en) or 'سكر عشوائي' in norm_ar:
        aliases_en.update(['random blood glucose', 'rbs', 'random blood sugar rbs', 'random blood sugar'])
        aliases_ar.update(['سكر عشوائي', 'سكر دم عشوائي'])
        abbrevs.add('RBS')
    if 'hba1c' in lower_en or 'glycated hemoglobin' in lower_en or 'glycosylated hemoglobin' in lower_en or 'تراكمي' in norm_ar:
        aliases_en.update(['glycated hemoglobin hba1c', 'hemoglobin a1c', 'hba1c test', 'glycohemoglobin', 'hba1c'])
        aliases_ar.update(['السكر التراكمي', 'سكر تراكمي', 'هيموجلوبين سكري', 'تحليل السكر التراكمي'])
        abbrevs.update(['HBA1C', 'A1C'])
    if 'oral glucose tolerance' in lower_en or re.search(r'\bogtt\b', lower_en) or 'منحنى سكر' in norm_ar:
        aliases_en.update(['oral glucose tolerance test ogtt', 'ogtt pregnant', 'ogtt non-pregnant', 'ogtt'])
        aliases_ar.update(['منحنى السكر بالدم', 'منحنى السكر للحوامل', 'اختبار تحمل الجلوكوز'])
        abbrevs.add('OGTT')
    if 'insulin' in lower_en and 'antibodies' not in lower_en and 'auto' not in lower_en:
        if 'fasting' in lower_en:
            aliases_en.update(['fasting serum insulin', 'fasting insulin'])
            aliases_ar.update(['انسولين صائم بالدم', 'انسولين صائم'])
        else:
            aliases_en.update(['serum insulin level', 'insulin test'])
            aliases_ar.update(['تحليل انسولين بالدم'])
    if 'c-peptide' in lower_en:
        aliases_en.update(['c-peptide fasting', 'c peptide test', 'c-peptide'])
        aliases_ar.update(['سي ببتيد صائم', 'تحليل سي ببتيد'])
        abbrevs.add('C-PEPTIDE')
    if 'homa' in lower_en or 'insulin resistance' in lower_en or 'مقاومة الانسولين' in norm_ar:
        aliases_en.update(['homa ir insulin resistance', 'insulin resistance index', 'homa-ir'])
        aliases_ar.update(['تحليل مقاومة الانسولين homa-ir', 'مقاومة الانسولين'])
        abbrevs.add('HOMA-IR')

    # 8. Lipid Profile & Atherosclerosis
    if 'cholesterol' in lower_en or 'كوليسترول' in norm_ar:
        if 'hdl' in lower_en:
            aliases_en.update(['hdl cholesterol', 'high density lipoprotein', 'good cholesterol', 'hdl'])
            aliases_ar.update(['كوليسترول عالي الكثافة النافع', 'كوليسترول نافع hdl'])
            abbrevs.add('HDL')
        elif 'ldl' in lower_en:
            aliases_en.update(['ldl cholesterol', 'low density lipoprotein', 'bad cholesterol', 'ldl'])
            aliases_ar.update(['كوليسترول منخفض الكثافة الضار', 'كوليسترول ضار ldl'])
            abbrevs.add('LDL')
        elif 'total' in lower_en or 'كلي' in norm_ar or 'كوليسترول' in norm_ar:
            aliases_en.update(['serum total cholesterol', 'total cholesterol blood', 'cholesterol test', 'cholesterol'])
            aliases_ar.update(['كوليسترول كلي بالدم', 'تحليل كوليسترول بالدم', 'كوليسترول'])
            abbrevs.add('CHOL')
    if 'triglyceride' in lower_en or 'دهون ثلاثية' in norm_ar:
        aliases_en.update(['serum triglycerides', 'triglycerides blood', 'tg blood', 'triglycerides'])
        aliases_ar.update(['دهون ثلاثية بالدم', 'تحليل دهون ثلاثية', 'دهون ثلاثية'])
        abbrevs.add('TG')
    if 'lipid profile' in lower_en or 'دهون كاملة' in norm_ar:
        aliases_en.update(['full lipid profile', 'lipid panel', 'complete lipid profile', 'lipid profile'])
        aliases_ar.update(['تحليل دهون كاملة', 'فحص دهون شامل'])
    if 'apolipoprotein' in lower_en:
        if 'a1' in lower_en:
            aliases_en.update(['apolipoprotein a1', 'apo a1'])
            abbrevs.add('APO-A1')
        elif 'b' in lower_en:
            aliases_en.update(['apolipoprotein b', 'apo b'])
            abbrevs.add('APO-B')

    # 9. Cardiac Biomarkers & Muscle Enzymes
    if 'troponin' in lower_en or 'تروبونين' in norm_ar:
        if 't' in lower_en and 'i' not in lower_en:
            aliases_en.update(['troponin t quantitative', 'hs-ctnt', 'cardiac troponin t', 'troponin t'])
            aliases_ar.update(['تروبونين تي عالي الحساسية', 'تروبونين t'])
            abbrevs.update(['CTNT', 'TROP-T'])
        else:
            aliases_en.update(['troponin i quantitative', 'hs-ctni', 'high sensitivity troponin i', 'cardiac troponin i', 'troponin i', 'troponin'])
            aliases_ar.update(['تروبونين اي نوعي عالي الحساسية', 'تحليل تروبونين للقلب', 'تروبونين نوعي بالدم', 'تروبونين'])
            abbrevs.update(['CTNI', 'TROP-I', 'TROPONIN'])
    if 'ck-mb' in lower_en or 'ck mb' in lower_en or 'سي كيه ام بي' in norm_ar:
        aliases_en.update(['ck mb mass', 'creatine kinase mb', 'ck-mb activity', 'ck mb test', 'ck-mb', 'ckmb'])
        aliases_ar.update(['انزيم القلب ck-mb', 'سي كيه ام بي', 'انزيمات القلب سي كيه'])
        abbrevs.update(['CK-MB', 'CKMB'])
    if (re.search(r'\bcpk\b', lower_en) or 'creatine kinase' in lower_en or re.search(r'\bck\b', lower_en)) and 'mb' not in lower_en:
        aliases_en.update(['total creatine kinase', 'total cpk', 'creatine phosphokinase', 'cpk test', 'cpk'])
        aliases_ar.update(['انزيم العضلات cpk', 'كرياتين كينيز كلي', 'تحليل cpk'])
        abbrevs.update(['CPK', 'CK'])
    if 'myoglobin' in lower_en or 'ميوجلوبين' in norm_ar:
        aliases_en.update(['serum myoglobin', 'myoglobin cardiac marker', 'myoglobin'])
        aliases_ar.update(['ميوجلوبين بالدم'])
    if re.search(r'\bbnp\b', lower_en) or 'probnp' in lower_en:
        aliases_en.update(['b-type natriuretic peptide', 'nt-probnp quantitative', 'bnp heart failure marker', 'bnp', 'nt-probnp'])
        aliases_ar.update(['تحليل bnp لفشل عضلة القلب', 'مؤشر ضعف عضلة القلب bnp', 'تحليل nt-probnp'])
        abbrevs.update(['BNP', 'NT-PROBNP'])

    # 10. Blood Gases & Acid-Base
    if 'arterial blood gas' in lower_en or re.search(r'\babg\b', lower_en) or 'غازات دم شرياني' in norm_ar or 'غازات الدم' in norm_ar:
        aliases_en.update(['arterial blood gas abg', 'abg with electrolytes', 'abg with lactate', 'blood gases', 'abg'])
        aliases_ar.update(['غازات دم شرياني', 'تحليل غازات الدم', 'غازات الدم الشرياني مع اللاكتات', 'غازات دم'])
        abbrevs.add('ABG')
    if 'venous blood gas' in lower_en or re.search(r'\bvbg\b', lower_en) or 'غازات دم وريدي' in norm_ar:
        aliases_en.update(['venous blood gas vbg', 'vbg'])
        aliases_ar.update(['غازات دم وريدي'])
        abbrevs.add('VBG')
    if 'lactate' in lower_en or 'lactic acid' in lower_en or 'لاكتات' in norm_ar:
        aliases_en.update(['serum lactic acid', 'blood lactate', 'lactic acid level', 'lactate'])
        aliases_ar.update(['لاكتات بالدم', 'حمض اللاكتيك بالدم', 'لاكتات'])
        abbrevs.add('LAC')
    if 'bicarbonate' in lower_en or 'بيكربونات' in norm_ar:
        aliases_en.update(['serum bicarbonate', 'hco3 blood', 'bicarbonate'])
        aliases_ar.update(['بيكربونات بالدم'])
        abbrevs.add('HCO3')

    # 11. Routine Excreta & Fluids
    if ('urine' in lower_en and ('analysis' in lower_en or 'routine' in lower_en or 'examination' in lower_en or 'complete' in lower_en)) or ('تحليل بول' in norm_ar or 'بول كامل' in norm_ar):
        aliases_en.update(['complete urine analysis', 'routine urine examination', 'urinalysis', 'cua', 'urine analysis'])
        aliases_ar.update(['تحليل بول كامل', 'فحص بول روتيني', 'تحليل البول الشامل', 'تحليل بول'])
        abbrevs.update(['CUA', 'UA'])
    if ('stool' in lower_en and ('analysis' in lower_en or 'routine' in lower_en or 'examination' in lower_en or 'complete' in lower_en)) or ('تحليل براز' in norm_ar or 'براز كامل' in norm_ar):
        aliases_en.update(['complete stool analysis', 'routine stool examination', 'csa', 'stool analysis'])
        aliases_ar.update(['تحليل براز كامل', 'فحص براز روتيني', 'تحليل براز'])
        abbrevs.add('CSA')
    if 'occult blood' in lower_en or re.search(r'\bfobt\b', lower_en) or 'دم خفي' in norm_ar:
        aliases_en.update(['fecal occult blood test fobt', 'occult blood in stool', 'fobt test', 'fobt', 'occult blood'])
        aliases_ar.update(['دم خفي في البراز', 'تحليل دم خفي بالبراز', 'دم خفي بالبراز'])
        abbrevs.add('FOBT')
    if 'calprotectin' in lower_en or 'كالبروتكتين' in norm_ar:
        aliases_en.update(['fecal calprotectin', 'stool calprotectin quantitative', 'calprotectin stool', 'calprotectin'])
        aliases_ar.update(['كالبروتكتين في البراز', 'تحليل التهاب الامعاء كالبروتكتين', 'كالبروتكتين'])
    if 'semen' in lower_en or 'سائل منوي' in norm_ar:
        aliases_en.update(['complete semen analysis', 'seminal fluid examination', 'semen analysis'])
        aliases_ar.update(['تحليل سائل منوي كامل', 'فحص السائل المنوي', 'تحليل سائل منوي'])

    # 12. Endocrinology, Thyroid & Hormones
    if re.search(r'\btsh\b', lower_en) or 'thyroid stimulating' in lower_en or 'تي اس اتش' in norm_ar:
        aliases_en.update(['thyroid stimulating hormone tsh', 'tsh ultra sensitive', 'serum tsh', 'tsh'])
        aliases_ar.update(['هرمون الغدة الدرقية tsh', 'تحليل تي اس اتش', 'هرمون محفز الغدة الدرقية', 'تي اس اتش'])
        abbrevs.add('TSH')
    if 'free t3' in lower_en or re.search(r'\bft3\b', lower_en):
        aliases_en.update(['free t3 ft3', 'serum ft3', 'free triiodothyronine', 'free t3'])
        aliases_ar.update(['تحليل free t3', 'ثلاثي يودوثيرونين حر'])
        abbrevs.add('FT3')
    if 'free t4' in lower_en or re.search(r'\bft4\b', lower_en):
        aliases_en.update(['free t4 ft4', 'serum ft4', 'free thyroxine', 'free t4'])
        aliases_ar.update(['تحليل free t4', 'ثيروكسين حر'])
        abbrevs.add('FT4')
    if 'total t3' in lower_en:
        aliases_en.update(['total t3', 'serum total t3'])
        aliases_ar.update(['تحليل t3 كلي'])
        abbrevs.add('TT3')
    if 'total t4' in lower_en:
        aliases_en.update(['total t4', 'serum total t4'])
        aliases_ar.update(['تحليل t4 كلي'])
        abbrevs.add('TT4')
    if 'thyroglobulin' in lower_en and 'anti' not in lower_en:
        aliases_en.update(['serum thyroglobulin', 'tg tumor marker'])
        aliases_ar.update(['ثيروجلوبيولين'])
        abbrevs.add('TG')
    # PTH with Greek ΡΤΗ support
    if re.search(r'\bpth\b', lower_en) or 'parathyroid' in lower_en or 'parathormone' in lower_en or 'باراثورمون' in norm_ar or 'غدة جار درقية' in norm_ar:
        aliases_en.update(['intact pth pth 1-84', 'parathormone pth', 'parathyroid hormone', 'intact pth', 'pth 1-84', 'pth'])
        aliases_ar.update(['هرمون الغدة الجار درقية', 'باراثورمون', 'تحليل هرمون الباراثورمون', 'تحليل pth', 'باراثرمون'])
        abbrevs.update(['PTH', 'IPTH'])
    if 'vitamin d' in lower_en or '25-oh' in lower_en or 'فيتامين د' in norm_ar:
        aliases_en.update(['25-oh vitamin d total', 'vitamin d3', 'vitamin d 25 hydroxy', '25-oh vitamin d', 'vitamin d'])
        aliases_ar.update(['تحليل فيتامين د', 'فيتامين د الكلي', 'فيتامين د3', 'فيتامين د'])
        abbrevs.add('VIT-D')
    if 'osteocalcin' in lower_en:
        aliases_en.update(['serum osteocalcin', 'bone turnover osteocalcin'])
        aliases_ar.update(['اوستيوكالسين'])
    if 'calcitonin' in lower_en:
        aliases_en.update(['serum calcitonin', 'calcitonin medullary thyroid marker'])
        aliases_ar.update(['كالسيتونين بالدم'])
    if 'hcg' in lower_en or 'pregnancy' in lower_en or 'حمل' in norm_ar:
        aliases_en.update(['beta hcg quantitative', 'serum pregnancy test', 'total beta hcg', 'pregnancy test in blood', 'beta hcg', 'b-hcg'])
        aliases_ar.update(['تحليل حمل رقمي بالدم', 'هرمون الحمل الرقمي', 'تحليل حمل بالدم', 'بيتا اتش سي جي', 'تحليل حمل'])
        abbrevs.update(['B-HCG', 'HCG'])
    if re.search(r'\bfsh\b', lower_en) or 'follicle stimulating' in lower_en:
        aliases_en.update(['follicle stimulating hormone fsh', 'serum fsh', 'fsh'])
        aliases_ar.update(['هرمون الاف اس اتش fsh', 'تحليل fsh'])
        abbrevs.add('FSH')
    if re.search(r'\blh\b', lower_en) or 'luteinizing' in lower_en:
        aliases_en.update(['luteinizing hormone lh', 'serum lh', 'lh'])
        aliases_ar.update(['هرمون ال ال اتش lh', 'تحليل lh'])
        abbrevs.add('LH')
    if 'prolactin' in lower_en or 'برولاكتين' in norm_ar or 'لبن' in norm_ar:
        aliases_en.update(['serum prolactin', 'milk hormone prolactin', 'prolactin level', 'prolactin'])
        aliases_ar.update(['هرمون اللبن برولاكتين', 'تحليل برولاكتين', 'برولاكتين'])
        abbrevs.add('PRL')
    if 'estradiol' in lower_en or re.search(r'\be2\b', lower_en) or 'استراديول' in norm_ar:
        aliases_en.update(['estradiol e2', 'serum estradiol', 'estrogen e2'])
        aliases_ar.update(['هرمون الاستراديول e2', 'استراديول'])
        abbrevs.add('E2')
    if 'progesterone' in lower_en or 'progestrone' in lower_en or 'بروجستيرون' in norm_ar:
        if '17-oh' in lower_en or '17 oh' in lower_en:
            aliases_en.update(['17-oh-progesterone', '17 hydroxyprogesterone'])
            aliases_ar.update(['17 هيدروكسي بروجستيرون'])
        else:
            aliases_en.update(['serum progesterone', 'progesterone hormone'])
            aliases_ar.update(['هرمون البروجستيرون', 'بروجستيرون'])
    if 'testosterone' in lower_en or 'تستوستيرون' in norm_ar or 'ذكورة' in norm_ar:
        if 'free' in lower_en or 'حر' in norm_ar:
            aliases_en.update(['free testosterone', 'free testo'])
            aliases_ar.update(['هرمون الذكورة حر', 'تستوستيرون حر'])
        else:
            aliases_en.update(['total testosterone', 'serum testosterone', 'testosterone'])
            aliases_ar.update(['هرمون الذكورة كلي', 'تحليل تستوستيرون', 'تستوستيرون'])
            abbrevs.add('TESTO')
    if 'dhea' in lower_en:
        aliases_en.update(['dhea sulfate', 'dhea-s', 'dheas'])
        aliases_ar.update(['هرمون dhea-s'])
        abbrevs.add('DHEA-S')
    if re.search(r'\bamh\b', lower_en) or 'anti mullerian' in lower_en or 'anti-mullerian' in lower_en or 'مخزون المبيض' in norm_ar:
        aliases_en.update(['anti mullerian hormone amh', 'ovarian reserve test', 'amh test', 'amh'])
        aliases_ar.update(['تحليل مخزون المبيض amh', 'هرمون مخزون البويضات', 'مخزون المبيض'])
        abbrevs.add('AMH')
    if 'cortisol' in lower_en or 'كورتيزول' in norm_ar:
        if 'am' in lower_en or 'صباح' in norm_ar:
            aliases_en.update(['serum cortisol am', 'morning cortisol'])
            aliases_ar.update(['كورتيزول صباحي'])
        elif 'pm' in lower_en or 'مساء' in norm_ar:
            aliases_en.update(['serum cortisol pm', 'evening cortisol'])
            aliases_ar.update(['كورتيزول مسائي'])
        elif 'urine' in lower_en:
            aliases_en.update(['24-hr urine free cortisol'])
            aliases_ar.update(['كورتيزول البول 24 ساعة'])
        else:
            aliases_en.update(['serum cortisol', 'cortisol test', 'cortisol'])
            aliases_ar.update(['تحليل كورتيزول', 'كورتيزول'])
    if re.search(r'\bacth\b', lower_en):
        aliases_en.update(['adrenocorticotropic hormone acth', 'acth hormone', 'acth'])
        aliases_ar.update(['هرمون acth', 'تحليل acth'])
        abbrevs.add('ACTH')
    if 'growth hormone' in lower_en or re.search(r'\bgh\b', lower_en) or 'نمو' in norm_ar:
        aliases_en.update(['growth hormone gh', 'human growth hormone hgh'])
        aliases_ar.update(['هرمون النمو gh', 'تحليل هرمون النمو'])
        abbrevs.update(['GH', 'HGH'])
    if 'igf-1' in lower_en or 'igf 1' in lower_en or 'somatomedin' in lower_en:
        aliases_en.update(['insulin-like growth factor 1', 'igf-1', 'somatomedin-c'])
        aliases_ar.update(['عامل النمو الشبيه بالانسولين igf-1'])
        abbrevs.add('IGF-1')

    # 13. Tumor Markers
    if re.search(r'\bpsa\b', lower_en) or 'prostate specific' in lower_en or 'بروستاتا' in norm_ar:
        if 'free' in lower_en or 'حر' in norm_ar:
            aliases_en.update(['free psa', 'free prostate specific antigen', 'fpsa'])
            aliases_ar.update(['بي اس ايه حر', 'دلالات اورام البروستاتا الحر'])
            abbrevs.add('FPSA')
        else:
            aliases_en.update(['total psa prostate specific antigen', 'total psa', 'prostate specific antigen', 'psa test', 'psa'])
            aliases_ar.update(['دلالات اورام البروستاتا psa', 'تحليل بي اس ايه', 'دلالات اورام بروستاتا', 'psa'])
            abbrevs.add('PSA')
    if re.search(r'\bcea\b', lower_en) or 'carcinoembryonic' in lower_en:
        aliases_en.update(['carcinoembryonic antigen cea', 'cea tumor marker', 'cea test', 'cea'])
        aliases_ar.update(['دلالات اورام القولون والجهاز الهضمي cea', 'تحليل cea', 'دلالات اورام cea'])
        abbrevs.add('CEA')
    if 'ca 125' in lower_en or 'ca-125' in lower_en or 'ca125' in lower_en:
        aliases_en.update(['ca 125 ovarian cancer marker', 'cancer antigen 125', 'ca 125 test', 'ca 125', 'ca-125'])
        aliases_ar.update(['دلالات اورام المبيض ca 125', 'تحليل ca 125', 'دلالات اورام المبيض'])
        abbrevs.add('CA-125')
    if 'ca 19-9' in lower_en or 'ca 19.9' in lower_en or 'ca19-9' in lower_en or 'ca 19' in lower_en:
        aliases_en.update(['ca 19-9 pancreatic gastrointestinal marker', 'cancer antigen 19-9', 'ca 19-9 test', 'ca 19-9', 'ca-19-9'])
        aliases_ar.update(['دلالات اورام البنكرياس والجهاز الهضمي ca 19-9', 'تحليل ca 19-9'])
        abbrevs.add('CA-19-9')
    if 'ca 15-3' in lower_en or 'ca 15.3' in lower_en or 'ca15-3' in lower_en or 'ca 15' in lower_en:
        aliases_en.update(['ca 15-3 breast cancer marker', 'cancer antigen 15-3', 'ca 15-3 test', 'ca 15-3', 'ca-15-3'])
        aliases_ar.update(['دلالات اورام الثدي ca 15-3', 'تحليل ca 15-3'])
        abbrevs.add('CA-15-3')
    if 'alpha-fetoprotein' in lower_en or 'alpha fetoprotein' in lower_en or re.search(r'\bafp\b', lower_en) or 'فيتو بروتين' in norm_ar:
        aliases_en.update(['alpha fetoprotein afp', 'afp liver tumor marker', 'afp test', 'alpha-fetoprotein', 'afp'])
        aliases_ar.update(['الفا فيتو بروتين دلالات اورام الكبد', 'تحليل afp', 'الفا فيتو بروتين'])
        abbrevs.add('AFP')
    if 'b2-microglobulin' in lower_en or 'beta 2 microglobulin' in lower_en:
        aliases_en.update(['beta 2 microglobulin', 'b2-microglobulin'])
        abbrevs.add('B2M')

    # 14. Therapeutic Drug Monitoring (TDM) & Toxicology
    if 'digoxin' in lower_en:
        aliases_en.update(['digoxin level', 'serum digoxin'])
        aliases_ar.update(['دواء الديجوكسين بالدم', 'ديجوكسين'])
    if 'theophylline' in lower_en:
        aliases_en.update(['theophylline level', 'serum theophylline'])
        aliases_ar.update(['مستوى الثيوفيللين بالدم'])
    if 'phenytoin' in lower_en:
        aliases_en.update(['phenytoin level', 'epanutin level'])
        aliases_ar.update(['دواء الفينيتوين بالدم'])
    if 'carbamazepine' in lower_en:
        aliases_en.update(['carbamazepine tegretol level', 'tegretol level'])
        aliases_ar.update(['مستوى التجريدول بالدم'])
    if 'valproic' in lower_en:
        aliases_en.update(['valproic acid depakine level', 'depakine level'])
        aliases_ar.update(['مستوى الديباكين بالدم'])
    if 'lithium' in lower_en:
        aliases_en.update(['serum lithium level', 'lithium blood'])
        aliases_ar.update(['مستوى الليثيوم بالدم'])
    if 'vancomycin' in lower_en:
        aliases_en.update(['vancomycin peak and trough level', 'vancomycin level'])
        aliases_ar.update(['فانكومايسين بالدم'])
    if 'methotrexate' in lower_en:
        aliases_en.update(['methotrexate level'])
        aliases_ar.update(['ميثوتريكسات بالدم'])
    if 'cyclosporine' in lower_en:
        aliases_en.update(['cyclosporine level'])
        aliases_ar.update(['سيكلوسبورين بالدم'])
    if 'tacrolimus' in lower_en:
        aliases_en.update(['tacrolimus level fk506', 'fk506 level'])
        aliases_ar.update(['تاكروليمس بالدم'])

    return list(aliases_en), list(aliases_ar), list(abbrevs)

print('Batch 4 test harness loaded successfully!')
