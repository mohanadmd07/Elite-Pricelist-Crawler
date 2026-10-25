import re
import openpyxl
from collections import defaultdict
from scripts.generate_catalog_aliases import clean_arabic, normalize_homoglyphs, is_batch_5

print("Testing batch partitioning of all 7,166 rows...")

wb = openpyxl.load_workbook('Pricelist_Comparison_Categorized.xlsx', read_only=True)
ws = wb['All items categorized']
rows = list(ws.iter_rows(values_only=True))[1:]

BATCH_1_CATS = {
    'Inpatient Services', 'Intervention Radiology', 'Endoscopy & GIT',
    'Cathlab', 'Ambulance', 'Stroke Unit', 'Cardiology (Non-invasive)', 'Open Heart'
}
BATCH_2_CATS = {'Radiology'}
BATCH_3_CATS = {'Procedures', 'Orthopedics'}
BATCH_6_CATS = {'Medical Devices', 'Chemotherapy', 'Dialysis'}
BATCH_7_CATS = {'Dental & Derma', 'Physiotherapy', 'Home Care', 'Examination'}

counts = defaultdict(int)
for r in rows:
    cat = r[5]
    en = str(r[1] or '').strip()
    ar = str(r[2] or '').strip()

    if cat in BATCH_1_CATS:
        counts['Batch 1'] += 1
    elif cat in BATCH_2_CATS:
        counts['Batch 2'] += 1
    elif cat in BATCH_3_CATS:
        counts['Batch 3'] += 1
    elif cat == 'Laboratory':
        if not is_batch_5(en, ar):
            counts['Batch 4'] += 1
        else:
            counts['Batch 5'] += 1
    elif cat in BATCH_6_CATS:
        counts['Batch 6'] += 1
    elif cat in BATCH_7_CATS:
        counts['Batch 7'] += 1
    else:
        counts['Unclassified'] += 1

total = sum(counts.values())
print("Batch Partition Summary:")
for b in sorted(counts.keys()):
    print(f"  {b:15}: {counts[b]}")
print(f"Total classified: {total} / {len(rows)}")
assert counts['Unclassified'] == 0, "Error: Unclassified items found!"
assert total == 7166, f"Error: Total is {total}, expected 7166!"
print("✓ Perfect 100.0% partition: Exactly 7,166 / 7,166 rows classified!")
