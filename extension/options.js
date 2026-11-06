const api=globalThis.browser??chrome;
const pairing=document.getElementById('pairing'),error=document.getElementById('error');
pairing.value=(await api.storage.local.get('pairing')).pairing??'';
document.getElementById('connect').onclick=async()=>{try{const r=await api.runtime.sendMessage({op:'connect',pairing:pairing.value.trim()});if(r.error)throw new Error(r.error);error.textContent='已连接，现在可以交接当前网页。';}catch(e){error.textContent=e.message;}};
