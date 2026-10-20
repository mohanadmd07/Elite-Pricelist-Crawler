const X=require('xlsx');const wb=X.readFile('contacts_table.xlsx');
for(const n of wb.SheetNames){const r=X.utils.sheet_to_json(wb.Sheets[n],{header:1});console.log(n,r.length);console.log(JSON.stringify(r.slice(0,15)));}
