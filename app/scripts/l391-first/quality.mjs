import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),root=path.dirname(app)
const raw = process.env.CORRAL_VERIFY_RAW ? path.resolve(process.env.CORRAL_VERIFY_RAW) : path.join(root,'specs/LIFE-391-command-palette-cli/raw/first-release/codex/quality')
fs.mkdirSync(raw,{recursive:true})
const results=[]
for(const [name,args]of [['typecheck',['run','typecheck']],['build',['run','build']],['boundary',['run','check:boundary']],['vitest',['exec','--','vitest','run']],['lint',['run','lint','--','--format','json']]]){
 const start=Date.now(),r=spawnSync('npm',args,{cwd:app,env:{...process.env,TMPDIR:'/tmp'},encoding:'utf8',timeout:180000,maxBuffer:12*1024*1024})
 fs.writeFileSync(path.join(raw,name+'.log'),r.stdout+r.stderr)
 results.push({name,argv:['npm',...args],exit:r.status,durationMs:Date.now()-start})
}
const baseline=JSON.parse(JSON.parse(fs.readFileSync(path.join(root,'specs/LIFE-391-command-palette-cli/raw/coordinator/baseline-eslint.json'),'utf8')).stdout)
const lintText=fs.readFileSync(path.join(raw,'lint.log'),'utf8'),candidate=JSON.parse(lintText.slice(lintText.indexOf('[{')))
const counts=rows=>{const m=new Map();for(const row of rows)for(const msg of row.messages){const key=JSON.stringify([row.filePath.split('/app/').at(-1),msg.ruleId,msg.message]);m.set(key,(m.get(key)??0)+1)}return m}
const before=counts(baseline),after=counts(candidate),added=[...after].flatMap(([key,n])=>n>(before.get(key)??0)?[{key,added:n-(before.get(key)??0)}]:[])
const report={head:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim(),node:process.version,TMPDIR:'/tmp',results,lint:{baselineErrors:baseline.reduce((s,r)=>s+r.errorCount,0),candidateErrors:candidate.reduce((s,r)=>s+r.errorCount,0),added}}
fs.writeFileSync(path.join(raw,'summary.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
if(results.some(r=>r.name!=='lint'&&r.exit!==0)||added.length)process.exitCode=1
