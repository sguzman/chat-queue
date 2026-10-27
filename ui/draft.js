'use strict';
// Cross-origin isolated editor. No privileged browser API, storage or network.
// The only data channel is the explicitly transferred MessagePort.
const field=document.getElementById('draft');
let channel=null;
window.addEventListener('message',event=>{
  if(channel||event.source!==parent||event.origin!=='https://chatgpt.com'||
     event.data?.type!=='queue-draft-init'||
     event.data.token!==location.hash.slice(1)||
     event.ports?.length!==1)return;
  channel=event.ports[0];
  channel.onmessage=e=>{
    const data=e.data;
    if(!data||typeof data!=='object')return;
    if(data.type==='set'&&typeof data.value==='string'&&data.value.length<=10000){
      field.value=data.value;
    }else if(data.type==='read'&&Number.isSafeInteger(data.id)){
      channel.postMessage({type:'snapshot',id:data.id,value:field.value});
    }
  };
  channel.start();
  channel.postMessage({type:'ready'});
});
field.addEventListener('input',()=>{
  if(channel)channel.postMessage({type:'input',value:field.value});
});
