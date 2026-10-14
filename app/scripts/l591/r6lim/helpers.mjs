// LIFE-591 최종 관문 「한계 확인」 — 리뷰어 codex-r6-raw 사본(본문 그대로, import 경로만)
/* eslint-disable -- 원본 사본(본문 그대로 — 고치지 않는다) */
import fs from 'node:fs';import path from 'node:path';
import {ctl,until,repoPane,sleep} from '../lib.mjs';
export {ctl,until,repoPane,sleep};
export function helpers(root,repo){
 const js=async code=>{const r=await ctl(root,{cmd:'eval',code});if(!r.ok)throw Error(JSON.stringify(r));return r.result};
 const key=(keyCode,modifiers=[])=>ctl(root,{cmd:'key',keyCode,modifiers});
 const click=selector=>until(async()=> (await ctl(root,{cmd:'click',selector})).ok,{label:selector,timeoutMs:5000});
 const ed=body=>js(`(()=>{const host=document.querySelector('[data-file-editor]');const e=window.reviewMonaco.editor.getEditors().find(e=>host?.contains(e.getContainerDomNode()));const m=e?.getModel();${body}})()`);
 const expose=()=>{const chunk=fs.readdirSync(path.join(process.env.R6_APP_OVERRIDE ?? process.cwd(),'out/renderer/assets')).find(f=>/^monaco-.*\.js$/.test(f));return js(`(async()=>{window.reviewMonaco=(await import('./assets/${chunk}')).monaco;return true})()`)};
 const open=async rel=>{
  const parts=rel.split('/');for(let i=1;i<parts.length;i++){
   const dir=parts.slice(0,i).join('/');await until(()=>js(`!!document.querySelector('[data-explorer-row="${dir}"]')`),{label:dir});
   if(await js(`document.querySelector('[data-explorer-row="${dir}"]').getAttribute('aria-expanded') !== 'true'`))await click(`[data-explorer-row="${dir}"]`);
  }
  await until(()=>js(`!!document.querySelector('[data-explorer-row="${rel}"]')`),{label:rel});
  await ctl(root,{cmd:'dblclick',selector:`[data-explorer-row="${rel}"]`});
  await until(()=>js(`!!document.querySelector('[data-file-view="${rel}"] [data-editor-ready]')`),{label:'editor '+rel});
 };
 const init=async()=>{await repoPane(root,{repo});await ctl(root,{cmd:'resize-window',width:1280,height:800});await until(()=>js(`!!document.querySelector('[data-right-panel]')`));if(await js(`document.querySelector('[data-right-panel]').dataset.rightPanel!=='open'`))await key('L',['meta']);};
 const type=async text=>ed(`e.focus();e.setPosition({lineNumber:1,column:1});e.trigger('keyboard','type',{text:${JSON.stringify(text)}});m.pushStackElement();return m.getValue();`);
 const state=()=>ed(`return {text:m?.getValue(),modelBom:m?.getValueLength(0,true)>m?.getValueLength(0,false),alt:m?.getAlternativeVersionId(),dirty:document.querySelector('[data-file-view]')?.dataset.fileDirty,rel:document.querySelector('[data-file-view]')?.dataset.fileView,scroll:e?.getScrollTop(),position:e?.getPosition(),view:e?.saveViewState()};`);
 const save=async()=>{await key('S',['meta']);await until(()=>js(`document.querySelector('[data-file-view]')?.dataset.fileDirty==='false'`),{label:'saved'});};
 const log=(name,value)=>console.log(JSON.stringify({name,value}));
 return{root,repo,js,key,click,ed,expose,open,init,type,state,save,log};
}
