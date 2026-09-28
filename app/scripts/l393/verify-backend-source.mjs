import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
import {app} from './lib.mjs'
// LIFE-430 C4 (LA ③, 구 LIFE-424). 이 스크립트의 출력 경로는 기본값이 LIFE-393 의 **동결 raw** 로
// 풀렸고, 파일명이 고정이라 그 자리를 그대로 덮어썼다. LIFE-409 구현이 이 함정을 두 번(r1·r3) 밟아
// 출고된 작업의 원자료가 지워졌다 — `43ba1fa6` 가 덮었고 r3 리뷰가 잡아 `7cfdd0f8` 로 복원했다.
// 증거가 진실의 원천인 구조에서, 증거를 지우는 쪽이 기본값이었다.
//
// 그래서 출력 경로는 **쓰기 전에** 판정한다. 그리고 r3 에서 판정의 **방향을 뒤집었다**: 거부 목록이
// 아니라 **허용 목록**이다. 거부 목록은 층을 쌓을수록 새 우회가 나왔다 — 3층(r1) → 5층(r2) 뒤에도
// macOS 의 대소문자 별칭(`SPECS/…`)과 `CORRAL_VERIFY_TASK=LIFE-393` 한 줄이 그대로 지나갔다.
// 허용 목록은 반대다: **허용되는 자리를 먼저 적고, 나머지를 전부 거절한다.**
//
//   ① `CORRAL_VERIFY_RAW` 가 없으면 거절한다. 기본 경로는 없다.
//   ② 경로를 `realpath` 로 끝까지 푼다. 심링크 문자열 그대로 보면 판정과 쓰기가 다른 곳을 본다.
//      아직 없는 디렉터리는 가장 가까운 존재하는 조상을 풀고 나머지 이름을 잇는다.
//   ③ **허용 목록.** 다음 둘 중 하나일 때만 지나간다.
//        (ㄱ) 이 스크립트를 돌리는 worktree **자신의 일감 폴더** 아래.
//        (ㄴ) **어느 git 저장소에도 속하지 않는 곳** (`/tmp/…` 등).
//      나머지는 전부 거절이다 — 다른 일감의 폴더, `specs/` 루트, 저장소 루트, 다른 worktree,
//      격리 fixture 저장소까지.
//   ④ 허용된 자리 안에서도, 이미 커밋된 파일을 담은 디렉터리는 거절한다. git 이 답하지 못하면
//      통과가 아니라 거절이다 — 답을 못 들은 것은 「추적 없음」이 아니다.
//   ⑤ 쓰려는 파일이 이미 있으면 거절한다. 쓰기는 `'wx'` — 판정과 쓰기 사이의 창을 커널이 닫는다.
//
// **두 가지를 일부러 그렇게 했다.**
//
// 첫째, ③(ㄱ) 의 "아래" 는 **문자열이 아니라 신원**으로 본다. 대상의 존재하는 조상 사슬을 올라가며
// `{dev, ino}` 가 일감 폴더의 것과 같은 자리가 있는지 본다. macOS 의 `SPECS/…` 는 `specs/…` 와
// **같은 inode** 이므로 같은 자리로 판정된다. 문자열을 소문자로 접는 방식은 쓰지 않는다 —
// 대소문자를 구분하는 파일 시스템에서는 서로 **다른** 디렉터리를 하나로 합쳐 버린다.
//
// 둘째, 일감 번호는 **환경변수에서 받지 않는다.** r2 의 `CORRAL_VERIFY_TASK` 는 한 줄로 남의 동결
// 트리를 자기 것이라고 선언하게 해 줬고, 거절 메시지가 그 변수를 복구 방법으로 가르치기까지 했다.
// 번호는 실행하는 worktree 자신에서만 나온다: 브랜치 이름, 없으면 worktree 폴더 이름.
//
// 한계. ③(ㄴ) 때문에 저장소 밖 아무 디렉터리나 쓸 수 있다 — 그래도 동결 증거는 전부 저장소 안이라
// 그 길로는 닿지 않는다. 검증·리뷰 worktree 가 detached 이고 폴더 이름에도 일감 번호가 없으면
// 자기 일감 폴더를 못 찾는다. 그때는 저장소 **밖** 디렉터리로 돌리면 된다(③(ㄴ)). 그리고 격리
// git fixture 도 거절된다 — 가드를 시험하려면 저장소가 아닌 임시 디렉터리를 쓴다.
//
// 이 판정은 `CORRAL_BACKEND_BUILD_ROOT` 검사보다 **먼저** 오고, 어떤 파일·임시 디렉터리보다 앞에
// 선다 (아래 `mkdtempSync` 도 쓰기다).
const OUTPUT_NAME='source-reconstruction-final.json'
const repoRoot=path.resolve(app,'..')
/** 기록에 로컬 절대경로를 남기지 않는다 (LIFE-426 누출 규칙). 주어진 루트 밖이면 경로를 말하지 않는다. */
const describe=(target,root=repoRoot)=>{const rel=path.relative(root,target);if(rel.startsWith('..')||path.isAbsolute(rel))return '(이 저장소 밖 경로)';return rel===''?'(저장소 루트)':rel}
const refuse=(why,detail)=>{
 console.error(`verify-backend-source: ${why}`)
 for(const [key,value] of Object.entries(detail))console.error(`  ${key}: ${value}`)
 process.exit(2)
}
/** git 한 번. 답하지 못하면 `null` 이다 — 저장소 밖이거나 git 이 죽은 경우. 출력이 커도 자르지 않는다. */
const git=(cwd,args)=>{
 const result=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',maxBuffer:256*1024*1024})
 return result.error!==undefined||result.status!==0?null:result.stdout
}
/** 경로의 신원. 문자열이 달라도 같은 디렉터리면 같은 값이다 (macOS 의 `SPECS`/`specs` 별칭). */
const identity=target=>{try{const info=fs.statSync(target);return `${info.dev}:${info.ino}`}catch{return null}}
/** 대상의 조상 사슬에 그 신원이 있는가. 아직 없는 경로는 존재하는 조상까지 올라가며 본다. */
const under=(target,rootIdentity)=>{
 if(rootIdentity===null)return false
 let current=target
 for(;;){
  if(identity(current)===rootIdentity)return true
  const parent=path.dirname(current)
  if(parent===current)return false
  current=parent
 }
}
const TASK=/^LIFE-(\d+)\b/
// ① 이 실행이 쓸 디렉터리를 직접 지정한다. 기본 출력 경로는 없다.
const rawEnv=process.env.CORRAL_VERIFY_RAW
if(rawEnv===undefined||rawEnv.trim()==='')refuse(
 'CORRAL_VERIFY_RAW 가 필요하다. 기본 출력 경로는 없앴다 — 이 실행이 기록을 쓸 디렉터리를 직접 지정한다.',
 {예시:'CORRAL_VERIFY_RAW="$PWD/specs/LIFE-NNN-<슬러그>/raw/worker/<owner>/backend/<회차>" node app/scripts/l393/verify-backend-source.mjs',
  이유:'예전 기본값은 specs/LIFE-393-cli-terminal/raw/codex 로 풀렸고 이 스크립트는 거기 고정 파일명을 덮어썼다 (LIFE-430 C4)'})
// ② 심링크를 끝까지 푼다. 아직 없는 디렉터리는 가장 가까운 존재하는 조상을 풀고 나머지를 잇는다.
const resolved=(()=>{
 let current=path.resolve(rawEnv)
 const tail=[]
 for(;;){
  let named=true
  try{fs.lstatSync(current)}catch{named=false}
  if(named){
   let real
   try{real=fs.realpathSync(current)}catch{refuse(
    'CORRAL_VERIFY_RAW 가 풀리지 않는 심볼릭 링크를 지난다.',
    {경로:describe(current),복구:'실재하는 디렉터리를 준다'})}
   return {path:path.join(real,...tail),anchor:fs.statSync(real).isDirectory()?real:path.dirname(real)}
  }
  const parent=path.dirname(current)
  if(parent===current)return {path:current,anchor:current}
  tail.unshift(path.basename(current))
  current=parent
 }
})()
const raw=resolved.path
const target=path.join(raw,OUTPUT_NAME)
// ③ 허용 목록. 이 worktree 자신의 일감 폴더이거나, 어느 저장소에도 속하지 않는 곳.
const mine=(()=>{
 const branch=git(repoRoot,['symbolic-ref','--short','HEAD'])?.trim()??null
 if(branch!==null&&TASK.test(branch))return {task:TASK.exec(branch)[1],from:`브랜치 ${branch}`}
 const folder=path.basename(repoRoot)
 if(TASK.test(folder))return {task:TASK.exec(folder)[1],from:`worktree 폴더 ${folder}`}
 return {task:null,from:branch===null?'detached HEAD 이고 worktree 폴더 이름에도 일감 번호가 없다':`브랜치 ${branch} 에 일감 번호가 없다`}
})()
const home=(()=>{
 if(mine.task===null)return {identity:null,why:`이 실행의 일감을 알 수 없다 (${mine.from})`}
 const specs=path.join(repoRoot,'specs')
 let named=[]
 try{named=fs.readdirSync(specs).filter(name=>new RegExp(`^LIFE-${mine.task}-`).test(name))}catch{
  return {identity:null,why:'이 worktree 에 specs/ 가 없다'}}
 if(named.length!==1)return {identity:null,why:`specs/ 에서 LIFE-${mine.task}-… 폴더를 하나로 정하지 못했다 (${named.length}개)`}
 const folder=path.join(specs,named[0])
 return {identity:identity(fs.realpathSync(folder)),path:folder,why:null}
})()
const allowed=under(raw,home.identity)
if(!allowed){
 // 저장소 밖이면 지나간다. 저장소 안인데 내 일감 폴더가 아니면 거절이다 — 어느 저장소든.
 const inside=git(resolved.anchor,['rev-parse','--show-toplevel'])?.trim()??null
 if(inside!==null)refuse(
  'CORRAL_VERIFY_RAW 가 허용되지 않은 자리를 가리킨다. 이 스크립트는 **이 worktree 자신의 일감 폴더** 아래이거나, 어느 git 저장소에도 속하지 않는 곳에만 쓴다.',
  {디렉터리:describe(raw,inside),대상이_속한_저장소:inside===repoRoot?'이 worktree':'다른 저장소 또는 다른 worktree',
   이_실행의_일감:mine.task===null?`알 수 없음 — ${mine.from}`:`LIFE-${mine.task} (${mine.from})`,
   허용되는_자리:home.identity===null?`정하지 못했다 — ${home.why}`:describe(home.path),
   복구:'이 일감 폴더 아래 이 회차만의 새 디렉터리를 주거나, 저장소 밖 디렉터리(예: 임시 폴더)를 준다'})
}
// ④ 허용된 자리 안에도 이미 커밋된 원자료가 있다. 그 위에는 쓰지 않는다.
const inRepo=git(resolved.anchor,['rev-parse','--show-toplevel'])?.trim()??null
if(inRepo!==null){
 const listed=git(inRepo,['ls-files','--',raw])
 if(listed===null)refuse(
  'git 이 이 디렉터리의 추적 파일을 답하지 못했다. 답을 못 들은 것을 「추적 없음」으로 읽지 않는다.',
  {디렉터리:describe(raw,inRepo),복구:'git 이 답하는 상태에서 다시 돌리거나, 저장소 밖 디렉터리를 준다'})
 const committed=listed.split('\n').filter(line=>line.length>0)
 if(committed.length>0)refuse(
  'CORRAL_VERIFY_RAW 가 이미 커밋된 원자료를 담은 디렉터리를 가리킨다. 기존 기록 위에는 쓰지 않는다.',
  {디렉터리:describe(raw,inRepo),추적중인_파일수:committed.length,첫_파일:committed[0],
   복구:'이 실행 회차만의 새 디렉터리를 준다 — 기존 기록 옆에 쓰고, 그 위에 쓰지 않는다'})
}
// ⑤ 쓰려는 파일이 이미 있으면 거절한다.
if(fs.existsSync(target))refuse(
 '쓰려는 파일이 이미 있다. 앞선 회차의 기록을 덮지 않는다.',
 {파일:describe(target,inRepo??repoRoot),git:inRepo===null?'답 없음 (이 저장소 밖이거나 git 이 없다)':'추적 안 됨',
  복구:'이 실행 회차만의 새 디렉터리를 준다'})
const work=process.env.CORRAL_BACKEND_BUILD_ROOT
assert(work,'Set CORRAL_BACKEND_BUILD_ROOT')
const source=JSON.parse(fs.readFileSync(path.join(app,'backend/source.json')))
const hash=buffer=>createHash('sha256').update(buffer).digest('hex')
assert.equal(hash(fs.readFileSync(path.join(work,'herdr.tar.gz'))),source.archiveSHA256)
const root=fs.mkdtempSync('/tmp/l393-' + (process.env.CORRAL_VERIFY_OWNER ?? 'codex') + '-source-'),extracted=path.join(root,'herdr-0.9.0')
const unpack=spawnSync('tar',['-xzf',path.join(work,'herdr.tar.gz'),'-C',root]);assert.equal(unpack.status,0)
const files=new Set()
for(const name of source.patches){
 const patch=fs.readFileSync(path.join(app,'backend',name));assert.equal(hash(patch),source.patchSHA256[name])
 const applied=spawnSync('patch',['-p1'],{cwd:extracted,input:patch});assert.equal(applied.status,0,applied.stdout.toString()+applied.stderr.toString())
 for(const line of patch.toString().split('\n'))if(line.startsWith('+++ b/'))files.add(line.slice(6))
}
const records=[]
for(const file of files){const expected=fs.readFileSync(path.join(extracted,file)),actual=fs.readFileSync(path.join(work,'herdr-0.9.0',file));assert.deepEqual(actual,expected,file);records.push({file,sha256:hash(actual),matchesReconstruction:true})}
fs.mkdirSync(raw,{recursive:true});fs.writeFileSync(target,JSON.stringify({source,records},null,2)+'\n',{flag:'wx'});console.log(`${records.length} patched files match pinned archive + committed patches`)
