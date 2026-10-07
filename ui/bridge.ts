import { locale, resolveLocale } from "./i18n";
import { applyMcpHostTheme } from "./theme";
declare const __PLUGIN_VERSION__: string;
function hostContext(context: unknown) {
 applyMcpHostTheme(context);
 const host=context as {locale?:string}|undefined;
 if(host?.locale){const next=resolveLocale([host.locale]);locale.set(next);document.documentElement.lang=next;}
}
let sequence=0;
type Result={isError?:boolean;structuredContent?:{result?:unknown};hostContext?:unknown};
const pending=new Map<number,{resolve:(v:Result)=>void;reject:(e:Error)=>void;timeout:ReturnType<typeof setTimeout>}>();
function rpc(method:string,params:unknown):Promise<Result>{return new Promise((resolve,reject)=>{
 const id=++sequence;const timeout=setTimeout(()=>{pending.delete(id);reject(new Error("Request timed out"));},90000);
 pending.set(id,{resolve,reject,timeout});window.parent.postMessage({jsonrpc:"2.0",id,method,params},"*");
});}
window.addEventListener("message",event=>{
 if(event.source!==window.parent||event.data?.jsonrpc!=="2.0")return;
 const message=event.data,call=pending.get(message.id);
 if(call&&!message.method){pending.delete(message.id);clearTimeout(call.timeout);if(message.error)call.reject(new Error(message.error.message));else call.resolve(message.result);return;}
 if(message.method==="ui/notifications/host-context-changed")hostContext(message.params);
 if(message.method==="ui/resource-teardown"){
  for(const call of pending.values()){clearTimeout(call.timeout);call.reject(new Error("Panel closed"));}pending.clear();
  window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");
 }
});
let initialization:Promise<void>|undefined;
export function initialize(){return initialization??=(rpc("ui/initialize",{appInfo:{name:"chatgpt-kanban",version:__PLUGIN_VERSION__},appCapabilities:{},protocolVersion:"2026-01-26"}).then(result=>{
 hostContext(result.hostContext);window.parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized"},"*");
},error=>{initialization=undefined;throw error;}));}
export async function callTool<T>(name:string,args:Record<string,unknown>):Promise<T>{
 const response=await rpc("tools/call",{name,arguments:args});const result=response.structuredContent?.result as T&{error?:{message?:string}};
 if(response.isError)throw new Error(result?.error?.message||"Tool request failed");
 if(result===undefined)throw new Error("Invalid tool response");return result;
}
export async function openLink(url:string){await rpc("ui/open-link",{url});}
