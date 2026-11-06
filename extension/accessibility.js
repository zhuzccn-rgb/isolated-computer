import { domOperation } from './dom.js';

// Native browser accessibility exposes computed roles/names, including labelled controls.
// Actions use the associated DOM control; they do not dispatch OS/CDP mouse input.
export async function accessibilitySnapshot(send, holder) {
  const {nodes}=await send('Accessibility.getFullAXTree',{depth:16});
  const generation=holder.axGeneration??=crypto.randomUUID();
  holder.axRefs=new Map();
  const controls=[];
  for(const node of nodes) {
    if(node.ignored)continue;
    const properties=Object.fromEntries((node.properties??[]).map(p=>[p.name,p.value?.value]));
    const ref=node.backendDOMNodeId?`ax-${generation}-${node.backendDOMNodeId}`:undefined;
    if(ref)holder.axRefs.set(ref,node.backendDOMNodeId);
    controls.push({ref,role:node.role?.value,name:node.name?.value?.slice(0,1000),value:properties.protected?undefined:node.value?.value,description:node.description?.value?.slice(0,1000),disabled:properties.disabled,checked:properties.checked,expanded:properties.expanded});
    if(controls.length===500)break;
  }
  return {accessibility:{source:'Chromium native accessibility tree',controls,truncated:nodes.length>500,limitations:['Main document only; cross-origin frames require a separate adapter','Semantic actions are synthetic DOM actions; trusted gestures use an isolated browser','Accessibility may be incomplete for canvas or custom controls']}};
}

export async function accessibilityAction(send,holder,action) {
  const backendNodeId=holder.axRefs?.get(action.ref);
  if(!backendNodeId)throw new Error('Unknown/stale accessibility reference; observe again');
  const {object}=await send('DOM.resolveNode',{backendNodeId,objectGroup:'isolated-computer-action'});
  try {
    const result=await send('Runtime.callFunctionOn',{
      objectId:object.objectId,
      functionDeclaration:`function(action){return (${domOperation.toString()})({op:'semantic',element:this,action});}`,
      arguments:[{value:action}],returnByValue:true
    });
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??'Semantic control action failed');
    return result.result.value;
  } finally {await send('Runtime.releaseObjectGroup',{objectGroup:'isolated-computer-action'}).catch(()=>{});}
}
