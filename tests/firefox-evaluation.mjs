import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn,execFileSync } from 'node:child_process';
import { mkdtemp,readFile,writeFile,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnReady,root,waitFor } from './helpers.mjs';
import { FirefoxDriver,driverAddress } from './firefox-driver.mjs';

const directory=await mkdtemp(join(tmpdir(),'ic-firefox-eval-'));
const report={date:new Date().toISOString(),environment:{systemBinary:'/snap/firefox/current/usr/lib/firefox/firefox',systemDriver:'/snap/firefox/current/usr/lib/firefox/geckodriver',launch:'System-installed Snap package binaries invoked directly; Snap launcher failed in private D-Bus session. Browser process sandbox not disabled.',display:'private Xvfb',windowManager:'Openbox 3.6.1',human:'Simulated human window inside same private display; real user desktop/profile untouched'},cases:[],benchmarks:{},limitations:[]};
const servers=[];let session,driver,client,transport,watch;
const caseRun=async(name,fn,status='PASS')=>{const start=performance.now();try{const evidence=await fn();if(evidence?.inconclusive)status='INCONCLUSIVE';report.cases.push({name,status,ms:performance.now()-start,evidence});console.log(status+' '+name);return evidence;}catch(e){report.cases.push({name,status:'FAIL',ms:performance.now()-start,error:e.message});console.log('FAIL '+name+': '+e.message.slice(0,400));return null;}};
const meta=r=>{assert.ok(!r.isError,r.content[0]?.text);return JSON.parse(r.content[0].text);};
const stats=a=>{const b=[...a].sort((x,y)=>x-y);return{samples:b.length,medianMs:b[Math.floor(b.length/2)],p95Ms:b[Math.ceil(b.length*.95)-1],minMs:b[0],maxMs:b.at(-1)};};
async function serve(){let html;const server=createServer((req,res)=>{if(req.url==='/frame'){res.setHeader('Content-Type','text/html');res.end('<label>Iframe 字段<input aria-label="Iframe 字段"></label>');return;}if(req.url==='/event'){req.resume();res.end('ok');return;}res.setHeader('Content-Type','text/html');res.end(html??'starting');});await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);return{url:`http://127.0.0.1:${server.address().port}`,set:s=>html=s};}
const first=await serve(),cross=await serve();first.set((await readFile(join(root,'tests/firefox-fixture.html'),'utf8')).replace('__CROSS_URL__',cross.url));
async function extensionScript(body,args=[]){return driver.asyncExecute(`const done=arguments[arguments.length-1];(async()=>{${body}})().then(v=>done({result:v}),e=>done({error:String(e.stack??e)}));`,args).then(r=>{if(r.error)throw new Error(r.error);return r.result;});}
async function uiMessage(message){return extensionScript('const r=await browser.runtime.sendMessage(arguments[0]);if(r.error)throw new Error(r.error);return r.result;',[message]);}
async function inspect(tab){return extensionScript(`const r=await browser.scripting.executeScript({target:{tabId:arguments[0]},func:()=>({state:JSON.parse(document.getElementById('result').textContent),name:document.getElementById('name').value,url:location.href})});return r[0].result;`,[Number(tab)]);}
async function probe(){return JSON.parse(execFileSync('/usr/bin/python3',['tests/x11_probe.py',session.info.isolation.display],{cwd:root,encoding:'utf8'}));}
async function focus(windowId){const active=JSON.parse(execFileSync('/usr/bin/python3',['tests/focus-window.py',session.info.isolation.display,'Firefox evaluation HUMAN'],{cwd:root,encoding:'utf8'}));report.humanFocusTarget={...active,browserWindowId:windowId};await new Promise(r=>setTimeout(r,150));return probe();}
async function monitorStart(label){const path=join(directory,label+'.json');const child=spawn('/usr/bin/python3',['tests/focus-watch.py',session.info.isolation.display,path],{cwd:root,stdio:'ignore'});watch={child,path};await new Promise(r=>setTimeout(r,80));}
async function monitorStop(){const current=watch;watch=null;await new Promise(r=>{current.child.once('exit',r);current.child.kill('SIGTERM');});return JSON.parse(await readFile(current.path,'utf8'));}
async function rssTree(pid){const map=new Map();for(const name of await readdir('/proc')){if(!/^\d+$/.test(name))continue;try{const text=await readFile('/proc/'+name+'/stat','utf8'),f=text.slice(text.lastIndexOf(')')+2).split(' ');map.set(Number(name),{parent:Number(f[1]),rss:Number(f[21])*4096});}catch{}}const ids=new Set([pid]);let change=true;while(change){change=false;for(const[id,p]of map)if(ids.has(p.parent)&&!ids.has(id)){ids.add(id);change=true;}}return{processes:ids.size,summedRSSMiB:[...ids].reduce((n,id)=>n+(map.get(id)?.rss??0),0)/1024**2,note:'Summed RSS double-counts shared pages. Test browser has extension and multiple fixture tabs; not M1 memory usage.'};}
try{
  const wm=process.env.IC_TEST_OPENBOX??'/tmp/ic-firefox-wm/usr/bin/openbox';
  const wmLibrary=process.env.IC_TEST_OPENBOX_LIB??'/tmp/ic-firefox-wm/usr/lib/x86_64-linux-gnu';
  const wmConfig=join(directory,'openbox.xml');await writeFile(wmConfig,'<openbox_config xmlns="http://openbox.org/3.4/rc"><focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus></openbox_config>');
  const apps=join(directory,'apps.json');await writeFile(apps,JSON.stringify([['env',`LD_LIBRARY_PATH=${wmLibrary}`,'XDG_DATA_DIRS=/tmp/ic-firefox-wm/usr/share:/usr/local/share:/usr/share',wm,'--config-file',wmConfig],[report.environment.systemDriver,'--port','0','--allow-system-access','--log','info']]));
  session=await spawnReady('/usr/bin/python3',['desktop/linux_session.py','--xvfb',process.env.IC_TEST_XVFB??'Xvfb','--width','1280','--height','1000','--token-file',join(directory,'bridge.token'),'--apps-file',apps]);report.environment.display=session.info.isolation.display;
  driver=new FirefoxDriver(await driverAddress(session));const started=await driver.start();report.environment.version=started.capabilities.browserVersion;report.environment.browserPID=started.capabilities['moz:processID'];
  await caseRun('system Firefox starts with real window manager',async()=>{assert.equal(started.capabilities.browserVersion,'156.0.1');const wmProperty=execFileSync('/usr/bin/xprop',['-display',session.info.isolation.display,'-root','_NET_SUPPORTING_WM_CHECK'],{encoding:'utf8'});assert.match(wmProperty,/window id/);return{version:started.capabilities.browserVersion,headless:started.capabilities['moz:headless'],driverVersion:started.capabilities['moz:geckodriverVersion'],wmProperty:wmProperty.trim()};});
  const archive=join(directory,'firefox.zip');execFileSync('/usr/bin/python3',['-c',"from pathlib import Path;from zipfile import ZipFile;import sys;r=Path(sys.argv[1]);z=ZipFile(sys.argv[2],'w');[z.write(p,p.relative_to(r)) for p in r.rglob('*') if p.is_file()];z.close()",join(root,'dist/extensions/firefox'),archive]);
  report.environment.extensionSHA256=createHash('sha256').update(await readFile(archive)).digest('hex');
  await driver.cmd('/window/rect',{width:1280,height:950});
  const addon=await driver.cmd('/moz/addon/install',{addon:(await readFile(archive)).toString('base64'),temporary:true});
  const optionsURL=await driver.extensionURL(addon);await driver.navigate(optionsURL);
  await caseRun('generated Firefox extension installs and receives runtime messages',async()=>{const result=await waitFor(()=>uiMessage({op:'list'}));return{addon,tabs:result.tabs.length};});
  transport=new StdioClientTransport({command:process.execPath,args:['src/server.mjs'],cwd:root,env:{...process.env,IC_DESKTOP_URL:session.info.url,IC_DESKTOP_TOKEN_FILE:session.info.tokenFile}});
  client=new Client({name:'system-firefox-evaluator',version:'1.0.0'});await client.connect(transport);const call=(name,args={})=>client.callTool({name,arguments:args});
  const status=meta(await call('computer_status'));
  const paired=await caseRun('Firefox extension connects to real MCP via authenticated WebSocket',()=>uiMessage({op:'connect',pairing:status.extensionURL}));
  if(!paired)throw new Error('Extension/MCP prerequisite failed');
  const form=await extensionScript('return browser.tabs.create({url:arguments[0],active:false});',[first.url+'/form']);
  const humanWindow=await extensionScript('return browser.windows.create({url:arguments[0],focused:true});',[first.url+'/human']);const human=humanWindow.tabs[0];
  await waitFor(()=>inspect(form.id));await waitFor(()=>inspect(human.id));
  await extensionScript(`for(const [tabId,value] of arguments[0])await browser.scripting.executeScript({target:{tabId},func:value=>{document.title=value==='HUMAN_SENTINEL'?'Firefox evaluation HUMAN':'Firefox evaluation AI';document.cookie='session=existing-login;path=/';const el=document.getElementById('name');document.getElementById('editor').focus();el.focus();el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},args:[value]});return true;`,[[[form.id,'用户已填一半'],[human.id,'HUMAN_SENTINEL']]]);
  await caseRun('real native browser-action toolbar button can be clicked during setup',async()=>{
    await driver.context('chrome');
    try{
      const widget=await driver.execute(`const UI=window.CustomizableUI??ChromeUtils.importESModule('moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs').CustomizableUI;const id=arguments[0].toLowerCase().replace(/[^a-z0-9_-]/g,'_')+'-browser-action';UI.addWidgetToArea(id,UI.AREA_NAVBAR);const form=[...window.gBrowser.tabs].find(t=>t.linkedBrowser.currentURI.spec===arguments[1]);if(!form)throw new Error('Form tab not in driver chrome window');window.gBrowser.selectedTab=form;if(window.gBrowser.selectedBrowser.currentURI.spec!==arguments[1])throw new Error('Native toolbar tab selection failed');window.focus();return id;`,[addon,first.url+'/form']);
      const element=await driver.cmd('/element',{using:'css selector',value:'#'+widget});
      await driver.cmd('/element/'+element['element-6066-11e4-a52e-4f735466cecf']+'/click',{});
      await new Promise(r=>setTimeout(r,200));
      await driver.execute(`for(const panel of window.document.querySelectorAll('panel'))if(panel.state==='open')panel.hidePopup();window.gBrowser.selectedTab=[...window.gBrowser.tabs].find(t=>t.linkedBrowser.currentURI.spec===arguments[0]);`,[optionsURL]);
      return{widget,userGesture:'WebDriver click on native Firefox browser-action button'};
    }finally{await driver.context('content');}
  });
  await caseRun('optional capture authorization before moving live tab',async()=>{const result=await extensionScript('const data=await browser.tabs.captureVisibleTab(arguments[0],{format:"jpeg"});return {bytes:data.length};',[form.windowId]);report.captureBeforeMove=result;return result?.bytes>0?result:{inconclusive:true,reason:'WebDriver extension-page probe returned null; pre-transfer permission was not established.'};});
  const beforeState=(await inspect(form.id)).state,baseline=await focus(humanWindow.id);await monitorStart('handoff-focus');
  const transferred=await caseRun('live-tab handoff preserves form, login and JS memory',async()=>{const result=await uiMessage({op:'handoff',tabId:form.id,task:'继续填写，完成后通知我，不提交。'});const after=(await inspect(form.id)).state;assert.equal(after.name,beforeState.name);assert.equal(after.nonce,beforeState.nonce);assert.match(after.cookie,/session=existing-login/);return result;});
  report.handoffFocus=await monitorStop();
  await caseRun('handoff does not change human focus or pointer, including sampled transient changes',async()=>{assert.deepEqual(await probe(),baseline);assert.ok(report.handoffFocus.changes.every(c=>c.focus===baseline.focus&&JSON.stringify(c.pointer)===JSON.stringify(baseline.pointer)));return report.handoffFocus;});
  if(!transferred)throw new Error('Handoff prerequisite failed');
  const tab=String(form.id);const observe=()=>call('handoff_observe',{tab});let tree=meta(await observe());
  await caseRun('lease scope excludes unrelated human tab and observation has no image',async()=>{const result=await observe();assert.ok(!result.content.some(c=>c.type==='image'));const tabs=meta(await call('handoff_tabs'));assert.equal(tabs.tabs.length,1);assert.equal(tabs.tabs[0].tab,tab);return{source:meta(result).accessibility.source,controls:meta(result).accessibility.controls.length};});
  const control=label=>{const found=tree.accessibility.controls.find(c=>c.label===label);if(!found)throw new Error('Control missing: '+label);return found.ref;};
  const act=async actions=>{const result=meta(await call('handoff_controls',{tab,actions}));tree=result;return result;};
  await focus(humanWindow.id);const inputBaseline=await probe();await monitorStart('semantic-focus');
  await caseRun('semantic refs survive repeated observation',async()=>{const ref=control('姓名');tree=meta(await observe());assert.equal(control('姓名'),ref);return{stable:true};});
  await caseRun('Chinese text and textarea fill update application state',async()=>{await act([{type:'fill',ref:control('姓名'),text:'用户已填一半，Firefox AI 接力'},{type:'fill',ref:control('备注'),text:'第一行中文\n第二行 emoji 😀'}]);const s=(await inspect(tab)).state;assert.equal(s.name,'用户已填一半，Firefox AI 接力');assert.equal(s.notes,'第一行中文\n第二行 emoji 😀');return{name:s.name,notes:s.notes};});
  await caseRun('ordinary button and custom role button click',async()=>{await act([{type:'click',ref:control('计数按钮')},{type:'click',ref:control('自定义语义按钮')}]);const s=(await inspect(tab)).state;assert.equal(s.clicks,1);assert.equal(s.custom,1);return{clicks:s.clicks,custom:s.custom};});
  await caseRun('select changes native HTML selection and emits change',async()=>{await act([{type:'select',ref:control('地区'),value:'sh'}]);const s=(await inspect(tab)).state;assert.equal(s.region,'sh');return{region:s.region,changes:s.changes};});
  await caseRun('select works by control type even when DOM name is polluted',async()=>{const select=tree.accessibility.controls.find(c=>c.tag==='select');await act([{type:'select',ref:select.ref,value:'bj'}]);assert.equal((await inspect(tab)).state.region,'bj');return{selection:'bj',reportedLabel:select.label};});
  await caseRun('checkbox and mutually exclusive radio selection',async()=>{await act([{type:'check',ref:control('同意测试条款'),checked:true},{type:'check',ref:control('第一选项'),checked:true},{type:'check',ref:control('第二选项'),checked:true}]);const s=(await inspect(tab)).state;assert.equal(s.agree,true);assert.equal(s.r1,false);assert.equal(s.r2,true);return{agree:s.agree,r1:s.r1,r2:s.r2};});
  await caseRun('disabled/read-only/password controls reject filling and password value is masked',async()=>{for(const label of ['禁用字段','只读字段','密码']){const r=await call('handoff_controls',{tab,actions:[{type:'fill',ref:control(label),text:'MUST_NOT_WRITE'}]});assert.equal(r.isError,true);}assert.equal(tree.accessibility.controls.find(c=>c.label==='密码').value,undefined);const s=(await inspect(tab)).state;assert.equal(s.disabled,'DISABLED_SENTINEL');assert.equal(s.readonly,'READONLY_SENTINEL');return{protected:true};});
  await caseRun('synthetic events cannot activate trusted-only widget',async()=>{await act([{type:'click',ref:control('可信事件按钮')}]);const s=(await inspect(tab)).state;assert.equal(s.trustedAccepted,0);assert.equal(s.trustedRejected,1);return{trustedAccepted:s.trustedAccepted,trustedRejected:s.trustedRejected};},'LIMITATION');
  await caseRun('contenteditable rich text is not supported',async()=>{const r=await call('handoff_controls',{tab,actions:[{type:'fill',ref:control('富文本编辑器'),text:'rich text'}]});assert.equal(r.isError,true);return{error:r.content[0].text};},'LIMITATION');
  await caseRun('iframe, shadow root and offscreen controls are absent from DOM snapshot',async()=>{const names=tree.accessibility.controls.map(c=>c.label);for(const label of ['Iframe 字段','Shadow 字段','视口外字段'])assert.ok(!names.includes(label));return{missing:['same-origin iframe','cross-origin iframe','shadow root','offscreen controls']};},'LIMITATION');
  await caseRun('aria-labelledby computed accessible name is missing in DOM fallback',async()=>{assert.ok(!tree.accessibility.controls.some(c=>c.label==='引用标签按钮'));return{nativeNameNotResolved:true};},'LIMITATION');
  await caseRun('canvas/pixel gesture rejected before input',async()=>{const r=await call('handoff_act',{tab,actions:[{type:'click',x:100,y:100}]});assert.equal(r.isError,true);assert.equal((await inspect(tab)).state.canvasEvents,0);return{error:r.content[0].text};},'LIMITATION');
  await caseRun('removed control reference is rejected',async()=>{const old=control('姓名');await act([{type:'click',ref:control('替换姓名字段')}]);const r=await call('handoff_controls',{tab,actions:[{type:'fill',ref:old,text:'STALE'}]});assert.equal(r.isError,true);return{staleRefRejected:true};});
  report.semanticFocus=await monitorStop();
  await caseRun('background semantic operation does not affect human input, focus or pointer',async()=>{assert.deepEqual(await probe(),inputBaseline);assert.ok(report.semanticFocus.changes.every(c=>c.focus===inputBaseline.focus&&JSON.stringify(c.pointer)===JSON.stringify(inputBaseline.pointer)));assert.equal((await inspect(human.id)).name,'HUMAN_SENTINEL');return report.semanticFocus;});
  const samples=25;const observeTimes=[],fillTimes=[],pngTimes=[];
  for(let i=0;i<samples+3;i++){let start=performance.now();tree=meta(await observe());if(i>=3)observeTimes.push(performance.now()-start);start=performance.now();await act([{type:'fill',ref:control('姓名'),text:'性能测试中文 '+i}]);if(i>=3)fillTimes.push(performance.now()-start);}
  for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,600));const start=performance.now(),r=await call('handoff_observe',{tab,capture:'png'});const info=meta(r),image=r.content.find(c=>c.type==='image');if(image){pngTimes.push(performance.now()-start);if(i===0){const buffer=Buffer.from(image.data,'base64');await writeFile(join(root,'artifacts/firefox-handoff.png'),buffer);report.screenshot={width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20),bytes:buffer.length};}}else report.screenshot={error:info.screenshotError};}
  report.benchmarks={observe:stats(observeTimes),fillAndObserve:stats(fillTimes),...(pngTimes.length?{pngAndObserve:stats(pngTimes)}:{}),scope:'Actual local MCP → Firefox extension → DOM round trip in system Firefox. Human-focus sampler stopped during benchmark. Excludes model, website network and VM latency.'};
  await caseRun('optional screenshot works without human activation',async()=>{assert.ok(pngTimes.length>0,JSON.stringify(report.screenshot));assert.deepEqual(await probe(),inputBaseline);return report.screenshot;});
  await caseRun('completion pauses, notification request does not activate window, explicit take-back restores live tab',async()=>{const done=meta(await call('handoff_request_user',{tab,kind:'complete',reason:'评测表格已填写，请接回检查。'}));assert.equal(done.state,'complete');assert.equal((await call('handoff_controls',{tab,actions:[{type:'click',ref:control('计数按钮')}]})).isError,true);assert.deepEqual(await probe(),inputBaseline);await uiMessage({op:'takeBack',tab});const location=await extensionScript('return browser.tabs.get(arguments[0]);',[form.id]);assert.equal(location.windowId,form.windowId);assert.equal((await inspect(tab)).state.nonce,beforeState.nonce);return{state:done.state,notificationRequested:done.notificationRequested,tabRestored:true};});
  await focus(humanWindow.id);await uiMessage({op:'handoff',tabId:form.id,task:'提交确认测试'});tree=meta(await observe());
  await caseRun('conventional submission pauses before application submit',async()=>{const r=await call('handoff_controls',{tab,actions:[{type:'click',ref:control('提交表格')}]});assert.equal(r.isError,true);assert.equal((await inspect(tab)).state.submitted,0);assert.equal(meta(await call('handoff_tabs')).tabs[0].state,'waiting_user');return{submissions:0,state:'waiting_user'};});
  // Read native Firefox accessibility separately. This is not the DOM handoff path.
  let nativeTree;
  await caseRun('system AT-SPI can read Firefox native computed roles/names',async()=>{const r=await call('desktop_observe');const m=meta(r);assert.ok(!r.content.some(c=>c.type==='image'));const ax=m.accessibility;nativeTree=ax;await writeFile(join(root,'artifacts/firefox-native-accessibility.json'),JSON.stringify(ax,null,2));const names=ax.controls.map(c=>c.name);assert.ok(names.includes('姓名')||names.includes('姓名 '),'Native form field not in bounded tree');report.nativeAX={source:ax.source,count:ax.controls.length,truncated:ax.truncated,warnings:ax.warnings,names:ax.controls.filter(c=>['姓名','富文本编辑器','引用标签按钮','Iframe 字段','Shadow 字段','视口外字段'].some(n=>c.name.includes(n))).map(c=>({role:c.role,name:c.name,interfaces:c.interfaces}))};return report.nativeAX;});
  if(nativeTree){
    const nativeBaseline=await focus(humanWindow.id);await monitorStart('native-focus');
    await caseRun('Firefox native EditableText fills live form without clipboard or pixel input',async()=>{const field=nativeTree.controls.find(c=>c.role==='entry'&&c.name==='姓名'&&c.value?.startsWith('性能测试'));assert.ok(field);const r=meta(await call('desktop_controls',{actions:[{type:'fill',ref:field.ref,text:'AT-SPI 原生接力中文'}]}));nativeTree=r.accessibility;await waitFor(async()=>(await inspect(tab)).name==='AT-SPI 原生接力中文');return{role:field.role,interface:'EditableText'};});
    await caseRun('Firefox native Action produces trusted event for guarded widget',async()=>{const button=nativeTree.controls.filter(c=>c.role==='button'&&c.name==='可信事件按钮').at(-1);assert.ok(button);const before=(await inspect(tab)).state.trustedAccepted;const r=meta(await call('desktop_controls',{actions:[{type:'click',ref:button.ref}]}));nativeTree=r.accessibility;await waitFor(async()=>(await inspect(tab)).state.trustedAccepted>before);return{trustedAccepted:(await inspect(tab)).state.trustedAccepted};});
    await caseRun('native provider resolves aria-labelledby, Shadow DOM, iframe and offscreen controls',async()=>{for(const name of ['引用标签按钮','Shadow 字段','Iframe 字段','视口外字段'])assert.ok(nativeTree.controls.some(c=>c.name===name));return{computedName:true,shadow:true,iframe:true,offscreen:true};});
    await caseRun('native EditableText supports contenteditable rich text',async()=>{const field=nativeTree.controls.filter(c=>c.role==='entry'&&c.name==='富文本编辑器').at(-1);assert.ok(field);const r=meta(await call('desktop_controls',{actions:[{type:'fill',ref:field.ref,text:'原生富文本填充'}]}));nativeTree=r.accessibility;const read=()=>extensionScript('const r=await browser.scripting.executeScript({target:{tabId:arguments[0]},func:()=>document.getElementById("editor").textContent});return r[0].result;',[form.id]);await waitFor(async()=>(await read())==='原生富文本填充');return{value:await read()};});
    report.nativeFocus=await monitorStop();
    await caseRun('native Firefox actions preserve human focus and input',async()=>{assert.deepEqual(await probe(),nativeBaseline);assert.ok(report.nativeFocus.changes.every(c=>c.focus===nativeBaseline.focus));assert.equal((await inspect(human.id)).name,'HUMAN_SENTINEL');return report.nativeFocus;});
    const nativeSamples=[];for(let i=0;i<10;i++){const begin=performance.now();meta(await call('desktop_observe'));nativeSamples.push(performance.now()-begin);}report.benchmarks.nativeFullTreeObserve=stats(nativeSamples);
    report.benchmarks.nativeScope='Application-wide tree includes Firefox UI and both test windows; native actions tested on private isolated desktop, not integrated with live-tab leases.';
  }
  report.processTree=await rssTree(report.environment.browserPID);report.pluginProcessTree=await rssTree(transport.pid);
  await uiMessage({op:'takeBack',tab});
  await focus(humanWindow.id);await uiMessage({op:'handoff',tabId:form.id,task:'后台持续运行评测'});
  await driver.navigate('about:blank');
  console.log('TEST idle lifecycle: settings page closed; waiting 45 seconds');
  const idleStart=performance.now();await new Promise(r=>setTimeout(r,45000));
  await caseRun('handoff remains connected after settings page closes and 45 seconds idle',async()=>{const r=await Promise.race([call('handoff_observe',{tab}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('No response within 5 seconds after idle')),5000))]);const m=meta(r);assert.equal(m.state,'running');return{idleMs:performance.now()-idleStart,state:m.state};});
  await driver.navigate(optionsURL);await waitFor(()=>uiMessage({op:'list'}));await uiMessage({op:'takeBack',tab});
}catch(e){report.fatal=e.message;report.diagnostics=session?.stderr().slice(-5000);console.log('EVALUATION FATAL '+e.message.slice(0,1000));}
finally{
  report.runtimeLog=session?.stderr().slice(-12000);
  if(watch)await monitorStop().catch(()=>{});
  await client?.close().catch(()=>{});await transport?.close().catch(()=>{});await driver?.close();await session?.stop();
  await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));
  report.summary=Object.fromEntries(['PASS','FAIL','LIMITATION','INCONCLUSIVE'].map(s=>[s,report.cases.filter(c=>c.status===s).length]));
  await writeFile(join(root,'artifacts/firefox-evaluation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({summary:report.summary,benchmarks:report.benchmarks,fatal:report.fatal},null,2));
}
