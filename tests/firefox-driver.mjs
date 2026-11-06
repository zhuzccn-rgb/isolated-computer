import { existsSync } from 'node:fs';
import { waitFor } from './helpers.mjs';

// Minimal local W3C client. This uses the installed system GeckoDriver/Firefox,
// never Playwright's downloaded Firefox or the human's browser profile.
export class FirefoxDriver {
  constructor(url){this.url=url;}
  async request(path,body,method=body===undefined?'GET':'POST'){
    const r=await fetch(this.url+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});
    const data=await r.json();
    if(!r.ok||data.value?.error)throw new Error(`WebDriver ${path}: ${data.value?.error??r.status}: ${data.value?.message??''}`);
    return data.value;
  }
  async start(){
    const value=await this.request('/session',{capabilities:{alwaysMatch:{browserName:'firefox',acceptInsecureCerts:false,'moz:firefoxOptions':{binary:process.env.IC_TEST_FIREFOX_BINARY??(existsSync('/snap/firefox/current/usr/lib/firefox/firefox')?'/snap/firefox/current/usr/lib/firefox/firefox':'firefox'),args:['--no-remote'],prefs:{'accessibility.force_disabled':-1,'browser.tabs.warnOnClose':false,'browser.shell.checkDefaultBrowser':false}}}}});
    this.id=value.sessionId;this.capabilities=value.capabilities;return value;
  }
  cmd(path,body,method){return this.request('/session/'+this.id+path,body,method);}
  execute(script,args=[]){return this.cmd('/execute/sync',{script,args});}
  asyncExecute(script,args=[]){return this.cmd('/execute/async',{script,args});}
  navigate(url){return this.cmd('/url',{url});}
  context(context){return this.cmd('/moz/context',{context});}
  async extensionURL(id){
    await this.context('chrome');
    try{return await this.execute('return WebExtensionPolicy.getByID(arguments[0]).getURL("options.html");',[id]);}
    finally{await this.context('content');}
  }
  async close(){if(this.id){await this.cmd('',undefined,'DELETE').catch(()=>{});this.id=null;}}
}

export async function driverAddress(session){
  return waitFor(()=>{const match=session.stderr().match(/Listening on (127\.0\.0\.1:\d+)/);return match&&'http://'+match[1];},15000);
}
