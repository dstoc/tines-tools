#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = async (bin,args) => JSON.parse((await exec(bin,args,{maxBuffer:16*1024*1024,timeout:30000})).stdout);
const tines = (...args) => run('tines',[...args,'--json']);
const gh = (...args) => run('gh',args);
const envNum = (name,fallback) => {
  const n=Number(process.env[name]??fallback);
  if(!Number.isFinite(n)||n<0) throw new Error('Invalid '+name);
  return n;
};
const options={};
for(let i=2;i<process.argv.length;i+=2) options[process.argv[i]]=process.argv[i+1];
const workspace=options['--workspace']||process.cwd();
const ref=options['--issue']||((await readFile(options['--prompt'],'utf8')).match(/This is run [^\n]+ for issue ([^\s;]+\/\d+);/)||[])[1];
if(!ref) throw new Error('Missing issue reference');
const issue=await tines('issues','show',ref);
const actions=new Set(issue.allowed_transitions?.map(x=>x.name)||[]);
if(!actions.has('Merged')||!actions.has('Merge failed')) throw new Error('Missing Tines transitions');
const getPr=async()=>{
 const artifacts=(await tines('issues','artifacts','list',ref)).items||[];
 const item=artifacts.find(x=>x.name===(process.env.PR_ARTIFACT_NAME||'pr'))||artifacts.filter(x=>x.artifact_type==='pr').length===1&&artifacts.find(x=>x.artifact_type==='pr');
 if(!item||item.artifact_type!=='pr') throw new Error('Missing PR artifact');
 const v=item.current_version;
 const repo=new URL(v.pr_repo_url);
 if(repo.hostname!=='github.com'||!/^\/[\w.-]+\/[\w.-]+$/.test(repo.pathname)) throw new Error('Invalid PR repository');
 return {repo:repo.pathname.slice(1),number:v.pr_number,version:v.version};
};
const pr=await getPr();
const expected=(process.env.EXPECTED_CHECKS||'').split(',').filter(Boolean);
const interval=envNum('POLL_INTERVAL_SECONDS',5)*1000;
const grace=envNum('MISSING_CHECK_GRACE_SECONDS',30)*1000;
const deadline=Date.now()+envNum('MERGE_TIMEOUT_SECONDS',1200)*1000;
const getChecks=async(required)=>{
 const args=['pr','checks',String(pr.number),'-R',pr.repo];
 if(required) args.push('--required');
 args.push('--json','name,state,bucket,link');
 const checkRun=await exec('gh',args,{maxBuffer:16*1024*1024,timeout:30000}).catch(e=>{
  if([1,8].includes(e.code)&&e.stdout) return {stdout:e.stdout};
  if(e.code===1&&/no (required )?checks reported/i.test(e.stderr||'')) return {stdout:'[]'};
  throw e;
 });
 const checks=JSON.parse(checkRun.stdout);
 if(!Array.isArray(checks)) throw new Error('Invalid checks response');
 return checks;
};
let missingSince=null,head=null,previousFailure=null,result=null;
try {
 while(Date.now()<deadline) {
  const view=await gh('pr','view',String(pr.number),'-R',pr.repo,'--json','number,state,headRefOid,baseRefName,mergedAt,mergeCommit,isDraft,mergeable,mergeStateStatus,autoMergeRequest,reviewDecision,url');
  if(view.number!==pr.number) throw new Error('PR mismatch');
  if(view.headRefOid!==head){head=view.headRefOid;missingSince=null;previousFailure=null;}
  let reason=null,checks=[];
  if(view.state==='MERGED'||view.mergedAt) {result={result:'merged',reason:'merged',view,checks};break;}
  if(view.state!=='OPEN') reason='closed_without_merge';
  else if(view.isDraft) reason='draft_pr';
  else if(view.mergeable==='CONFLICTING'||view.mergeStateStatus==='DIRTY') reason='merge_conflict';
  else if(!view.autoMergeRequest) reason='auto_merge_disabled';
  else if(view.reviewDecision!=='APPROVED') reason='approval_missing';
  else {
   checks=await getChecks(true);
   if(checks.some(x=>['fail','cancel'].includes(x.bucket))) reason='required_checks_failed';
   else if(!checks.length||expected.some(x=>!checks.some(c=>c.name===x))) {
    const allChecks=await getChecks(false);
    if(allChecks.some(x=>x.bucket==='pending')) missingSince=null;
    else {
     missingSince??=Date.now();
     if(Date.now()-missingSince>=grace) reason='required_checks_missing';
    }
   } else missingSince=null;
  }
  if(!reason&&view.mergeStateStatus==='BEHIND') {
   // rebaseable is a REST field, not a gh pr view JSON field. Only use
   // a matching, still-open snapshot; null/omitted means no evidence yet.
   const pull=await gh('api',`repos/${pr.repo}/pulls/${pr.number}`);
   if(pull.number!==pr.number) throw new Error('PR mismatch');
   if(pull.state==='open'&&!pull.merged&&pull.head?.sha===view.headRefOid&&pull.base?.ref===view.baseRefName&&pull.mergeable_state==='behind') {
    view.rebaseable=pull.rebaseable;
    if(pull.rebaseable===false) reason='rebase_conflict';
   }
  }
  const failure=reason?JSON.stringify([reason,view.headRefOid,view.baseRefName]):null;
  if(failure&&failure===previousFailure){result={result:'failed',reason,view,checks};break;}
  previousFailure=failure;
  await sleep(Math.min(interval,Math.max(0,deadline-Date.now())));
 }
 if(!result) throw new Error('Merge wait timed out');
 const latest=await getPr();
 if(latest.repo!==pr.repo||latest.number!==pr.number||latest.version!==pr.version) throw new Error('PR artifact changed');
 const report={schema_version:1,checked_at:new Date().toISOString(),issue:{ref},pr,result:result.result,reason:result.reason,view:result.view,checks:result.checks};
 const path=join(workspace,'github-merge-status.json');
 await writeFile(path,JSON.stringify(report,null,2)+'\n');
 await tines('issues','artifacts','attach',ref,'github-merge-status','--file',path,'--content-type','application/json');
 const current=await tines('issues','show',ref);
 const action=result.result==='merged'?'Merged':'Merge failed';
 if(current.state?.id!==issue.state?.id||!current.allowed_transitions?.some(x=>x.name===action)) throw new Error('Issue state changed');
 const failedChecks=result.checks.filter(x=>['fail','cancel'].includes(x.bucket)).map(x=>x.name).filter(Boolean);
 const missingChecks=expected.filter(name=>!result.checks.some(check=>check.name===name));
 const detail=result.reason==='merged'
  ? `PR #${pr.number} merged from ${result.view.headRefOid}`
  : result.reason==='merge_conflict' ? `merge conflicts with ${result.view.baseRefName}`
  : result.reason==='rebase_conflict' ? `branch is behind ${result.view.baseRefName} and GitHub reports it cannot be rebased; update the branch to resolve the integration failure`
  : result.reason==='closed_without_merge' ? 'PR was closed without merging'
  : result.reason==='draft_pr' ? 'PR is still a draft'
  : result.reason==='auto_merge_disabled' ? 'auto-merge is disabled'
  : result.reason==='approval_missing' ? `required approval is missing (${result.view.reviewDecision||'unknown review state'})`
  : result.reason==='required_checks_failed' ? `required checks failed${failedChecks.length?`: ${failedChecks.join(', ')}`:''}`
  : result.reason==='required_checks_missing' ? missingChecks.length?`required checks are missing: ${missingChecks.join(', ')}`:'no required checks were reported'
  : result.reason;
 const message=result.result==='merged'?detail:`Merge failed for PR #${pr.number} at ${result.view.headRefOid}: ${detail}`;
 try {
  // --json must precede positional arguments for the comment command.
  await run('tines',['issues','comment','--json',ref,message]);
 } catch(error) {
  // Match github-checks: comments are explanatory, but must not block the transition.
  console.error('[github-merge] Warning: could not post merge comment:',error instanceof Error?error.message:String(error));
 }
 await tines('issues','move',ref,action);
} catch(e) {console.error('[github-merge]',e);process.exitCode=1;}
