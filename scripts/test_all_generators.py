import sys; sys.path.append('.')
import re
import os
import csv
import json
import openpyxl
from collections import defaultdict
from scripts.generate_catalog_aliases import (
    BATCH_1_CATS, BATCH_2_CATS, BATCH_3_CATS,
    clean_arabic, normalize_homoglyphs,
    generate_radiology_aliases,
    generate_batch_4_aliases
)

BATCH_6_CATS = {'Medical Devices', 'Chemotherapy', 'Dialysis'}
BATCH_7_CATS = {'Dental & Derma', 'Physiotherapy', 'Home Care', 'Examination'}

def is_batch_5(name: str, ar: str) -> bool:
    n = normalize_homoglyphs(name).lower()
    a = clean_arabic(ar)
    if re.match(r'^cd\d+', n) or 'flow cytometry' in n or 'تدفق خلوي' in a:
        return True
    if any(k in n for k in ['-ihc', 'ihc', 'ihс', 'histopath', 'biopsy', 'cytology', 'cell block', 'pap smear', 'stain']):
        return True
    if any(k in a for k in ['صبغات مناعية', 'باثولوجي', 'عينة نسيجية', 'سيتولوجي', 'مسحة عنق الرحم']):
        return True
    if any(k in n for k in ['ige', 'allergy', 'contact specific', 'food specific', 'inhalant specific', 'wool الصوف', 'phadiatop']):
        return True
    if any(k in a for k in ['حساسية', 'الصوف']):
        return True
    if any(k in n for k in ['culture', 'swab', 'gram stain', 'zn stain', 'fungal stain', 'biofire', 'filmarray', 'glucan', 'galactomannan', 'mycology', 'bacteriology', 'parasite']):
        return True
    if any(k in a for k in ['مزرعة', 'مسحة', 'صبغة جرام']):
        return True
    if any(k in n for k in ['pcr', 'bcr-abl', 'k-ras', 'n-ras', 'braf', 'jak-2', 'jak2', 'jak ii', 'egfr', 'dna', 'rna', 'karyotyping', 'hla', 'fish ']):
        return True
    if any(k in a for k in ['بي سي ار', 'وراثة', 'جين']):
        return True
    if any(k in n for k in ['hcv', 'hbs', 'hbc', 'hbe', 'hiv', 'rubella', 'toxoplasma', 'cmv', 'ebv', 'hsv', 'widal', 'brucella', 'rpr', 'vdrl', 'tpha', 'paul bunnel', 'weil felix', 'hydatid', 'schistosoma', 'entamoeba', 'helicobacter', 'h. pylori', 'clostridium', 'c. difficile']):
        return True
    if (re.search(r'\bana\b', n) and 'analysis' not in n) or (re.search(r'\brf\b', n) and 'film' not in n) or any(k in n for k in ['rose waaler', 'rose waler', 'complement', 'reticulin', 'anca', 'dsdna', 'anti-dsdna', 'ena', 'anti-sm', 'anti-ro', 'anti-la', 'anti-rnp', 'scl-70', 'jo-1', 'centromere', 'anti-ccp', 'rheumatoid factor', 'asma', 'ama', 'lkm', 'anti-mitochondrial', 'anti-smooth', 'anti-liver', 'anti-cardiolipin', 'phospholipid', 'lupus anticoagulant', 'glycoprotein', 'aquaporin', 'anti musk', 'antimyelin', 'acetylcholine', 'ganglioside', 'islet cell', 'anti-gad', 'insulin antibodies', 'asca', 'anti-saccharomyces', 'gliadin', 'endomysial', 'tissue transglutaminase', 'ttg', 'immunoglobulin g', 'immunoglobulin a', 'immunoglobulin m', 'igg subclass', 'c1- esterase', 'c1-esterase', 'amyloid-a']):
        return True
    return False

def generate_batch_1_aliases_updated(name_en: str, name_ar: str, cat: str):
    from scripts.generate_catalog_aliases import generate_batch_1_aliases
    aliases_en, aliases_ar, abbrevs = generate_batch_1_aliases(name_en, name_ar, cat)
    aliases_en = set(aliases_en)
    aliases_ar = set(aliases_ar)
    abbrevs = set(abbrevs)

    lower_en = name_en.lower()
    if 'fnac' in lower_en or 'fine needle' in lower_en:
        aliases_en.update(['fna', 'fnac', 'fine needle aspiration', 'fna cytology', 'us guided fna'])
        aliases_ar.update(['عينة بالابرة الرفيعة', 'فحص خلايا بذل بالإبرة الدقيقة'])
        abbrevs.update(['FNA', 'FNAC'])

    return list(aliases_en), list(aliases_ar), list(abbrevs)

def generate_batch_3_aliases_updated(name_en: str, name_ar: str, cat: str):
    from scripts.generate_catalog_aliases import generate_batch_3_aliases
    aliases_en, aliases_ar, abbrevs = generate_batch_3_aliases(name_en, name_ar, cat)
    aliases_en = set(aliases_en)
    aliases_ar = set(aliases_ar)
    abbrevs = set(abbrevs)

    lower_en = name_en.lower()
    norm_ar = clean_arabic(name_ar)
    if 'frozen' in lower_en or 'مقطع تجميدي' in norm_ar:
        aliases_en.update(['frozen section biopsy', 'intraoperative frozen section', 'pathology frozen section'])
        aliases_ar.update(['فحص عينة فورية بالعمليات فروزن', 'فحص نسيجي فوري مقطع تجميدي', 'فروزن سكشن'])

    return list(aliases_en), list(aliases_ar), list(abbrevs)

def generate_batch_5_aliases(name_en: str, name_ar: str, cat: str):
    aliases_en = set()
    aliases_ar = set()
    abbrevs = set()

    lower_en = normalize_homoglyphs(name_en).lower().strip()
    norm_ar = clean_arabic(name_ar)
    no_dots_en = lower_en.replace('.', '')

    if lower_en:
        aliases_en.add(lower_en)
        clean_name = re.sub(r'[(),/:.-]', ' ', lower_en)
        clean_name = re.sub(r'\s+', ' ', clean_name).strip()
        if clean_name != lower_en:
            aliases_en.add(clean_name)
        if no_dots_en != lower_en:
            aliases_en.add(no_dots_en)
    if name_ar.strip():
        aliases_ar.add(name_ar.strip())
        if norm_ar and norm_ar != name_ar.strip():
            aliases_ar.add(norm_ar)

    # 1. Autoimmune & Rheumatology
    if re.search(r'\bana\b', lower_en) or re.search(r'\bana\b', no_dots_en) or 'antinuclear' in lower_en:
        aliases_en.update(['ana', 'antinuclear antibodies', 'ana test', 'ana ifa', 'ana elisa', 'ana screen', 'antinuclear antibody'])
        aliases_ar.update(['تحليل ana', 'اجسام مضادة للنواة', 'تحليل الاجسام المضادة للنواة', 'اجسام مناعية للنواة'])
        abbrevs.add('ANA')
    if 'anca' in lower_en:
        aliases_en.update(['anca', 'p-anca', 'c-anca', 'anti-neutrophil cytoplasmic antibodies', 'anca test'])
        aliases_ar.update(['تحليل anca', 'تحليل انكا', 'اجسام مضادة لسيتوبلازم العدلات'])
        abbrevs.update(['ANCA', 'P-ANCA', 'C-ANCA'])
    if 'anti-dna' in lower_en or 'anti dna' in lower_en or 'dsdna' in lower_en or 'ds-dna' in lower_en:
        aliases_en.update(['anti-dsdna', 'anti dsdna', 'double stranded dna antibodies', 'anti-dna', 'anti dna antibody'])
        aliases_ar.update(['تحليل anti-dsdna', 'تحليل ذئبة حمراء', 'اجسام مضادة للحمض النووي', 'اجسام مضادة للذئبة'])
        abbrevs.update(['dsDNA', 'anti-dsDNA'])
    if 'cardiolipin' in lower_en or 'acl' in lower_en:
        aliases_en.update(['anti-cardiolipin', 'anticardiolipin antibodies', 'acl antibodies'])
        aliases_ar.update(['اجسام مضادة للكارديوليبين', 'تحليل انتي كارديوليبين', 'تحليل كارديوليبين'])
        abbrevs.add('ACL')
        if 'igg' in lower_en:
            aliases_en.add('anti-cardiolipin igg')
            aliases_ar.add('انتي كارديوليبين igg')
            abbrevs.add('ACL-IgG')
        if 'igm' in lower_en:
            aliases_en.add('anti-cardiolipin igm')
            aliases_ar.add('انتي كارديوليبين igm')
            abbrevs.add('ACL-IgM')
    if 'ccp' in lower_en:
        aliases_en.update(['anti-ccp', 'cyclic citrullinated peptide', 'anti ccp test', 'anti ccp quantitative'])
        aliases_ar.update(['تحليل anti-ccp', 'اجسام مضادة للسيترولين'])
        abbrevs.add('Anti-CCP')
    if 'rheumatoid' in lower_en or re.search(r'\brf\b', lower_en) or 'rose waaler' in lower_en or 'rose waler' in lower_en or 'روماتويد' in norm_ar:
        aliases_en.update(['rheumatoid factor', 'rf test', 'rf quantitative', 'ra test', 'rf latex', 'rose waaler'])
        aliases_ar.update(['معامل الروماتويد', 'تحليل روماتويد', 'فحص الروماتويد', 'تحليل rf'])
        abbrevs.update(['RF', 'RA'])
    if 'complement' in lower_en or 'c3' in lower_en or 'c4' in lower_en:
        if '3' in lower_en or 'c3' in lower_en:
            aliases_en.update(['complement c3', 'c3 complement', 'serum c3', 'complement 3'])
            aliases_ar.update(['مكمل مناعي c3', 'تحليل c3'])
            abbrevs.add('C3')
        if '4' in lower_en or 'c4' in lower_en:
            aliases_en.update(['complement c4', 'c4 complement', 'serum c4', 'complement 4'])
            aliases_ar.update(['مكمل مناعي c4', 'تحليل c4'])
            abbrevs.add('C4')
    if 'smooth muscle' in lower_en or 'asma' in lower_en:
        aliases_en.update(['anti-smooth muscle antibody', 'asma', 'anti smooth muscle ab'])
        aliases_ar.update(['اجسام مضادة للعضلات الملساء', 'تحليل asma'])
        abbrevs.add('ASMA')
    if 'mitochondrial' in lower_en or re.search(r'\bama\b', lower_en):
        aliases_en.update(['anti-mitochondrial antibody', 'ama test'])
        aliases_ar.update(['اجسام مضادة للميتوكوندريا', 'تحليل ama'])
        abbrevs.add('AMA')
    if 'lkm' in lower_en:
        aliases_en.update(['anti-lkm1', 'anti liver kidney microsomal', 'lkm antibodies'])
        aliases_ar.update(['اجسام مضادة للكبد والكلى', 'تحليل lkm'])
        abbrevs.add('LKM')
    if 'transglutaminase' in lower_en or 'ttg' in lower_en or 'celiac' in lower_en or 'سيلياك' in norm_ar or 'قمح' in norm_ar:
        aliases_en.update(['anti-ttg', 'tissue transglutaminase', 'celiac panel', 'celiac disease test', 't-tg iga', 't-tg igg'])
        aliases_ar.update(['تحليل حساسية القمح', 'تحليل سيلياك', 'اجسام مضادة لمرض السيلياك', 'تحليل ترانس جلوتامينيز'])
        abbrevs.add('tTG')
    if 'reticulin' in lower_en:
        aliases_en.update(['anti-reticulin ab', 'reticulin antibodies', 'ara test'])
        aliases_ar.update(['اجسام مضادة للريتيكولين', 'تحليل انتي ريتيكولين'])
        abbrevs.add('ARA')
    if 'saccharomyces' in lower_en or 'asca' in lower_en:
        aliases_en.update(['anti-saccharomyces cerevisiae', 'asca', 'asca iga', 'asca igg'])
        aliases_ar.update(['تحليل اسكا', 'اجسام مضادة للخميرة كرونز'])
        abbrevs.add('ASCA')
    if 'lupus anticoagulant' in lower_en:
        aliases_en.update(['lupus anticoagulant test', 'd测t', 'lac test'])
        aliases_ar.update(['تحليل لوبس انتي كواجيولانت', 'مضاد تخثر الذئبة'])
        abbrevs.add('LAC')

    # 2. Allergy Panels & Specific IgE
    if 'ige' in lower_en or 'allergy' in lower_en or 'حساسية' in norm_ar:
        if 'food' in lower_en:
            aliases_en.update(['food allergy panel', 'food specific ige', 'food intolerance screen'])
            aliases_ar.update(['تحليل حساسية الطعام', 'فحص حساسية الاطعمة', 'بانل حساسية طعام'])
        elif 'inhalant' in lower_en:
            aliases_en.update(['inhalant allergy panel', 'inhalant specific ige', 'respiratory allergy panel'])
            aliases_ar.update(['تحليل حساسية الصدر والانف', 'فحص حساسية الاستنشاق', 'بانل استنشاقي'])
        elif 'phadiatop' in lower_en:
            aliases_en.update(['phadiatop test', 'phadiatop infant', 'phadiatop inhalant screen'])
            aliases_ar.update(['تحليل فادياتوب', 'فحص فادياتوب للحساسية'])
        elif 'total' in lower_en:
            aliases_en.update(['total ige', 'serum total ige', 'immunoglobulin e total'])
            aliases_ar.update(['تحليل ige الكلي', 'مستوى ige بالدم', 'اجسام مناعية نوع e'])
            abbrevs.add('Total-IgE')
        else:
            allergen_match = re.search(r'^([a-zA-Z0-9\s-]+?)\s+(?:ige|specific)', lower_en)
            if allergen_match:
                allergen = allergen_match.group(1).strip()
                if len(allergen) > 2:
                    aliases_en.update([f'{allergen} allergy test', f'{allergen} specific ige', f'ige {allergen}'])
                    aliases_ar.update([f'تحليل حساسية {allergen}'])

    # 3. Microbiology & Cultures
    if 'culture' in lower_en or 'مزرعة' in norm_ar:
        if 'blood' in lower_en or 'دم' in norm_ar:
            aliases_en.update(['blood culture', 'blood culture and sensitivity', 'bactec blood culture'])
            aliases_ar.update(['مزرعة دم', 'مزرعة دم وحساسية للمضادات', 'مزرعه دم'])
            abbrevs.add('BC')
            if 'aerobic' in lower_en:
                aliases_en.add('aerobic blood culture')
                aliases_ar.add('مزرعة دم هوائية')
            if 'anerobic' in lower_en or 'anaerobic' in lower_en:
                aliases_en.add('anaerobic blood culture')
                aliases_ar.add('مزرعة دم لاهوائية')
        elif 'urine' in lower_en or 'بول' in norm_ar:
            aliases_en.update(['urine culture', 'urine culture and sensitivity', 'clean catch urine culture'])
            aliases_ar.update(['مزرعة بول', 'مزرعة بول وحساسية للمضادات', 'مزرعه بول'])
            abbrevs.add('UC')
        elif 'sputum' in lower_en or 'بصاق' in norm_ar:
            aliases_en.update(['sputum culture', 'sputum culture and sensitivity', 'respiratory culture'])
            aliases_ar.update(['مزرعة بصاق', 'مزرعة بلغم', 'مزرعة افرازات صدر'])
        elif 'pus' in lower_en or 'wound' in lower_en or 'صديد' in norm_ar or 'جرح' in norm_ar:
            aliases_en.update(['wound culture', 'pus culture', 'wound swab culture', 'swab culture and sensitivity', 'pus culture aerobic', 'pus culture anaerobic'])
            aliases_ar.update(['مزرعة صديد', 'مزرعة مسحة جرح', 'مزرعة قيح', 'مزرعة جرح'])
        elif 'stool' in lower_en or 'براز' in norm_ar:
            aliases_en.update(['stool culture', 'fecal culture', 'stool culture and sensitivity'])
            aliases_ar.update(['مزرعة براز', 'مزرعة براز وميكروبات معوية'])
        elif 'throat' in lower_en or 'swab' in lower_en or 'حلق' in norm_ar or 'مسحة' in norm_ar:
            aliases_en.update(['throat swab culture', 'swab culture', 'swab c&s'])
            aliases_ar.update(['مزرعة مسحة حلق', 'مزرعة مسحة'])
        else:
            aliases_en.update(['culture and sensitivity', 'c&s test', 'bacterial culture'])
            aliases_ar.update(['مزرعة وميكروب', 'مزرعة بكتيرية'])

    # 4. Stains & Infectious Serology
    if 'stain' in lower_en or 'صبغة' in norm_ar:
        if 'gram' in lower_en:
            aliases_en.update(['gram stain', 'gram smear', 'gram stain direct examination'])
            aliases_ar.update(['صبغة جرام', 'فحص صبغة جرام المباشر'])
        if 'zn' in lower_en or 'acid fast' in lower_en or 'afb' in lower_en:
            aliases_en.update(['zn stain', 'ziehl neelsen stain', 'afb stain', 'acid fast bacilli smear'])
            aliases_ar.update(['صبغة زن', 'صبغة ميكروب الدرن', 'فحص afb'])
            abbrevs.update(['ZN', 'AFB'])
        if 'fungal' in lower_en or 'fungus' in lower_en:
            aliases_en.update(['fungal stain', 'koh preparation', 'fungus direct smear'])
            aliases_ar.update(['فحص صبغة فطريات', 'صبغة فطريات'])
    if 'glucan' in lower_en:
        aliases_en.update(['1-3 beta-d-glucan', 'bdg test', 'fungitell', 'beta glucan'])
        aliases_ar.update(['تحليل بيتا دي جلوكان', 'فحص الفطريات الجهازي'])
        abbrevs.add('BDG')
    if 'galactomannan' in lower_en:
        aliases_en.update(['galactomannan antigen', 'aspergillus antigen', 'galactomannan test'])
        aliases_ar.update(['تحليل جلاكتومانان', 'انتيجين الاسبرجلس'])

    # 5. Virology & Hepatitis
    if 'hcv' in lower_en or 'فيروس سي' in norm_ar:
        if 'pcr' in lower_en or 'rna' in lower_en:
            aliases_en.update(['hcv rna pcr', 'hcv viral load', 'hcv pcr quantitative', 'hepatitis c pcr'])
            aliases_ar.update(['بي سي ار فيروس سي', 'تحليل الحمل الفيروسي فيروس سي', 'pcr فيروس c'])
            abbrevs.update(['HCV-PCR', 'HCV-RNA'])
        else:
            aliases_en.update(['hcv ab', 'hepatitis c antibody', 'anti-hcv', 'hcv screen', 'hep c antibody'])
            aliases_ar.update(['فيروس سي', 'تحليل فيروس سي', 'اجسام مضادة فيروس سي', 'فحص فيروس c'])
            abbrevs.update(['HCV', 'Anti-HCV'])
    if 'hbs' in lower_en or 'hbv' in lower_en or 'فيروس بي' in norm_ar:
        if 'pcr' in lower_en or 'dna' in lower_en:
            aliases_en.update(['hbv dna pcr', 'hbv viral load', 'hbv pcr quantitative', 'hepatitis b pcr'])
            aliases_ar.update(['بي سي ار فيروس بي', 'تحليل الحمل الفيروسي فيروس بي', 'pcr فيروس b'])
            abbrevs.update(['HBV-PCR', 'HBV-DNA'])
        else:
            aliases_en.update(['hbsag', 'hepatitis b surface antigen', 'hep b screen', 'hbs ag test'])
            aliases_ar.update(['فيروس بي', 'تحليل فيروس بي', 'انتيجين السطح فيروس بي', 'فحص فيروس b'])
            abbrevs.update(['HBsAg', 'HBV'])
    if 'hiv' in lower_en or 'ايدز' in norm_ar:
        aliases_en.update(['hiv test', 'hiv 1 and 2 antibodies', 'hiv combo', 'anti-hiv 1/2', 'aids test'])
        aliases_ar.update(['تحليل الايدز', 'فيروس نقص المناعة البشرية', 'تحليل hiv', 'اجسام مضادة للايدز'])
        abbrevs.add('HIV')
    if 'torch' in lower_en:
        aliases_en.update(['torch panel', 'torch screen', 'torch antibodies'])
        aliases_ar.update(['بانل تورش', 'تحليل ميكروبات الحمل تورش'])
        abbrevs.add('TORCH')
    if 'toxoplasma' in lower_en or 'ميكروب القطط' in norm_ar:
        aliases_en.update(['toxoplasma antibodies', 'toxo test', 'toxoplasmosis screen'])
        aliases_ar.update(['تحليل ميكروب القطط', 'تحليل توكسوبلازما', 'فحص التوكسوبلازما'])
        abbrevs.add('TOXO')
    if 'rubella' in lower_en or 'الحصبة الالمانية' in norm_ar:
        aliases_en.update(['rubella antibodies', 'german measles test'])
        aliases_ar.update(['تحليل الحصبة الالمانية', 'تحليل روبيلا'])
    if 'cmv' in lower_en:
        aliases_en.update(['cmv antibodies', 'cytomegalovirus test'])
        aliases_ar.update(['تحليل cmv', 'تحليل فيروس سيتوميجالو'])
        abbrevs.add('CMV')
    if 'ebv' in lower_en:
        aliases_en.update(['ebv antibodies', 'epstein barr virus test'])
        aliases_ar.update(['تحليل ebv', 'تحليل فيروس ابشتاين بار'])
        abbrevs.add('EBV')
    if 'widal' in lower_en or 'تيفود' in norm_ar:
        aliases_en.update(['widal test', 'typhoid agglutination', 'salmonella antibodies'])
        aliases_ar.update(['تحليل فيدال', 'تحليل التيفود', 'فحص فيدال للتيفويد'])
    if 'brucella' in lower_en or 'مالطية' in norm_ar or 'مالطيه' in norm_ar:
        aliases_en.update(['brucella agglutination', 'rose bengal test', 'malta fever test', 'brucella test'])
        aliases_ar.update(['تحليل بروسيلا', 'تحليل الحمى المالطية', 'تحليل حمى مالطية', 'فحص بروسيلا', 'حمى مالطية'])
        abbrevs.add('BRUCELLA')
    if 'vdrl' in lower_en or 'rpr' in lower_en or 'tpha' in lower_en or 'syphilis' in lower_en or 'زهري' in norm_ar:
        aliases_en.update(['vdrl test', 'rpr test', 'syphilis screen', 'treponema pallidum antibodies', 'tpha'])
        aliases_ar.update(['تحليل الزهري', 'تحليل vdrl', 'تحليل rpr', 'فحص الزهري'])
        abbrevs.update(['VDRL', 'RPR', 'TPHA'])
    if 'pylori' in lower_en or 'جرثومة' in norm_ar:
        aliases_en.update(['h pylori antigen in stool', 'h pylori antibodies', 'helicobacter pylori test'])
        aliases_ar.update(['تحليل جرثومة المعدة', 'جرثومة المعدة بالبراز', 'تحليل ميكروب المعدة الحلزوني'])
        abbrevs.add('HP')
    if 'difficile' in lower_en:
        aliases_en.update(['c difficile toxins a and b', 'clostridium difficile toxin', 'c diff test'])
        aliases_ar.update(['تحليل كلوستريديوم ديفيسيل', 'سموم بكتيريا كلوستريديوم بالبراز'])
        abbrevs.add('CDIFF')

    # 6. Molecular Biology & PCR
    if 'bcr-abl' in lower_en or 'bcr abl' in lower_en:
        aliases_en.update(['bcr-abl pcr', 'philadelphia chromosome pcr', 'bcr abl quantitative pcr', 'bcr-abl', 'bcr abl'])
        aliases_ar.update(['تحليل جين bcr-abl', 'بي سي ار كروموسوم فيلادلفيا'])
        abbrevs.add('BCR-ABL')
    if 'jak-2' in lower_en or 'jak2' in lower_en or 'jak ii' in lower_en:
        aliases_en.update(['jak-2 mutation', 'jak2 mutation', 'jak2 v617f mutation pcr', 'jak2 test', 'jak2'])
        aliases_ar.update(['طفرة jak2', 'تحليل جين jak2 بالدم'])
        abbrevs.update(['JAK2', 'JAK-2'])
    if 'fmf' in lower_en or 'mediterranean' in lower_en or 'حمى البحر' in norm_ar:
        aliases_en.update(['fmf pcr', 'fmf gene mutation', 'familial mediterranean fever pcr'])
        aliases_ar.update(['تحليل حمى البحر المتوسط', 'فحص جين fmf', 'تحليل fmf'])
        abbrevs.add('FMF')
    if 'factor v' in lower_en or 'leiden' in lower_en:
        aliases_en.update(['factor v leiden pcr', 'factor v mutation', 'factor 5 leiden'])
        aliases_ar.update(['طفرة فاكتور 5 ليدن', 'تحليل فاكتور v'])
    if 'karyotyping' in lower_en:
        aliases_en.update(['karyotyping blood', 'karyotyping', 'chromosomal analysis', 'chromosome study'])
        aliases_ar.update(['تحليل الكروموسومات', 'فحص وراثي للكروموسومات', 'رسم الكروموسومات'])
    if 'fish ' in lower_en or 'fish for' in lower_en:
        aliases_en.update(['fish test', 'fluorescence in situ hybridization'])
        aliases_ar.update(['فحص فيش للكروموسومات', 'تحليل fish'])
        abbrevs.add('FISH')
    if 'hla' in lower_en:
        aliases_en.update(['hla typing', 'human leukocyte antigen test'])
        aliases_ar.update(['تحليل تطابق الانسجة hla', 'فحص hla'])
        abbrevs.add('HLA')
        if 'b27' in lower_en or 'b-27' in lower_en or 'b 27' in lower_en:
            aliases_en.update(['hla-b27', 'hla b27'])
            aliases_ar.add('تحليل hla-b27 لالتيبس الفقاري')
            abbrevs.add('HLA-B27')
        if 'b51' in lower_en or 'b 51' in lower_en or 'b-51' in lower_en or 'b5' in lower_en:
            aliases_en.update(['hla-b51', 'hla b51', 'pcr for hla-b 51'])
            aliases_ar.add('تحليل hla-b51 لمرض بهجت')
            abbrevs.add('HLA-B51')

    # 7. Pathology, Cytology & IHC
    if '-ihc' in lower_en or 'ihc' in lower_en or 'ihс' in lower_en:
        marker = re.sub(r'[-\s]*ih[cс].*', '', lower_en).strip()
        aliases_en.update([f'{marker} ihc', f'{marker} immunohistochemistry', f'{marker} stain', f'{marker}-ihc', 'ihc marker'])
        aliases_ar.update([f'صبغة مناعية {marker}', f'فحص ihc {marker}', 'صبغات مناعية باثولوجي'])
        abbrevs.add('IHC')
        # Extract acronym in parens if any, e.g. Progesterone Receptor (PR) -> PR
        paren_match = re.findall(r'\(([a-zA-Z0-9\s-]+)\)', marker)
        for pm in paren_match:
            p_clean = pm.lower().strip()
            aliases_en.update([f'{p_clean}-ihc', f'{p_clean} ihc', f'{p_clean} stain'])
            aliases_ar.add(f'صبغة مناعية {p_clean}')
            abbrevs.add(pm.upper())
        if 'ki' in marker and '67' in marker:
            aliases_en.update(['ki-67', 'ki 67', 'ki67', 'ki-67-ihc', 'ki 67 - ihc', 'ki-67 ihc'])
            abbrevs.add('Ki-67')
    if 'biopsy' in lower_en or 'histopath' in lower_en or 'باثولوجي' in norm_ar or 'عينة نسيجية' in norm_ar:
        aliases_en.update(['surgical pathology', 'histopathology report', 'biopsy examination', 'tissue biopsy'])
        aliases_ar.update(['فحص عينة باثولوجي', 'تحليل نسيجي', 'فحص نسيج جراحي'])
        abbrevs.add('HISTO')
    if 'cytology' in lower_en or 'سيتولوجي' in norm_ar:
        aliases_en.update(['cytology examination', 'fluid cytology', 'cytopathology report'])
        aliases_ar.update(['فحص سيتولوجي', 'فحص خلايا'])
    if 'pap smear' in lower_en or 'عنق الرحم' in norm_ar:
        aliases_en.update(['pap smear', 'cervical pap smear', 'papanicolaou smear', 'cervical screening'])
        aliases_ar.update(['مسحة عنق الرحم', 'تحليل مسحة عنق الرحم سيتولوجي'])
        abbrevs.add('PAP')

    return list(aliases_en), list(aliases_ar), list(abbrevs)

def generate_batch_6_aliases(name_en: str, name_ar: str, cat: str):
    aliases_en = set()
    aliases_ar = set()
    abbrevs = set()

    lower_en = normalize_homoglyphs(name_en).lower().strip()
    norm_ar = clean_arabic(name_ar)
    no_dots_en = lower_en.replace('.', '')

    if lower_en:
        aliases_en.add(lower_en)
        clean_name = re.sub(r'[(),/:.-]', ' ', lower_en)
        clean_name = re.sub(r'\s+', ' ', clean_name).strip()
        if clean_name != lower_en:
            aliases_en.add(clean_name)
        if no_dots_en != lower_en:
            aliases_en.add(no_dots_en)
    if name_ar.strip():
        aliases_ar.add(name_ar.strip())
        if norm_ar and norm_ar != name_ar.strip():
            aliases_ar.add(norm_ar)

    # 1. Chemotherapy & Oncology Daycare
    if cat == 'Chemotherapy' or 'chemotherapy' in lower_en or 'كيماوي' in norm_ar or 'اورام' in norm_ar:
        if 'chemotherapy' in lower_en and 'preparation' in lower_en:
            aliases_en.update(['chemotherapy preparation service', 'chemotherapy preparation', 'chemo drug preparation', 'cytotoxic reconstitution'])
            aliases_ar.update(['خدمة تحضير علاج كيماوي', 'تحضير كيماوي', 'تحضير ادوية الاورام'])
        elif 'i.v solutions' in lower_en or 'محاليل' in norm_ar:
            aliases_en.update(['iv solutions preparation service', 'solutions preparation'])
            aliases_ar.update(['خدمة تحضير محاليل', 'تحضير محاليل'])
        elif '2' in lower_en and '6' in lower_en:
            aliases_en.update(['chemotherapy session 2-6 hrs', 'chemo session 2 to 6 hours', 'chemotherapy administration'])
            aliases_ar.update(['جلسة علاج كيماوي من ساعتين الى 6 ساعات', 'جلسة كيماوي 2 الى 6 ساعات', 'جلسة كيماوي'])
        elif 'less than two' in lower_en or 'less that 2' in lower_en or 'اقل من ساعتين' in norm_ar:
            aliases_en.update(['chemotherapy less than 2 hours', 'short chemo session', 'chemo session under 2 hours'])
            aliases_ar.update(['جلسة علاج كيماوي اقل من ساعتين', 'جلسة كيماوي اقل من ساعتين'])
        elif 'pharmacy' in lower_en or 'صيدلة' in norm_ar or 'صيدله' in norm_ar:
            aliases_en.update(['clinical pharmacy supervision', 'oncology clinical pharmacy', 'pharmacy supervision'])
            aliases_ar.update(['اشراف الصيدلة الاكلينيكية', 'اشراف صيدلي اكلينيكي'])
        elif 'ice cap' in lower_en or 'ايس كاب' in norm_ar:
            aliases_en.update(['ice cape procedure', 'ice cap therapy', 'scalp cooling session', 'ice cap chemotherapy'])
            aliases_ar.update(['خدمة الايس كاب', 'ايس كاب لحماية الشعر', 'تبريد فروة الراس'])
        elif 'biotherapy' in lower_en or 'حيوي موجه' in norm_ar:
            aliases_en.update(['targeted biotherapy session', 'biotherapy session', 'targeted therapy session'])
            aliases_ar.update(['جلسة علاج حيوي موجه', 'جلسة علاج بيولوجي موجه'])
        elif 'immune' in lower_en or 'مناعي' in norm_ar:
            aliases_en.update(['immunotherapy administration', 'immune therapy', 'immune therapy session'])
            aliases_ar.update(['جلسة علاج مناعي', 'تنفيذ علاج مناعي'])
        elif 'nutrition' in lower_en or 'تغذية' in norm_ar or 'وريدية' in norm_ar:
            aliases_en.update(['tpn preparation', 'parenteral nutrition preparation', 'total parenteral nutrition'])
            aliases_ar.update(['تحضير التغذية الوريدية', 'تحضير الاغذية الوريدية tpn'])
            abbrevs.add('TPN')

    # 2. Hemodialysis & Blood Purification
    if cat == 'Dialysis' or 'dialysis' in lower_en or 'غسيل كلوي' in norm_ar or 'hd ' in lower_en or 'hdf' in lower_en:
        if 'fistula' in lower_en or 'وصلة' in norm_ar or 'وصله' in norm_ar:
            aliases_en.update(['hd session with fistula', 'hd with av fistula', 'hemodialysis fistula session'])
            aliases_ar.update(['جلسة غسيل كلوي بوصلة شريانية', 'غسيل كلوي بوصلة شريانية وريدية'])
            abbrevs.add('HD-AVF')
        elif 'catheter' in lower_en or 'قسطرة' in norm_ar:
            aliases_en.update(['hd session with catheter', 'hd with catheter', 'hemodialysis catheter session', 'dialysis with permcath', 'temporary double lumen hd catheter'])
            aliases_ar.update(['جلسة غسيل كلوي بالقسطرة', 'غسيل كلوي بقسطرة مستديمة', 'تركيب قسطرة غسيل كلوي مؤقتة'])
            abbrevs.add('HD-Cath')
        elif 'sled' in lower_en or 'بطيء' in norm_ar:
            aliases_en.update(['sled session', 'sled dialysis', 'sustained low efficiency dialysis'])
            aliases_ar.update(['جلسة غسيل كلوي بطيء sled', 'غسيل كلوي بطيء'])
            abbrevs.add('SLED')
        elif 'hdf' in lower_en or 'hemodiafiltration' in lower_en:
            aliases_en.update(['hdf session', 'hemodiafiltration', 'online hdf'])
            aliases_ar.update(['جلسة غسيل كلوي hdf', 'غسيل كلوي عالي الترشيح hdf'])
            abbrevs.add('HDF')
        elif 'icu' in lower_en or 'عناية' in norm_ar:
            aliases_en.update(['icu hemodialysis session', 'dialysis in intensive care', 'bedside dialysis'])
            aliases_ar.update(['جلسة غسيل كلوي بالعناية المركزة', 'غسيل كلوي بالرعاية'])
        elif 'pharesis' in lower_en or 'plasmapheresis' in lower_en or 'بلازما' in norm_ar:
            aliases_en.update(['plasmapheresis', 'plasmapheresis session', 'therapeutic plasma exchange', 'plasma exchange'])
            aliases_ar.update(['جلسة فصل البلازما', 'فصل البلازما العلاجي', 'تبديل البلازما'])
            abbrevs.update(['TPE', 'PLEX'])
        else:
            aliases_en.update(['hemodialysis session', 'hd session', 'dialysis session', 'renal dialysis'])
            aliases_ar.update(['جلسة غسيل كلوي', 'غسيل كلوي', 'جلسة كلية صناعية'])
            abbrevs.add('HD')

    # 3. Medical Devices & Equipment Usage Fees
    if cat == 'Medical Devices' or 'device' in lower_en or 'machine' in lower_en or 'رسم استخدام' in norm_ar or 'جهاز' in norm_ar:
        if 'c-arm' in lower_en or 'c arm' in lower_en or 'سي ارم' in norm_ar:
            aliases_en.update(['c-arm usage', 'c-arm fluoroscopy', 'c-arm in operating theater', 'c-arm device'])
            aliases_ar.update(['رسم استخدام جهاز السي ارم', 'جهاز السي ارم', 'اشعة سي ارم بالعمليات'])
            abbrevs.add('C-ARM')
        if 'cusa' in lower_en or 'cavitron' in lower_en or 'كوزا' in norm_ar:
            aliases_en.update(['cusa machine', 'cusa device usage', 'cavitron ultrasonic surgical aspirator'])
            aliases_ar.update(['جهاز الكوزا', 'رسم استخدام جهاز الكوزا', 'جهاز الكوزا تفتيت وشفط الاورام'])
            abbrevs.add('CUSA')
        if 'bipap' in lower_en or 'باي باب' in norm_ar:
            aliases_en.update(['bipap usage', 'bipap machine usage', 'bipap per day', 'non-invasive ventilation bipap'])
            aliases_ar.update(['استخدام جهاز باي باب باليوم', 'جهاز باي باب', 'تنفس غير تداخلي باي باب'])
            abbrevs.add('BiPAP')
        if 'cpap' in lower_en or 'سي باب' in norm_ar:
            aliases_en.update(['cpap usage', 'cpap machine usage', 'cpap per day', 'continuous positive airway pressure'])
            aliases_ar.update(['استخدام جهاز سي باب باليوم', 'جهاز سي باب'])
            abbrevs.add('CPAP')
        if 'ventilator' in lower_en or 'تنفس صناعي' in norm_ar:
            aliases_en.update(['mechanical ventilator usage', 'ventilator usage', 'ventilator per day', 'invasive mechanical ventilation'])
            aliases_ar.update(['رسم استخدام جهاز التنفس الصناعي', 'جهاز تنفس صناعي باليوم'])
            abbrevs.add('MV')
        if 'monitor' in lower_en or 'مونيتور' in norm_ar:
            aliases_en.update(['cardiac monitor usage', 'patient monitor per day', 'bedside monitor', 'cardiac monitor'])
            aliases_ar.update(['رسم استخدام جهاز المونيتور', 'مونيتور باليوم', 'متابعة القلب والمونيتور'])
        if 'laser' in lower_en or 'ليزر' in norm_ar:
            aliases_en.update(['auriga laser machine', 'laser machine usage', 'surgical laser device', 'auriga laser'])
            aliases_ar.update(['رسم استخدام جهاز الليزر', 'جهاز ليزر اوريجا', 'ليزر جراحي'])
        if 'bipolar' in lower_en or 'بيبولار' in norm_ar:
            aliases_en.update(['bipolar diathermy usage', 'bipolar generator'])
            aliases_ar.update(['رسم استخدام جهاز البيبولار', 'جهاز بيبولار كي'])
        if 'harmonic' in lower_en or 'هارمونيك' in norm_ar:
            aliases_en.update(['harmonic scalpel usage', 'ultrasonic shears usage'])
            aliases_ar.update(['رسم استخدام جهاز الهارمونيك', 'مشرط توافقي هارمونيك'])

    return list(aliases_en), list(aliases_ar), list(abbrevs)

def generate_batch_7_aliases(name_en: str, name_ar: str, cat: str):
    aliases_en = set()
    aliases_ar = set()
    abbrevs = set()

    lower_en = normalize_homoglyphs(name_en).lower().strip()
    norm_ar = clean_arabic(name_ar)
    no_dots_en = lower_en.replace('.', '')

    if lower_en:
        aliases_en.add(lower_en)
        clean_name = re.sub(r'[(),/:.-]', ' ', lower_en)
        clean_name = re.sub(r'\s+', ' ', clean_name).strip()
        if clean_name != lower_en:
            aliases_en.add(clean_name)
        if no_dots_en != lower_en:
            aliases_en.add(no_dots_en)
    if name_ar.strip():
        aliases_ar.add(name_ar.strip())
        if norm_ar and norm_ar != name_ar.strip():
            aliases_ar.add(norm_ar)

    # 1. Outpatient Consultations & Clinical Examinations
    if cat == 'Examination' or 'examination' in lower_en or 'consult' in lower_en or 'كشف' in norm_ar or 'استشاري' in norm_ar or 'استاذ' in norm_ar:
        is_prof = ('professor' in lower_en or 'استاذ' in norm_ar or 'أستاذ' in name_ar)
        is_cons = ('consultant' in lower_en or 'استشاري' in norm_ar or 'إستشاري' in name_ar)
        is_spec = ('specialist' in lower_en or 'اخصائي' in norm_ar or 'أخصائي' in name_ar)

        if is_prof:
            aliases_en.update(['professor examination', 'professor consultation', 'prof exam', 'prof clinic'])
            aliases_ar.update(['كشف استاذ', 'عيادة استاذ', 'استشارة استاذ', 'كشف استاذ بالعيادة'])
        elif is_cons:
            aliases_en.update(['consultant examination', 'consultant consultation', 'specialist consultant exam'])
            aliases_ar.update(['كشف استشاري', 'عيادة استشاري', 'استشارة استشاري', 'كشف استشاري بالعيادة'])
        elif is_spec:
            aliases_en.update(['specialist examination', 'specialist consultation', 'specialist doctor clinic'])
            aliases_ar.update(['كشف اخصائي', 'عيادة اخصائي', 'استشارة اخصائي'])

        if 'consulto' in lower_en or 'consult ' in lower_en or 'كونسلتو' in norm_ar:
            aliases_en.update(['consulto examination', 'multidisciplinary medical board', 'consulto board'])
            aliases_ar.update(['كشف كونسلتو', 'كونسلتو طبي', 'كونسلتو استشاريين', 'لجنة طبية كونسلتو'])
        if 'ultrasound' in lower_en or 'ultra-sound' in lower_en or 'سونار' in norm_ar:
            aliases_en.update(['examination with ultrasound', 'consultation with us', 'clinic ultrasound exam'])
            if is_cons:
                aliases_ar.add('كشف استشاري بسونار')
            elif is_prof:
                aliases_ar.add('كشف استاذ بسونار')
            else:
                aliases_ar.add('كشف اخصائي بسونار')
        if 'er ' in lower_en or 'emergency' in lower_en or 'طوارئ' in norm_ar or 'طوارئ' in name_ar:
            aliases_en.update(['er examination', 'emergency room consultation', 'er doctor exam', 'urgent care exam'])
            aliases_ar.update(['كشف طوارئ', 'تذكرة طوارئ', 'كشف اخصائي طوارئ', 'فحص قسم الطوارئ'])
            abbrevs.add('ER')

    # 2. Physiotherapy & Rehabilitation
    if cat == 'Physiotherapy' or 'physiotherapy' in lower_en or 'علاج طبيعي' in norm_ar or 'جلسة' in norm_ar:
        aliases_en.update(['physiotherapy session', 'physical therapy', 'rehabilitation session', 'pt session'])
        aliases_ar.update(['جلسة علاج طبيعي', 'علاج طبيعي وتاهيل', 'جلسة تاهيل حركي'])
        abbrevs.add('PT')
        if 'acupuncture' in lower_en or 'ابر صينية' in norm_ar or 'إبر صينية' in name_ar:
            aliases_en.update(['acupuncture', 'acupuncture session', 'chinese needles therapy'])
            aliases_ar.update(['ابر صينية', 'جلسة ابر صينية', 'تركيب الابر الصينية', 'وخز بالابر الصينية'])
        if 'biofeedback' in lower_en or 'بيوفيد' in norm_ar:
            aliases_en.update(['biofeedback session', 'pelvic floor biofeedback'])
            aliases_ar.update(['جلسة بيوفيدباك', 'جلسة بيوفيد باك لعضلات الحوض'])
        if 'aqua' in lower_en or 'hydro' in lower_en or 'مائي' in norm_ar:
            aliases_en.update(['aqua massage therapy', 'hydrotherapy session'])
            aliases_ar.update(['جلسة مساج مائي', 'علاج مائي اكوا'])

    # 3. Dental & Dermatology
    if cat == 'Dental & Derma' or 'dental' in lower_en or 'اسنان' in norm_ar or 'أسنان' in name_ar or 'سنطه' in norm_ar or 'جلدية' in norm_ar:
        if 'cryo' in lower_en or 'تبريد' in norm_ar:
            aliases_en.update(['warts excision cryotherapy', 'cryotherapy wart removal', 'liquid nitrogen wart', 'cryotherapy'])
            aliases_ar.update(['كي بالتبريد للسنط', 'ازالة سنط بالتبريد', 'جلسة كي نيتروجين للسنط', 'جلسة كرايو'])
        elif 'electric' in lower_en or 'كهربائي' in norm_ar:
            aliases_en.update(['electrocautery wart excision', 'electric wart removal'])
            aliases_ar.update(['كي كهربائي للسنط', 'ازالة سنط بالكي الكهربائي'])
        elif 'injection' in lower_en or 'حقن' in norm_ar:
            aliases_en.update(['wart injection', 'intralesional wart injection'])
            aliases_ar.update(['حقن سنطة', 'حقن موضعي للسنط'])
        if 'tooth' in lower_en or 'teeth' in lower_en or 'اسنان' in norm_ar or 'ضرس' in norm_ar or 'حشو' in norm_ar or 'خلع' in norm_ar:
            aliases_en.update(['dental procedure', 'dentistry treatment', 'tooth restoration'])
            aliases_ar.update(['اجراء اسنان', 'علاج اسنان', 'طب وجراحة الاسنان'])
        if 'vitallium' in lower_en or 'vitalium' in lower_en or 'فيتاليوم' in norm_ar:
            aliases_en.update(['vitallium partial denture', 'vitallium cast teeth'])
            aliases_ar.update(['تركيب اسنان فيتاليوم', 'تركيبة فيتاليوم متحركة'])

    # 4. Home Care Services
    if cat == 'Home Care' or ('منزل' in norm_ar and cat != 'Dental & Derma'):
        if 'nurse' in lower_en or 'تمريض' in norm_ar:
            aliases_en.update(['nurse visit in home', 'home nursing visit', 'home nurse care'])
            aliases_ar.update(['تمريض منزلي', 'زيارة تمريض منزلية'])
        elif 'doctor' in lower_en or 'physician' in lower_en or 'طبيب' in norm_ar or 'كشف' in norm_ar:
            aliases_en.update(['doctor visit in home', 'home medical visit', 'doctor home care'])
            aliases_ar.update(['كشف منزلي', 'زيارة طبيب منزلية'])
        else:
            aliases_en.update(['home care service', 'domiciliary healthcare', 'home visit'])
            aliases_ar.update(['خدمة رعاية منزلية', 'رعاية منزلية', 'زيارة منزلية'])

        if 'اشعه' in norm_ar or 'اشعة' in norm_ar or 'x-ray' in lower_en or 'plain' in lower_en:
            aliases_en.update(['home mobile x-ray', 'home x-ray', 'portable x-ray at home'])
            aliases_ar.update(['اشعة منزلية متنقلة', 'اشعة عادية بالمنزل'])
        elif 'موجات' in norm_ar or 'سونار' in norm_ar or 'ultrasound' in lower_en:
            aliases_en.update(['home ultrasound examination', 'portable home ultrasound', 'home sonar'])
            aliases_ar.update(['سونار بالمنزل', 'موجات صوتية منزلية'])

    return list(aliases_en), list(aliases_ar), list(abbrevs)

wb = openpyxl.load_workbook('Pricelist_Comparison_Categorized.xlsx', read_only=True)
ws = wb['All items categorized']
rows = list(ws.iter_rows(values_only=True))[1:]

catalog_items = []
counts = defaultdict(int)

for r in rows:
    yr = r[0]
    name_en = str(r[1] or '').strip()
    name_ar = str(r[2] or '').strip()
    price = r[3]
    cat = r[5]

    if cat in BATCH_1_CATS:
        counts['Batch 1'] += 1
        aliases_en, aliases_ar, abbrevs = generate_batch_1_aliases_updated(name_en, name_ar, cat)
        bname = 'Batch 1'
    elif cat in BATCH_2_CATS:
        counts['Batch 2'] += 1
        aliases_en, aliases_ar, abbrevs = generate_radiology_aliases(name_en, name_ar)
        bname = 'Batch 2'
    elif cat in BATCH_3_CATS:
        counts['Batch 3'] += 1
        aliases_en, aliases_ar, abbrevs = generate_batch_3_aliases_updated(name_en, name_ar, cat)
        bname = 'Batch 3'
    elif cat == 'Laboratory':
        if not is_batch_5(name_en, name_ar):
            counts['Batch 4'] += 1
            aliases_en, aliases_ar, abbrevs = generate_batch_4_aliases(name_en, name_ar, cat)
            bname = 'Batch 4'
        else:
            counts['Batch 5'] += 1
            aliases_en, aliases_ar, abbrevs = generate_batch_5_aliases(name_en, name_ar, cat)
            bname = 'Batch 5'
    elif cat in BATCH_6_CATS:
        counts['Batch 6'] += 1
        aliases_en, aliases_ar, abbrevs = generate_batch_6_aliases(name_en, name_ar, cat)
        bname = 'Batch 6'
    elif cat in BATCH_7_CATS:
        counts['Batch 7'] += 1
        aliases_en, aliases_ar, abbrevs = generate_batch_7_aliases(name_en, name_ar, cat)
        bname = 'Batch 7'
    else:
        raise ValueError(f"Unclassified: {cat} - {name_en}")

    catalog_items.append({
        'batch': bname,
        'year': yr,
        'category': cat,
        'nameEnglish': name_en,
        'nameArabic': name_ar,
        'price': price,
        'aliases_en': aliases_en,
        'aliases_ar': aliases_ar,
        'abbreviations': abbrevs
    })

print(f"Processed total items: {len(catalog_items)} / {len(rows)}")
for b, cnt in sorted(counts.items()):
    print(f"  {b}: {cnt}")

canonical_map = defaultdict(lambda: {
    'canonical_name': '',
    'category': '',
    'years': set(),
    'aliases_en': set(),
    'aliases_ar': set(),
    'abbreviations': set(),
    'items': []
})

for itm in catalog_items:
    clean_key = re.sub(r'\s+', ' ', itm['nameEnglish']).strip().lower()
    if not clean_key:
        clean_key = clean_arabic(itm['nameArabic'])
    clean_key = re.sub(r'^\d+\s*[-.)]\s*', '', clean_key)
    entry = canonical_map[clean_key]
    entry['canonical_name'] = itm['nameEnglish'] if itm['nameEnglish'] else itm['nameArabic']
    entry['category'] = itm['category']
    entry['years'].add(itm['year'])
    entry['aliases_en'].update(itm['aliases_en'])
    entry['aliases_ar'].update(itm['aliases_ar'])
    entry['abbreviations'].update(itm['abbreviations'])
    entry['items'].append(itm)

print(f"Canonical alias entries generated: {len(canonical_map)}")

test_queries = [
    # Batch 5: Autoimmune & Serology
    ('ANA by Microarray', 'ANA'),
    ('تحليل ana', 'ANA'),
    ('ANCA', 'ANCA'),
    ('Anti-dsDNA', 'DNA'),
    ('Anti-CCP', 'CCP'),
    ('Rheumatoid Factor', 'RF'),
    ('تحليل روماتويد', 'RF'),
    ('Complement C3', 'Complement'),
    ('Complement C4', 'Complement'),
    ('Tissue Transglutaminase', 'Transglutaminase'),
    ('تحليل حساسية القمح', 'Transglutaminase'),
    ('HCV Ab', 'HCV'),
    ('فيروس سي', 'HCV'),
    ('HBsAg', 'HBs'),
    ('HIV test', 'HIV'),
    ('تحليل الايدز', 'HIV'),
    ('Widal test', 'Widal'),
    ('تحليل التيفود', 'Widal'),
    ('Brucella agglutination', 'Brucella'),
    ('تحليل حمى مالطية', 'Brucella'),
    ('Blood Culture', 'Blood Culture'),
    ('مزرعة دم', 'Blood Culture'),
    ('Urine Culture', 'Urine'),
    ('مزرعة بول', 'Urine'),
    ('Sputum Culture', 'Sputum'),
    ('Wound Swab Culture', 'Pus'),
    ('Gram stain', 'Gram'),
    ('ZN stain', 'ZN'),
    ('Fungal stain', 'Fungal'),
    ('HCV RNA PCR', 'HCV'),
    ('بي سي ار فيروس سي', 'HCV'),
    ('HBV DNA PCR', 'HBV'),
    ('BCR-ABL', 'BCR'),
    ('JAK2 mutation', 'JAK'),
    ('FMF PCR', 'FMF'),
    ('Factor V Leiden PCR', 'Factor V'),
    ('Karyotyping blood', 'Karyotyping'),
    ('HLA-B27', 'HLA'),
    ('FNA cytology', 'FNA'),
    ('Pap smear', 'Pap'),
    ('مسحة عنق الرحم', 'Pap'),
    ('Frozen section biopsy', 'Frozen'),
    ('Ki-67-IHC', 'KI 67'),
    ('ER-IHC', 'ER'),
    ('PR-IHC', 'PR'),
    ('HER2-IHC', 'HER2'),
    ('CD20-IHC', 'CD20'),

    # Batch 6: Specialized Units, Chemo, Dialysis & Devices
    ('Chemotherapy Session 2 Hours To 6 Hours', 'Chemotherapy'),
    ('جلسة علاج كيماوي', 'Chemotherapy'),
    ('Chemotherapy Preparation Service', 'Chemotherapy'),
    ('Clinical Pharmacy Supervision', 'Pharmacy'),
    ('Ice Cape Procedure', 'Ice Cap'),
    ('Targeted Biotherapy Session', 'Biotherapy'),
    ('HD session with Fistula', 'Fistula'),
    ('جلسة غسيل كلوي', 'HD'),
    ('HD session with Catheter', 'Catheter'),
    ('HDF Session', 'HDF'),
    ('SLED Session', 'SLED'),
    ('Plasmapheresis', 'Pharesis'),
    ('جلسة فصل البلازما', 'Pharesis'),
    ('Temporary double lumen HD catheter', 'Catheter'),
    ('C-Arm Usage', 'C-Arm'),
    ('CUSA Machine', 'Cavitron'),
    ('جهاز الكوزا', 'Cavitron'),
    ('BiPAP usage', 'Bipap'),
    ('CPAP usage', 'Cpap'),
    ('Mechanical Ventilator Usage', 'Ventilator'),
    ('Cardiac Monitor Usage', 'Cardiac Monitor'),
    ('Auriga Laser Machine', 'Laser'),

    # Batch 7: Outpatient, Physiotherapy, Dental & Derma, Home Care
    ('Professor Examination', 'Professor'),
    ('كشف استاذ', 'Professor'),
    ('Consultant Examination', 'Consultant'),
    ('كشف استشاري', 'Consultant'),
    ('Specialist Examination', 'Specialist'),
    ('كشف اخصائي', 'Specialist'),
    ('ER Examination', 'ER'),
    ('كشف طوارئ', 'ER'),
    ('Consulto Examination', 'Consult'),
    ('كشف كونسلتو', 'Consult'),
    ('Physiotherapy Session', 'Physiotherapy'),
    ('جلسة علاج طبيعي', 'Physiotherapy'),
    ('Acupuncture', 'Acupuncture'),
    ('ابر صينية', 'Acupuncture'),
    ('Biofeedback Session', 'Biofeedback'),
    ('Warts Excision Cryotherapy', 'Cryotherapy'),
    ('كي بالتبريد للسنط', 'Cryotherapy'),
    ('Home Care Service', 'Home Care'),
    ('رعاية منزلية', 'Home Care'),
    ('Home Mobile X-Ray', 'اشعه')
]

matched = 0
for q, expected in test_queries:
    q_clean = q.lower().strip()
    q_ar = clean_arabic(q)
    cands = []
    for k, entry in canonical_map.items():
        matched_by = None
        if q.upper() in entry['abbreviations']:
            matched_by = 'abbrev'
        elif q_clean and any(alias == q_clean for alias in entry['aliases_en']):
            matched_by = 'exact_en'
        elif q_ar and any(alias == q or q_ar == clean_arabic(alias) for alias in entry['aliases_ar']):
            matched_by = 'exact_ar'
        elif q_clean and any(len(alias) >= 3 and (alias == q_clean or (len(alias) <= 4 and re.search(r'\b' + re.escape(alias) + r'\b', q_clean)) or (len(alias) > 4 and (alias in q_clean or q_clean in alias))) for alias in entry['aliases_en']):
            matched_by = 'sub_en'
        elif q_ar and any(len(clean_arabic(alias)) >= 3 and (clean_arabic(alias) == q_ar or clean_arabic(alias) in q_ar or (len(clean_arabic(alias)) > 4 and q_ar in clean_arabic(alias))) for alias in entry['aliases_ar']):
            matched_by = 'sub_ar'
        if matched_by:
            cands.append((entry, matched_by))
    best = cands[0][0] if cands else None
    passed = best and (expected.lower() in best['canonical_name'].lower() or expected.lower() in best['category'].lower())
    if passed:
        matched += 1
    else:
        print(f"FAILED query: '{q}' (expected: '{expected}') -> Matched: {best['canonical_name'] if best else 'None'}")

print(f"\n✓ Test Queries Passed: {matched} / {len(test_queries)} ({matched/len(test_queries)*100:.1f}%)")
