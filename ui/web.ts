// Development host for the unchanged MCP app panel.
const panel=document.getElementById('panel') as HTMLIFrameElement;
const theme=matchMedia('(prefers-color-scheme: dark)');
const send=(message:unknown)=>panel.contentWindow?.postMessage(message,location.origin);
function context(){const p=new URLSearchParams(location.search);return {containerDimensions:{width:panel.clientWidth,height:panel.clientHeight},theme:p.get('theme')|| (theme.matches?'dark':'light'),locale:p.get('locale')||navigator.language};}
window.addEventListener('message',async event=>{
 if(event.source!==panel.contentWindow||event.origin!==location.origin||event.data?.jsonrpc!=='2.0')return;
 const {id,method,params}=event.data;if(id===undefined)return;
 try{
  let result;
  if(method==='ui/initialize')result={protocolVersion:'2026-01-26',hostCapabilities:{},hostContext:context()};
  else if(method==='tools/call'){
   const response=await fetch('/__plugin/tools',{method:'POST',headers:{'Content-Type':'application/json','X-Kanban-Request':'1'},body:JSON.stringify(params)});
   result=await response.json();if(!response.ok)throw new Error(result.error||`HTTP ${response.status}`);
  } else if(method==='ui/open-link'){window.open(params.url,'_blank','noopener');result={};}
  else throw new Error(`Unsupported preview method: ${method}`);
  send({jsonrpc:'2.0',id,result});
 }catch(error){send({jsonrpc:'2.0',id,error:{code:-32000,message:String(error)}});}
});
theme.addEventListener('change',()=>send({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:context()}));
panel.src='/plugin-panel.html';

new ResizeObserver(() => send({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: context() })).observe(panel);
