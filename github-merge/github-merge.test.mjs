import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const script=new URL('./github-merge.mjs',import.meta.url).pathname;
const mockTines=`#!/usr/bin/env node
const fs=require('node:fs');
const a=process.argv.slice(2).filter(x=>x!=='--json');
fs.appendFileSync(process.env.LOG,JSON.stringify({bin:'tines',args:a})+'\\n');
if(a[0]==='issues'&&a[1]==='show') console.log(JSON.stringify({state:{id:'waiting'},allowed_transitions:[{name:'Merged'},{name:'Merge failed'}]}));
else if(a[0]==='issues'&&a[1]==='artifacts'&&a[2]==='list') console.log(JSON.stringify({items:[{name:'pr',artifact_type:'pr',current_version:{version:process.env.MODE==='changed_artifact'&&fs.existsSync(process.env.COUNT)?2:1,pr_repo_url:'https://github.com/acme/app',pr_number:123}}]}));
else if(a[0]==='issues'&&a[1]==='comment'&&process.env.COMMENT_FAIL==='1') {console.error('comment failed');process.exit(1);}
else console.log('{}');
`;
const mockGh=`#!/usr/bin/env node
const fs=require('node:fs');
const a=process.argv.slice(2);
fs.appendFileSync(process.env.LOG,JSON.stringify({bin:'gh',args:a})+'\\n');
const mode=process.env.MODE;
const samples=JSON.parse(process.env.SAMPLES||'null');
const n=Number(fs.existsSync(process.env.COUNT)&&fs.readFileSync(process.env.COUNT,'utf8'))||0;
if(a[1]==='view'){
fs.writeFileSync(process.env.COUNT,String(n+1));
if(samples){ console.log(JSON.stringify(samples[Math.min(n,samples.length-1)].view)); } else {
const merged=mode==='merged'||mode==='changed_artifact'||mode==='eventually_merged'&&n>0||mode==='blocked_then_merged'&&n>2||mode==='prerequisite_checks_then_merged'&&n>2;
console.log(JSON.stringify({number:123,url:'https://github.com/acme/app/pull/123',state:merged?'MERGED':mode==='closed'?'CLOSED':'OPEN',headRefOid:'a'.repeat(40),baseRefName:'main',mergedAt:null,mergeCommit:null,isDraft:mode==='draft',mergeable:mode==='conflict'?'CONFLICTING':'MERGEABLE',mergeStateStatus:mode==='blocked'||mode==='blocked_then_merged'?'BLOCKED':mode==='behind'?'BEHIND':'CLEAN',autoMergeRequest:mode==='no_auto'?null:{enabledAt:'2026-10-08'},reviewDecision:mode==='no_approval'?'REVIEW_REQUIRED':'APPROVED'}));
}
}else if(a[0]==='api'){
if(a[1]!=='repos/acme/app/pulls/123') process.exit(3);
console.log(JSON.stringify(samples?samples[Math.min(n-1,samples.length-1)].pull:{number:123,state:'open',merged:false,head:{sha:'a'.repeat(40)},base:{ref:'main'},mergeable_state:'behind',rebaseable:true}));
}else if(a[1]==='checks'){
const required=a.includes('--required');
if(mode==='prerequisite_checks_then_merged'){
 console.log(JSON.stringify(required?[]:[{name:'prerequisite',state:'IN_PROGRESS',bucket:'pending',link:null}]));
 if(!required) process.exit(8);
}else{
 const bucket=mode==='failed_checks'?'fail':mode==='pending'?'pending':'pass';
 console.log(JSON.stringify(mode==='missing_checks'?[]:[{name:'build',state:'SUCCESS',bucket,link:null}]));
 if(bucket==='fail') process.exit(1);
 if(bucket==='pending') process.exit(8);
}
}else process.exit(3);
`;
async function simulate(mode,{commentFail=false,samples=null}={}){
const dir=await mkdtemp(join(tmpdir(),'merge-test-'));
try{
const bin=join(dir,'bin');await mkdir(bin);
for(const [name,src] of [['tines',mockTines],['gh',mockGh]]){const p=join(bin,name);await writeFile(p,src);await chmod(p,0o755);}
const log=join(dir,'log');await writeFile(log,'');
const r=spawnSync(process.execPath,[script,'--issue','demo/4','--workspace',dir],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:bin+':'+process.env.PATH,LOG:log,COUNT:join(dir,'count'),MODE:mode,SAMPLES:JSON.stringify(samples),COMMENT_FAIL:commentFail?'1':'0',MERGE_TIMEOUT_SECONDS:samples?'3':'0.8',POLL_INTERVAL_SECONDS:'0.05',MISSING_CHECK_GRACE_SECONDS:'0'}});
const events=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
let report=null;try{report=JSON.parse(await readFile(join(dir,'github-merge-status.json'),'utf8'));}catch{}
return {r,events,report};
}finally{await rm(dir,{recursive:true,force:true});}
}
for(const [mode,action,reason,comment] of [
 ['merged','Merged','merged','PR #123 merged from'],
 ['eventually_merged','Merged','merged','PR #123 merged from'],
 ['blocked_then_merged','Merged','merged','PR #123 merged from'],
 ['prerequisite_checks_then_merged','Merged','merged','PR #123 merged from'],
 ['conflict','Merge failed','merge_conflict','merge conflicts with main'],
 ['closed','Merge failed','closed_without_merge','closed without merging'],
 ['draft','Merge failed','draft_pr','still a draft'],
 ['no_auto','Merge failed','auto_merge_disabled','auto-merge is disabled'],
 ['no_approval','Merge failed','approval_missing','required approval is missing'],
 ['failed_checks','Merge failed','required_checks_failed','required checks failed: build'],
 ['missing_checks','Merge failed','required_checks_missing','no required checks were reported'],
]){
test(mode,async()=>{const {r,events,report}=await simulate(mode);assert.equal(r.status,0,r.stderr);assert.equal(report.reason,reason);const moveIndex=events.findIndex(x=>x.bin==='tines'&&x.args[1]==='move');const commentIndex=events.findIndex(x=>x.bin==='tines'&&x.args[1]==='comment');assert.ok(moveIndex>=0);assert.ok(commentIndex>=0);assert.ok(commentIndex<moveIndex);assert.ok(events[commentIndex].args[3].includes(comment),events[commentIndex].args[3]);assert.equal(events[moveIndex].args[3],action);assert.ok(events.findIndex(x=>x.bin==='tines'&&x.args[2]==='attach')<commentIndex);});
}
test('comment failure does not block transition',async()=>{const {r,events}=await simulate('merged',{commentFail:true});assert.equal(r.status,0,r.stderr);assert.ok(events.some(x=>x.bin==='tines'&&x.args[1]==='comment'));assert.ok(events.some(x=>x.bin==='tines'&&x.args[1]==='move'&&x.args[3]==='Merged'));});
for(const mode of ['pending','behind','blocked']){
test(mode+' times out without transition',async()=>{const {r,events}=await simulate(mode);assert.notEqual(r.status,0);assert.ok(!events.some(x=>x.bin==='tines'&&x.args[1]==='move'));assert.ok(!events.some(x=>x.bin==='tines'&&x.args[1]==='comment'));});
}

const sample=(rebaseable,{head='a',base='main',view={},pull={}}={})=>({
 view:{number:123,state:'OPEN',headRefOid:head.repeat(40),baseRefName:base,mergedAt:null,isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'BEHIND',autoMergeRequest:{},reviewDecision:'APPROVED',...view},
 pull:{number:123,state:'open',merged:false,head:{sha:head.repeat(40)},base:{ref:base},mergeable_state:'behind',rebaseable,...pull},
});
const mergedSample=sample(true,{view:{state:'MERGED'}});
test('persistent non-rebaseable signal does not fail before a successful rebase',async()=>{
 const {r,events,report}=await simulate('rebase',{samples:[sample(false),sample(false),sample(false),sample(true,{head:'b'}),mergedSample]});
 assert.equal(r.status,0,r.stderr);
 assert.equal(report.reason,'merged');
 assert.ok(!events.some(x=>x.bin==='tines'&&x.args[1]==='move'&&x.args[3]==='Merge failed'));
});
for(const [name,samples] of [
 ['ordinary behind',[sample(true),sample(true),mergedSample]],
 ['changed head',[sample(false),sample(false,{head:'b'}),mergedSample]],
 ['changed target',[sample(false),sample(false,{base:'other'}),mergedSample]],
]) test(name+' waits for merge',async()=>{
 const {r,report,events}=await simulate('rebase',{samples});
 assert.equal(r.status,0,r.stderr);
 assert.equal(report.reason,'merged');
 assert.ok(!events.some(x=>x.bin==='tines'&&x.args[1]==='move'&&x.args[3]==='Merge failed'));
});

const conflictSample=sample(true,{view:{mergeable:'CONFLICTING',mergeStateStatus:'DIRTY'}});
for(const [name,samples] of [
 ['merge before failure publication',[conflictSample,conflictSample,mergedSample]],
 ['rebase before failure publication',[conflictSample,conflictSample,sample(true,{head:'b'}),mergedSample]],
 ['conflict disappears before publication',[conflictSample,conflictSample,sample(true),mergedSample]],
]) test(name,async()=>{
 const {r,report,events}=await simulate('race',{samples});
 assert.equal(r.status,0,r.stderr);
 assert.equal(report.reason,'merged');
 assert.ok(!events.some(x=>x.bin==='tines'&&x.args[1]==='move'&&x.args[3]==='Merge failed'));
});
test('confirmed conflict is revalidated before failure report',async()=>{
 const {r,report,events}=await simulate('race',{samples:[conflictSample]});
 assert.equal(r.status,0,r.stderr);
 assert.equal(report.reason,'merge_conflict');
 assert.equal(events.filter(x=>x.bin==='gh'&&x.args[1]==='view').length,3);
 assert.equal(events.find(x=>x.bin==='tines'&&x.args[1]==='move').args[3],'Merge failed');
});

test('changed PR artifact prevents stale completion',async()=>{
 const {r,events,report}=await simulate('changed_artifact');
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/PR artifact changed/);
 assert.equal(report,null);
 assert.ok(!events.some(x=>x.bin==='tines'&&x.args[1]==='move'));
});
