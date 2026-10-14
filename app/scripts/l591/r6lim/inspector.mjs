// LIFE-591 최종 관문 「한계 확인」 — 리뷰어 codex-r6-raw 사본(본문 그대로, import 경로만)
/* eslint-disable -- 원본 사본(본문 그대로 — 고치지 않는다) */
import fs from 'node:fs';
export async function mainInspector(root){
 const file=fs.readdirSync(root).find(f=>/^electron-.*\.log$/.test(f));
 const url=fs.readFileSync(root+'/'+file,'utf8').match(/Debugger listening on (ws:\/\/\S+)/)?.[1];
 if(!url)throw Error('no inspector');
 const ws=new WebSocket(url);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no});
 let next=0;const pending=new Map();
 ws.onmessage=e=>{const v=JSON.parse(e.data);if(v.id){const p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result)}}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 await evaluate(`globalThis.r5electron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');globalThis.r5w=r5electron.BrowserWindow.getAllWindows()[0];true`);
 return {eval:evaluate,close:()=>ws.close()};
}
