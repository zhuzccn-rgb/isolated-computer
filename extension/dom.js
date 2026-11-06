// This function is serialized into an isolated extension execution world.
export function domOperation(args) {
  // Isolated-world references never add attributes or handlers to the user's DOM.
  const key = Symbol.for('isolated-computer.controls');
  const store = globalThis[key] ??= { nodes: new Map(), next: 1, generation:Array.from(crypto.getRandomValues(new Uint8Array(12)),n=>n.toString(16).padStart(2,'0')).join('') };
  for(const [ref,node] of store.nodes)if(!node.isConnected)store.nodes.delete(ref);
  const refFor = el => { for (const [ref,node] of store.nodes) if(node===el)return ref; const ref='dom-'+store.generation+'-'+store.next++;store.nodes.set(ref,el);return ref; };
  const candidates = () => [...document.querySelectorAll('input,textarea,select,button,a[href],[role="button"],[contenteditable="true"]')].filter(el => {
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  });
  const submitControl = el => {
    const button = el?.closest('button,input');
    return Boolean(button?.form && ['submit','image'].includes(button.type));
  };
  if(args.op==='semantic') {
    const el=args.element??store.nodes.get(args.action.ref), action=args.action;
    if(!el?.isConnected)throw new Error('Stale control reference; observe again');
    if(el.disabled||el.readOnly||el.closest('[inert]')||el.getAttribute('aria-disabled')==='true')throw new Error('Control is disabled or read-only');
    if(action.type==='click') {
      if(submitControl(el))return {needsConfirmation:true};
      if(!el.matches('button,input,a[href],[role="button"],[role="checkbox"],[role="radio"]'))throw new Error('This node has no supported semantic click');
      // HTMLElement.click() never sends mouse events to the OS/window manager.
      el.click();return {eventMode:'synthetic-semantic'};
    }
    if(action.type==='fill') {
      if(!['INPUT','TEXTAREA'].includes(el.tagName)||['file','password','checkbox','radio','submit','button','hidden','image'].includes(el.type))throw new Error('Unsupported text control; human input required');
      const proto=el.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,action.text);
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:action.text}));
      el.dispatchEvent(new Event('change',{bubbles:true}));return {eventMode:'synthetic-semantic'};
    }
    if(action.type==='select') {
      if(el.tagName!=='SELECT'||![...el.options].some(o=>o.value===action.value&&!o.disabled))throw new Error('Unknown or disabled select option');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,action.value);
      el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {eventMode:'synthetic-semantic'};
    }
    if(action.type==='check') {
      if(el.tagName!=='INPUT'||!['checkbox','radio'].includes(el.type))throw new Error('Unsupported checked control');
      if(el.type==='radio'&&!action.checked)throw new Error('A radio button cannot be unchecked independently');
      if(el.checked!==action.checked)el.click();return {eventMode:'synthetic-semantic'};
    }
    throw new Error('Unsupported semantic action');
  }
  if (args.op === 'checkSubmit') return { submit: submitControl(document.elementFromPoint(args.x,args.y)) };
  if (args.op === 'inspect') return {
    url: location.href, width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    fields: candidates().slice(0,150).map(el => {
      const r = el.getBoundingClientRect();
      return { ref:refFor(el), role:el.getAttribute('role')||({BUTTON:'button',A:'link',TEXTAREA:'textbox',SELECT:'combobox',INPUT:['checkbox','radio'].includes(el.type)?el.type:'textbox'}[el.tagName]), tag: el.tagName.toLowerCase(), type: el.type, label: el.labels?.[0]?.textContent?.trim() || el.getAttribute('aria-label') || el.placeholder || el.textContent?.trim().slice(0,200), value: el.type === 'password' ? undefined : el.value, disabled: Boolean(el.disabled), x:r.x,y:r.y,width:r.width,height:r.height };
    }), limitations: ['DOM actions are synthetic and cannot produce trusted browser input', 'Top frame only; cross-origin iframe controls need separate authorization', 'Canvas, native dialogs and complex drag gestures are unsupported']
  };
  throw new Error('Unknown semantic operation');
}
