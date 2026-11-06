import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn,execFileSync } from 'node:child_process';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnReady,root,waitFor } from './helpers.mjs';
import { FirefoxDriver,driverAddress } from './firefox-driver.mjs';

const focusedOnly=process.argv.includes('--concurrent-only');
const directory=await mkdtemp(join(tmpdir(),'ic-firefox-scenarios-'));
const report={date:new Date().toISOString(),environment:{systemBinary:process.env.IC_TEST_FIREFOX_BINARY??(existsSync('/snap/firefox/current/usr/lib/firefox/firefox')?'/snap/firefox/current/usr/lib/firefox/firefox':'firefox'),systemDriver:process.env.IC_TEST_GECKODRIVER??(existsSync('/snap/firefox/current/usr/lib/firefox/geckodriver')?'/snap/firefox/current/usr/lib/firefox/geckodriver':'geckodriver'),launch:'System-installed Snap package binaries invoked directly; Snap launcher failed in private D-Bus session. Browser process sandbox not disabled.',display:'private Xvfb',windowManager:'Openbox 3.6.1',human:'Simulated human window inside same private display; real user desktop/profile untouched'},cases:[],benchmarks:{},limitations:[]};
const servers=[];let session,driver,client,transport,watch;
const caseRun=async(name,fn,status='PASS')=>{const start=performance.now();try{const evidence=await fn();if(evidence?.inconclusive)status='INCONCLUSIVE';report.cases.push({name,status,ms:performance.now()-start,evidence});console.log(status+' '+name);return evidence;}catch(e){report.cases.push({name,status:'FAIL',ms:performance.now()-start,error:e.message});console.log('FAIL '+name+': '+e.message.slice(0,400));return null;}};
const meta=r=>{assert.ok(!r.isError,r.content[0]?.text);return JSON.parse(r.content[0].text);};
async function serve(){let html;const server=createServer((req,res)=>{if(req.url==='/frame'){res.setHeader('Content-Type','text/html');res.end('<label>Iframe 字段<input aria-label="Iframe 字段"></label>');return;}if(req.url==='/event'){req.resume();res.end('ok');return;}res.setHeader('Content-Type','text/html');res.end(html??'starting');});await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);return{url:`http://127.0.0.1:${server.address().port}`,set:s=>html=s};}
const first=await serve(),cross=await serve();first.set((await readFile(join(root,'tests/firefox-fixture.html'),'utf8')).replace('__CROSS_URL__',cross.url));
async function extensionScript(body,args=[]){return driver.asyncExecute(`const done=arguments[arguments.length-1];(async()=>{${body}})().then(v=>done({result:v}),e=>done({error:String(e.stack??e)}));`,args).then(r=>{if(r.error)throw new Error(r.error);return r.result;});}
async function uiMessage(message){return extensionScript('const r=await browser.runtime.sendMessage(arguments[0]);if(r.error)throw new Error(r.error);return r.result;',[message]);}
async function inspect(tab){return extensionScript(`const r=await browser.scripting.executeScript({target:{tabId:arguments[0]},func:()=>({state:JSON.parse(document.getElementById('result').textContent),name:document.getElementById('name').value,url:location.href})});return r[0].result;`,[Number(tab)]);}
async function probe(){return JSON.parse(execFileSync('/usr/bin/python3',['tests/x11_probe.py',session.info.isolation.display],{cwd:root,encoding:'utf8'}));}
async function focus(windowId){const active=JSON.parse(execFileSync('/usr/bin/python3',['tests/focus-window.py',session.info.isolation.display,'Firefox evaluation HUMAN'],{cwd:root,encoding:'utf8'}));report.humanFocusTarget={...active,browserWindowId:windowId};await new Promise(r=>setTimeout(r,150));return probe();}
async function monitorStart(label){const path=join(directory,label+'.json');const child=spawn('/usr/bin/python3',['tests/focus-watch.py',session.info.isolation.display,path],{cwd:root,stdio:'ignore'});watch={child,path};await new Promise(r=>setTimeout(r,80));}
async function monitorStop(){const current=watch;watch=null;await new Promise(r=>{current.child.once('exit',r);current.child.kill('SIGTERM');});return JSON.parse(await readFile(current.path,'utf8'));}
try{
  const wm=process.env.IC_TEST_OPENBOX??'openbox';
  const wmEnv=[...(process.env.IC_TEST_OPENBOX_LIB?[`LD_LIBRARY_PATH=${process.env.IC_TEST_OPENBOX_LIB}`]:[]),...(process.env.IC_TEST_OPENBOX_DATA?[`XDG_DATA_DIRS=${process.env.IC_TEST_OPENBOX_DATA}:/usr/local/share:/usr/share`]:[])];
  const wmConfig=join(directory,'openbox.xml');await writeFile(wmConfig,'<openbox_config xmlns="http://openbox.org/3.4/rc"><focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus></openbox_config>');
  const apps=join(directory,'apps.json');await writeFile(apps,JSON.stringify([['env',...wmEnv,wm,'--config-file',wmConfig],[report.environment.systemDriver,'--port','0','--allow-system-access','--log','info']]));
  session=await spawnReady('/usr/bin/python3',['desktop/linux_session.py','--xvfb',process.env.IC_TEST_XVFB??'Xvfb','--width','1280','--height','1000','--token-file',join(directory,'bridge.token'),'--apps-file',apps]);report.environment.display=session.info.isolation.display;
  driver=new FirefoxDriver(await driverAddress(session));const started=await driver.start();report.environment.version=started.capabilities.browserVersion;report.environment.browserPID=started.capabilities['moz:processID'];
  await caseRun('system Firefox starts with real window manager',async()=>{assert.match(started.capabilities.browserVersion,/^\d+(?:\.\d+)*$/);if(process.env.IC_TEST_FIREFOX_VERSION)assert.equal(started.capabilities.browserVersion,process.env.IC_TEST_FIREFOX_VERSION);const wmProperty=execFileSync('/usr/bin/xprop',['-display',session.info.isolation.display,'-root','_NET_SUPPORTING_WM_CHECK'],{encoding:'utf8'});assert.match(wmProperty,/window id/);return{version:started.capabilities.browserVersion,headless:started.capabilities['moz:headless'],driverVersion:started.capabilities['moz:geckodriverVersion'],wmProperty:wmProperty.trim()};});
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

  // Resolve the human WebDriver handle before leasing the AI tab. Enumerating
  // windows after handoff can activate the leased tab and correctly pause it.
  let humanHandle,optionsHandle;
  if(focusedOnly){
    optionsHandle=await driver.cmd('/window');const handles=await driver.cmd('/window/handles');
    for(const handle of handles){await driver.cmd('/window',{handle});if(await driver.execute('return document.title')==='Firefox evaluation HUMAN'){humanHandle=handle;break;}}
    assert.ok(humanHandle,'human WebDriver window found before handoff');await driver.cmd('/window',{handle:optionsHandle});
  }
  const tab=String(form.id),beforeState=(await inspect(form.id)).state;
  const locations=await extensionScript('return {tabs:await browser.tabs.query({}),windows:await browser.windows.getAll()};');
  const baseline=await focus(humanWindow.id);await monitorStart('in-place-handoff');
  await caseRun('in-place handoff retains window, index, form, cookie and live JS state',async()=>{
    const result=await uiMessage({op:'handoff',tabId:form.id,task:'原标签页后台接力'});assert.equal(result.placement,'original-tab');
    const after=await extensionScript('return {tab:await browser.tabs.get(arguments[0]),tabs:await browser.tabs.query({}),windows:await browser.windows.getAll()};',[form.id]);
    assert.equal(after.tab.windowId,form.windowId);assert.equal(after.tab.index,form.index);
    assert.equal(after.tabs.length,locations.tabs.length);assert.equal(after.windows.length,locations.windows.length);
    const state=(await inspect(tab)).state;assert.equal(state.name,beforeState.name);assert.equal(state.nonce,beforeState.nonce);assert.equal(state.cookie,beforeState.cookie);
    return {placement:result.placement,windowUnchanged:true,noNewTabOrWindow:true,liveStatePreserved:true};
  });
  report.handoffFocus=await monitorStop();
  function focusUnchanged(samples,expected){assert.ok(samples.changes.every(c=>c.focus===expected.focus&&JSON.stringify(c.pointer)===JSON.stringify(expected.pointer)));}
  await caseRun('handoff leaves physical human focus and pointer unchanged under Openbox',async()=>{assert.deepEqual(await probe(),baseline);focusUnchanged(report.handoffFocus,baseline);return report.handoffFocus;});
  let tree=meta(await call('handoff_observe',{tab}));
  const ref=()=>tree.accessibility.controls.find(c=>c.label==='姓名').ref;
  await monitorStart('background-fill');
  await caseRun('MCP fills inactive live tab without screenshot or modifying human tab',async()=>{
    const result=await call('handoff_controls',{tab,actions:[{type:'fill',ref:ref(),text:'后台接力填写中文'}]});tree=meta(result);assert.ok(!result.content.some(c=>c.type==='image'));
    assert.equal((await inspect(tab)).name,'后台接力填写中文');assert.equal((await inspect(human.id)).name,'HUMAN_SENTINEL');
    const listed=meta(await call('handoff_tabs'));assert.equal(listed.tabs.length,1);assert.equal(listed.tabs[0].tab,tab);assert.equal(listed.tabs[0].placement,'original-tab');
    return {image:false,leasedTabs:1,actualFormValue:'后台接力填写中文'};
  });
  report.semanticFocus=await monitorStop();
  await caseRun('semantic fill keeps physical human focus and pointer unchanged',async()=>{assert.deepEqual(await probe(),baseline);focusUnchanged(report.semanticFocus,baseline);return report.semanticFocus;});
  if(focusedOnly){
    const concurrentResult=await caseRun('physical human typing overlaps background handoff without stealing focus',async()=>{
      // Establish actual content focus before the concurrent section. Neither
      // WebDriver nor the test manipulates focus during the concurrent section.
      assert.equal(session.info.isolation.kind,'xvfb');assert.equal(session.info.isolation.managed,true);
      assert.notEqual(session.info.isolation.display,process.env.DISPLAY,'private display must differ from host display');
      await driver.cmd('/window',{handle:humanHandle});
      const el=(await driver.cmd('/element',{using:'css selector',value:'#name'}))['element-6066-11e4-a52e-4f735466cecf'];
      await driver.cmd('/element/'+el+'/click',{});
      const initial=await driver.execute('return {active:document.activeElement.id,hasFocus:document.hasFocus()}');
      assert.equal(initial.active,'name');assert.equal(initial.hasFocus,true);
      const keys=(letters)=>{
        const child=spawn('/usr/bin/python3',['tests/firefox-human-keys.py',session.info.isolation.display,letters],{cwd:root});let output='';child.stdout.on('data',d=>output+=d);
        return new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve(output.trim().split('\n').map(line=>Number(line.split(' ')[1]))):reject(new Error('physical typing failed: '+code)));});
      };
      await keys('q');assert.equal(await driver.execute('return document.getElementById("name").value'),'HUMAN_SENTINELq','physical key precondition');
      const before=await probe();await monitorStart('concurrent-focus');
      const typing=keys('abcdefghij');await new Promise(r=>setTimeout(r,100));const firstAction=Date.now();
      for(const text of ['Concurrent English','后台中文并行','Concurrent English 2','后台中文并行二'])meta(await call('handoff_controls',{tab,actions:[{type:'fill',ref:ref(),text}]}));
      const lastAction=Date.now(),timestamps=await typing;const samples=await monitorStop();
      assert.equal(timestamps.length,10);assert.ok(timestamps[0]<=firstAction&&timestamps.at(-1)>=lastAction,'physical typing must overlap AI actions');
      const after=await driver.execute('return {value:document.getElementById("name").value,hasFocus:document.hasFocus(),active:document.activeElement.id}');
      assert.equal(after.value,'HUMAN_SENTINELqabcdefghij');assert.equal(after.hasFocus,true);assert.equal(after.active,'name');
      assert.ok(samples.samples>0,'focus monitor produced samples');assert.deepEqual(await probe(),before);focusUnchanged(samples,before);
      const final=meta(await call('handoff_observe',{tab}));assert.equal(final.accessibility.controls.find(c=>c.label==='姓名').value,'后台中文并行二');
      return {physicalPrecondition:true,overlapVerified:true,humanValueVerified:true,backgroundValueVerified:true,focusSamples:samples.samples??null};
    });
    if(!concurrentResult)throw new Error('Concurrent input failed; ownership checks require a valid precondition');
    await driver.cmd('/window',{handle:optionsHandle});
    await caseRun('foreground selection pauses ownership after concurrent input',async()=>{
      await extensionScript('await browser.tabs.update(arguments[0],{active:true});return true;',[form.id]);
      await waitFor(async()=>meta(await call('handoff_tabs')).tabs[0]?.state==='waiting_user');
      const rejected=await call('handoff_controls',{tab,actions:[{type:'fill',ref:ref(),text:'MUST_NOT_WRITE'}]});
      assert.equal(rejected.isError,true);assert.equal((await inspect(tab)).name,'后台中文并行二');return{paused:true,furtherInputRejected:true};
    });
    await caseRun('explicit take-back revokes ownership after concurrent input',async()=>{
      await uiMessage({op:'takeBack',tab});assert.equal(meta(await call('handoff_tabs')).tabs.length,0);
      const state=(await inspect(tab)).state;assert.equal(state.nonce,beforeState.nonce);assert.equal((await inspect(tab)).name,'后台中文并行二');return{leaseRevoked:true};
    });
  }else{
  await caseRun('inactive DOM screenshot remains unavailable without activating tab',async()=>{
    const result=await call('handoff_observe',{tab,capture:'png'}),info=meta(result);assert.ok(info.screenshotError);assert.ok(!result.content.some(c=>c.type==='image'));assert.deepEqual(await probe(),baseline);return {expectedBoundary:info.screenshotError};
  });
  await caseRun('unsupported pixel actions rejected before input',async()=>{const result=await call('handoff_act',{tab,actions:[{type:'click',x:100,y:100}]});assert.equal(result.isError,true);assert.deepEqual(await probe(),baseline);return {error:result.content[0].text};});
  await caseRun('explicit selection of leased tab pauses ownership',async()=>{
    await extensionScript('await browser.tabs.update(arguments[0],{active:true});return true;',[form.id]);await new Promise(r=>setTimeout(r,250));assert.equal(meta(await call('handoff_observe',{tab})).state,'waiting_user');return {state:'waiting_user',focusBefore:baseline,focusAfter:await probe()};
  });
  await caseRun('paused lease rejects further input during human foreground activation',async()=>{
    execFileSync('/usr/bin/python3',['tests/focus-window.py',session.info.isolation.display,'Firefox evaluation AI'],{cwd:root,encoding:'utf8'});
    await waitFor(async()=>meta(await call('handoff_tabs')).tabs[0].state==='waiting_user');
    const result=await call('handoff_controls',{tab,actions:[{type:'fill',ref:ref(),text:'MUST_NOT_WRITE'}]});assert.equal(result.isError,true);assert.equal((await inspect(tab)).name,'后台接力填写中文');return {state:'waiting_user',furtherInputRejected:true};
  });
  await caseRun('explicit take-back revokes lease while keeping same live page',async()=>{
    await uiMessage({op:'takeBack',tab});assert.equal(meta(await call('handoff_tabs')).tabs.length,0);assert.equal((await inspect(tab)).state.nonce,beforeState.nonce);assert.equal((await inspect(tab)).name,'后台接力填写中文');return {leaseRevoked:true,liveStatePreserved:true};
  });
  await focus(humanWindow.id);await uiMessage({op:'handoff',tabId:form.id,task:'任务完成提示测试'});const completionBaseline=await probe();
  await caseRun('task completion pauses and requests notification without activation',async()=>{
    const result=meta(await call('handoff_request_user',{tab,kind:'complete',reason:'填写完成，请检查。'}));assert.equal(result.state,'complete');assert.equal(result.focused,false);assert.deepEqual(await probe(),completionBaseline);
    assert.equal((await call('handoff_act',{tab,actions:[{type:'wait',ms:0}]})).isError,true);return {state:result.state,notificationRequested:result.notificationRequested};
  });
  await uiMessage({op:'takeBack',tab});await focus(humanWindow.id);await uiMessage({op:'handoff',tabId:form.id,task:'关闭设置页后继续运行'});
  await driver.navigate('about:blank');const idleBaseline=await probe();console.log('TEST settings closed; waiting 45 seconds without extension-page activity');
  const idleStart=performance.now();await monitorStart('closed-settings-idle');await new Promise(r=>setTimeout(r,45000));
  await caseRun('closed settings and 45 seconds idle retain connection and running ownership',async()=>{
    const result=await Promise.race([call('handoff_observe',{tab}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('No response after idle')),5000))]);tree=meta(result);assert.equal(tree.state,'running');
    tree=meta(await call('handoff_controls',{tab,actions:[{type:'fill',ref:ref(),text:'关闭设置页后继续接力'}]}));assert.deepEqual(await probe(),idleBaseline);return {idleMs:performance.now()-idleStart,state:tree.state,postIdleInput:true};
  });
  report.idleFocus=await monitorStop();
  await caseRun('idle and post-idle input keep human focus and pointer unchanged',async()=>{focusUnchanged(report.idleFocus,idleBaseline);return report.idleFocus;});
  await driver.navigate(optionsURL);assert.equal((await inspect(tab)).name,'关闭设置页后继续接力');await uiMessage({op:'takeBack',tab});
  }
  report.scope=(focusedOnly?'Concurrent physical typing, in-place handoff and adjacent ownership checks only. No idle test. ':'Default in-place handoff, ownership and persistent background lifecycle regression. ')+ 'System Firefox with temporary profile in private Xvfb plus real Openbox; no actual user desktop/profile. Focus sampled about every 5ms, shorter transients not excluded. Firefox remains DOM fallback. Other browsers, long-duration reliability and VM performance not covered.';
}catch(e){report.fatal=e.message;report.diagnostics=session?.stderr().slice(-5000);console.log('REGRESSION FATAL '+e.message.slice(0,1000));}
finally{
  if(watch)await monitorStop().catch(()=>{});
  await client?.close().catch(()=>{});await transport?.close().catch(()=>{});await driver?.close();await session?.stop();
  await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));
  report.summary=Object.fromEntries(['PASS','FAIL','LIMITATION','INCONCLUSIVE'].map(s=>[s,report.cases.filter(c=>c.status===s).length]));
  await writeFile(join(root,focusedOnly?'artifacts/firefox-concurrent-focused.json':'artifacts/firefox-scenarios.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({summary:report.summary,fatal:report.fatal}));
  if(report.fatal||report.summary.FAIL)process.exitCode=1;
}
