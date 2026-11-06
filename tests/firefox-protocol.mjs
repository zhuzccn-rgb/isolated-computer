import { existsSync } from 'node:fs';
// Separate control-path experiment. These are WebDriver native events, not the plugin's DOM adapter.
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnReady,root,fixtureServer,waitFor } from './helpers.mjs';
import { FirefoxDriver,driverAddress } from './firefox-driver.mjs';
const dir=await mkdtemp(join(tmpdir(),'ic-firefox-native-protocol-'));
const fixture=await fixtureServer();const report={date:new Date().toISOString(),scope:'System Firefox native W3C WebDriver events on private Xvfb/Openbox. Not integrated in the live-tab extension. Marionette-enabled test profile; ordinary running user browsers are not attachable by default.',cases:[]};
let session,driver;
const test=async(name,fn)=>{try{const evidence=await fn();report.cases.push({name,status:'PASS',evidence});console.log('PASS '+name);}catch(e){report.cases.push({name,status:'FAIL',error:e.message});console.log('FAIL '+name+': '+e.message.slice(0,400));}};
try{
 const wmConfig=join(dir,'wm.xml');await writeFile(wmConfig,'<openbox_config xmlns="http://openbox.org/3.4/rc"><focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus></openbox_config>');
 const wm=process.env.IC_TEST_OPENBOX??'openbox',wmEnv=[...(process.env.IC_TEST_OPENBOX_LIB?[`LD_LIBRARY_PATH=${process.env.IC_TEST_OPENBOX_LIB}`]:[]),...(process.env.IC_TEST_OPENBOX_DATA?[`XDG_DATA_DIRS=${process.env.IC_TEST_OPENBOX_DATA}:/usr/local/share:/usr/share`]:[])],geckodriver=process.env.IC_TEST_GECKODRIVER??(existsSync('/snap/firefox/current/usr/lib/firefox/geckodriver')?'/snap/firefox/current/usr/lib/firefox/geckodriver':'geckodriver');
 const apps=join(dir,'apps.json');await writeFile(apps,JSON.stringify([['env',...wmEnv,wm,'--config-file',wmConfig],[geckodriver,'--port','0','--log','info']]));
 session=await spawnReady('/usr/bin/python3',['desktop/linux_session.py','--xvfb',process.env.IC_TEST_XVFB??'Xvfb','--token-file',join(dir,'bridge.token'),'--apps-file',apps]);
 driver=new FirefoxDriver(await driverAddress(session));await driver.start();report.version=driver.capabilities.browserVersion;
 const element=async selector=>(await driver.cmd('/element',{using:'css selector',value:selector}))['element-6066-11e4-a52e-4f735466cecf'];
 const click=id=>driver.cmd('/element/'+id+'/click',{});
 const text=(id,value)=>driver.cmd('/element/'+id+'/value',{text:value});
 const value=id=>driver.cmd('/element/'+id+'/property/value');
 await driver.navigate(fixture.url+'/form');const original=await driver.cmd('/window');
 await driver.execute("document.title='Firefox evaluation AI';document.getElementById('click').addEventListener('click',e=>{document.getElementById('click').dataset.nativeTrusted=String(e.isTrusted)});");
 const input=await element('#text'),button=await element('#click');
 await text(input,'用户半填内容');
 const human=(await driver.cmd('/window/new',{type:'window'})).handle;
 await driver.cmd('/window',{handle:human});await driver.navigate(fixture.url+'/human');await driver.execute("document.title='Firefox evaluation HUMAN'");const humanInput=await element('#text');await text(humanInput,'HUMAN_SENTINEL');
 await driver.cmd('/window',{handle:original});
 const focus=()=>JSON.parse(execFileSync('/usr/bin/python3',['tests/x11_probe.py',session.info.isolation.display],{cwd:root,encoding:'utf8'}));
 const foreground=()=>{const target=JSON.parse(execFileSync('/usr/bin/python3',['tests/focus-window.py',session.info.isolation.display,'Firefox evaluation HUMAN'],{cwd:root,encoding:'utf8'}));return{target,state:focus()};};
 await test('native WebDriver text continues Chinese form with real human window in foreground',async()=>{const before=foreground();await text(input,'，原生协议接力');assert.equal(await value(input),'用户半填内容，原生协议接力');assert.deepEqual(focus(),before.state);return{before,after:focus()};});
 await test('native WebDriver click produces trusted event without system pointer/focus change',async()=>{const before=foreground();await click(button);await waitFor(async()=>(await driver.execute('return document.getElementById("click").dataset.nativeTrusted'))==='true');assert.deepEqual(focus(),before.state);return{trusted:true,before,after:focus()};});
 await test('native WebDriver pointer actions perform drag without system focus/pointer change',async()=>{const before=foreground();await driver.cmd('/actions',{actions:[{type:'pointer',id:'mouse',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',duration:0,origin:'viewport',x:70,y:240},{type:'pointerDown',button:0},{type:'pointerMove',duration:200,origin:'viewport',x:190,y:270},{type:'pointerUp',button:0}]}]});await driver.cmd('/actions',undefined,'DELETE');await waitFor(()=>fixture.state().dragged);assert.deepEqual(focus(),before.state);return{dragged:true,before,after:focus()};});
 await test('native WebDriver screenshot works without activating target window',async()=>{const before=foreground();const data=await driver.cmd('/screenshot'),png=Buffer.from(data,'base64');assert.ok(png.length>1000);assert.deepEqual(focus(),before.state);await writeFile(join(root,'artifacts/firefox-native-protocol.png'),png);return{width:png.readUInt32BE(16),height:png.readUInt32BE(20),before,after:focus()};});
 await test('human window input remains unchanged',async()=>{await driver.cmd('/window',{handle:human});assert.equal(await value(humanInput),'HUMAN_SENTINEL');return{sentinelPreserved:true};});
}catch(e){report.fatal=e.message;report.log=session?.stderr().slice(-3000);console.log('FATAL '+e.message);}
finally{await driver?.close();await session?.stop();await fixture.close();await writeFile(join(root,'artifacts/firefox-native-protocol.json'),JSON.stringify(report,null,2));if(report.fatal||report.cases.some(c=>c.status==='FAIL'))process.exitCode=1;}
