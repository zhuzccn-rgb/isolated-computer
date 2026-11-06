import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BrowserEngine } from '../src/browser.mjs';
import { fixtureServer, root } from './helpers.mjs';

const fixture=await fixtureServer();
const baseline=new BrowserEngine();
const client=new Client({name:'performance-verifier',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:['src/server.mjs'],cwd:root,env:{...process.env,IC_VIEWER:'0'}});
const samples=30;
const stats=values=>{const v=[...values].sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1],samples:v.length};};
async function rssTree(pid) {
  const map=new Map();
  for(const item of await readdir('/proc')) {
    if(!/^\d+$/.test(item))continue;
    try {
      const content=await readFile(`/proc/${item}/stat`,'utf8');
      const fields=content.slice(content.lastIndexOf(')')+2).split(' ');
      map.set(Number(item),{parent:Number(fields[1]),rss:Number(fields[21])*4096});
    } catch {}
  }
  const descendants=new Set([pid]);let changed=true;
  while(changed){changed=false;for(const [id,info]of map)if(descendants.has(info.parent)&&!descendants.has(id)){descendants.add(id);changed=true;}}
  return {processes:descendants.size,summedRSSMiB:[...descendants].reduce((sum,id)=>sum+(map.get(id)?.rss??0),0)/1024**2,note:'Summed RSS counts shared memory more than once; not unique physical memory. Single simple page, viewer disabled.'};
}
try {
  await client.connect(transport);
  await baseline.open({url:fixture.url,capture:'none'});
  const page=baseline.page().page;
  const opened=await client.callTool({name:'browser_open',arguments:{url:fixture.url,capture:'none'}});
  assert.ok(!opened.isError,opened.content[0].text);
  const tab=JSON.parse(opened.content[0].text).tab;
  const results={date:new Date().toISOString(),platform:process.platform,node:process.version,samples,scope:'Local microbenchmark: warmed Chromium on a synthetic page, direct BrowserEngine versus the same engine over real MCP stdio. Both read the native accessibility tree after each action. Excludes model latency, network websites, live handoff, VM cost and real-task success rate.',cases:{}};
  for(const capture of ['none','png']) {
    const direct=[],mcp=[];
    const raw=async()=>{await baseline.act({actions:[{type:'click',x:100,y:145,button:'left',clicks:1}],capture});};
    const wrapped=async()=>{const result=await client.callTool({name:'browser_act',arguments:{tab,actions:[{type:'click',x:100,y:145}],capture}});assert.ok(!result.isError,result.content[0].text);};
    for(let i=0;i<5;i++){await raw();await wrapped();}
    for(let i=0;i<samples;i++) {
      const pair=i%2?[[wrapped,mcp],[raw,direct]]:[[raw,direct],[wrapped,mcp]];
      for(const [run,values]of pair){const start=performance.now();await run();values.push(performance.now()-start);}
    }
    const a=stats(direct),b=stats(mcp);
    results.cases[capture]={directEngine:a,mcpPlugin:b,medianOverheadMs:b.medianMs-a.medianMs,medianRatio:b.medianMs/a.medianMs};
  }
  results.pluginProcessTree=await rssTree(transport.pid);
  await writeFile(new URL('../artifacts/linux-benchmark.json',import.meta.url),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally {await baseline.close();await client.close();await transport.close();await fixture.close();}
