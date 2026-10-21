import json,re,collections,difflib
P='public/'
Y=[2023,2024,2025,2026]
data={y:json.load(open(f'{P}{y}_cash.json')) for y in Y}
UNI={'Laboratory':'Laboratory','Radiology':'Radiology','Procedures':'Procedures','Dental':'Dental & Derma','Derma & Cosmo':'Dental & Derma','Dental & Derma':'Dental & Derma',
'INP':'Inpatient Services','IPD Services':'Inpatient Services','ICU':'Inpatient Services','Devices':'Medical Devices','Medical devices':'Medical Devices','Physiotherapy':'Physiotherapy',
'Orthopedics':'Orthopedics','Intervention radiology':'Intervention Radiology','Endoscopy':'Endoscopy & GIT','Endoscopy & GIT':'Endoscopy & GIT','HC':'Home Care','Examination':'Examination',
'Examination services':'Examination','Chemotherapy':'Chemotherapy','Cathlab unit':'Cathlab','Ambulance':'Ambulance','Dialysis unit':'Dialysis','Open heart':'Open Heart','Stroke unit':'Stroke Unit',
'Non-Invasive Diagnostic Cardiology Unit':'Cardiology (Non-invasive)'}
def norm(s):
    s=s.lower(); s=re.sub(r'anaesth','anesth',s); s=re.sub(r'[^a-z0-9 ]',' ',s); return ' '.join(s.split())
# reference: categorized items from 2023 + 2026 (and 2025 non-General)
ref={}
for y in (2023,2026):
    for x in data[y]:
        ref.setdefault(norm(x['nameEnglish']),collections.Counter())[UNI[x['sectionName']]]+=1
refkeys=list(ref)
RULES=[ # (category, regex) ordered
('Laboratory',r'\big[eg]\b|allergy|food (intolerance|print)|\bpcr\b|blood (bag|filt)|in urine|skin biopsy'),
('Procedures',r'operating room|surgery medical team|over ?wight|golden program|extra half hour|consultant doctor'),
('Dental & Derma',r'dental|tooth|teeth|molar|gingiv|scaling|root canal|crown|denture|orthodont|braces|veneer|implant fixture|filling|extraction|pulp|laser hair|botox|filler|derma|acne|peel|wart|mole removal|cosmetic|hair removal|prp|mesotherapy|microneedling|skin tag'),
('Dialysis',r'dialysis|hemodialysis|haemodialysis|\bhd\b|crrt'),
('Chemotherapy',r'chemo|oncolog|cytotoxic'),
('Cathlab',r'cath ?lab|angiograph|coronary|stent|pacemaker|\bptca\b|angioplasty|\bicd\b|electrophysiolog'),
('Cardiology (Non-invasive)',r'\becg\b|ekg|echocardio|\becho\b|stress test|holter|treadmill|ambulatory blood'),
('Ambulance',r'ambulance'),
('Home Care',r'home (care|visit|nursing|service)|\bhc\b'),
('Physiotherapy',r'physio|rehabilitat|ultrasound therapy|tens\b|traction|exercise therapy|electrotherapy|shock ?wave'),
('Endoscopy & GIT',r'endoscop|gastroscop|colonoscop|sigmoidoscop|ercp|capsule|bronchoscop|cystoscop|fibroscan|polypectomy|\bgit\b|manometry|ph monitoring'),
('Intervention Radiology',r'embolization|embolisation|\btace\b|biopsy under (ct|us|ultrasound)|ablation|drainage under (ct|us)|radiofrequency|percutaneous|nephrostomy|\bpicc\b|\bivc filter'),
('Radiology',r'x-?ray|\bct\b|\bmri\b|mammogra|ultrasound|\bu/?s\b|doppler|sonar|radiograph|\bdexa\b|bone density|fluoroscop|\bpet\b|scan\b|\bcxr\b|barium|hsg|hysterosalping|angio ct|\bmra\b|panoramic'),
('Examination',r'\bexamination\b|consultation|\bvisit\b|clinic fee|second opinion|assessment'),
('Medical Devices',r'device|brace|splint|collar|crutch|walker|wheelchair|cpap|bipap|oxygen concentrator|nebulizer|mask|pump|monitor rental|rental|\bcast\b|support\b|belt|corset|stocking|insole|prosthes'),
('Inpatient Services',r'room|bed\b|\bicu\b|\bnicu\b|\bpicu\b|\bccu\b|admission|inpatient|ward|suite|nursing care|per day|ventilator|incubator|isolation|accommodation|stay'),
('Open Heart',r'open heart|cabg|bypass|valve replacement|cardiac surgery'),
('Stroke Unit',r'stroke|thrombolysis'),
('Orthopedics',r'fracture|orthop|arthroscop|knee replacement|hip replacement|ligament|meniscus|acl\b|spine fusion|osteotomy|\bpop\b|reduction of (dislocation|fracture)'),
('Laboratory',r'\bblood\b|serum|urine|stool|culture|\bcbc\b|hormone|antibod|antigen|\bigg\b|\bigm\b|\bpcr\b|panel|level\b|profile|test\b|\bhba1c|glucose|cholesterol|creatinine|\btsh\b|vitamin|biopsy|histopath|cytolog|smear|swab|electrolyte|enzyme|marker|\bana\b|\banti\b|hepatitis|\bhiv\b|toxicolog|genetic|karyotype|\bhla\b|culture|sensitivity|bilirubin|protein|albumin|\bcrp\b|\besr\b|ferritin|cortisol|insulin|hemoglobin|platelet|coagulation|\bpt\b|\binr\b|\bptt\b'),
('Procedures',r'.'),
]
RX=[(c,re.compile(r,re.I)) for c,r in RULES]
def classify(name):
    n=norm(name)
    if n in ref: return ref[n].most_common(1)[0][0],'exact'
    m=difflib.get_close_matches(n,refkeys,n=1,cutoff=0.88)
    if m: return ref[m[0]].most_common(1)[0][0],'fuzzy'
    for c,r in RX:
        if r.search(name): return c,'keyword'

import pandas as pd
rows=[]
for y in Y:
    for x in data[y]:
        orig=x['sectionName']; 
        if y in (2023,2026) or orig in UNI and orig!='General':
            cat,src=UNI[orig],'original'
        else:
            cat,src=classify(x['nameEnglish'])
        try: pr=float(str(x['price']).replace(',',''))
        except: pr=None
        rows.append(dict(year=y,name=x['nameEnglish'],arabic=x.get('nameArabic',''),price=pr,original_section=orig,category=cat,cat_source=src,key=norm(x['nameEnglish'])))
df=pd.DataFrame(rows)
df.to_csv('scratch/all_categorized.csv',index=False)
print(df.groupby(['year','cat_source']).size().unstack(fill_value=0))
print(df.pivot_table(index='category',columns='year',values='name',aggfunc='count',fill_value=0))
# comparison
pv=df.drop_duplicates(['key','year']).pivot(index='key',columns='year',values='price')
names=df.drop_duplicates('key').set_index('key')['name']
cats=df.sort_values('year',ascending=False).drop_duplicates('key').set_index('key')['category']
cmp=pv.copy(); cmp.insert(0,'category',cats); cmp.insert(0,'name',names)
cmp['years_present']=pv.notna().sum(axis=1)
cmp=cmp.sort_values(['category','name'])
print('presence',cmp.years_present.value_counts().to_dict())
with pd.ExcelWriter('Pricelist_Comparison_Categorized.xlsx') as w:
    cmp.reset_index(drop=True).to_excel(w,sheet_name='Comparison',index=False)
    df.drop(columns='key').to_excel(w,sheet_name='All items categorized',index=False)
    df[(df.year.isin([2024,2025]))].drop(columns='key').to_excel(w,sheet_name='Newly categorized 24-25',index=False)
    df.pivot_table(index='category',columns='year',values='name',aggfunc='count',fill_value=0).to_excel(w,sheet_name='Category counts')
