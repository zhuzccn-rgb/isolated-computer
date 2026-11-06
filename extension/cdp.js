const api = globalThis.browser ?? chrome;
import { domOperation } from './dom.js';
export const command = (tab, method, params={}) => api.debugger.sendCommand({tabId:tab},method,params);

export async function pageMetrics(tab) {
  const result=await command(tab,'Runtime.evaluate',{expression:'({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,url:location.href})',returnByValue:true});
  if(result.exceptionDetails)throw new Error('Cannot observe this page');
  return result.result.value;
}
export function dimensions(base64,format) {
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
  const view=new DataView(bytes.buffer);
  if(format==='png')return {width:view.getUint32(16),height:view.getUint32(20)};
  let at=2;
  while(at+8<bytes.length){
    if(bytes[at++]!==255)continue;
    const marker=bytes[at++];if(marker===216||marker===217)continue;
    const length=view.getUint16(at);
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return {height:view.getUint16(at+3),width:view.getUint16(at+5)};
    at+=length;
  }
  throw new Error('Cannot determine screenshot dimensions');
}
export async function snapshotCDP(lease,capture='none') {
  const metrics=await pageMetrics(lease.tabId);
  const result={target:'handoff',tab:String(lease.tabId),mode:'cdp',url:metrics.url,state:lease.state,width:metrics.width,height:metrics.height,cssWidth:metrics.width,cssHeight:metrics.height};
  lease.viewport={width:metrics.width,height:metrics.height};lease.scale=1;
  if(capture!=='none'){
    let image,lastError;
    for(let attempt=0;attempt<3;attempt++){
      try{image=await command(lease.tabId,'Page.captureScreenshot',{format:capture,fromSurface:true,captureBeyondViewport:false,...(capture==='jpeg'?{quality:85}:{})});break;}
      catch(error){lastError=error;await new Promise(r=>setTimeout(r,100));}
    }
    if(!image){
      try{
        const tab=await api.tabs.get(lease.tabId),active=(await api.tabs.query({windowId:tab.windowId,active:true}))[0];
        if(active?.id!==lease.tabId)throw new Error('Leased tab is not active in its own background window');
        const dataURL=await api.tabs.captureVisibleTab(tab.windowId,{format:capture,...(capture==='jpeg'?{quality:85}:{})});
        image={data:dataURL.slice(dataURL.indexOf(',')+1)};
        result.screenshotTransport='captureVisibleTab; no window activation';
      }catch(error){
        const inspected=await command(lease.tabId,'Runtime.evaluate',{expression:'('+domOperation.toString()+')({op:"inspect"})',returnByValue:true});
        result.fields=inspected.result?.value?.fields;
        result.screenshotError=String(lastError?.message??'')+'; '+error.message;
        result.coordinateMode='DOM bounds in CSS pixels; screenshot unavailable';
        lease.scale=1;lease.viewport={width:metrics.width,height:metrics.height};return result;
      }
    }
    const size=dimensions(image.data,capture);
    lease.scale=size.width/metrics.width;lease.viewport={width:metrics.width,height:metrics.height};
    Object.assign(result,size,{image:{data:image.data,mimeType:'image/'+capture},coordinateScale:lease.scale});
  }
  return result;
}
