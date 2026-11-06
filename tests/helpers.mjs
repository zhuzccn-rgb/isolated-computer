import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function fixtureServer() {
  const html = await readFile(new URL('./fixture.html', import.meta.url));
  let state = {};
  const server = createServer(async (req,res) => {
    if(req.url==='/event') {let chunks=[];for await(const chunk of req) chunks.push(chunk);state=JSON.parse(Buffer.concat(chunks));res.end('ok');return;}
    res.setHeader('Content-Type','text/html');res.end(req.url==='/popup'?'<h1>Popup fixture</h1>':html);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`, state:()=>state, close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();})};
}
export async function waitFor(fn, ms=5000) {
  const until=Date.now()+ms;let last;
  while(Date.now()<until){try{const value=await fn();if(value)return value;}catch(e){last=e;}await new Promise(r=>setTimeout(r,30));}
  throw last??new Error('Timed out waiting for fixture state');
}
export async function spawnReady(command,args,env) {
  const child=spawn(command,args,{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let stderr='',stdout=''; child.stderr.on('data',d=>stderr+=d);
  const ready=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Bridge startup timeout: '+stderr));},15000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Bridge exited ${code}: ${stderr}`));});
    child.stdout.on('data',d=>{stdout+=d;const newline=stdout.indexOf('\n');if(newline>=0){clearTimeout(timer);resolve(JSON.parse(stdout.slice(0,newline)));}});
  });
  return {child,info:ready,stderr:()=>stderr,stop:()=>new Promise(resolve=>{if(child.exitCode!==null){resolve();return;}child.once('exit',resolve);child.kill('SIGTERM');})};
}
