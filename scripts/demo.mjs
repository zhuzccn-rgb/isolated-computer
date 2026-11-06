// Local acceptance harness: starts one private desktop and a real MCP client/server.
import {mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {spawnReady} from '../tests/helpers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='linux')throw new Error('This acceptance demo currently requires Linux');
const directory=join(root,'.runtime','acceptance');await mkdir(directory,{recursive:true,mode:0o700});
let previous;
try{
 const old=JSON.parse(await readFile(join(directory,'session.json')));
 const argv=(await readFile(`/proc/${old.pid}/cmdline`,'utf8')).split('\0');
 const cwd=await realpath(`/proc/${old.pid}/cwd`);
 if(argv.includes(fileURLToPath(import.meta.url))||(cwd===root.replace(/\/$/,'')&&argv.includes('scripts/demo.mjs')))previous=old;
}catch{}
if(process.argv.includes('--stop')){
 if(previous){process.kill(previous.pid,'SIGTERM');console.log('Stopped the verified local acceptance demo.');}
 else console.log('No running acceptance demo found.');
 process.exit(0);
}
if(previous)throw new Error('Acceptance demo already running; open .runtime/acceptance/session.json or stop with node scripts/demo.mjs --stop');
const python=process.env.IC_DEMO_PYTHON??'/usr/bin/python3',xvfb=process.env.IC_TEST_XVFB??'Xvfb';
const wm=process.env.IC_TEST_OPENBOX??'openbox';
const argv=process.env.IC_TEST_OPENBOX_LIB?['env','LD_LIBRARY_PATH='+process.env.IC_TEST_OPENBOX_LIB,'XDG_DATA_DIRS=/tmp/ic-firefox-wm/usr/share:/usr/local/share:/usr/share',wm]:[wm];
const apps=join(directory,'apps.json');await writeFile(apps,JSON.stringify([argv,[python,join(root,'desktop/demo_app.py')]]));
let session,client,transport,timer;let closing=false;
async function close(){if(closing)return;closing=true;clearInterval(timer);await client?.close().catch(()=>{});await transport?.close().catch(()=>{});await session?.stop();}
process.once('SIGINT',()=>close().finally(()=>process.exit(0)));process.once('SIGTERM',()=>close().finally(()=>process.exit(0)));
try{
 session=await spawnReady(python,['desktop/linux_session.py','--xvfb',xvfb,'--width','1280','--height','900','--token-file',join(directory,'desktop.token'),'--apps-file',apps]);
 transport=new StdioClientTransport({command:process.execPath,args:[join(root,'src/server.mjs')],cwd:root,env:{...process.env,IC_VIEWER:'1',IC_DESKTOP_URL:session.info.url,IC_DESKTOP_TOKEN_FILE:session.info.tokenFile}});
 client=new Client({name:'manual-acceptance',version:'1.0.0'});await client.connect(transport);
 const result=await client.callTool({name:'computer_status',arguments:{}});if(result.isError)throw new Error(result.content[0].text);
 const status=JSON.parse(result.content[0].text);
 const viewerURL=new URL(status.viewerURL);viewerURL.searchParams.set('target','desktop');
 const data={viewerURL:viewerURL.href,extensionURL:status.extensionURL,desktopURL:session.info.url,tokenFile:session.info.tokenFile,pid:process.pid,display:session.info.isolation.display};
 await writeFile(join(directory,'session.json'),JSON.stringify(data,null,2),{mode:0o600});
 // Config is optional: a new AI client will use its own MCP instance/viewer.
 const config={mcpServers:{'isolated-computer':{command:process.execPath,args:[join(root,'src/server.mjs')],env:{IC_DESKTOP_URL:session.info.url,IC_DESKTOP_TOKEN_FILE:session.info.tokenFile}}}};
 await writeFile(join(directory,'mcp-config.json'),JSON.stringify(config,null,2),{mode:0o600});
 // Verify real native accessibility rather than calling the demo ready on startup alone.
 let native;for(let n=0;n<20;n++){
  const r=await client.callTool({name:'desktop_observe',arguments:{}});
  if(!r.isError){const m=JSON.parse(r.content[0].text);if(m.accessibility?.controls.some(c=>c.name==='验收输入框')){native=m;break;}}
  await new Promise(r=>setTimeout(r,200));
 }
 if(!native)throw new Error('GTK demo app did not expose native accessibility: '+session.stderr().slice(-1500));
 const button=native.accessibility.controls.find(c=>c.name==='验收计数按钮'&&c.interfaces.includes('Action'));
 if(!button)throw new Error('Native demo count button missing');
 let busy=false;
 timer=setInterval(async()=>{
  if(busy||closing)return;busy=true;
  try{
   const r=await client.callTool({name:'computer_status',arguments:{}});const state=JSON.parse(r.content[0].text);
   if(!state.paused&&state.desktopOwner==='ai')await client.callTool({name:'desktop_controls',arguments:{actions:[{type:'click',ref:button.ref}]}});
  }catch{}finally{busy=false;}
 },2000);
 console.log('Acceptance desktop ready; native AT-SPI verified.');
 console.log('Session details: '+join(directory,'session.json'));
 console.log('Stop with Ctrl+C; no user browser profile or desktop window is automated.');
 console.log('A local MCP loop clicks the count button every 2 seconds to simulate AI input; no model/API call.');
 await new Promise(()=>{});
}catch(error){await close();throw error;}
