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
else if(a[0]==='issues'&&a[1]==='artifacts'&&a[2]==='list') console.log(JSON.stringify({items:[{name:'pr',artifact_type:'pr',current_version:{version:1,pr_repo_url:'https://github.com/acme/app',pr_number:123}}]}));
else console.log('{}');
`;
const mockGh=`#!/usr/bin/env node
const fs=require('node:fs');
const a=process.argv.slice(2);
fs.appendFileSync(process.env.LOG,JSON.stringify({bin:'gh',args:a})+'\\n');
const mode=process.env.MODE;
const n=Number(fs.existsSync(process.env.COUNT)&&fs.readFileSync(process.env.COUNT,'utf8'))||0;
if(a[1]==='view'){
fs.writeFileSync(process.env.COUNT,String(n+1));
console.log(JSON.stringify({number:123,url:'https://github.com/acme/app/pull/123',state:mode==='merged'||mode==='eventually_merged'&&n>0?'MERGED':mode==='closed'?'CLOSED':'OPEN',headRefOid:'a'.repeat(40),baseRefName:'main',mergedAt:null,mergeCommit:null,isDraft:mode==='draft',mergeable:mode==='conflict'?'CONFLICTING':'MERGEABLE',mergeStateStatus:mode==='blocked'?'BLOCKED':mode==='behind'?'BEHIND':'CLEAN',autoMergeRequest:mode==='no_auto'?null:{enabledAt:'2026-10-08'},reviewDecision:mode==='no_approval'?'REVIEW_REQUIRED':'APPROVED'}));
}else if(a[1]==='checks'){
const bucket=mode==='failed_checks'?'fail':mode==='pending'?'pending':'pass';
console.log(JSON.stringify(mode==='missing_checks'?[]:[{name:'build',state:'SUCCESS',bucket,link:null}]));
if(bucket==='fail') process.exit(1);
if(bucket==='pending') process.exit(8);
}else process.exit(3);
`;
async function simulate(mode){
const dir=await mkdtemp(join(tmpdir(),'merge-test-'));
try{
const bin=join(dir,'bin');await mkdir(bin);
for(const [name,src] of [['tines',mockTines],['gh',mockGh]]){const p=join(bin,name);await writeFile(p,src);await chmod(p,0o755);}
const log=join(dir,'log');await writeFile(log,'');
const r=spawnSync(process.execPath,[script,'--issue','demo/4','--workspace',dir],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:bin+':'+process.env.PATH,LOG:log,COUNT:join(dir,'count'),MODE:mode,MERGE_TIMEOUT_SECONDS:'0.8',POLL_INTERVAL_SECONDS:'0.05',MISSING_CHECK_GRACE_SECONDS:'0'}});
const events=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
let report=null;try{report=JSON.parse(await readFile(join(dir,'github-merge-status.json'),'utf8'));}catch{}
return {r,events,report};
}finally{await rm(dir,{recursive:true,force:true});}
}
for(const [mode,action,reason] of [['merged','Merged','merged'],['eventually_merged','Merged','merged'],['conflict','Merge failed','merge_conflict'],['closed','Merge failed','closed_without_merge'],['draft','Merge failed','draft_pr'],['no_auto','Merge failed','auto_merge_disabled'],['no_approval','Merge failed','approval_missing'],['failed_checks','Merge failed','required_checks_failed'],['missing_checks','Merge failed','required_checks_missing'],['blocked','Merge failed','merge_blocked']]){
test(mode,async()=>{const {r,events,report}=await simulate(mode);assert.equal(r.status,0,r.stderr);assert.equal(report.reason,reason);const move=events.find(x=>x.bin==='tines'&&x.args[1]==='move');assert.equal(move.args[3],action);assert.ok(events.findIndex(x=>x.bin==='tines'&&x.args[2]==='attach')<events.indexOf(move));});
}
for(const mode of ['pending','behind']){
test(mode+' times out without transition',async()=>{const {r,events}=await simulate(mode);assert.notEqual(r.status,0);assert.ok(!events.some(x=>x.bin==='tines'&&x.args[1]==='move'));});
}
