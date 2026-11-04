const KGM_URL = "https://www.kgm.gov.tr/Sayfalar/KGM/SiteTr/YolDanisma/TrafigeKapaliYollar.aspx";

const TERMS = [
  /motokurye/i,/moto\s*kurye/i,/motosiklet/i,/motorlu\s*kurye/i,
  /trafiğe\s*çıkış.*yasak/i,/trafiğe\s*çıkmaları.*yasak/i,
  /hava\s*muhalefeti/i,/yoğun\s*kar/i,/fırtına/i,/buzlanma/i
];

function strip(s=""){return s.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim()}
// Yalnızca kullanıcıdan gelen il adı temizlenir; sorgudaki site:/when:/OR/"..." operatörleri korunur.
// (Eski escQ tüm sorguyu temizliyor, "site:gov.tr when:2d" filtresini "site gov tr when 2d" yapıyordu.)
function cleanTerm(s=""){return String(s).replace(/[^\p{L}\p{N}\s-]/gu," ").replace(/\s+/g," ").trim().slice(0,60)}
const FETCH_TIMEOUT_MS=6000;
function fetchT(url,opts={},ms=FETCH_TIMEOUT_MS){return fetch(url,{...opts,signal:AbortSignal.timeout(ms)})}
function official(u=""){try{const h=new URL(u).hostname;return h.endsWith(".gov.tr")||h==="gov.tr"}catch{return false}}
function absMgm(u){try{return new URL(u,KGM_URL).href}catch{return u}}
function classify(t){
 if(/motokurye|moto\s*kurye|motosiklet|motorlu\s*kurye/i.test(t)&&/yasak|kısıt|trafiğe.*çık/i.test(t))return ["MOTOSIKLET_YASAGI","🏍️ Motosiklet/Motokurye"];
 if(/kapalı|ulaşıma kapat|trafiğe kapat/i.test(t))return ["YOL_KAPALI","⛔ Kapalı yol"];
 return ["HAVA_UYARISI","🌨️ Hava/Valilik"];
}
async function googleOfficial(il){
 // Google News RSS yalnızca keşif için kullanılır; kullanıcıya yalnızca .gov.tr kaynaklı duyurular gösterilir.
 const term=cleanTerm(il);
 if(!term)return [];
 const q=`"${term}" (motokurye OR motosiklet OR "trafiğe kapalı" OR "hava muhalefeti") site:gov.tr when:2d`;
 const url="https://news.google.com/rss/search?q="+encodeURIComponent(q)+"&hl=tr&gl=TR&ceid=TR:tr";
 let xml;
 try{
  const r=await fetchT(url,{headers:{"User-Agent":"Mozilla/5.0"}});
  if(!r.ok)return [];
  xml=await r.text();
 }catch{return []}
 const ilLow=il.toLocaleLowerCase("tr");
 const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0,20).map(m=>{
  const b=m[1];
  return {
   title:strip((b.match(/<title>([\s\S]*?)<\/title>/i)||[])[1]||""),
   link:strip((b.match(/<link>([\s\S]*?)<\/link>/i)||[])[1]||""),
   pub:strip((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)||[])[1]||""),
   source:(b.match(/<source[^>]*url="([^"]+)"/i)||[])[1]||""
  };
 }).filter(x=>x.link&&TERMS.some(t=>t.test(x.title))).slice(0,8);
 // Bağlantılar paralel ve zaman aşımlı çözülür (eskiden sırayla ve süresiz bekleniyordu;
 // istemci 9 sn'de vazgeçtiği için uyarılar hiç görünmeyebiliyordu).
 const res=await Promise.all(items.map(async x=>{
  try{
   const rr=await fetchT(x.link,{redirect:"follow",headers:{"User-Agent":"Mozilla/5.0"}},5000);
   const final=rr.url;
   if(official(final)){
    const body=strip(await rr.text());
    if(!body.toLocaleLowerCase("tr").includes(ilLow))return null;
    const [type,label]=classify(x.title+" "+body.slice(0,3000));
    return {type,label,title:x.title,summary:x.pub?`Yayın: ${x.pub}`:"Güncel resmî duyuru",url:final};
   }
   // Google News bazen yönlendirmeyi JS ile yapar; bu durumda RSS'teki <source> resmî ise kabul et.
   if(official(x.source)&&x.title.toLocaleLowerCase("tr").includes(ilLow)){
    const [type,label]=classify(x.title);
    return {type,label,title:x.title,summary:(x.pub?`Yayın: ${x.pub} • `:"")+"Kaynak: "+new URL(x.source).hostname,url:x.link};
   }
  }catch{}
  return null;
 }));
 return res.filter(Boolean);
}
async function kgm(il){
 try{
  const r=await fetchT(KGM_URL,{headers:{"User-Agent":"Mozilla/5.0"}});
  if(!r.ok)return [];
  const h=await r.text(), text=strip(h);
  if(!text.toLocaleLowerCase("tr").includes(il.toLocaleLowerCase("tr")))return [];
  // KGM sayfasında il adı geçen kapalı yol bilgisini güvenli biçimde özetle; sayfanın tamamını kopyalama.
  const low=text.toLocaleLowerCase("tr"), p=low.indexOf(il.toLocaleLowerCase("tr"));
  const sn=text.slice(Math.max(0,p-180),Math.min(text.length,p+420));
  if(!/kapalı|ulaşıma kapat|trafiğe kapat/i.test(sn))return [];
  return [{type:"YOL_KAPALI",label:"⛔ KGM yol durumu",title:`${il} için KGM yol kapanması kaydı`,summary:sn.slice(0,260)+"…",url:KGM_URL}];
 }catch{return []}
}

const MGM_WEB = "https://servis.mgm.gov.tr/web";

function trSlug(v=""){
  return v.toLocaleLowerCase("tr-TR")
    .replace(/ı/g,"i").replace(/ğ/g,"g").replace(/ü/g,"u")
    .replace(/ş/g,"s").replace(/ö/g,"o").replace(/ç/g,"c")
    .replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
}
function trKey(v=""){
  return v.toLocaleLowerCase("tr-TR")
    .replace(/ı/g,"i").replace(/ğ/g,"g").replace(/ü/g,"u")
    .replace(/ş/g,"s").replace(/ö/g,"o").replace(/ç/g,"c")
    .replace(/[^a-z0-9]/g,"");
}
function pick(o, keys){
  for(const k of keys) if(o && o[k] !== undefined && o[k] !== null) return o[k];
  return null;
}
function mgmHeaders(){
  return {
    "Accept":"application/json, text/plain, */*",
    "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36",
    "Origin":"https://www.mgm.gov.tr",
    "Referer":"https://www.mgm.gov.tr/tahmin/il-ve-ilceler.aspx"
  };
}
async function getJson(url){
  const r=await fetchT(url,{headers:mgmHeaders(),cf:{cacheTtl:600,cacheEverything:true}},5000);
  const txt=await r.text();
  if(!r.ok) throw new Error("MGM HTTP "+r.status+" @ "+new URL(url).pathname);
  try{return JSON.parse(txt)}catch{throw new Error("MGM JSON yanıtı alınamadı")}
}
async function mgmWeather(il, ilce){
  const ilSlug=trSlug(il), ilceKey=trKey(ilce);

  // More reliable route: get all centers for the province, then select the district locally.
  let centers=await getJson(MGM_WEB+"/merkezler/ililcesi?il="+encodeURIComponent(ilSlug));
  if(!Array.isArray(centers)) centers=centers && Array.isArray(centers.data) ? centers.data : [];
  let c=centers.find(x=>trKey(x.ilce||"")===ilceKey);

  // Some MGM records use "Merkez" or slightly different district spelling.
  if(!c){
    c=centers.find(x=>trKey(x.ilce||"").includes(ilceKey) || ilceKey.includes(trKey(x.ilce||"")));
  }

  // Fallback to MGM's direct province/district lookup.
  if(!c){
    let direct=await getJson(MGM_WEB+"/merkezler?il="+encodeURIComponent(ilSlug)+"&ilce="+encodeURIComponent(trSlug(ilce)));
    if(!Array.isArray(direct)) direct=direct && Array.isArray(direct.data) ? direct.data : [];
    c=direct[0];
  }
  if(!c) throw new Error("MGM merkez bulunamadı: "+ilce+" / "+il);

  // Daily forecast station number is the correct field when available.
  const istno=pick(c,["gunlukTahminIstNo","merkezId","istNo","istno"]);
  if(!istno) throw new Error("MGM günlük tahmin istasyonu bulunamadı");

  let daily=await getJson(MGM_WEB+"/tahminler/gunluk?istno="+encodeURIComponent(istno));
  if(!Array.isArray(daily)) daily=daily && Array.isArray(daily.data) ? daily.data : [];
  if(!daily.length) throw new Error("MGM günlük tahmin bulunamadı");

  const d=daily[0];

  // Today's weather: first try MGM current observation. If that endpoint
  // fails (Cloudflare/MGM 525), fall back to MGM hourly forecast for today.
  let current=null;
  try{
    let currentData=await getJson(MGM_WEB+"/sondurumlar?merkezid="+encodeURIComponent(c.merkezId));
    if(!Array.isArray(currentData)) currentData=currentData && Array.isArray(currentData.data) ? currentData.data : [];
    const x=currentData[0] || null;
    if(x){
      current={
        source:"MGM Son Durum",
        isForecast:false,
        tarih: pick(x,["veriZamani","tarih","date"]),
        hadise: pick(x,["hadiseKodu","hadise","weather"]),
        sicaklik: pick(x,["sicaklik","temperature"]),
        nem: pick(x,["nem","humidity"]),
        ruzgarYon: pick(x,["ruzgarYon","ruzgarYonu"]),
        ruzgarHiz: pick(x,["ruzgarHiz","ruzgarHizi"]),
        maksimumRuzgarHizi: pick(x,["maksimumRuzgarHizi","maksRuzgarHiz"]),
        yagis00Now: pick(x,["yagis00Now","yagis"])
      };
    }
  }catch(e){}

  if(!current){
    try{
      const hourlyNo=c.saatlikTahminIstNo || c.sondurumIstNo || c.merkezId;
      let hourly=await getJson(MGM_WEB+"/tahminler/saatlik?istno="+encodeURIComponent(hourlyNo));
      if(!Array.isArray(hourly)) hourly=hourly && Array.isArray(hourly.data) ? hourly.data : [];
      const pack=hourly[0] || {};
      const list=Array.isArray(pack.tahmin) ? pack.tahmin : hourly;
      const now=Date.now();
      const usable=list.filter(x=>x && x.tarih);
      let x=usable.find(x=>new Date(x.tarih).getTime()>=now) || usable[0] || null;
      if(x){
        current={
          source:"MGM Saatlik Tahmin",
          isForecast:true,
          tarih: pick(x,["tarih","date"]),
          hadise: pick(x,["hadise","hadiseKodu","weather"]),
          sicaklik: pick(x,["sicaklik","temperature"]),
          hissedilenSicaklik: pick(x,["hissedilenSicaklik"]),
          nem: pick(x,["nem","humidity"]),
          ruzgarYon: pick(x,["ruzgarYonu","ruzgarYon"]),
          ruzgarHiz: pick(x,["ruzgarHizi","ruzgarHiz"]),
          maksimumRuzgarHizi: pick(x,["maksimumRuzgarHizi"])
        };
      }
    }catch(e){
      current={error:String(e && e.message || e)};
    }
  }

  const rows=[];
  for(let i=1;i<=5;i++){
    rows.push({
      tarih: pick(d,["tarihGun"+i,"tarih"+i]),
      hadise: pick(d,["hadiseGun"+i]),
      enDusuk: pick(d,["enDusukGun"+i]),
      enYuksek: pick(d,["enYuksekGun"+i]),
      enDusukNem: pick(d,["enDusukNemGun"+i]),
      enYuksekNem: pick(d,["enYuksekNemGun"+i]),
      ruzgarYon: pick(d,["ruzgarYonGun"+i]),
      ruzgarHiz: pick(d,["ruzgarHizGun"+i])
    });
  }
  return {
    center:{
      il:c.il, ilce:c.ilce, merkezId:c.merkezId,
      gunlukTahminIstNo:c.gunlukTahminIstNo
    },
    current,
    rows,
    source:"MGM"
  };
}

// İl bazında uyarı önbelleği (isolate belleği): her sorguda Google + KGM'ye 10'larca istek atılmasın.
const ALERT_TTL_MS=10*60*1000;
const alertCache=new Map();
async function alertsFor(il){
 const k=il.toLocaleLowerCase("tr");
 const hit=alertCache.get(k);
 if(hit&&Date.now()-hit.at<ALERT_TTL_MS)return hit.alerts;
 const [v,kg]=await Promise.all([googleOfficial(il),kgm(il)]);
 const seen=new Set(), alerts=[...v,...kg].filter(x=>{
  const z=x.url+"|"+x.title;
  if(seen.has(z)) return false;
  seen.add(z); return true;
 });
 if(alertCache.size>200)alertCache.delete(alertCache.keys().next().value);
 alertCache.set(k,{at:Date.now(),alerts});
 return alerts;
}

export default {
 async fetch(req){
  const u=new URL(req.url);
  const headers={
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"public, max-age=600"
  };
  if(req.method==="OPTIONS") return new Response(null,{headers});

  const il=(u.searchParams.get("il")||"").trim();
  const ilce=(u.searchParams.get("ilce")||"").trim();
  if(!il) return new Response(JSON.stringify({error:"il gerekli"}),{status:400,headers});

  if(u.pathname==="/weather"){
    if(!ilce) return new Response(JSON.stringify({error:"ilce gerekli"}),{status:400,headers});
    try{
      const weather=await mgmWeather(il,ilce);
      return new Response(JSON.stringify({il,ilce,checkedAt:new Date().toISOString(),...weather}),{headers});
    }catch(e){
      return new Response(JSON.stringify({il,ilce,error:String(e && e.message || e)}),{status:502,headers});
    }
  }

  if(il.length>60) return new Response(JSON.stringify({error:"il geçersiz"}),{status:400,headers});
  const alerts=await alertsFor(il);
  return new Response(JSON.stringify({il,ilce,checkedAt:new Date().toISOString(),alerts}),{headers});
 }
}

