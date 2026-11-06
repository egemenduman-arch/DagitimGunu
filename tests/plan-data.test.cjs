const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const P=require('../plan-data.js'),base=path.join(__dirname,'../data'),manifest=JSON.parse(fs.readFileSync(base+'/dagitim.json'));
const load=()=>P.loader(manifest,async file=>JSON.parse(fs.readFileSync(path.join(base,file),'utf8')));
test('Excel’den gelen bütün iller ve 59.621 kayıt eksiksiz, günler 7 bit',()=>{
 assert.equal(manifest.provinces.length,81);let count=0;
 for(const p of manifest.provinces){const d=JSON.parse(fs.readFileSync(base+'/'+p.file));assert.equal(P.validate(d).rows.length,p.count);assert.ok(d.rows.every(r=>r[0]===p.il));count+=d.rows.length}
 assert.equal(count,59621);assert.equal(manifest.count,count);
});
test('il listesi hiçbir il dosyasını indirmez; seçim yalnızca kendi ilini yükler',async()=>{
 const calls=[];const p=P.loader(manifest,async f=>{calls.push(f);return JSON.parse(fs.readFileSync(base+'/'+f))});
 assert.equal((await p.query('/api/iller')).rows.length,81);assert.equal(calls.length,0);
 assert.ok((await p.query('/api/ilceler?il=Bartın')).rows.includes('Amasra'));assert.equal(calls.length,1);
 const m=await p.query('/api/mahalleler?il=Bartın&ilce=Amasra');assert.ok(m.rows.includes('Çakrazşeyhler Köyü'));assert.equal(calls.length,1);
 const r=await p.query('/api/mahalle?il=Bartın&ilce=Amasra&mahalle=Çakrazşeyhler Köyü');assert.equal(r.row.mahalle,'Çakrazşeyhler Köyü');
});
test('Türkçe arama, uzun adres ve belirsiz mahalleler korunur',async()=>{
 const p=load();let r=await p.query('/api/ara?q='+encodeURIComponent('Bostancı İstanbul'));assert.ok(r.rows.some(r=>r.ilce==='Kadıköy'));
 r=await p.query('/api/ara?q='+encodeURIComponent('Bostancı Mah. Bağdat Cad. No:12 Kadıköy İstanbul'));assert.ok(r.rows.some(r=>r.mahalle==='Bostancı Mh.'));
 r=await p.query('/api/ara?q=Yildirim');assert.ok(r.rows.length>1);
 assert.equal((await p.query('/api/ara?q=zzxyzxxyyzz')).rows.length,0);
});
test('tekrarlarda dosyadaki son satır kuralı ve üç çelişki korunur',async()=>{
 const p=load();for(const [il,ic,m,days] of [['Antalya','Alanya','Büyükhasbahçe Mh.',[1,1,1,1,1,1,0]],['Antalya','Alanya','Çakallar Mh.',[1,0,0,0,0,0,0]],['İstanbul','Arnavutköy','Mustafa Kemal Paşa Mh.',[1,1,1,1,1,0,0]]]){
 const {row}=await p.query('/api/mahalle?'+new URLSearchParams({il,ilce:ic,mahalle:m}));assert.deepEqual(['pazartesi','sali','carsamba','persembe','cuma','cumartesi','pazar'].map(k=>row[k]),days)}
});
test('bozuk/eksik dosya adres bulunamadı sonucuna çevrilmez',async()=>{
 const p=P.loader(manifest,async()=>{throw Error('network failed')});await assert.rejects(p.query('/api/ilceler?il=İstanbul'),/kullanılamıyor/);
 assert.throws(()=>P.validate({schema:1,updated:manifest.updated,rows:[['A','B','C',[1,0,0,null,0,0,0]]]}));
 const mismatched=P.loader(manifest,async()=>({schema:1,updated:'2020-01-01',rows:[['A','B','C',[1,0,0,0,0,0,0]]]}));await assert.rejects(mismatched.query('/api/ilceler?il=İstanbul'));
});
