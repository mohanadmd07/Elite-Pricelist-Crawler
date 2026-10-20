const X=require('xlsx'),fs=require('fs');
let cs=require('../data/contractors.json');
const rows=X.utils.sheet_to_json(X.readFile('contacts_table.xlsx').Sheets.Contacts,{header:1});
const OFF={'زياد':'زياد','نادين':'نادين','ابو الوفا':'محمد ابو الوفا','ديانا':'ديانا','جابر':'محمد جابر','حمزة':'أحمد حمزة','طارق':'طارق'};
const nz=s=>String(s).replace(/[\u064B-\u065F\u200e\u200f\u00a0]/g,'').replace(/\s+/g,'').replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/[ىئ]/g,'ي');
const by=n=>{const r=cs.find(c=>c.name===n)||cs.find(c=>nz(c.name)===nz(n));if(!r)throw new Error('missing '+n);return r};
const log=[];
const uniq=a=>[...new Set(a.map(s=>s.trim()).filter(Boolean))];
// 1. merge duplicates (survivor <- others)
function merge(surv,others,dropAliases=[]){const s=by(surv);
 for(const o of others){let r;try{r=by(o)}catch(e){log.push('skip (already merged) '+o);continue}s.aliases=uniq([...s.aliases,...r.aliases]);cs=cs.filter(c=>c!==r);log.push(`MERGE "${o}" -> "${surv}"`);}
 s.aliases=s.aliases.filter(a=>!dropAliases.includes(a));}
merge('بترول ابو قير',['بترول ابوقير'],['ابوقير للأسمدة']);
merge('ايثدكو',['(Ethydco) اثيدكو.']);
merge('ميد نت',['ميدنت'],['Med Right ميد رايت']);
by('ميدرايت').aliases=uniq([...by('ميدرايت').aliases,'Med Right','Med Right ميد رايت']);
merge('حديد عز ( مصانع حديد عز الصناعيه )',['عز للحديد والصلب']);
{const s=by('حديد عز ( مصانع حديد عز الصناعيه )');const old=by('حديد عز ( مصانع حديد عز الصناعيه )');
 // inherit discount/year from seed record that was merged (عز للحديد والصلب 35%, 2023)
 s.discountPercentage=35;s.priceListYear='2023';s.name='حديد عز';s.id='حديد_عز';s.aliases=uniq(['حديد عز','عز للحديد والصلب',...s.aliases]);s.updatedBy='contacts_table_sync';}
{const nc=cs.find(c=>c.name==='Next Care نكست كير'||c.name==='نيكست كير');nc.aliases=uniq([...nc.aliases,'نيكست كير','نكست كير','Next Care نكست كير','Next Care']);nc.name='Next Care نكست كير';}
{const s=by('( Smouha Club 106 ) خصم نادي سموحة كاش');s.aliases=uniq(['نادي سموحة',...s.aliases]);s.name='نادي سموحة';s.id='نادي_سموحة';}
{const s=by('نقابة اطباء Cash');s.aliases=uniq(['نقابة اطباء',...s.aliases]);s.name='نقابة اطباء';s.id='نقابة_اطباء';}
{const s=by('صاان مصر');s.aliases=uniq(['صان مصر','مصر للصيانة','EMC',...s.aliases]);s.name='صان مصر';s.id='صان_مصر';}
{const s=by('تكنولوجيا الاخشاب');s.aliases=uniq([...s.aliases,'Wotech']);}
// 2. excel cell -> existing record name (explicit) ; NEW otherwise
const MAP={ 'الشركة العامة للبترول':'العامة للبترول','Petromaint':'بترومنت','شركة بترول الصحراء الغربيه (wepco)':'ويبكو','نادي سموحة':'نادي سموحة','فاركو':'فاركو للادوية',
'الشركة المصرية لانتاج البروبلين والبولى':'المصرية لانتاج البروبلين','Med Right':'ميدرايت','Ethydco':'ايثدكو','Wotech':'تكنولوجيا الاخشاب',
'شركة الحمرا اويل':'الحمراويل','(عجيبة للبترول) Agiba':'عجيبة للبترول','اليكو':'ميتلايف اليكو','Sumed':'سوميد','مجموعة منصور Mansour Group':'منصور جروب',
'البنك المركزي المصري':'البنك المركزى','شركة السويس للزيت سوكو':'سوكو','Bapetco - Badr El Din للبترول':'بدر الدين للبترول','وزارة العدل':'وزراة العدل',
'حديد عز':'حديد عز','EPROM':'ايبروم','يونايتد':'يونايد','شركة (بترول خليج السويس (جابكو GUPCO':'جابكو','نكست كير Next Care':'Next Care نكست كير',
'AMOC':'اموك','شركة وادى النيل للتأمين wadi el nile':'وادى النيل','هيئة قناة السويس':'هيئة قناة السويس','شركة اسبك (asppc)':'اسبك',
'البتروكيماويات':'البتروكيماويات المصرية','شركة اكسا (AXA)':'اكسا','مصر للصيانة (صان مصر) EMC':'صان مصر','هيئة الرقابة الاداريه':'هيئة الرقابة الادارية',
'فحص QNB':'QNB','ابوقير للأسمدة':'ابو قير للاسمدة','بترول ابوقير':'بترول ابو قير','GIG Egypt':'GIG','شركة الماسية للخدمات الطبية (D M S)':'الماسية DMS',
'شركة جابكو':'جابكو','شركة اسكندرية للبترول':'اسكندرية للبترول','نقابة اطباء':'نقابة اطباء','المشرق Mashreq':null,'شركة ليمتلس كير':null};
const STOP=new Set(['شركه','فحص','كاش','co','company','مجموعه','group','egypt','للتامين','للتامينات','للبترول']);
const norm=s=>String(s).toLowerCase().replace(/[\u064B-\u065F]/g,'').replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/[ىئ]/g,'ي').replace(/[^\u0600-\u06FFa-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const key=s=>norm(s).split(' ').filter(t=>t&&!STOP.has(t)).map(t=>t.replace(/^ال(?=.{3})/,'')).join('');
const stats={upd:0,same:0,add:0};const seen=new Map();const conflicts=[];
const NEWNAMES={'شركة سوليتك':'سوليتك','شركة حياة كارد':'حياة كارد','شركة بيريللي فحص بريميثيون (Pirelli)':'بيريللي (Pirelli)','شركة اسمنت العامرية فحص':'اسمنت العامرية',
'النقابة العامة للبترول':'النقابة العامة للبترول','المشرق Mashreq':'المشرق Mashreq','شركة ليمتلس كير':'ليمتلس كير','شركة اون لاين ( اكسكلوسيف )':'اون لاين (اكسكلوسيف)',
'فحص ELNG':'ELNG','فحص شركة ثروة للتأمينات الحياة':'ثروة للتأمينات الحياة','شركة اكسا (AXA)':null,'مصلحة الضرائب':'مصلحة الضرائب','Ma3ak App':'Ma3ak App'};
for(let col=1;col<rows[0].length;col++){const off=OFF[rows[0][col]];
 for(let r=1;r<rows.length-1;r++){const cell=rows[r][col];if(!cell)continue;
  let rec=null;
  if(MAP[cell]) rec=by(MAP[cell]);
  else if(!(cell in NEWNAMES)){rec=cs.find(c=>[c.name,...c.aliases].some(a=>key(a)===key(cell)))||null;}
  if(!rec&&!MAP[cell]){ // try exact key match against all (incl. new ones already added)
    rec=cs.find(c=>[c.name,...c.aliases].some(a=>key(a)===key(cell)))||null;}
  if(rec){ if(seen.has(rec)&&seen.get(rec)!==off)conflicts.push(`${rec.name}: ${seen.get(rec)} vs ${off}`);
    seen.set(rec,off);
    if(rec.contractorOfficer!==off){log.push(`OFFICER ${rec.name}: ${rec.contractorOfficer} -> ${off}`);rec.contractorOfficer=off;rec.updatedBy='contacts_table_sync';stats.upd++;}else stats.same++;
    rec.aliases=uniq([...rec.aliases,cell]);
  } else { const name=NEWNAMES[cell]||String(cell).trim();
    const n={id:name.replace(/[^\u0600-\u06FFA-Za-z0-9]+/g,'_'),name,aliases:uniq([name,cell]),priceListYear:'2025',contractorOfficer:off,discountPercentage:0,updatedAt:{_methodName:'serverTimestamp'},updatedBy:'contacts_table_sync'};
    cs.push(n);seen.set(n,off);stats.add++;log.push(`ADD ${name} -> ${off}`);}
 }}
// 3. officer phone numbers not stored in schema -> ignore
fs.writeFileSync('data/contractors.json',JSON.stringify(cs,null,2)+'\n');
console.log(log.join('\n'));console.log(stats,'total',cs.length);console.log('CONFLICTS',conflicts);
// final dup check
const ks={};cs.forEach(c=>[c.name,...c.aliases].forEach(a=>{const k=key(a);if(k){(ks[k]=ks[k]||new Set()).add(c.name)}}));
console.log('DUP KEYS',Object.entries(ks).filter(([k,v])=>v.size>1).map(([k,v])=>[...v].join(' | ')));
const ids={};cs.forEach(c=>ids[c.id]=(ids[c.id]||0)+1);console.log('DUP IDS',Object.entries(ids).filter(([k,v])=>v>1));
