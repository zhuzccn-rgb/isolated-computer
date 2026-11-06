import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {waitFor} from '../tests/helpers.mjs';
const session=JSON.parse(await readFile(new URL('../.runtime/acceptance/session.json',import.meta.url)));
const url=new URL(session.viewerURL),headers={Authorization:'Bearer '+url.hash.slice(1)};
async function snapshot(){return(await fetch(new URL('/semantics?target=desktop',url),{headers})).json();}
async function count(){const s=await snapshot();const c=s.accessibility.controls.find(c=>c.name?.startsWith('点击：'));assert.ok(c,'Counter label missing');return Number(c.name.match(/点击：(\d+)/)[1]);}
const checks=[];const pass=s=>{checks.push(s);console.log('PASS '+s);};
const browser=await chromium.launch({headless:true,chromiumSandbox:true});const page=await browser.newPage({viewport:{width:1000,height:1150}});let returned=false;
try{
 const first=await count();await waitFor(async()=>await count()>first,5000);pass('live acceptance demo performs background MCP native Action clicks');
 await page.goto(session.viewerURL);await page.locator('#takeover:not([disabled])').waitFor();assert.equal(await page.locator('#target').inputValue(),'desktop');
 await page.click('#takeover');await page.locator('#handback').waitFor();const held=await count();await new Promise(r=>setTimeout(r,2500));assert.equal(await count(),held);pass('real GTK demo stops background MCP loop while human owns input');
 await page.locator('#keyboard').fill('验收中文');
 await waitFor(async()=>(await snapshot()).accessibility.controls.some(c=>c.name==='验收输入框'&&c.value?.includes('验收中文')));pass('human keyboard input reaches real GTK Entry in acceptance demo');
 const jpeg=await(await fetch(new URL('/frame?target=desktop',url),{headers})).arrayBuffer();
 const framePath=fileURLToPath(new URL('../.runtime/acceptance/frame.jpg',import.meta.url));await writeFile(framePath,Buffer.from(jpeg));
 const bounds=JSON.parse(execFileSync('/usr/bin/python3',['-c',`from PIL import Image;import json,sys
im=Image.open(sys.argv[1]).convert('RGB');points=[]
for y in range(0,im.height,5):
 for x in range(0,im.width,5):
  r,g,b=im.getpixel((x,y))
  if 25<r<85 and 85<g<140 and 145<b<210:points.append((x,y))
assert len(points)>100,'Blue drag area did not render'
print(json.dumps({'x':sum(p[0] for p in points)/len(points),'y':sum(p[1] for p in points)/len(points)}))`,framePath],{encoding:'utf8'}));
 const point=await page.locator('#screen').evaluate((el,p)=>{const r=el.getBoundingClientRect();return{x:r.left+p.x*r.width/el.naturalWidth,y:r.top+p.y*r.height/el.naturalHeight};},bounds);
 await page.mouse.move(point.x-30,point.y);await page.mouse.down();await page.mouse.move(point.x+30,point.y,{steps:8});await page.mouse.up();await page.mouse.wheel(0,250);
 await waitFor(async()=>(await snapshot()).accessibility.controls.some(c=>/拖拽：[1-9]/.test(c.name)&&/滚轮：[1-9]/.test(c.name)));pass('GTK acceptance drag area renders blue and receives human drag/wheel');
 await page.screenshot({path:new URL('../artifacts/acceptance-window.png',import.meta.url).pathname,fullPage:true});
 await page.click('#handback');returned=true;await waitFor(async()=>await count()>held,5000);pass('explicit hand-back restarts demo loop through native accessibility');
 await writeFile(new URL('../artifacts/acceptance-demo.json',import.meta.url),JSON.stringify({date:new Date().toISOString(),checks,scope:'Real GTK app and Openbox in private Xvfb, AT-SPI MCP loop and actual Chromium viewer. No model calls. OS IME and host desktop concurrency await human acceptance.'},null,2));
}finally{
 if(!returned)await page.click('#handback').catch(()=>{});
 await browser.close();
}
