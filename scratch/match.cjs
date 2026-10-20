const X=require('xlsx'),fs=require('fs');
const cs=require('../data/contractors.json');
const rows=X.utils.sheet_to_json(X.readFile('contacts_table.xlsx').Sheets.Contacts,{header:1});
const hdr=rows[0].slice(1);
const OFF={'زياد':'زياد','نادين':'نادين','ابو الوفا':'محمد ابو الوفا','ديانا':'ديانا','جابر':'محمد جابر','حمزة':'أحمد حمزة','طارق':'طارق'};
const STOP=new Set(['شركه','شركة','فحص','كاش','cash','co','company','للبترول','ال','مجموعه','group','egypt','للتامين','للتأمين','للتامينات']);
const norm=s=>String(s).toLowerCase().replace(/[\u064B-\u0652]/g,'').replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/[ىئ]/g,'ي').replace(/ؤ/g,'و').replace(/[^\u0600-\u06FFa-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const toks=s=>norm(s).split(' ').map(t=>t.replace(/^ال(?=.{3})/,'')).filter(t=>t&&!STOP.has(t));
const forms=c=>[c.name,...c.aliases].map(a=>({raw:a,t:toks(a),n:toks(a).join('')}));
function score(a,b){ // a,b token arrays
  if(!a.length||!b.length)return 0;
  const A=new Set(a),B=new Set(b);let i=0;for(const t of A)if(B.has(t)||[...B].some(u=>u.length>3&&t.length>3&&(u.startsWith(t)||t.startsWith(u))))i++;
  return i/Math.min(A.size,B.size)*(i/Math.max(A.size,B.size)>=0.5?1:0.7);
}
const out=[];
for(let col=0;col<hdr.length;col++){const off=OFF[hdr[col]];
 for(let r=1;r<rows.length-1;r++){const cell=rows[r][col+1];if(!cell)continue;
  const ct=toks(cell);let best=null,bs=0;
  cs.forEach((c,idx)=>{for(const f of forms(c)){let s=score(ct,f.t);if(f.n&&f.n===ct.join(''))s=1.5;if(s>bs){bs=s;best=idx}}});
  out.push({off,cell,best,bs,match:best!=null?cs[best].name+' ('+cs[best].contractorOfficer+')':null});
 }}
fs.writeFileSync('scratch/match.json',JSON.stringify(out,null,1));
for(const o of out)console.log(o.bs.toFixed(2),o.off,'|',o.cell,'=>',o.bs>=0.99?o.match:'?? '+o.match);
