const token=location.hash.slice(1)||sessionStorage.getItem('ic-viewer-token')||'';
const initialTarget=new URLSearchParams(location.search).get('target');
if(token)sessionStorage.setItem('ic-viewer-token',token);
history.replaceState(null,'',location.pathname);
const $=id=>document.getElementById(id);
const target=$('target'),tabs=$('tabs'),pause=$('pause'),takeover=$('takeover'),handback=$('handback');
const status=$('status'),error=$('error'),screen=$('screen'),keyboard=$('keyboard');
const keymode=$('keymode');let platform;
const live=$('live');
const savedTarget=initialTarget||sessionStorage.getItem('ic-viewer-target');
if(['browser','handoff','desktop'].includes(savedTarget))target.value=savedTarget;
let paused=false,desktopOwner='ai',busy=false,blobURL,frameBusy=false,controlling=false,transition=false;
let socket,nextID=1,remoteSize,heartbeat,frameTimer,composing=false,inputTimer,inputBusy=false,generation=0,stopping=false;
const pending=new Map(),forwardedKeys=new Map();let events=[];
async function request(path,options={}){
  const r=await fetch(path,{...options,headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
  if(!r.ok){const body=await r.json().catch(()=>({}));throw new Error(body.error||'连接失败：'+r.status);}return r;
}
function ui(){
  const desktop=target.value==='desktop';
  takeover.hidden=!desktop||controlling;handback.hidden=!controlling;keyboard.hidden=!controlling;
  keymode.hidden=!controlling;
  $('live-box').hidden=!desktop;live.disabled=controlling;
  takeover.disabled=transition||['human','acquiring'].includes(desktopOwner);
  target.disabled=tabs.disabled=transition||controlling;
  pause.disabled=transition||controlling;
  pause.textContent=paused||(desktop&&desktopOwner==='paused')?'继续 AI':'暂停 AI';
  screen.classList.toggle('controlled',controlling);
  status.textContent=transition?'正在交接，请稍候':controlling?'你正在接管，AI 已停止输入':desktop&&desktopOwner==='human'?'其他窗口正在接管':paused||(desktop&&desktopOwner==='paused')?'已暂停':'后台工作中';
  $('hint').textContent=controlling?'点击画面操作；中文输入和粘贴使用下方输入区。切换到其他窗口会退出接管并释放按键，AI 保持暂停。':'默认读取控件，不截图。独立应用可接管键鼠；接管期间会为你更新画面，AI 的默认观察仍不截图。';
}
async function refresh(){
  if(document.hidden||busy)return;busy=true;
  try{
    const state=await(await request('/state')).json();paused=state.paused;desktopOwner=state.desktopOwner;ui();
    const selected=tabs.value,list=target.value==='handoff'?state.handoffTabs:state.tabs;
    tabs.replaceChildren(...list.map(tab=>{const o=document.createElement('option');o.value=tab.tab;o.textContent=tab.tab+' · '+tab.url;return o;}));
    if(list.some(tab=>tab.tab===selected))tabs.value=selected;tabs.hidden=target.value==='desktop';
    if(controlling)return;
    if(target.value!=='desktop'&&!list.length){error.textContent=target.value==='handoff'?'请在浏览器扩展中交接标签页':'等待 AI 打开网页';return;}
    if(target.value==='desktop'&&!state.desktopConfigured){takeover.disabled=true;error.textContent='独立桌面尚未配置，见安装教程';return;}
    const r=await request('/semantics?target='+target.value+'&tab='+encodeURIComponent(tabs.value));
    if(r.status!==204)$('tree').textContent=JSON.stringify((await r.json()).accessibility,null,2);
    error.textContent=state.lastError||'';
  }catch(e){error.textContent=e.message;}finally{busy=false;}
}
async function frame(){
  if(document.hidden||frameBusy)return;frameBusy=true;
  try{
    const r=await request('/frame?target='+target.value+'&tab='+encodeURIComponent(tabs.value));if(r.status===204)return;
    const old=blobURL;blobURL=URL.createObjectURL(await r.blob());
    await new Promise((resolve,reject)=>{screen.onload=resolve;screen.onerror=()=>reject(new Error('画面加载失败'));screen.src=blobURL;});
    if(old)URL.revokeObjectURL(old);screen.hidden=false;
    if(controlling&&(screen.naturalWidth!==remoteSize.width||screen.naturalHeight!==remoteSize.height))throw new Error('独立桌面分辨率已变化，请重新接管');
  }catch(e){error.textContent=e.message;live.checked=false;if(controlling)await stopControl(false);}finally{frameBusy=false;}
}
async function frameLoop(){
  clearTimeout(frameTimer);if(document.hidden||(!controlling&&!(live.checked&&target.value==='desktop')))return;
  await frame();if(!document.hidden&&(controlling||live.checked))frameTimer=setTimeout(frameLoop,controlling?250:1000);
}
function rpc(op,extra={}){
  if(socket?.readyState!==1)return Promise.reject(new Error('键鼠通道未连接'));
  const id=nextID++;return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('键鼠通道响应超时'));socket?.close();},10000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,op,...extra}));
  });
}
async function connect(){
  const ws=new WebSocket('ws://'+location.host+'/input','ic-'+token);socket=ws;
  ws.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch{ws.close();return;}const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result);};
  ws.onclose=()=>{
    if(socket!==ws)return;socket=null;
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('键鼠连接已断开，AI 保持暂停'));}pending.clear();
    resetControl();desktopOwner='paused';ui();
  };
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(new Error('无法连接本地键鼠通道'));});
}
function resetControl(){
  controlling=false;composing=false;events=[];forwardedKeys.clear();keyboard.value='';
  keymode.value='text';
  clearInterval(heartbeat);clearTimeout(frameTimer);clearTimeout(inputTimer);ui();
}
async function stopControl(resume){
  if(stopping)return;stopping=true;generation++;
  const ws=socket;resetControl();transition=true;ui();
  try{if(ws?.readyState===1)await rpc('release',{resume});}
  catch(e){error.textContent=e.message;}
  finally{if(socket===ws)socket=null;ws?.close();desktopOwner=resume&&!paused?'ai':'paused';transition=false;stopping=false;ui();await refresh();void frameLoop();}
}
function enqueue(event){
  if(!controlling)return;
  const last=events.at(-1);
  if(event.type==='pointer'&&event.phase==='move'&&last?.type==='pointer'&&last.phase==='move')events[events.length-1]=event;
  else if(event.type==='text'&&last?.type==='text'&&last.text.length+event.text.length<=20000)last.text+=event.text;
  else events.push(event);
  if(events.length>256){error.textContent='输入积压，已停止接管';void stopControl(false);return;}
  clearTimeout(inputTimer);inputTimer=setTimeout(flush,8);
}
async function flush(){
  if(inputBusy||!controlling||!events.length)return;inputBusy=true;
  try{await rpc('input',{events:events.splice(0,64)});}
  catch(e){error.textContent=e.message;await stopControl(false);}
  finally{inputBusy=false;if(controlling&&events.length)inputTimer=setTimeout(flush,0);}
}
function point(e){
  const r=screen.getBoundingClientRect();
  return{x:Math.max(0,Math.min(remoteSize.width-1,Math.floor((e.clientX-r.left)*remoteSize.width/r.width))),y:Math.max(0,Math.min(remoteSize.height-1,Math.floor((e.clientY-r.top)*remoteSize.height/r.height)))};
}
const button=e=>['left','middle','right'][e.button];
screen.onpointerdown=e=>{
  if(!controlling||!button(e))return;screen.setPointerCapture(e.pointerId);keyboard.focus({preventScroll:true});
};
// Pointer down/up only cover the first/last mouse button. Compatibility mouse
// edges also preserve chords (e.g. left and right held together).
screen.onmousedown=e=>{if(controlling&&button(e)){e.preventDefault();enqueue({type:'pointer',phase:'down',...point(e),button:button(e)});}};
screen.onpointermove=e=>{if(controlling)enqueue({type:'pointer',phase:'move',...point(e)});};
screen.onmouseup=e=>{if(controlling&&button(e)){e.preventDefault();enqueue({type:'pointer',phase:'up',...point(e),button:button(e)});}};
screen.onpointercancel=()=>{if(controlling){error.textContent='指针操作已取消，AI 保持暂停';void stopControl(false);}};
screen.onlostpointercapture=e=>{if(controlling&&e.buttons){error.textContent='指针捕获中断，AI 保持暂停';void stopControl(false);}};
screen.oncontextmenu=e=>{if(controlling)e.preventDefault();};
screen.addEventListener('wheel',e=>{
  if(!controlling)return;e.preventDefault();const scale=e.deltaMode===1?16:e.deltaMode===2?remoteSize.height:1;
  enqueue({type:'wheel',...point(e),deltaX:Math.max(-10000,Math.min(10000,e.deltaX*scale)),deltaY:Math.max(-10000,Math.min(10000,e.deltaY*scale))});
},{passive:false});
function keyName(code){
  if(/^Key[A-Z]$/.test(code))return code.slice(3).toLowerCase();if(/^Digit\d$/.test(code))return code.slice(5);
  if(platform==='Linux'){
    const sides={ControlLeft:'Control_L',ControlRight:'Control_R',ShiftLeft:'Shift_L',ShiftRight:'Shift_R',AltLeft:'Alt_L',AltRight:'Alt_R',MetaLeft:'Super_L',MetaRight:'Super_R'};
    if(sides[code])return sides[code];
  }
  const keys={ControlLeft:'Control',ControlRight:'Control',ShiftLeft:'Shift',ShiftRight:'Shift',AltLeft:'Alt',AltRight:'Alt',MetaLeft:'Meta',MetaRight:'Meta',Comma:',',Period:'.',Slash:'/',Semicolon:';',Quote:"'",Backquote:'`',Minus:'-',Equal:'=',BracketLeft:'[',BracketRight:']',Backslash:'\\',NumpadEnter:'Enter'};
  return keys[code]??(/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Enter|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Tab|Space|F([1-9]|1[0-2]))$/.test(code)?code:null);
}
keyboard.onkeydown=e=>{
  if(!controlling||composing||e.isComposing||e.keyCode===229)return;
  // Let local text/IME/paste commit Unicode. Chords/navigation go to the guest.
  if(keymode.value==='text'&&e.key.length===1&&!e.ctrlKey&&!e.altKey&&!e.metaKey)return;
  if(keymode.value==='text'&&e.code==='KeyV'&&(e.ctrlKey||e.metaKey))return;
  const key=keyName(e.code);if(!key)return;e.preventDefault();if(e.repeat)return;
  forwardedKeys.set(e.code,key);enqueue({type:'key',key,down:true});
};
keyboard.onkeyup=e=>{const key=forwardedKeys.get(e.code);if(!controlling||!key)return;e.preventDefault();forwardedKeys.delete(e.code);enqueue({type:'key',key,down:false});};
function commit(){if(controlling&&!composing&&keyboard.value){enqueue({type:'text',text:keyboard.value});keyboard.value='';}}
keyboard.addEventListener('compositionstart',()=>{composing=true;});
keyboard.addEventListener('compositionend',()=>{composing=false;queueMicrotask(commit);});
keyboard.oninput=e=>{if(!e.isComposing)commit();};
keyboard.onpaste=e=>{if(!controlling)return;const text=e.clipboardData?.getData('text/plain');if(text){e.preventDefault();enqueue({type:'text',text});}};
keymode.onchange=()=>{
  events=[];forwardedKeys.clear();keyboard.value='';
  rpc('releaseKeys').then(()=>keyboard.focus({preventScroll:true})).catch(e=>{error.textContent=e.message;void stopControl(false);});
};
takeover.onclick=async()=>{
  if(transition||controlling)return;transition=true;ui();error.textContent='';
  const attempt=++generation;
  try{
    await connect();if(attempt!==generation)throw new Error('接管已取消');
    const result=await rpc('takeover');if(attempt!==generation)throw new Error('接管已取消');
    remoteSize={width:result.width,height:result.height};platform=result.platform;desktopOwner='human';controlling=true;
    $('tree').textContent='';await frame();if(!controlling)throw new Error('接管画面不可用');keyboard.focus({preventScroll:true});
    heartbeat=setInterval(()=>{if(controlling)rpc('heartbeat').catch(e=>{error.textContent=e.message;void stopControl(false);});},1000);
    frameTimer=setTimeout(frameLoop,250);
  }catch(e){error.textContent=e.message;await stopControl(false);}finally{transition=false;ui();}
};
handback.onclick=()=>stopControl(true);
pause.onclick=async()=>{try{await request(paused||(target.value==='desktop'&&desktopOwner==='paused')?'/resume':'/pause',{method:'POST'});await refresh();}catch(e){error.textContent=e.message;}};
$('capture').onclick=()=>frame();
target.onchange=()=>{sessionStorage.setItem('ic-viewer-target',target.value);live.checked=false;clearTimeout(frameTimer);screen.hidden=true;$('tree').textContent='';ui();void refresh();};tabs.onchange=refresh;
live.onchange=()=>{void frameLoop();};
window.addEventListener('blur',()=>{if(controlling||transition)void stopControl(false);});
window.addEventListener('pagehide',()=>{socket?.close();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(frameTimer);if(controlling||transition)void stopControl(false);}else{void refresh();void frameLoop();}});
setInterval(refresh,3000);void refresh();
