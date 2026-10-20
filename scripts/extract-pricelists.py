#!/usr/bin/env python3
"""
Unified pricelist extractor: regenerates public/{2023,2024,2025,2026}_cash.json
from the source workbooks in the project root.

Usage:  python3 scripts/extract-pricelists.py [--dry-run]

Cleaning applied to every row:
  * Persian look-alike letters -> Arabic (ی->ي, ک->ك, ھ->ه), Arabic-Indic digits -> ASCII
  * tatweel / diacritics / NBSP / repeated whitespace removed
  * leading "*" / "**" markers (send-out tests) stripped -> `outsourced: true`
  * Arabic text found in the English column (and vice versa) is moved to the right field
  * rows without a positive numeric price are dropped (priced by class / on request)
  * exact duplicates (same names + price + section) are removed
Output shape stays compatible with the app's ProcedureResult, plus optional `code` / `outsourced`.
"""
import json, re, sys, collections, openpyxl

ROOT = __file__.rsplit('/scripts/', 1)[0]
AR = re.compile(r'[\u0600-\u06FF]')
AR_RUN = re.compile(r'[\u0600-\u06FF][\u0600-\u06FF\s,\u060C\-+/()]*')
CHAR_MAP = str.maketrans({'ی': 'ي', 'ى': 'ي', 'ک': 'ك', 'ھ': 'ه', 'ۀ': 'ه', 'ے': 'ي',
                          **{chr(0x0660 + i): str(i) for i in range(10)},
                          **{chr(0x06F0 + i): str(i) for i in range(10)}})
SKIP_SHEETS = {'القواعد العامة', 'Packages'}  # no priced rows / handled separately


def clean(v):
    if v is None: return ''
    s = str(v).replace('\xa0', ' ').translate(CHAR_MAP)
    s = re.sub(r'[\u064B-\u065F\u0670\u0640]', '', s)
    return re.sub(r'\s+', ' ', s).strip()


def num(v):
    if isinstance(v, bool): return None
    if isinstance(v, (int, float)): return float(v)
    if isinstance(v, str):
        s = clean(v).replace(',', '').replace('EGP', '').strip()
        if re.fullmatch(r'\d+(\.\d+)?', s): return float(s)
    return None


def fmt_price(p):
    return str(int(p)) if float(p).is_integer() else str(p)


def make(en, ar, price, section, year, code=None):
    en, ar = clean(en), clean(ar)
    if en and AR.search(en) and not ar: en, ar = '', en
    elif ar and not AR.search(ar) and not en: en, ar = ar, ''
    out = False
    m = re.match(r'^\*+\s*(.*)$', en)
    if m: en, out = m.group(1), True
    en = re.sub(r'\s+([,.)])', r'\1', en)
    en = re.sub(r'([A-Za-z]{2,})- ([a-z]{2,})', r'\1\2', en)  # PDF line-break hyphenation: 'un- der' -> 'under'
    if not (en or ar) or price is None or price <= 0: return None
    row = {'nameEnglish': en, 'nameArabic': ar, 'price': fmt_price(price),
           'sectionName': section, 'sourceFile': f'Elite Hospital {year}'}
    if code and code not in ('#N/A', 'None'): row['code'] = str(code).strip()
    if out: row['outsourced'] = True
    return row


# ---------------------------------------------------------------- multi-sheet workbooks (2023, 2026)
def parse_sheets(path, year):
    wb = openpyxl.load_workbook(path, data_only=True)
    rows, stats = [], {}
    for ws in wb:
        title = ws.title.strip()
        if title in SKIP_SHEETS: continue
        en = ar = pr = code = None
        cnt = 0
        for row in ws.iter_rows(values_only=True):
            cells = [clean(v) for v in row]
            low = [c.lower() for c in cells]
            pcols = [i for i, c in enumerate(low) if c and 'price' in c and len(c) < 25 and 'package' not in c]
            if pcols and not any(num(v) is not None for v in row):
                pr = pcols[0]
                n_en = n_ar = n_code = None
                for i, c in enumerate(low):
                    if i == pr: continue
                    if 'arabic' in c: n_ar = i
                    elif c == 'code': n_code = i
                    elif ('english' in c or 'service name' in c) and n_en is None: n_en = i
                # sub-headers such as "Observation Fees | Price | مرور" don't name columns: inherit the last layout
                if n_en is None:
                    n_en = en if en is not None else next((i for i, c in enumerate(cells) if c and i != pr), None)
                    n_ar = n_ar if n_ar is not None else ar
                    n_code = n_code if n_code is not None else code
                en, ar, code = n_en, n_ar, n_code
                # a sub-header that itself is a data label is not a row; skip it
                continue
            if pr is None or en is None: continue
            p = num(row[pr]) if pr < len(row) else None
            r = make(cells[en] if en < len(cells) else '', cells[ar] if ar is not None and ar < len(cells) else '',
                     p, title, year, cells[code] if code is not None and code < len(cells) else None)
            if r: rows.append(r); cnt += 1
        stats[title] = cnt
    return rows, stats, wb


def split_mixed(text):
    t = clean(text)
    ar = clean(' '.join(m.group(0) for m in AR_RUN.finditer(t)))
    en = clean(AR_RUN.sub(' ', t))
    en = re.sub(r'\(\s*\)', '', en).strip()
    if en.count('(') > en.count(')'): en += ')'
    if en.count(')') > en.count('(') : en = en.replace(')', '', en.count(')') - en.count('('))
    return clean(en), ar


def package_rows(wb, sheets, year):
    """'Package price' blocks: title line (ar+en) ... 'NNN EGP' ; or 'NNN EGP | ar  en' pairs."""
    out = []
    for t in sheets:
        if t not in wb.sheetnames: continue
        title = None
        for row in wb[t].iter_rows(values_only=True):
            c = [clean(v) for v in row if v is not None and clean(v)]
            if not c: continue
            m = re.fullmatch(r'(\d+)\s*EGP', c[0])
            if m:
                name = c[1] if len(c) > 1 else title
                if name:
                    e, a = split_mixed(name)
                    r = make(e, a, float(m.group(1)), t.strip(), year)
                    if r: out.append(r)
            elif len(c) == 1 and AR.search(c[0]) and re.search(r'[A-Za-z]', c[0]) and not c[0].startswith('Package'):
                title = c[0]
    return out


def ipd_accommodation(wb, year):
    out = []
    ws = wb['IPD Services']
    for row in ws.iter_rows(min_row=5, max_row=24, values_only=True):
        label = clean(row[0]); nums = [num(v) for v in row[1:6] if num(v) is not None]
        if not label or not nums: continue
        total = nums[3] if len(nums) >= 4 else nums[-1]
        parts = [x.strip() for x in label.split('/')]
        a = next((x for x in parts if AR.search(x)), ''); e = next((x for x in parts if not AR.search(x)), '')
        r = make(e, a, total, 'IPD Services', year)
        if r: out.append(r)
    return out


# ---------------------------------------------------------------- flat sheets (2024, 2025)
def parse_flat(path, year):
    ws = openpyxl.load_workbook(path, data_only=True).worksheets[0]
    rows, dropped = [], collections.Counter()
    for raw in ws.iter_rows(values_only=True):
        cells = [c for c in raw if c is not None and clean(c) != '']
        if not cells: continue
        if clean(cells[0]).lower() == 'english_name': continue
        # single comma-joined cell e.g. "EN,AR,"
        if len(cells) == 1 and isinstance(cells[0], str) and ',' in cells[0] and AR.search(cells[0]):
            parts = [p for p in cells[0].split(',') if p.strip()]
            en_p = [p for p in parts if not AR.search(p)]; ar_p = [p for p in parts if AR.search(p)]
            dropped['no price (comma-joined)'] += 1; continue
        price = None
        for c in reversed(cells):
            n = num(c)
            if n is not None: price = n; break
        txt = [clean(c) for c in cells if num(c) is None]
        en_parts = [t for t in txt if not AR.search(t)]
        ar_parts = [t for t in txt if AR.search(t)]
        # a text cell that merely holds a number-with-text is treated as name text (comma-split names)
        en = ', '.join(en_parts) if en_parts else ''
        ar = ' - '.join(ar_parts) if ar_parts else ''
        r = make(en, ar, price, 'General', year)
        if r: rows.append(r)
        else: dropped['no/zero price' if (en or ar) else 'blank'] += 1
    return rows, dropped


def dedupe(rows):
    seen, out = set(), []
    for r in rows:
        k = (r['nameEnglish'].lower(), r['nameArabic'], r['price'], r['sectionName'])
        if k in seen: continue
        seen.add(k); out.append(r)
    return out, len(rows) - len(out)


def main():
    dry = '--dry-run' in sys.argv
    report = {}

    # 2023 / 2026 multi-sheet
    for year, fname in (('2023', '2023 Cash.xlsx'), ('2026', '2026 Elite Cash PL 12-1 (1).xlsx')):
        rows, stats, wb = parse_sheets(f'{ROOT}/{fname}', year)
        if year == '2026':
            rows += ipd_accommodation(wb, year)
            rows += package_rows(wb, ['Stroke unit', 'Cathlab unit', 'Open heart'], year)
        else:
            rows += package_rows(wb, ['Cathlab unit '], year)
        rows, dups = dedupe(rows)
        report[year] = (len(rows), dups, None)
        if not dry: json.dump(rows, open(f'{ROOT}/public/{year}_cash.json', 'w'), ensure_ascii=False)

    # 2024 / 2025 flat
    for year, fname in (('2024', '2024 Pricelist extracted.xlsx'), ('2025', '2025 Cash.xlsx')):
        rows, dropped = parse_flat(f'{ROOT}/{fname}', year)
        if year == '2025':  # keep manually-added rows (non-default sections) from the current JSON
            try:
                old = json.load(open(f'{ROOT}/public/2025_cash.json'))
                rows += [o for o in old if o.get('sectionName') not in ('Sheet1', 'General')]
            except Exception: pass
        rows, dups = dedupe(rows)
        report[year] = (len(rows), dups, dict(dropped))
        if not dry: json.dump(rows, open(f'{ROOT}/public/{year}_cash.json', 'w'), ensure_ascii=False)

    for y, (n, d, dr) in report.items():
        print(f'{y}: {n} rows, {d} duplicates removed' + (f', dropped {dr}' if dr else ''))


if __name__ == '__main__':
    main()
