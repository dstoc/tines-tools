#!/usr/bin/env node
// Dependency-free Tines custom harness. Requires Node.js 20+, tines CLI, and gh CLI.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const ACTIONS = {
  passed: 'Checks passed',
  failed: 'Checks failed',
  infrastructure_failed: 'Infrastructure failed',
};
const CHECK_FIELDS = 'name,workflow,state,bucket,link,startedAt,completedAt';
const INFRA_STATES = new Set([
  'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'STALE', 'ACTION_REQUIRED', 'ERROR',
]);
const number = (name, fallback, min, max) => {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
};
const say = (message) => console.log(`[github-status-checks] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class OperationalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function command(binary, args, { timeoutMs = 30_000, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, GH_PROMPT_DISABLED: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Issue detail JSON includes comments and can exceed 64 KiB. Preserve stdout
    // in complete UTF-8 buffers; only truncate stderr, which is diagnostic text.
    const maxStdoutBytes = 16 * 1024 * 1024;
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stdoutTooLarge = false;
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      if (stream) process.stdout.write(chunk);
      if (stdoutTooLarge) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        stdoutTooLarge = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-65_536);
      if (stream) process.stderr.write(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, Math.max(1, timeoutMs));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new OperationalError('command_error', `${binary}: ${error.message}`));
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (stdoutTooLarge)
        return reject(new OperationalError('output_too_large',
          `${binary} ${args.slice(0, 3).join(' ')} exceeded ${maxStdoutBytes} stdout bytes`));
      resolve({ stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr, exitCode, signal, timedOut });
    });
  });
}

async function jsonCommand(binary, args, options) {
  const result = await command(binary, args, options);
  if (result.timedOut)
    throw new OperationalError('command_timeout', `${binary} timed out: ${args.slice(0, 3).join(' ')}`);
  if (result.exitCode !== 0)
    throw new OperationalError('command_failed', `${binary} ${args.slice(0, 3).join(' ')}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    // Avoid echoing the response: issue JSON may contain secrets.
    throw new OperationalError('invalid_json',
      `${binary} ${args.slice(0, 3).join(' ')} returned invalid JSON (${Buffer.byteLength(result.stdout)} bytes)`);
  }
}

const tines = (...args) => jsonCommand('tines', [...args, '--json']);

function argsFromCli(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--prompt', '--issue', '--workspace'].includes(key) || !argv[i + 1])
      throw new Error('Usage: github-status-checks.mjs --prompt <prompt.md> --workspace <dir> [--issue <project/number>]');
    options[key.slice(2)] = argv[++i];
  }
  if (!options.issue && !options.prompt)
    throw new Error('Pass --prompt <prompt.md> or --issue <project/number>');
  return options;
}

async function issueRef(options) {
  if (options.issue) {
    if (!/^[^\s/]+\/\d+$/.test(options.issue)) throw new Error('Invalid --issue reference');
    return options.issue;
  }
  const prompt = await readFile(options.prompt, 'utf8');
  const match = prompt.match(/This is run [^\n]+ for issue ([^\s;]+\/\d+);/);
  if (!match) throw new Error('Cannot extract issue ref from the Tines supervisor preamble');
  return match[1];
}

function normalizeRepo(url) {
  if (typeof url !== 'string') return null;
  const ssh = url.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`.toLowerCase();
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com' ||
      !['https:', 'ssh:'].includes(parsed.protocol) || parsed.search || parsed.hash) return null;
    const match = parsed.pathname.match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
  } catch { return null; }
}

async function allowedRepos(workspace) {
  if (!workspace) return [];
  let repos;
  try { repos = JSON.parse(await readFile(join(workspace, 'repos.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new OperationalError('repos_invalid', `Cannot parse repos.json: ${error.message}`);
  }
  if (!Array.isArray(repos)) throw new OperationalError('repos_invalid', 'repos.json must be an array');
  return repos.map((r) => normalizeRepo(r?.url)).filter(Boolean);
}

function prFromArtifacts(items, preferredName) {
  const named = items.find((a) => a.name === preferredName);
  const candidates = items.filter((a) => a.artifact_type === 'pr');
  const artifact = named ?? (candidates.length === 1 ? candidates[0] : null);
  if (!artifact)
    throw new OperationalError('pr_artifact_missing', `Expected PR artifact '${preferredName}' (found ${candidates.length} PR artifacts)`);
  if (artifact.artifact_type !== 'pr')
    throw new OperationalError('pr_artifact_invalid', `Artifact '${artifact.name}' is ${artifact.artifact_type}, not pr`);
  const version = artifact.current_version;
  const repo = normalizeRepo(version?.pr_repo_url);
  const number = version?.pr_number;
  if (!repo || !Number.isSafeInteger(number) || number <= 0)
    throw new OperationalError('pr_artifact_invalid', `Artifact '${artifact.name}' has an invalid GitHub repository or PR number`);
  return { repo, number, artifact_name: artifact.name, artifact_version: version.version,
    url: `https://github.com/${repo}/pull/${number}` };
}

async function prView(pr) {
  const result = await jsonCommand('gh', [
    'pr', 'view', String(pr.number), '--repo', pr.repo,
    '--json', 'number,url,state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus',
  ]);
  if (result.number !== pr.number || result.url?.toLowerCase() !== pr.url.toLowerCase() ||
      !/^[0-9a-f]{40,64}$/i.test(result.headRefOid ?? ''))
    throw new OperationalError('pr_mismatch', 'GitHub returned an unexpected PR or invalid HEAD');
  if (result.state !== 'OPEN' || result.isDraft)
    throw new OperationalError('pr_not_ready', `PR must be open and not draft (state=${result.state}, draft=${result.isDraft})`);
  return result;
}

function hasMergeConflicts(view) {
  return view.mergeable === 'CONFLICTING' || view.mergeStateStatus === 'DIRTY';
}

function conflictVerdict() {
  return {
    result: 'failed',
    reason: 'merge_conflict',
    summary: { total: 0, passed: 0, failed: 0, infrastructure: 0, pending: 0, skipped: 0 },
    checks: [],
  };
}

async function checks(pr) {
  const args = ['pr', 'checks', String(pr.number), '--repo', pr.repo,
    '--json', CHECK_FIELDS, '--required'];
  const result = await command('gh', args);
  if (result.timedOut)
    throw new OperationalError('checks_timeout', 'Timed out fetching GitHub checks');
  // gh exits nonzero when checks fail (1) or are pending (8), even with JSON output.
  // With no checks, some versions of gh emit only a diagnostic on stderr.
  if (result.exitCode === 1 && !result.stdout.trim() &&
      /no checks reported/i.test(result.stderr)) return [];
  if (![0, 1, 8].includes(result.exitCode))
    throw new OperationalError('checks_unavailable', result.stderr.trim() || `gh pr checks exited ${result.exitCode}`);
  let entries;
  try { entries = JSON.parse(result.stdout); }
  catch { throw new OperationalError('checks_invalid', `gh pr checks did not return JSON: ${result.stderr.trim()}`); }
  if (!Array.isArray(entries)) throw new OperationalError('checks_invalid', 'Expected JSON check array');
  return entries;
}

function classify(entries) {
  const summary = { total: entries.length, passed: 0, failed: 0,
    infrastructure: 0, pending: 0, skipped: 0 };
  const normalized = entries.map((c) => {
    const bucket = String(c.bucket ?? '').toLowerCase();
    const state = String(c.state ?? '').toUpperCase();
    let outcome;
    if (INFRA_STATES.has(state) || bucket === 'cancel') outcome = 'infrastructure';
    else if (bucket === 'fail') outcome = 'failed';
    else if (bucket === 'pass') outcome = 'passed';
    else if (bucket === 'skipping') outcome = 'skipped';
    else outcome = 'pending';
    summary[outcome]++;
    return {
      name: c.name, workflow: c.workflow || null, state: c.state, bucket,
      outcome, url: c.link || null, started_at: c.startedAt || null,
      completed_at: c.completedAt || null,
    };
  });
  const result = summary.pending ? null : summary.infrastructure ? 'infrastructure_failed'
    : summary.failed ? 'failed' : summary.total ? 'passed' : null;
  return { summary, checks: normalized, result };
}

async function waitForChecks(pr, config) {
  const deadline = Date.now() + config.timeoutSeconds * 1000;
  let sawChecks = false;
  while (true) {
    if (Date.now() >= deadline)
      throw sawChecks
        ? new OperationalError('checks_timeout', `Required checks did not complete within ${config.timeoutSeconds}s`)
        : new OperationalError('no_checks', `No required checks appeared within ${config.timeoutSeconds}s`);
    const entries = await checks(pr);
    sawChecks ||= entries.length > 0;
    const actualNames = new Set(entries.map((c) => c.name));
    const missing = config.expected.filter((name) => !actualNames.has(name));
    if (!entries.length || missing.length) {
      // Checks may never register for a conflicting PR. Do not exhaust the CI deadline.
      if (hasMergeConflicts(await prView(pr))) return conflictVerdict();
      say(entries.length ? `Waiting for expected required checks: ${missing.join(', ')}` : 'Waiting for required checks to appear');
      await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
      continue;
    }
    const verdict = classify(entries);
    if (verdict.result) return verdict;

    say(`Waiting for ${verdict.summary.pending} pending required check(s) on ${pr.url}`);
    const watched = await command('gh', [
      'pr', 'checks', String(pr.number), '--repo', pr.repo,
      '--required', '--watch', '--interval', '10',
    ], { timeoutMs: Math.max(1, deadline - Date.now()), stream: config.watchOutput });
    if (watched.timedOut)
      throw new OperationalError('checks_timeout', `gh pr checks --watch exceeded ${config.timeoutSeconds}s`);
    // A completed failing check can make --watch exit 1 while others remain pending.
    if (![0, 1, 8].includes(watched.exitCode))
      throw new OperationalError('watch_failed', watched.stderr.trim() || `gh watch exited ${watched.exitCode}`);
    if (watched.exitCode === 1)
      await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
  }
}

async function main() {
  const options = argsFromCli(process.argv.slice(2));
  const ref = await issueRef(options);
  const config = {
    timeoutSeconds: number('CHECK_TIMEOUT_SECONDS', 1200, 2, 86400),
    expected: (process.env.EXPECTED_CHECKS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    watchOutput: process.env.WATCH_OUTPUT === '1',
  };
  const result = {
    schema_version: 1,
    checked_at: null,
    issue: { ref },
    pr: null,
    result: null,
    reason: null,
    summary: null,
    checks: [],
    error: null,
  };

  const issue = await tines('issues', 'show', ref);
  const initialStateId = issue.state?.id;
  const available = new Set(issue.allowed_transitions?.map((t) => t.name) ?? []);
  const absent = Object.values(ACTIONS).filter((name) => !available.has(name));
  if (absent.length)
    throw new Error(`Issue ${ref} is missing required workflow actions: ${absent.join(', ')}`);

  try {
    const artifacts = await tines('issues', 'artifacts', 'list', ref);
    const pr = prFromArtifacts(artifacts.items ?? [], process.env.PR_ARTIFACT_NAME || 'pr');
    result.pr = { ...pr, head_sha: null, base_ref: null };
    const allowed = await allowedRepos(options.workspace);
    if (allowed.length && !allowed.includes(pr.repo))
      throw new OperationalError('pr_repo_mismatch', `PR repo ${pr.repo} not in effective issue repos: ${allowed.join(', ')}`);
    const view = await prView(pr);
    result.pr.head_sha = view.headRefOid;
    result.pr.base_ref = view.baseRefName;
    say(`Checking ${pr.url} at ${view.headRefOid.slice(0, 12)}`);
    const verdict = hasMergeConflicts(view) ? conflictVerdict() : await waitForChecks(pr, config);
    result.summary = verdict.summary;
    result.checks = verdict.checks;
    // Reject results for a SHA that changed while gh was watching CI.
    const after = await prView(pr);
    if (after.headRefOid !== view.headRefOid)
      throw new OperationalError('head_changed', `PR HEAD changed ${view.headRefOid} -> ${after.headRefOid}`);
    // A PR can become conflicting while checks are running; don't report stale success.
    if (hasMergeConflicts(after) && verdict.reason !== 'merge_conflict') {
      const conflict = conflictVerdict();
      result.summary = conflict.summary;
      result.checks = conflict.checks;
      verdict.result = conflict.result;
      verdict.reason = conflict.reason;
    }
    const latest = prFromArtifacts(
      (await tines('issues', 'artifacts', 'list', ref)).items ?? [], pr.artifact_name,
    );
    if (latest.artifact_version !== pr.artifact_version ||
        latest.repo !== pr.repo || latest.number !== pr.number)
      throw new OperationalError('pr_artifact_changed', 'PR artifact changed while checking GitHub');
    result.result = verdict.result;
    result.reason = verdict.reason ?? (verdict.result === 'infrastructure_failed' ? 'check_infrastructure_failure'
      : verdict.result === 'failed' ? 'completed_checks_failed' : 'all_checks_passed');
  } catch (error) {
    const failure = error instanceof OperationalError ? error
      : new OperationalError('unexpected_error', error instanceof Error ? error.message : String(error));
    result.result = 'infrastructure_failed';
    result.reason = failure.code;
    result.error = { code: failure.code, message: failure.message.slice(0, 2000) };
    say(`Infrastructure failure: ${failure.code}: ${failure.message}`);
  }

  result.checked_at = new Date().toISOString();
  const workspace = options.workspace || process.cwd();
  const reportPath = join(workspace, 'github-status-checks.json');
  await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n');
  say(`Wrote ${reportPath}`);
  // Never transition without the report. The existing artifact must be of type 'file'.
  await jsonCommand('tines', [
    'issues', 'artifacts', 'attach', ref, 'github-status-checks',
    '--file', reportPath, '--content-type', 'application/json', '--json',
  ], { timeoutMs: 60_000 });
  const currentIssue = await tines('issues', 'show', ref);
  if (currentIssue.state?.id !== initialStateId)
    throw new Error(`Issue ${ref} moved from its original state; report attached but not transitioning`);
  const action = ACTIONS[result.result];
  if (!currentIssue.allowed_transitions?.some((t) => t.name === action))
    throw new Error(`Transition '${action}' no longer available; report attached but issue unchanged`);
  if (result.result === 'passed' || result.result === 'failed') {
    const status = result.reason === 'merge_conflict' ? 'BLOCKED' : result.result.toUpperCase();
    const detail = result.reason === 'merge_conflict'
      ? `: merge conflicts with ${result.pr.base_ref}` : '';
    const message = `Status checks ${status} for PR #${result.pr.number} at ${result.pr.head_sha}${detail}`;
    try {
      // --json precedes positional arguments: the comment CLI passes through trailing options.
      await jsonCommand('tines', ['issues', 'comment', '--json', ref, message]);
      say(`Commented: ${message}`);
    } catch (error) {
      // A failed comment must not prevent the issue from taking its workflow transition.
      say(`Warning: could not post status comment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await tines('issues', 'move', ref, action);
  say(`${ref}: ${action} (${result.reason})`);
}

main().catch((error) => {
  console.error(`[github-status-checks] Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
