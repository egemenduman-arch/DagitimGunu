const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');const base=path.join(__dirname,'..');
(async()=>{const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});try{for(const width of [390,700,1440]){
 const p=await browser.newPage({viewport:{width,height:800},timezoneId:'Europe/Istanbul'});let mode='live',missingFiles=false,oldWorker=false,calls=0;const errors=[],forbidden=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('**/*',async route=>{const u=new URL(route.request().url());
  if(u.hostname==='preview.local'){
   const file=path.join(base,u.pathname==='/'?'index.html':u.pathname);
   if(missingFiles&&u.pathname.includes('/data/'))return route.fulfill({status:503,json:{error:'test'}});
   if(fs.existsSync(file))return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'application/javascript':'application/json',body:fs.readFileSync(file)});
   return route.fulfill({status:404,body:''});
  }
  if(u.hostname.includes('dagitimveri')){
   if(u.pathname==='/api/capabilities')return oldWorker?route.fulfill({status:404,json:{error:'Not found'}}):route.fulfill({json:{optymus:true,attachments:true}});
   if(u.pathname==='/api/adres-gun'){calls++;if(mode==='reject')return route.fulfill({status:422,json:{error:'Hizmet bölgesi bulunamadı'}});if(mode==='unavailable')return route.fulfill({status:503,json:{error:'Canlı servise ulaşılamıyor'}});return route.fulfill({json:{ok:true,days:[1,0,1,0,1,0,0]}})}
   forbidden.push(u.pathname);return route.fulfill({status:503,json:{error:'D1_ERROR: free tier row read limit'}});
  }
  if(u.pathname.endsWith('.svg'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});
  return route.fulfill({contentType:'application/json',body:'{}'});
 });
 await p.goto('http://preview.local/');await p.waitForFunction(()=>document.querySelector('#il').options.length===82);assert.equal(await p.locator('#il option').count(),82);
 await p.locator('#q').fill('Bostancı Mh. Bağdat Cad. No:12 Kadıköy İstanbul');await p.locator('#btn').click();await p.locator('.place').waitFor();assert.equal(await p.locator('.place').innerText(),'Bostancı Mh.');assert.match(await p.locator('#results').innerText(),/Kadıköy \/ İstanbul/);assert.match(await p.locator('#results').innerText(),/En erken teslimat/);
 await p.waitForTimeout(450);if(width<=700){const b=await p.locator('#deliverySection .accHead').boundingBox();assert.ok(b.y>=0&&b.y+b.height<=800)}
 await p.locator('.mapButton').click();assert.match(await p.locator('#mapAddress').innerText(),/Bağdat Cad\. No:12/);await p.locator('#mapClose').click();
 await p.locator('.filtersToggle summary').click();await p.locator('#il').selectOption('Bartın');await p.locator('#ilce').selectOption('Amasra');mode='reject';const before=calls;await p.locator('#mah').selectOption('Çakrazşeyhler Köyü');await p.locator('.place').waitFor();assert.equal(await p.locator('.place').innerText(),'Çakrazşeyhler Köyü');assert.equal(calls,before+1);assert.match(await p.locator('#results').innerText(),/kayıtlı ziyaret planı/);await p.locator('.mapButton').click();assert.equal(await p.locator('#mapAddress').innerText(),'Çakrazşeyhler Köyü, Amasra, Bartın');await p.locator('#mapClose').click();
 await p.locator('#q').fill('Bulunmayan Adres İstanbul');await p.locator('#btn').click();await p.locator('#results [role=alert]').waitFor();assert.equal(await p.locator('.result').count(),0);
 mode='unavailable';missingFiles=true;await p.reload();await p.locator('#q').fill('Veri kesintisi örnek adres');await p.locator('#btn').click();await p.locator('#results [role=alert]').waitFor();assert.match(await p.locator('#results').innerText(),/Kayıtlı bölge listesine ulaşılamıyor/);assert.doesNotMatch(await p.locator('#results').innerText(),/Adres bulunamadı|D1_ERROR/);
 // Eski Worker'da capabilities yoksa da D1 tabanlı meta canlı sorguyu engelleyemez.
 missingFiles=false;oldWorker=true;mode='live';await p.reload();await p.waitForFunction(()=>document.querySelector('#il').options.length===82);await p.locator('#q').fill('Bostancı İstanbul');await p.locator('#btn').click();await p.locator('.place').waitFor();assert.match(await p.locator('#results').innerText(),/En erken teslimat/);
 assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));console.log(width+'px: D1 isteği yok, canlı sonuç, otomatik mahalle sorgusu, kayıtlı plan, harita hedefleri, kesinti mesajı ve eski Worker uyumu geçti');await p.close();
}}finally{await browser.close()}})().catch(e=>{console.error(e.stack);process.exit(1)});
