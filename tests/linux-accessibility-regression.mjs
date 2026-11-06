import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {root,spawnReady,waitFor} from './helpers.mjs';

const python=process.env.IC_AX_PYTHON??'/usr/bin/python3',xvfb=process.env.IC_TEST_XVFB??'Xvfb';
const dir=await mkdtemp(join(tmpdir(),'ic-ax-regression-')),checks=[];
const pass=(version,name)=>{checks.push({version,name});console.log(`PASS GTK${version} ${name}`);};
const meta=r=>{assert.ok(!r.isError,r.content[0]?.text);assert.equal(r.content.some(c=>c.type==='image'),false);return JSON.parse(r.content[0].text);};
let human;
try {
  const humanState=join(dir,'human.json'),humanApps=join(dir,'human-apps.json');
  await writeFile(humanApps,JSON.stringify([[python,join(root,'tests/gtk_fixture.py'),'--state',humanState,'--sentinel','HUMAN_SENTINEL']]));
  human=await spawnReady(python,['desktop/linux_session.py','--xvfb',xvfb,'--token-file',join(dir,'human.token'),'--apps-file',humanApps]);
  await waitFor(()=>readFile(humanState,'utf8').then(JSON.parse));
  const probe=()=>JSON.parse(execFileSync(python,['tests/x11_probe.py',human.info.isolation.display],{cwd:root,encoding:'utf8'}));
  const before=probe();
  for(const version of ['3.0','4.0']) {
    let session,client,transport;
    const file=join(dir,version+'.json'),commands=join(dir,version+'-commands.json'),apps=join(dir,version+'-apps.json');
    const state=()=>readFile(file,'utf8').then(JSON.parse);
    let commandId=0;
    const change=async operation=>{const id=++commandId;await writeFile(commands,JSON.stringify({operation,id}));await waitFor(async()=>((await state()).command===id));};
    try {
      await writeFile(apps,JSON.stringify([[python,join(root,'tests/gtk_regression_fixture.py'),'--gtk',version,'--state',file,'--commands',commands]]));
      session=await spawnReady(python,['desktop/linux_session.py','--xvfb',xvfb,'--token-file',join(dir,version+'.token'),'--apps-file',apps]);
      await waitFor(state);
      transport=new StdioClientTransport({command:process.execPath,args:['src/server.mjs'],cwd:root,env:{...process.env,DISPLAY:human.info.isolation.display,IC_DESKTOP_URL:session.info.url,IC_DESKTOP_TOKEN_FILE:session.info.tokenFile}});
      client=new Client({name:'ax-regression',version:'1.0.0'});await client.connect(transport);
      const call=(name,args={})=>client.callTool({name,arguments:args});
      const observe=async()=>meta(await call('desktop_observe'));
      const act=async actions=>meta(await call('desktop_controls',{actions}));
      const tree=await waitFor(async()=>{const o=await observe();return o.accessibility.controls.some(c=>c.name==='Regression input')?o.accessibility:false;},10000);
      const find=(name,role)=>tree.controls.find(c=>c.name===name&&(!role||c.role===role));
      const input=find('Regression input'),button=find('Regression click','button'),dynamic=find('Regression dynamic','button');
      assert.ok(button.enabled&&button.available);assert.ok(button.states.includes('sensitive'));assert.ok(button.supportedActions.includes('click'));
      if(version==='4.0')assert.equal(button.states.includes('enabled'),false);
      assert.equal(tree.controls.some(c=>c.value==='PASSWORD_SENTINEL'||c.value==='HUMAN_SENTINEL'),false);
      pass(version,'raw states, normalized availability and password redaction');
      await act([{type:'fill',ref:input.ref,text:'原生状态回归测试'},{type:'click',ref:button.ref}]);
      await waitFor(async()=>{const s=await state();return s.text==='原生状态回归测试'&&s.clicks===1;});
      pass(version,'native fill and click verified by application state');
      const reject=async(action,pattern)=>{const r=await call('desktop_controls',{actions:[action]});assert.equal(r.isError,true);assert.equal(r.content.some(c=>c.type==='image'),false);assert.match(r.content[0].text,pattern);};
      for(const name of ['Regression disabled','Regression disabled ancestor']) {
        const node=find(name,'button');assert.equal(node.enabled,false);assert.equal(node.available,false);
        await reject({type:'click',ref:node.ref},/disabled/);
      }
      await reject({type:'fill',ref:find('Regression readonly').ref,text:'FORBIDDEN'},/read-only|not editable/);
      await reject({type:'fill',ref:find('Regression password').ref,text:'FORBIDDEN'},/EditableText/);
      const unsupported=find('Regression unsupported');assert.deepEqual(unsupported.supportedActions,[]);
      pass(version,'disabled controls, disabled ancestors, readonly and password rejected without screenshot fallback');
      const fallbackResult=await call('desktop_controls',{actions:[{type:'click',ref:button.ref},{type:'click',ref:unsupported.ref},{type:'click',ref:button.ref}]});
      assert.ok(!fallbackResult.isError,fallbackResult.content[0]?.text);
      const fallbackMeta=JSON.parse(fallbackResult.content.find(c=>c.type==='text').text);
      assert.equal(fallbackMeta.status,'needs_pixel_action');assert.equal(fallbackMeta.fallback.kind,'screenshot');
      assert.equal(fallbackMeta.fallback.completedActions,1);assert.equal(fallbackMeta.fallback.pendingActions.length,2);
      assert.equal(fallbackMeta.fallback.target.ref,unsupported.ref);assert.ok(fallbackResult.content.some(c=>c.type==='image'&&c.mimeType==='image/png'));
      const fallbackImage=fallbackResult.content.find(c=>c.type==='image');
      await writeFile(join(root,`artifacts/gtk${version}-fallback.png`),Buffer.from(fallbackImage.data,'base64'));
      await writeFile(join(root,`artifacts/gtk${version}-fallback.json`),JSON.stringify(fallbackMeta,null,2));
      await waitFor(async()=>(await state()).clicks===2);assert.equal((await state()).fallbackClicks,0);
      const bounds=fallbackMeta.fallback.target.bounds;assert.ok(bounds&&bounds.width>0&&bounds.height>0);
      // GTK4 can report the wrong SCREEN origin. The screenshot is what a model
      // inspects; this deterministic test uses the fixture's real allocation,
      // matching the target visibly located at y=294..342 in the saved image.
      const visualBounds=(await state()).fallbackBounds;
      const x=visualBounds.x+visualBounds.width/2,y=visualBounds.y+visualBounds.height/2;
      assert.ok(x>=0&&x<fallbackMeta.width&&y>=0&&y<fallbackMeta.height);
      meta(await call('desktop_act',{actions:[{type:'click',x,y}],capture:'none'}));
      await waitFor(async()=>(await state()).fallbackClicks===1);assert.equal((await state()).clicks,2);
      pass(version,'missing native click returns screenshot; prior actions counted, later actions paused, explicit pixel click verified');
      const noRefresh=async()=>call('desktop_controls',{actions:[{type:'click',ref:dynamic.ref}]});
      await change('disable');let r=await noRefresh();assert.equal(r.isError,true);assert.match(r.content[0].text,/disabled/);
      await change('enable');meta(await noRefresh());await waitFor(async()=>(await state()).dynamicClicks===1);
      // GTK4 can keep SHOWING/VISIBLE on a hidden object; its native Action
      // must still reject it. Assert the actual effect below as well.
      await change('hide');r=await noRefresh();assert.equal(r.isError,true);assert.match(r.content[0].text,/showing|unavailable|AT-SPI action was rejected/);
      await change('show');meta(await noRefresh());await waitFor(async()=>(await state()).dynamicClicks===2);
      pass(version,'live enabled changes refreshed, hidden action rejected, visible action restored without another observation');
      await change('remove');r=await noRefresh();assert.equal(r.isError,true);assert.match(r.content[0].text,/unavailable|stale|showing|disabled/);
      await observe();await reject({type:'click',ref:dynamic.ref},/Unknown or stale/);
      await reject({type:'click',ref:'atspi-unknown'},/Unknown or stale/);
      pass(version,'removed and unknown references rejected');
      const final=await state();assert.equal(final.disabledClicks,0);assert.equal(final.ancestorClicks,0);assert.equal(final.readonly,'READONLY_SENTINEL');assert.equal(final.dynamicClicks,2);assert.equal(final.fallbackClicks,1);
      assert.deepEqual(probe(),before);const humanFinal=JSON.parse(await readFile(humanState,'utf8'));assert.equal(humanFinal.text,'HUMAN_SENTINEL');assert.equal(humanFinal.clicks,0);
      pass(version,'rejected actions have no effect and separate human focus/pointer/form preserved');
    } finally {await client?.close().catch(()=>{});await transport?.close().catch(()=>{});await session?.stop();}
  }
  await writeFile(join(root,'artifacts/linux-accessibility-regression.json'),JSON.stringify({date:new Date().toISOString(),passed:true,checks,scope:'Real GTK3/GTK4, private D-Bus and managed Xvfb; native actions use no screenshots/mouse/clipboard; missing native clicks return a screenshot and require explicit pixel continuation'},null,2));
} finally {await human?.stop();}
