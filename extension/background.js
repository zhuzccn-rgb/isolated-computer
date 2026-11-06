import { domOperation } from './dom.js';
import { snapshotCDP, command, pageMetrics, dimensions } from './cdp.js';
import { accessibilitySnapshot, accessibilityAction } from './accessibility.js';
const api=globalThis.browser??chrome;
const actionUI=api.action??api.browserAction;
const leases=new Map();let socket,keepalive,chain=Promise.resolve(),connecting;
const save=()=>api.storage.local.set({leases:[...leases.values()].map(({scale,viewport,axRefs,axGeneration,...lease})=>lease)});
const sendTabs=async()=>{const tabs=await list();if(socket?.readyState===1)socket.send(JSON.stringify({event:'tabs',tabs:tabs.tabs}));};
async function list(){const tabs=[];for(const lease of leases.values()){try{const tab=await api.tabs.get(lease.tabId);tabs.push({tab:String(lease.tabId),url:tab.url,title:tab.title,task:lease.task,state:lease.state,mode:lease.mode,placement:lease.placement,reason:lease.reason});}catch{leases.delete(lease.tabId);}}return {connected:socket?.readyState===1,tabs};}
function leased(tab){const lease=leases.get(Number(tab));if(!lease)throw new Error('This tab has not been handed to AI by the human');return lease;}
async function dom(lease,args){const results=await api.scripting.executeScript({target:{tabId:lease.tabId},func:domOperation,args:[args]});if(results[0]?.error)throw new Error(results[0].error.message);return results[0]?.result;}
async function notify(lease,kind,reason){
  lease.state=kind==='complete'?'complete':'waiting_user';lease.reason=reason;await save();
  await actionUI.setBadgeText({text:kind==='complete'?'OK':'?',tabId:lease.tabId});
  await actionUI.setBadgeBackgroundColor({color:kind==='complete'?'#278259':'#b7791f',tabId:lease.tabId});
  let notificationRequested=false;
  if(api.notifications){try{await api.notifications.create('handoff-'+lease.tabId,{type:'basic',iconUrl:api.runtime.getURL('icon.png'),title:kind==='complete'?'AI 已完成，等待接回':'AI 需要你的确认',message:reason.slice(0,300)});notificationRequested=true;}catch{}}
  await sendTabs();return {tab:String(lease.tabId),state:lease.state,reason,notificationRequested,focused:false};
}
async function handoff(tabId,task='',forceDOM=false){
  if(socket?.readyState!==1)throw new Error('先在设置中连接本地插件');
  if(leases.has(tabId))throw new Error('此标签页已经交接');
  const tab=await api.tabs.get(tabId);if(!/^https?:/.test(tab.url??''))throw new Error('只交接 HTTP(S) 网页');
  const mode=!forceDOM&&api.debugger?'cdp':'dom';
  // A live tab stays in place. Even windows.create({focused:false}) stole
  // physical focus in the Firefox/Openbox evaluation. Do not move, activate,
  // reload, or create a replacement tab while transferring ownership.
  const lease={tabId,task,originalWindow:tab.windowId,originalIndex:tab.index,placement:'original-tab',mode,state:'transferring'};
  leases.set(tabId,lease);
  try{
    // No focused:true and no Page.bringToFront while AI owns this tab.
    if(mode==='cdp'){
      await api.debugger.attach({tabId},'1.3');
      await command(tabId,'Page.enable');
    }
    else await dom(lease,{op:'inspect'});
    lease.state='running';await snapshot(lease,'none');await save();
    await actionUI.setBadgeText({text:'AI',tabId});await actionUI.setBadgeBackgroundColor({color:'#3b6bb5',tabId});
    await sendTabs();return {tab:String(tabId),mode,placement:lease.placement,originalWindow:lease.originalWindow};
  }catch(error){lease.state='waiting_user';lease.reason='交接失败：'+error.message;await save();await sendTabs();throw error;}
}
async function takeBack(tab){
  const lease=leased(tab);lease.state='returned';
  // Revoke first, then wait for the dispatched batch to stop before giving
  // input back to the human. Queued actions see the revoked ownership.
  await chain.catch(()=>{});
  if(lease.mode==='cdp'){
    await command(lease.tabId,'Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});
    await api.debugger.detach({tabId:lease.tabId}).catch(()=>{});
  }
  let destination;
  try{destination=await api.windows.get(lease.originalWindow);}catch{}
  if(destination&&lease.placement!=='original-tab'){
    await api.tabs.move(lease.tabId,{windowId:destination.id,index:lease.originalIndex});
    if(lease.placeholder)await api.tabs.remove(lease.placeholder).catch(()=>{});
    await api.tabs.update(lease.tabId,{active:true});await api.windows.update(destination.id,{focused:true});
  }else{const tabInfo=await api.tabs.get(lease.tabId);await api.tabs.update(lease.tabId,{active:true});await api.windows.update(tabInfo.windowId,{focused:true});}
  leases.delete(lease.tabId);await actionUI.setBadgeText({text:'',tabId:lease.tabId});await save();await sendTabs();return {returned:true};
}
async function snapshot(lease,capture='none'){
  if(lease.mode==='cdp') {
    const result=await snapshotCDP(lease,capture);
    return {...result,...await accessibilitySnapshot((method,params)=>command(lease.tabId,method,params),lease)};
  }
  const info=await dom(lease,{op:'inspect'});
  const result={target:'handoff',tab:String(lease.tabId),mode:'dom',state:lease.state,...info,accessibility:{source:'DOM semantic fallback (not native accessibility)',controls:info.fields}};
  lease.viewport={width:info.width,height:info.height};lease.scale=1;
  if(capture!=='none'){
    try{
      const tab=await api.tabs.get(lease.tabId);
      const active=(await api.tabs.query({windowId:tab.windowId,active:true}))[0];
      if(active?.id!==lease.tabId)throw new Error('The leased tab is no longer active in its own window; human intervention required');
      const dataURL=await api.tabs.captureVisibleTab(tab.windowId,{format:capture,...(capture==='jpeg'?{quality:85}:{})});
      const data=dataURL.slice(dataURL.indexOf(',')+1),size=dimensions(data,capture);
      lease.scale=size.width/info.width;Object.assign(result,size,{coordinateScale:lease.scale,image:{data,mimeType:'image/'+capture}});
    }catch(error){result.screenshotError=error.message;result.coordinateMode='DOM coordinates in CSS pixels';}
  }
  return result;
}
async function act(args){
  const lease=leased(args.tab);if(lease.state!=='running')throw new Error('此网页已暂停或等待用户，请勿重试动作');
  // Verified Linux headful mouse presses activate windows. Reject before dispatch.
  if(args.actions.some(a=>a.type!=='wait'))throw new Error('Live-tab pixel input is disabled because it can steal focus. Use handoff_controls with accessibility refs; use browser_act in the isolated headless browser for gestures.');
  for(const action of args.actions){
    if(lease.state!=='running')throw new Error('Tab ownership was revoked or paused');
    await new Promise(r=>setTimeout(r,action.ms));
  }
  return snapshot(lease,args.capture);
}
async function controls(args){
  const lease=leased(args.tab);
  for(const action of args.actions){
    if(lease.state!=='running')throw new Error('Tab ownership is paused or revoked');
    const result=lease.mode==='cdp'?await accessibilityAction((method,params)=>command(lease.tabId,method,params),lease,action):await dom(lease,{op:'semantic',action});
    if(result?.needsConfirmation){await notify(lease,'confirmation','表单已到提交步骤，请接回检查并确认。');throw new Error('Conventional form submission stopped for human confirmation');}
  }
  return snapshot(lease,args.capture);
}
async function route(op,args){
  if(op==='list')return list();
  if(op==='observe')return snapshot(leased(args.tab),args.capture);
  if(op==='act')return act(args);
  if(op==='controls')return controls(args);
  if(op==='requestUser')return notify(leased(args.tab),args.kind,args.reason);
  if(op==='pauseAll'){for(const lease of leases.values()){if(args.paused&&lease.state==='running')lease.state='paused';else if(!args.paused&&lease.state==='paused')lease.state='running';}await save();await sendTabs();return {paused:args.paused};}
  throw new Error('Unknown operation');
}
async function connect(pairing){
  const url=new URL(pairing);if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.pathname!=='/extension'||!/^#[a-f0-9]{64}$/.test(url.hash))throw new Error('Use extensionURL from computer_status');
  const token=url.hash.slice(1);url.hash='';
  socket?.close();clearInterval(keepalive);
  const ws=new WebSocket(url.href,'ic-'+token);socket=ws;
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(new Error('Local plugin connection failed'));});
  ws.onmessage=event=>{
    let message;try{message=JSON.parse(event.data);}catch{return;}
    if(message.event)return;
    // Pause controls can interrupt a running batch between actions.
    const job=()=>route(message.op,message.args);
    const result=message.op==='pauseAll'?job():chain.then(job);
    if(message.op!=='pauseAll')chain=result.catch(()=>{});
    result.then(value=>{if(ws.readyState===1)ws.send(JSON.stringify({id:message.id,result:value}));},error=>{if(ws.readyState===1)ws.send(JSON.stringify({id:message.id,error:error.message}));});
  };
  ws.onclose=async()=>{if(socket===ws){clearInterval(keepalive);for(const lease of leases.values())if(lease.state==='running')lease.state='paused';await save();}};
  keepalive=setInterval(()=>{if(ws.readyState===1)ws.send(JSON.stringify({event:'ping'}));},20000);
  await api.storage.local.set({pairing});await sendTabs();return {connected:true};
}
api.runtime.onMessage.addListener((message,sender,reply)=>{
  // Content scripts and web pages have no command channel. Only extension pages may hand off or restore a tab.
  if(!sender.url?.startsWith(api.runtime.getURL(''))){reply({error:'Extension page required'});return false;}
  (async()=>{
    if(message.op==='connect')return connect(message.pairing);
    if(message.op==='handoff')return handoff(message.tabId,message.task,message.forceDOM);
    if(message.op==='takeBack')return takeBack(message.tab);
    if(message.op==='list')return list();
    if(message.op==='resume'){const lease=leased(message.tab);if(lease.state!=='paused')throw new Error('Only a paused tab can resume; confirmation/completion requires taking it back');lease.state='running';await save();await sendTabs();return {};}
    if(message.op==='pause'){const lease=leased(message.tab);lease.state='paused';await save();await sendTabs();return {};}
    throw new Error('Unknown extension action');
  })().then(result=>reply({result}),error=>reply({error:error.message}));return true;
});
api.debugger?.onDetach.addListener(async(source)=>{const lease=leases.get(source.tabId);if(lease&&lease.state!=='returned')await notify(lease,'confirmation','浏览器调试连接被关闭，AI 已暂停。');});
api.debugger?.onEvent.addListener(async(source,method)=>{if(method==='Page.javascriptDialogOpening'){const lease=leases.get(source.tabId);if(lease)await notify(lease,'confirmation','网页打开了对话框，请接回页面处理。');}});
async function pauseVisibleLease(windowId){
  if(windowId<0)return;
  const win=await api.windows.get(windowId).catch(()=>null);if(!win?.focused)return;
  const [tab]=await api.tabs.query({windowId,active:true});
  const lease=tab&&leases.get(tab.id);
  if(lease?.state==='running')await notify(lease,'confirmation','你已返回交接的网页，AI 已暂停，请接回后操作。');
}
api.windows.onFocusChanged.addListener(id=>pauseVisibleLease(id).catch(()=>{}));
api.tabs.onActivated.addListener(({windowId})=>pauseVisibleLease(windowId).catch(()=>{}));
api.tabs.onRemoved.addListener(async id=>{if(leases.delete(id)){await save();await sendTabs();}});
// Internal extension-context API for reproducible integration tests; never exposed to page content.
globalThis.IC={handoff,takeBack,connect,list,route};
api.storage.local.get(['leases','pairing']).then(stored=>{
  for(const lease of stored.leases??[]){lease.state='paused';leases.set(lease.tabId,lease);}
  if(stored.pairing)connect(stored.pairing).catch(()=>{});
});
