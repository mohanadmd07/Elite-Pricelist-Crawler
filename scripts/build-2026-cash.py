"""Convert '2026 Elite Cash PL 12-1 (1).xlsx' into public/2026_cash.json (same shape as 2025_cash.json)."""
import openpyxl, json, re, sys
SRC = '2026 Elite Cash PL 12-1 (1).xlsx'
OUT = 'public/2026_cash.json'
SKIP = {'القواعد العامة'}
AR = re.compile(r'[\u0600-\u06FF]')

def num(v):
    if isinstance(v, bool): return None
    if isinstance(v, (int, float)): return v
    if isinstance(v, str):
        s = v.replace(',', '').replace('EGP', '').strip()
        if re.fullmatch(r'\d+(\.\d+)?', s): return float(s)
    return None

def clean(s):
    return re.sub(r'\s+', ' ', str(s).replace('\xa0', ' ')).strip() if s is not None else ''

wb = openpyxl.load_workbook(SRC, data_only=True)
out, stats = [], {}
for ws in wb:
    title = ws.title.strip()
    if title in SKIP: continue
    en = ar = pr = None
    n = 0
    for row in ws.iter_rows(values_only=True):
        cells = [clean(v) for v in row]
        low = [c.lower() for c in cells]
        pcols = [i for i, c in enumerate(low) if c and 'price' in c and len(c) < 25]
        if pcols and not any(num(v) is not None for v in row):
            pr = pcols[0]; en = ar = None
            for i, c in enumerate(low):
                if i == pr: continue
                if 'arabic' in c: ar = i
                elif ('english' in c or 'service name' in c) and en is None: en = i
            continue
        if pr is None or en is None: continue
        p = num(row[pr]) if pr < len(row) else None
        name_en = cells[en] if en < len(cells) else ''
        name_ar = cells[ar] if ar is not None and ar < len(cells) else ''
        if p is None or p <= 0 or not (name_en or name_ar): continue
        if name_en and AR.search(name_en) and not name_ar: name_ar, name_en = name_en, ''
        out.append({'nameEnglish': name_en, 'nameArabic': name_ar,
                    'price': str(int(p)) if float(p).is_integer() else str(p),
                    'sectionName': title, 'sourceFile': 'Elite Hospital 2026'})
        n += 1
    stats[title] = n
# --- IPD accommodation table: "ar / en" label, last numeric column = total
ws = wb['IPD Services']
for row in ws.iter_rows(min_row=5, max_row=24, values_only=True):
    label = clean(row[0]); nums = [num(v) for v in row[1:6] if num(v) is not None]
    if not label or not nums: continue
    total = int(nums[3] if len(nums) >= 4 else nums[-1])
    parts = [x.strip() for x in label.split('/')]
    a = next((x for x in parts if AR.search(x)), ''); e = next((x for x in parts if not AR.search(x)), '')
    out.append({'nameEnglish': e, 'nameArabic': a, 'price': str(total), 'sectionName': 'IPD Services', 'sourceFile': 'Elite Hospital 2026'})
# --- Package sheets (Stroke unit / Cathlab unit / Open heart)
def split_mixed(text):
    t = clean(text)
    ar = ' '.join(re.findall(r'[\u0600-\u06FF][\u0600-\u06FF ,\u060C\-+]*', t)).strip()
    en = re.sub(r'[\u0600-\u06FF][\u0600-\u06FF ,\u060C\-+]*', ' ', t)
    en = clean(en.replace('(', ' ( ').replace(')', ' ) ')).replace('( ', '(').replace(' )', ')')
    en = en.strip(' ()') if en.count('(') != en.count(')') else en
    en = re.sub(r'\(\s*\)', '', en).strip(); en = re.sub(r'\(3\)$', '', en).strip() if en.endswith('Stents) (3)') else en
    if en.count('(') > en.count(')'): en += ')'
    return clean(en), ar
for t in ['Stroke unit', 'Cathlab unit', 'Open heart']:
    title = None; cnt = 0
    for row in wb[t].iter_rows(values_only=True):
        c = [clean(v) for v in row if v is not None and clean(v)]
        if not c: continue
        m = re.fullmatch(r'(\d+)\s*EGP', c[0])
        if m:
            name = c[1] if len(c) > 1 else title
            if not name: continue
            e, a = split_mixed(name)
            out.append({'nameEnglish': e, 'nameArabic': a, 'price': m.group(1), 'sectionName': t, 'sourceFile': 'Elite Hospital 2026'}); cnt += 1
        elif len(c) == 1 and AR.search(c[0]) and re.search(r'[A-Za-z]', c[0]) and not c[0].startswith('Package'):
            title = c[0]
    stats[t] = cnt
json.dump(out, open(OUT, 'w'), ensure_ascii=False)
print(len(out)); print(stats)
