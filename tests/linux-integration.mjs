import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixtureServer, root, spawnReady, waitFor } from './helpers.mjs';

if (process.platform!=='linux') throw new Error('This integration test requires Linux');
const python=process.env.IC_TEST_PYTHON??'python3', xvfb=process.env.IC_TEST_XVFB??'Xvfb';
const directory=await mkdtemp(join(tmpdir(),'ic-verification-'));
const fixture=await fixtureServer();
let human,ai,client,transport;
const checks=[];
function passed(name){checks.push(name);console.log('PASS '+name);}
function metadata(result){assert.ok(!result.isError,result.content[0]?.text);return JSON.parse(result.content.find(c=>c.type==='text').text);}
function image(result){return result.content.find(c=>c.type==='image');}
try {
  for(const [name,sentinel] of [['human','HUMAN_SENTINEL'],['ai','']]){
    const state=join(directory,name+'.json'), apps=join(directory,name+'-apps.json');
    await writeFile(apps,JSON.stringify([[python,join(root,'tests/tk_fixture.py'),'--state',state,'--sentinel',sentinel]]));
    const session=await spawnReady(python,['desktop/linux_session.py','--xvfb',xvfb,'--token-file',join(directory,name+'.token'),'--apps-file',apps]);
    session.state=state;await waitFor(async()=>JSON.parse(await readFile(state,'utf8')));
    if(name==='human')human=session;else ai=session;
  }
  const probe=()=>JSON.parse(execFileSync(python,['tests/x11_probe.py',human.info.isolation.display],{cwd:root,encoding:'utf8'}));
  const before=probe();
  transport=new StdioClientTransport({command:process.execPath,args:['src/server.mjs'],cwd:root,env:{...process.env,DISPLAY:human.info.isolation.display,IC_DESKTOP_URL:ai.info.url,IC_DESKTOP_TOKEN_FILE:ai.info.tokenFile}});
  client=new Client({name:'linux-verifier',version:'1.0.0'});
  await client.connect(transport);
  const tools=await client.listTools();assert.equal(tools.tools.length,15);passed('MCP initialize and tool discovery');
  const status=metadata(await client.callTool({name:'computer_status',arguments:{}}));
  const call=(name,args={})=>client.callTool({name,arguments:args});
  const opened=await call('browser_open',{url:fixture.url,capture:'png'});const tab=metadata(opened).tab;
  const png=Buffer.from(image(opened).data,'base64');assert.equal(png.readUInt32BE(16),1280);assert.equal(png.readUInt32BE(20),800);
  passed('headless browser screenshot dimensions');
  const ax=metadata(await call('browser_observe',{tab}));assert.ok(ax.accessibility.source.includes('native'));
  const textRef=ax.accessibility.controls.find(c=>c.role==='textbox').ref;
  await call('browser_controls',{tab,actions:[{type:'fill',ref:textRef,text:'无障碍填表'}]}).then(metadata);
  await waitFor(()=>fixture.state().text==='无障碍填表');
  await call('browser_controls',{tab,actions:[{type:'fill',ref:metadata(await call('browser_observe',{tab})).accessibility.controls.find(c=>c.role==='textbox').ref,text:''}]}).then(metadata);
  passed('native browser accessibility and screenshot-free semantic fill');
  await call('browser_act',{tab,actions:[{type:'click',x:100,y:80},{type:'type',text:'独立输入 hello'},{type:'click',x:100,y:145}],capture:'none'}).then(metadata);
  await waitFor(()=>fixture.state().text==='独立输入 hello'&&fixture.state().clicks===1);passed('browser Chinese text and click');
  await call('browser_act',{tab,actions:[{type:'drag',path:[{x:70,y:240},{x:150,y:245},{x:220,y:260}]}],capture:'png'}).then(metadata);
  await waitFor(()=>fixture.state().dragged);passed('browser drag');
  await call('browser_act',{tab,actions:[{type:'click',x:450,y:85}],capture:'none'}).then(metadata);
  await waitFor(async()=>metadata(await call('browser_observe',{tab,capture:'none'})).dialogs.length===1);passed('browser dialog does not block');
  await call('browser_act',{tab,actions:[{type:'click',x:450,y:145}],capture:'none'}).then(metadata);
  await waitFor(async()=>metadata(await call('browser_tabs')).tabs.length===2);passed('popup registered independently');
  await call('browser_act',{tab,actions:[{type:'scroll',x:600,y:500,deltaY:500},{type:'wait',ms:100}],capture:'none'}).then(metadata);
  await waitFor(()=>fixture.state().scrollY>0);passed('browser scroll');
  const invalid=await call('browser_act',{tab,actions:[{type:'click',x:2000,y:80}],capture:'none'});assert.equal(invalid.isError,true);passed('reject out-of-viewport action');
  const desktop=await call('desktop_act',{actions:[{type:'click',x:100,y:80},{type:'type',text:'hello 原生隔离'},{type:'click',x:100,y:145},{type:'wait',ms:100}],capture:'png'});
  metadata(desktop);await writeFile(join(root,'artifacts/linux-native.png'),Buffer.from(image(desktop).data,'base64'));
  await waitFor(async()=>{const state=JSON.parse(await readFile(ai.state,'utf8'));return state.text==='hello 原生隔离'&&state.clicks===1;});passed('native Chinese text, click and screenshot');
  await call('desktop_act',{actions:[{type:'drag',path:[{x:70,y:240},{x:150,y:245},{x:220,y:260}]},{type:'wait',ms:100}],capture:'none'}).then(metadata);
  await waitFor(async()=>JSON.parse(await readFile(ai.state,'utf8')).dragged);passed('native drag');
  // Tk on X11 pastes without replacing a selection, so explicitly delete it first.
  await call('desktop_act',{actions:[{type:'click',x:100,y:80},{type:'key',keys:['Home']},{type:'key',keys:['Shift','End']},{type:'key',keys:['Backspace']},{type:'type',text:'replaced'},{type:'wait',ms:100}],capture:'none'}).then(metadata);
  await waitFor(async()=>JSON.parse(await readFile(ai.state,'utf8')).text==='replaced');passed('native keyboard shortcut');
  const nativeToken=(await readFile(ai.info.tokenFile,'utf8')).trim();
  assert.equal((await fetch(ai.info.url+'/health')).status,401);
  assert.equal((await fetch(ai.info.url+'/act',{method:'POST',headers:{Authorization:'Bearer '+nativeToken,'Content-Type':'application/json'},body:JSON.stringify({actions:[{type:'shell',command:'echo nope'}]})})).status,400);passed('desktop authentication and input validation');
  const url=new URL(status.viewerURL),viewerToken=url.hash.slice(1);url.hash='';
  const headers={Authorization:'Bearer '+viewerToken};
  const semantics=await fetch(new URL('/semantics?target=browser&tab='+tab,url),{headers});assert.equal(semantics.status,200);const structured=await semantics.json();assert.ok(structured.accessibility);assert.equal(structured.image,undefined);passed('observation window defaults to structured controls without screenshot');
  assert.equal((await fetch(new URL('/frame',url))).status,401);
  const frame=await fetch(new URL('/frame?target=desktop',url),{headers});assert.equal(frame.status,200);assert.equal(frame.headers.get('content-type'),'image/jpeg');passed('authenticated observation window');
  await fetch(new URL('/pause',url),{method:'POST',headers});
  assert.equal((await call('browser_act',{tab,actions:[{type:'wait',ms:0}]})).isError,true);
  assert.equal((await call('desktop_act',{actions:[{type:'wait',ms:0}]})).isError,true);
  await fetch(new URL('/resume',url),{method:'POST',headers});passed('pause and resume block both targets');
  await call('browser_close',{tab}).then(metadata);passed('tab resource cleanup');
  const after=probe();assert.deepEqual(after,before);
  const humanState=JSON.parse(await readFile(human.state,'utf8'));assert.equal(humanState.text,'HUMAN_SENTINEL');assert.equal(humanState.clicks,0);assert.equal(humanState.dragged,false);
  passed('simulated human display focus, pointer and input remain unchanged');
  await writeFile(join(root,'artifacts/linux-verification.json'),JSON.stringify({date:new Date().toISOString(),platform:process.platform,checks,referenceDisplayBefore:before,referenceDisplayAfter:after,humanState,scope:'Real headless Chromium + real Tk GUI in Xvfb; simulated human desktop in second Xvfb, not a live user desktop. macOS/Windows not tested.'},null,2));
} finally {
  await client?.close().catch(()=>{});
  await transport?.close().catch(()=>{});
  await ai?.stop();await human?.stop();await fixture.close();
}
