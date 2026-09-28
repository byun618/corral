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
// 그래서 출력 경로는 **쓰기 전에** 다섯 층으로 판정한다. 필수 인자 한 층만으로는 부족하다: 그것은
// "아무것도 안 주면" 만 막고, 동결 경로를 **명시해서** 주는 세 번째 사고는 그대로 통과시킨다.
//
//   ① `CORRAL_VERIFY_RAW` 가 없으면 거절한다. 기본 경로는 없앴다.
//   ② 경로를 `realpath` 로 끝까지 푼다. 심링크 문자열 그대로 보면 git 은 「저장소 밖」이라 답하는데
//      `writeFileSync` 는 링크를 따라 동결 트리 안으로 들어간다. 아직 없는 디렉터리는 가장 가까운
//      존재하는 조상을 풀고 나머지 이름을 이어 붙인다. 안 풀리는 링크는 거절한다.
//   ③ **주인 판정**. 푼 경로가 어느 저장소의 `specs/` 아래인지 묻고(그 경로 **자신의** 저장소에 묻는다 —
//      이 체크아웃에서 물으면 본체 체크아웃이 exit 128 로 「추적 없음」이 된다), 경로가 말하는 일감과
//      이 실행의 일감(`CORRAL_VERIFY_TASK` → 브랜치 이름 → worktree 폴더 이름)이 다르면 거절한다.
//      `specs/` 루트처럼 주인을 말하지 않는 자리도 거절이다. 이 층이 **동결 트리 안의 아직 빈 새 하위
//      폴더**를 막는다 — 덮어쓰기만 막으면 그 트리에 새 파일을 만드는 길이 남는다.
//   ④ 그 디렉터리가 git 추적 파일을 하나라도 담고 있으면 거절한다 — 그것은 누군가 커밋한 원자료
//      트리이고, 이 스크립트가 그 안에 무언가를 만들 이유가 없다. (쓰려는 파일 자신이 추적 중인
//      경우도 여기에 걸린다 — 동결 raw 의 `source-reconstruction-final.json` 이 정확히 그 경우다.)
//      git 이 답하지 못하면 통과가 아니라 **거절**이다. 답을 못 들은 것은 「추적 없음」이 아니다.
//   ⑤ 쓰려는 파일이 이미 있으면 거절한다. 추적되지 않는 앞선 회차의 기록도 덮지 않는다.
//
// 그리고 실제 쓰기는 `'wx'` 로 한다 — 판정과 쓰기 사이의 창을 커널이 닫는다.
//
// 한계 세 가지. ③④ 는 git 이 있는 저장소 안에서만 말한다. 대상이 어느 저장소에도 속하지 않으면
// (`/tmp/…` 등) ①·⑤·`'wx'` 만 남고, 거절 메시지가 `git: 답 없음` 을 말한다. ③ 은 `specs/LIFE-NNN-`
// 규약에 기댄다 — 그 규약 밖 이름의 증거 트리는 ④ 가 맡는다. 그리고 ④·⑤ 는 *새* 디렉터리를
// 요구하므로, 같은 관문을 다시 돌리려면 회차마다 새 하위 폴더를 준다. 그것이 옆에 쓰고 덮지 않는다는
// 규칙(LIFE-410 N12=C18)과 같은 말이다.
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
/** git 한 번. 답하지 못하면 `null` 이다 — 저장소 밖이거나 git 이 죽은 경우. 출력이 커도 자르지 않는다
 *  (`specs/` 의 `ls-files` 는 1.5MB 라 기본 maxBuffer 1MB 에서 자식이 죽고 목록이 빈 것처럼 보였다 — grok G2). */
const git=(cwd,args)=>{
 const result=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',maxBuffer:256*1024*1024})
 return result.error!==undefined||result.status!==0?null:result.stdout
}
const TASK=/^LIFE-(\d+)\b/
// ① 이 실행이 쓸 디렉터리를 직접 지정한다. 기본 출력 경로는 없다.
const rawEnv=process.env.CORRAL_VERIFY_RAW
if(rawEnv===undefined||rawEnv.trim()==='')refuse(
 'CORRAL_VERIFY_RAW 가 필요하다. 기본 출력 경로는 없앴다 — 이 실행이 기록을 쓸 디렉터리를 직접 지정한다.',
 {예시:'CORRAL_VERIFY_RAW="$PWD/specs/LIFE-NNN-<슬러그>/raw/worker/<owner>/backend/<회차>" node app/scripts/l393/verify-backend-source.mjs',
  이유:'예전 기본값은 specs/LIFE-393-cli-terminal/raw/codex 로 풀렸고 이 스크립트는 거기 고정 파일명을 덮어썼다 (LIFE-430 C4)'})
// ② 심링크를 끝까지 푼 뒤에 판단한다. 링크 문자열 그대로 보면 git 은 「저장소 밖」이라 답하는데
//    `writeFileSync` 는 링크를 따라 동결 트리 안으로 들어간다. 아직 없는 디렉터리는 **가장 가까운 존재하는
//    조상**을 풀고 나머지 이름을 이어 붙인다.
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
// ③ 이 실행이 **누구의** 증거 트리에 쓰는지. 경로가 말하는 일감과 이 실행의 일감이 다르면 거절한다.
//    남의 일감 폴더 안이면 아직 파일이 없는 새 하위 폴더여도 거절이다 — 동결 트리에 새 파일을 만드는 것도 오염이고,
//    `specs/` 처럼 주인을 말하지 않는 자리도 거절이다. 저장소는 **대상 경로 자신의 저장소**를 묻는다 —
//    이 체크아웃에서 `git -C repoRoot` 로 물으면 본체 체크아웃의 동결 raw 가 exit 128 로 「추적 없음」이 됐다.
const home=git(resolved.anchor,['rev-parse','--show-toplevel'])
const inside=home===null?null:home.trim()
const mine=(()=>{
 const named=process.env.CORRAL_VERIFY_TASK
 if(named!==undefined&&named.trim()!=='')return {task:TASK.exec(named.trim())?.[1]??null,from:'CORRAL_VERIFY_TASK'}
 const branch=git(repoRoot,['symbolic-ref','--short','HEAD'])?.trim() ?? null
 if(branch!==null&&TASK.test(branch))return {task:TASK.exec(branch)[1],from:`브랜치 ${branch}`}
 const folder=path.basename(repoRoot)
 if(TASK.test(folder))return {task:TASK.exec(folder)[1],from:`worktree 폴더 ${folder}`}
 return {task:null,from:branch===null?'detached HEAD 이고 worktree 폴더 이름에도 일감이 없다':`브랜치 ${branch} 에 일감 번호가 없다`}
})()
if(inside!==null){
 const rel=path.relative(inside,raw)
 if(rel==='specs'||rel.startsWith(`specs${path.sep}`)){
  const folder=rel.split(path.sep)[1]
  const owner=folder===undefined?null:TASK.exec(folder)?.[1]??null
  if(owner===null)refuse(
   'CORRAL_VERIFY_RAW 가 specs/ 아래인데 어느 일감의 자리인지 경로가 말하지 않는다. 주인을 모르는 트리에는 쓰지 않는다.',
   {디렉터리:describe(raw,inside),복구:'specs/LIFE-NNN-<슬러그>/raw/… 아래 이 회차만의 디렉터리를 준다'})
  if(mine.task===null)refuse(
   '이 실행이 어느 일감인지 알 수 없어 남의 증거 트리인지 가릴 수 없다.',
   {디렉터리:describe(raw,inside),현재:mine.from,복구:'CORRAL_VERIFY_TASK=LIFE-NNN 으로 이 실행의 일감을 알린다'})
  if(owner!==mine.task)refuse(
   'CORRAL_VERIFY_RAW 가 다른 일감의 증거 트리를 가리킨다. 출고된 작업의 원자료 위에도, 그 안 새 자리에도 쓰지 않는다.',
   {디렉터리:describe(raw,inside),경로의_일감:`LIFE-${owner}`,이_실행의_일감:`LIFE-${mine.task}`,이_실행의_근거:mine.from,
    복구:'이 일감 폴더 아래 이 회차만의 새 디렉터리를 준다'})
 }
 // ④ 이미 커밋된 파일을 담은 디렉터리는 자기 일감 안이어도 거절한다.
 //    git 이 답하지 못하면 통과가 아니라 거절이다 — 답을 못 들은 것을 「추적 없음」으로 읽지 않는다.
 const listed=git(inside,['ls-files','--',raw])
 if(listed===null)refuse(
  'git 이 이 디렉터리의 추적 파일을 답하지 못했다. 답을 못 들은 것을 「추적 없음」으로 읽지 않는다.',
  {디렉터리:describe(raw,inside),복구:'git 이 답하는 상태에서 다시 돌리거나, 저장소 밖 디렉터리를 준다'})
 const committed=listed.split('\n').filter(line=>line.length>0)
 if(committed.length>0)refuse(
  'CORRAL_VERIFY_RAW 가 이미 커밋된 원자료를 담은 디렉터리를 가리킨다. 출고된 작업의 동결 증거 위에는 쓰지 않는다.',
  {디렉터리:describe(raw,inside),추적중인_파일수:committed.length,첫_파일:committed[0],
   복구:'이 실행 회차만의 새 디렉터리를 준다 — 기존 기록 옆에 쓰고, 그 위에 쓰지 않는다'})
}
// ⑤ 쓰려는 파일이 이미 있으면 거절한다. git 이 아무 말도 하지 않는 저장소 밖 자리의 마지막 관문이다 (쓰기는 'wx').
if(fs.existsSync(target))refuse(
 '쓰려는 파일이 이미 있다. 앞선 회차의 기록을 덮지 않는다.',
 {파일:describe(target,inside??repoRoot),git:inside===null?'답 없음 (이 저장소 밖이거나 git 이 없다)':'추적 안 됨',
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
