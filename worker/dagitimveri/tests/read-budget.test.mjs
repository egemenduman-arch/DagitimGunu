import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';

const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8')
 .replace('export default {','globalThis.worker = {')
 .replace('export { extractDays, trKey, timingSafeEqual };','')
 +'\nglobalThis.inspectPlan={clearPlanReads,planState};';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(`CREATE TABLE dagitim(id INTEGER PRIMARY KEY,il TEXT,ilce TEXT,mahalle TEXT,pazartesi INTEGER,sali INTEGER,carsamba INTEGER,persembe INTEGER,cuma INTEGER,cumartesi INTEGER,pazar INTEGER,arama TEXT);
 CREATE TABLE oneriler(id INTEGER PRIMARY KEY);
 CREATE TABLE veri_bilgisi(id INTEGER PRIMARY KEY,guncelleme_tarihi TEXT,kayit_sayisi INTEGER);
 INSERT INTO dagitim VALUES(1,'İstanbul','Kadıköy','Bostancı',1,0,1,0,1,0,0,'istanbul kadikoy bostanci');
 INSERT INTO dagitim VALUES(2,'Ankara','Çankaya','Merkez',0,1,0,1,0,0,0,'ankara cankaya merkez');`);
 const stats={reads:0,queries:[]};let now=0,fail=false;
 const db={prepare(query){let args=[];return{bind(...values){args=values;return this;},async all(){stats.reads++;stats.queries.push(query);if(fail)throw Error('test offline');return{results:sql.prepare(query).all(...args)};},async first(){stats.reads++;stats.queries.push(query);if(fail)throw Error('test offline');return sql.prepare(query).get(...args);},async run(){const r=sql.prepare(query).run(...args);return{meta:{changes:Number(r.changes)}};}};},async batch(list){sql.exec('BEGIN');try{const r=await Promise.all(list.map(x=>x.run()));sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 class Clock extends Date{static now(){return now;}}
 const context={Request,Response,Headers,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,TextEncoder,TextDecoder,crypto:webcrypto,atob,Date:Clock};
 vm.createContext(context);vm.runInContext(source,context);
 const env={DB:db,ADMIN_PASSWORD:'test-only'};
 const request=(path,options={})=>context.worker.fetch(new Request('https://worker.test'+path,options),env,{waitUntil(){}});
 return{sql,db,stats,context,request,advance(ms){now+=ms;},offline(v){fail=v;}};
}
test('identical list requests avoid D1; responses keep each request CORS and location filtering',async()=>{
 const f=fixture();
 const first=await f.request('/api/ilceler?il='+encodeURIComponent('İstanbul'),{headers:{Origin:'https://a.test'}});
 assert.deepEqual((await first.json()).rows,['Kadıköy']);const reads=f.stats.reads;
 const second=await f.request('/api/ilceler?il='+encodeURIComponent('İstanbul'),{headers:{Origin:'https://b.test'}});
 assert.equal(second.status,200);assert.equal(f.stats.reads,reads);assert.equal(second.headers.get('Access-Control-Allow-Origin'),'*');
 const other=await(await f.request('/api/ilceler?il=Ankara')).json();assert.deepEqual(other.rows,['Çankaya']);assert.equal(f.stats.reads,reads+1);
});
test('50 simultaneous identical cold requests share one list query',async()=>{
 const f=fixture();const rs=await Promise.all(Array.from({length:50},()=>f.request('/api/iller')));
 assert.ok(rs.every(r=>r.status===200));assert.equal(f.stats.reads,1);
});
test('list TTL expires; failures are never cached and a recovered DB can retry',async()=>{
 const f=fixture();await f.request('/api/iller');assert.equal(f.stats.reads,1);
 f.advance(599999);await f.request('/api/iller');assert.equal(f.stats.reads,1);
 f.advance(2);f.offline(true);assert.equal((await f.request('/api/iller')).status,503);
 f.offline(false);assert.equal((await f.request('/api/iller')).status,200);assert.equal(f.stats.reads,3);
});
test('legacy substring search retains Turkish matching and caches identical results',async()=>{
 const f=fixture();const path='/api/ara?q='+encodeURIComponent('Bostancı');
 const a=await(await f.request(path)).json();assert.equal(a.rows[0].mahalle,'Bostancı');const reads=f.stats.reads;
 const b=await(await f.request(path)).json();assert.deepEqual(b,a);assert.equal(f.stats.reads,reads);
 f.advance(60001);await f.request(path);assert.ok(f.stats.reads>reads);
});
test('successful admin import invalidates cached plans; failed/unauthorized import cannot replace data',async()=>{
 const f=fixture();await f.request('/api/iller');
 const admin={method:'POST',headers:{'Content-Type':'application/json','X-Admin-Password':'test-only'},body:'{}'};
 await f.request('/admin/start',admin);
 const row=['İzmir','Konak','Alsancak',[1,0,1,0,0,0,0]];
 const chunk=await f.request('/admin/chunk',{...admin,body:JSON.stringify({rows:[row]})});assert.equal(chunk.status,200);
 const result=await f.request('/admin/finish',admin);assert.equal(result.status,200,await result.clone().text());
 assert.deepEqual((await(await f.request('/api/iller')).json()).rows,['İzmir']);
 assert.equal((await f.request('/admin/finish',{method:'POST',body:'{}'})).status,401);
 assert.deepEqual((await(await f.request('/api/iller')).json()).rows,['İzmir']);
});
test('cache capacity is bounded and separate databases cannot reuse another DB result',async()=>{
 const f=fixture();for(let i=0;i<80;i++)await f.request('/api/ilceler?il='+i);
 assert.equal(f.context.inspectPlan.planState(f.db).values.size,64);
 const other={prepare(){return{run:async()=>({}),all:async()=>({results:[{il:'Other'}]})};}};
 const r=await f.context.worker.fetch(new Request('https://worker.test/api/iller'),{DB:other},{});
 assert.deepEqual((await r.json()).rows,['Other']);
});
test('location lookup uses a covering index on the synthetic SQLite fixture',async()=>{
 const f=fixture();await f.request('/api/mahalle?il=Ankara&ilce='+encodeURIComponent('Çankaya')+'&mahalle=Merkez');
 const plan=f.sql.prepare('EXPLAIN QUERY PLAN SELECT il,ilce,mahalle FROM dagitim WHERE il=? AND ilce=? AND mahalle=? ORDER BY id DESC LIMIT 1').all('Ankara','Çankaya','Merkez');
 assert.ok(plan.some(row=>/SEARCH.*idx_dagitim_location/.test(row.detail)));
});
test('invalid and short queries do not touch D1 even when it is unavailable',async()=>{
 const f=fixture();f.offline(true);
 assert.equal((await f.request('/api/ilceler')).status,400);
 assert.equal((await f.request('/api/mahalleler?il=Ankara')).status,400);
 assert.equal((await f.request('/api/mahalle?il=Ankara')).status,400);
 assert.deepEqual((await(await f.request('/api/ara?q=ab')).json()).rows,[]);
 assert.equal(f.stats.reads,0);
});
test('an old in-flight result cannot repopulate the cache after invalidation',async()=>{
 const f=fixture();let complete;
 const old=f.db.prepare;
 f.db.prepare=query=>query.includes('SELECT DISTINCT il FROM')?{all:()=>new Promise(resolve=>{complete=resolve;})}:old(query);
 const pending=f.request('/api/iller');
 while(!complete)await new Promise(resolve=>setImmediate(resolve));
 f.context.inspectPlan.clearPlanReads(f.db);
 complete({results:[{il:'Old'}]});assert.equal((await pending).status,200);
 assert.equal(f.context.inspectPlan.planState(f.db).values.size,0);
 f.db.prepare=old;
 assert.deepEqual((await(await f.request('/api/iller')).json()).rows,['Ankara','İstanbul']);
});
