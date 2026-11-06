/* Ziyaret planı: aynı sitedeki onaylı JSON dosyasından okunur; D1 kullanılmaz. */
(function(root){
'use strict';
const DAYS=['pazartesi','sali','carsamba','persembe','cuma','cumartesi','pazar'];
const unavailable=()=>new Error('Kayıtlı bölge listesi şu anda kullanılamıyor. Tam adresle canlı sorgu yapabilirsiniz.');
const key=v=>String(v??'').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i').replace(/ş/g,'s').replace(/ğ/g,'g').replace(/ü/g,'u').replace(/ö/g,'o').replace(/ç/g,'c').replace(/\b(mahallesi|mahalle|mah|mh|koyu)\b\.?/g,' ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
function validate(data){
 if(!data||data.schema!==1||!Array.isArray(data.rows)||!data.rows.length||data.rows.length>150000||typeof data.updated!=='string'||!Number.isFinite(Date.parse(data.updated)))throw unavailable();
 const unique=new Map();
 for(const r of data.rows){
  if(!Array.isArray(r)||r.length!==4||r.slice(0,3).some((v,i)=>typeof v!=='string'||!v.trim()||v.length>(i===2?160:80))||!Array.isArray(r[3])||r[3].length!==7||r[3].some(v=>v!==0&&v!==1))throw unavailable();
  const clean=[...r.slice(0,3).map(v=>v.trim()),[...r[3]]];
  unique.set(JSON.stringify(clean.slice(0,3)),clean);
 }
 return {schema:1,updated:data.updated,rows:[...unique.values()]};
}
function create(data){
 const snapshot=validate(data),rows=snapshot.rows.map(r=>({il:r[0],ilce:r[1],mahalle:r[2],...Object.fromEntries(DAYS.map((d,i)=>[d,r[3][i]]))}));
 const indexed=rows.map(row=>({row,search:key([row.il,row.ilce,row.mahalle].join(' ')),il:key(row.il),ilce:key(row.ilce),mahalle:key(row.mahalle)}));
 const distinct=(rs,k)=>[...new Set(rs.map(r=>r[k]))].sort((a,b)=>a.localeCompare(b,'tr'));
 function query(path){
  const u=new URL(path,'https://plan.local'),p=u.searchParams,il=p.get('il'),ic=p.get('ilce');
  if(u.pathname==='/api/iller')return {rows:distinct(rows,'il')};
  const area=rows.filter(r=>(!il||r.il===il)&&(!ic||r.ilce===ic));
  if(u.pathname==='/api/ilceler')return {rows:distinct(area,'ilce')};
  if(u.pathname==='/api/mahalleler')return {rows:distinct(area,'mahalle')};
  if(u.pathname==='/api/mahalle')return {row:area.find(r=>r.mahalle===p.get('mahalle'))||null};
  if(u.pathname==='/api/ara'){
   const q=key(p.get('q')),tokens=q.split(' ').filter(Boolean);if(q.length<3)return {rows:[]};
   const direct=indexed.filter(r=>tokens.every(t=>r.search.includes(t)));
   if(direct.length)return {rows:direct.slice(0,30).map(r=>r.row)};
   // Uzun adreslerde bina/sokak kelimelerini mahalleye zorla eşleştirme.
   const text=' '+q+' ',has=k=>k&&text.includes(' '+k+' ');
   let areas=indexed.filter(r=>has(r.ilce));const province=areas.filter(r=>has(r.il));if(province.length)areas=province;
   if(!areas.length){const provinces=new Set(indexed.filter(r=>has(r.il)).map(r=>r.il));if(provinces.size===1)areas=indexed.filter(r=>provinces.has(r.il))}
   return {rows:areas.filter(r=>r.mahalle.length>=3&&has(r.mahalle)).sort((a,b)=>b.mahalle.length-a.mahalle.length).slice(0,10).map(r=>r.row)};
  }
  throw new Error('Desteklenmeyen plan sorgusu');
 }
 return {query,snapshot};
}
const api={validate,create,key,unavailable};
if(typeof module==='object'&&module.exports)module.exports=api;else root.PlanData=api;
})(globalThis);

/* Manifest küçük tutulur; listeden seçimde yalnızca ilgili ilin verisi indirilir. */
(function(api){
api.loader=function(manifest,fetchPart){
 if(!manifest||manifest.schema!==1||!Array.isArray(manifest.provinces)||!manifest.provinces.length||!Number.isFinite(Date.parse(manifest.updated))||manifest.provinces.some(p=>typeof p.il!=='string'||!p.il.trim()||!/^plan-\d{2,3}\.json$/.test(p.file)||!Number.isInteger(p.count)||p.count<1)||new Set(manifest.provinces.map(p=>p.il)).size!==manifest.provinces.length)throw api.unavailable();
 const cache=new Map();
 const get=p=>{if(!cache.has(p.file))cache.set(p.file,fetchPart(p.file).then(data=>{const plan=api.create(data);if(plan.snapshot.updated!==manifest.updated||plan.snapshot.rows.length!==p.count||plan.snapshot.rows.some(r=>r[0]!==p.il))throw api.unavailable();return plan}).catch(()=>{cache.delete(p.file);throw api.unavailable()}));return cache.get(p.file)};
 return {snapshot:manifest,query:async function(path){
  const u=new URL(path,'https://plan.local');
  if(u.pathname==='/api/iller')return {rows:manifest.provinces.map(p=>p.il).sort((a,b)=>a.localeCompare(b,'tr'))};
  const il=u.searchParams.get('il');
  if(il){const p=manifest.provinces.find(p=>p.il===il);return p?(await get(p)).query(path):{rows:[]};}
  if(u.pathname!=='/api/ara')throw api.unavailable();
  if(api.key(u.searchParams.get('q')).length<3)return {rows:[]};
  const text=' '+api.key(u.searchParams.get('q'))+' ';
  const exact=manifest.provinces.filter(p=>text.includes(' '+api.key(p.il)+' '));
  const parts=exact.length?exact:manifest.provinces,results=[];
  // İlk öneri aramasında paralellik sınırlandırılır; sonraki sorgular belleği kullanır.
  let next=0;await Promise.all(Array.from({length:Math.min(6,parts.length)},async()=>{while(next<parts.length){const p=parts[next++];results.push(...(await get(p)).query(path).rows)}}));
  results.sort((a,b)=>a.il.localeCompare(b.il,'tr')||a.ilce.localeCompare(b.ilce,'tr')||a.mahalle.localeCompare(b.mahalle,'tr'));
  return {rows:results.slice(0,30)};
 }};
};
})(typeof module==='object'&&module.exports?module.exports:globalThis.PlanData);
