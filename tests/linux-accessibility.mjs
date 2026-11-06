import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { root,spawnReady,waitFor } from './helpers.mjs';
const python=process.env.IC_AX_PYTHON??'/usr/bin/python3', xvfb=process.env.IC_TEST_XVFB??'Xvfb';
const dir=await mkdtemp(join(tmpdir(),'ic-native-ax-'));
let human,ai,client,transport;
const checks=[];
const pass=name=>{checks.push(name);console.log('PASS '+name);};
const meta=r=>{assert.ok(!r.isError,r.content[0]?.text);return JSON.parse(r.content[0].text);};
try{
  for(const [name,sentinel]of [['human','HUMAN_SENTINEL'],['ai','']]){
    const state=join(dir,name+'.json'),apps=join(dir,name+'-apps.json');
    await writeFile(apps,JSON.stringify([[python,join(root,'tests/gtk_fixture.py'),'--state',state,'--sentinel',sentinel]]));
    const session=await spawnReady(python,['desktop/linux_session.py','--xvfb',xvfb,'--token-file',join(dir,name+'.token'),'--apps-file',apps]);
    session.state=state;await waitFor(()=>readFile(state,'utf8').then(JSON.parse));if(name==='human')human=session;else ai=session;
  }
  const probe=()=>JSON.parse(execFileSync(python,['tests/x11_probe.py',human.info.isolation.display],{cwd:root,encoding:'utf8'}));
  const before=probe();
  transport=new StdioClientTransport({command:process.execPath,args:['src/server.mjs'],cwd:root,env:{...process.env,DISPLAY:human.info.isolation.display,IC_DESKTOP_URL:ai.info.url,IC_DESKTOP_TOKEN_FILE:ai.info.tokenFile}});
  client=new Client({name:'native-ax-verifier',version:'1.0.0'});await client.connect(transport);
  const call=(name,args={})=>client.callTool({name,arguments:args});
  let last;
  const observation=await waitFor(async()=>{const r=await call('desktop_observe'),m=meta(r);last=m;return m.accessibility?.controls?.some(c=>c.name==='Native form input')?r:false;},10000).catch(e=>{console.log(JSON.stringify({last,bridgeLog:ai.stderr()}));throw e;});
  assert.equal(observation.content.some(c=>c.type==='image'),false);const tree=meta(observation).accessibility;
  assert.equal(tree.source,'Linux native AT-SPI');assert.ok(tree.controls.every(c=>c.value!=='HUMAN_SENTINEL'));pass('native AT-SPI tree reads only the isolated application, without screenshot');
  const input=tree.controls.find(c=>c.name==='Native form input'),button=tree.controls.find(c=>c.name==='Count clicks'&&c.interfaces.includes('Action'));
  meta(await call('desktop_controls',{actions:[{type:'fill',ref:input.ref,text:'原生无障碍中文填表'},{type:'click',ref:button.ref}]}));
  await waitFor(async()=>{const s=JSON.parse(await readFile(ai.state,'utf8'));return s.text==='原生无障碍中文填表'&&s.clicks===1;});pass('AT-SPI EditableText fills Chinese and native Action clicks, without clipboard/mouse');
  const invalid=await call('desktop_controls',{actions:[{type:'fill',ref:'atspi-stale-or-unknown',text:'SHOULD_NOT_RETRY'}]});assert.equal(invalid.isError,true);pass('unknown native accessibility refs are rejected');
  const updated=meta(await call('desktop_observe'));assert.ok(updated.accessibility.controls.some(c=>c.value==='原生无障碍中文填表'));pass('native accessibility reports the updated form value');
  assert.equal(updated.accessibility.controls.find(c=>c.name==='Native form input').ref,input.ref);pass('control refs survive observation-window refresh');
  assert.deepEqual(probe(),before);const unchanged=JSON.parse(await readFile(human.state,'utf8'));assert.equal(unchanged.text,'HUMAN_SENTINEL');assert.equal(unchanged.clicks,0);pass('human display focus, pointer and form remain unchanged');
  await writeFile(join(root,'artifacts/linux-accessibility-verification.json'),JSON.stringify({date:new Date().toISOString(),checks,referenceDisplayBefore:before,referenceDisplayAfter:probe(),scope:'Real GTK3 native application and native AT-SPI in one private Xvfb/D-Bus session; human simulated by a second private session. No screenshots taken. Other OS native accessibility unimplemented.'},null,2));
}finally{await client?.close().catch(()=>{});await transport?.close().catch(()=>{});await ai?.stop();await human?.stop();}
