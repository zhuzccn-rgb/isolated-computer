import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { humanEventsSchema } from './actions.mjs';

export async function startViewer({ browser, desktop, handoff, state }, port = 0) {
  const token = randomBytes(32).toString('hex');
  const html = await readFile(new URL('../public/viewer.html', import.meta.url));
  const javascript = await readFile(new URL('../public/viewer.js', import.meta.url));
  function authorized(req) {
    const got = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    return got.length === expected.length && timingSafeEqual(got, expected);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*; frame-ancestors 'none'");
    const host = req.headers.host;
    if (host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, `http://${host}`);
    if(req.method==='GET'&&url.pathname==='/viewer.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(javascript);return;}
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html); return;
    }
    if (!authorized(req)) { res.writeHead(401).end(); return; }
    try {
      if (req.method === 'GET' && url.pathname === '/state') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ paused: state.paused, desktopOwner:desktop.owner, tabs: browser.tabs(), handoffTabs: handoff.cachedTabs, desktopConfigured: Boolean(desktop.url), lastError: state.lastError })); return;
      }
      if (req.method === 'POST' && ['/pause', '/resume'].includes(url.pathname)) {
        const paused=url.pathname === '/pause';
        if(!paused&&['human','acquiring'].includes(desktop.owner))throw new Error('请先交还独立桌面的操作权');
        state.paused = paused;
        try{
          if (desktop.url) await desktop.setPaused(paused);
          if (handoff.socket?.readyState === 1) await handoff.request('pauseAll', { paused });
        }catch(error){state.paused=true;throw error;}
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ paused: state.paused })); return;
      }
      if (req.method === 'GET' && ['/frame','/semantics'].includes(url.pathname)) {
        const target = url.searchParams.get('target') ?? 'browser';
        if (!['browser', 'desktop', 'handoff'].includes(target)) throw new Error('Unknown target');
        const engine = target === 'browser' ? browser : target === 'desktop' ? desktop : handoff;
        if (engine.lane.busy && !(target==='desktop'&&desktop.owner==='human')) { res.writeHead(204).end(); return; }
        const result = target==='desktop'&&url.pathname==='/frame' ? await desktop.preview() : await engine.observe({ tab: url.searchParams.get('tab') || undefined, capture: url.pathname==='/semantics'?'none':target === 'handoff' ? 'png' : 'jpeg' });
        if(url.pathname==='/semantics'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}
        if (!result.image) throw new Error(result.screenshotError || 'This adapter returned DOM information without a screenshot');
        res.setHeader('Content-Type', result.image.mimeType);
        res.end(Buffer.from(result.image.data, 'base64')); return;
      }
      res.writeHead(404).end();
    } catch (error) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400).end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  handoff.attach(server, token);
  const input = new WebSocketServer({noServer:true,maxPayload:100000});
  server.on('upgrade',(req,socket,head)=>{
    if(req.url==='/extension')return;
    const host=`127.0.0.1:${server.address().port}`;
    const got=Buffer.from(req.headers['sec-websocket-protocol']??''),expected=Buffer.from('ic-'+token);
    if(req.url!=='/input'||req.headers.host!==host||req.headers.origin!==`http://${host}`||got.length!==expected.length||!timingSafeEqual(got,expected)){
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;
    }
    input.handleUpgrade(req,socket,head,ws=>{
      input.emit('connection',ws,req);
      let chain=Promise.resolve(),pending=0,lastActivity=Date.now();
      const expiry=setInterval(()=>{
        if(desktop.owner==='human'&&desktop.humanClient===ws&&Date.now()-lastActivity>6500)ws.terminate();
      },500);
      const reply=(id,result,error)=>{if(ws.readyState===1)ws.send(JSON.stringify(error?{id,error}:{id,result}));};
      ws.on('message',raw=>{
        let message;try{message=JSON.parse(raw);}catch{ws.close(1008,'Invalid JSON');return;}
        if(!Number.isSafeInteger(message.id)||message.id<1||!['takeover','input','heartbeat','releaseKeys','release'].includes(message.op)||++pending>128){ws.close(1008,'Invalid input request');return;}
        const job=async()=>{
          if(ws.readyState!==1)throw new Error('Observation window disconnected');
          if(message.op==='takeover')return desktop.takeOver(ws);
          if(message.op==='input'){
            try{return await desktop.humanInput(ws,humanEventsSchema.parse(message.events));}
            catch(error){await desktop.releaseHuman(ws,false).catch(()=>{});throw error;}
          }
          if(message.op==='heartbeat')return desktop.humanCommand(ws,'heartbeat');
          if(message.op==='releaseKeys')return desktop.humanCommand(ws,'releaseKeys');
          return desktop.releaseHuman(ws,message.resume===true&&!state.paused);
        };
        const next=chain.then(job);chain=next.catch(()=>{});
        next.then(result=>{lastActivity=Date.now();reply(message.id,result);},error=>reply(message.id,null,error.message)).finally(()=>pending--);
      });
      ws.on('close',()=>{clearInterval(expiry);chain.finally(()=>desktop.releaseHuman(ws,false)).catch(()=>{});});
      ws.on('error',()=>{ws.terminate();});
    });
  });
  return { url: `http://127.0.0.1:${server.address().port}/#${token}`, extensionURL: `ws://127.0.0.1:${server.address().port}/extension#${token}`, close: async () => {
    for(const ws of input.clients){await desktop.releaseHuman(ws,false).catch(()=>{});ws.terminate();}
    input.close();await handoff.close();await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}
