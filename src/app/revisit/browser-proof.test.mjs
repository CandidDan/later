// Cloud-only supplementary UI proof. Requires a synthetic-config production build.
// PLAYWRIGHT_MODULE may point to an externally provisioned playwright installation.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require('node:assert/strict');
(async () => {
 const {spawn}=require('node:child_process');
 const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p','3200']);
 server.stderr.on('data',d=>process.stderr.write(d));
 await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(d.toString().includes('Ready'))resolve()});server.on('exit',()=>reject(Error('Server exited')))});
 process.on('exit',()=>server.kill());
 const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,args:["--no-sandbox", "--disable-dev-shm-usage"]});
 const page = await browser.newPage({viewport:{width:320,height:800}});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 const base='http://127.0.0.1:3200';
 await page.route('https://return-test.supabase.co/**', route=>route.fulfill({status:200,contentType:'application/json',body:'{}'}));
 await page.goto(base+'/revisit');
 await page.getByLabel('Email address',{exact:true}).fill('owner@example.test');
 await page.getByRole('button',{name:'Email me a sign-in link'}).click();
 await page.getByText('Check your email for a sign-in link.',{exact:false}).waitFor();
 await page.evaluate(() => {
   const exp=Math.floor(Date.now()/1000)+3600;
   const access_token=btoa(JSON.stringify({alg:'HS256',typ:'JWT'}))+'.'+btoa(JSON.stringify({sub:'11111111-1111-4111-8111-111111111111',aud:'authenticated',exp}))+'.synthetic';
   localStorage.setItem('sb-return-test-auth-token',JSON.stringify({access_token,refresh_token:'synthetic',expires_at:exp,expires_in:3600,token_type:'bearer',user:{id:'11111111-1111-4111-8111-111111111111',email:'owner@example.test'}}));
 });
 let batches=0,actions=0,fail=true;
 const cards=[1,2,3].map(n=>({captureId:'save'+n,title:'Saved item '+n,rawText:'LongContext'.repeat(100),note:'My original note',kind:'link',channel:'email',source:'example.com',savedAt:'2025-01-01T00:00:00Z',inferred:[],assets:n===1?[{id:"asset",filename:"Memory.png",mediaType:"image/png",available:true,raster:true}]:[],originalDestination:'https://example.com/original'}));
 let previewFails=true;
 await page.route('**/api/revisit/assets/**',route=>previewFails?route.fulfill({status:503,json:{error:'Unavailable'}}):route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')}));
 await page.route('**/api/revisit/batch',route=>{batches++;return route.fulfill({json:{cards:cards.slice()}})});
 await page.route('**/api/revisit/actions/*',route=>{actions++; if(fail)return route.fulfill({status:503,json:{error:'Unavailable'}});cards.splice(cards.findIndex(c=>route.request().url().endsWith(c.captureId)),1);return route.fulfill({json:{status:'applied'}})});
 await page.reload(); await page.getByRole('heading',{name:'Saved item 1'}).waitFor();
 assert.equal(await page.getByRole('article').count(),3);
 await page.getByRole('button',{name:'Retry preview'}).waitFor(); previewFails=false;
 await page.getByRole('button',{name:'Retry preview'}).click();
 await page.getByAltText('Captured attachment: Memory.png').waitFor();
 assert.equal(await page.getByRole('article').count(),3);

 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'320px must not overflow');
 await page.getByRole('button',{name:'Another time',exact:true}).first().focus(); await page.keyboard.press('Enter');
 await page.getByText("Your choice hasn't been confirmed",{exact:false}).waitFor();assert.equal(await page.getByRole('article').count(),3);
 fail=false;await page.getByRole('button',{name:'Another time',exact:true}).first().click();
 await page.getByText('Saved for another time.',{exact:false}).waitFor();
 assert.equal(await page.getByRole('article').count(),2);assert.equal(batches,1);assert.equal(actions,2);
 assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Show a few more');
 await page.getByRole('button',{name:'Show a few more'}).click();assert.equal(batches,2);
 await page.reload(); await page.getByRole('heading',{name:'Saved item 2'}).waitFor(); assert.equal(await page.getByRole('heading',{name:'Saved item 1',exact:true}).count(),0);
 await page.route('**/api/revisit/batch',route=>route.fulfill({status:401,json:{error:'Unauthorized'}}));
 await page.getByRole('button',{name:'Show a few more'}).click();await page.getByLabel('Email address',{exact:true}).waitFor();assert.equal(await page.getByRole('article').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: magic-link sent, preview failure/retry, three cards, 320px overflow, keyboard action, failure/retry, focus after removal, explicit more, reload, expiry clears data, no browser exceptions');
 await browser.close(); server.kill();
})().catch(e=>{console.error(e);process.exit(1)});
