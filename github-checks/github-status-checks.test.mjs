import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./github-status-checks.mjs', import.meta.url).pathname;
const sha = 'a'.repeat(40);
const mockTines = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2).filter((s) => s !== '--json');
const event = a.slice(0, 3).join(' ');
fs.appendFileSync(process.env.EVENT_LOG, JSON.stringify({ binary: 'tines', args: a }) + '\\n');
const actions = ['Checks passed', 'Checks failed', 'Infrastructure failed'];
if (a[0] === 'issues' && a[1] === 'show') {
  const count = Number(fs.existsSync(process.env.SHOW_COUNTER) && fs.readFileSync(process.env.SHOW_COUNTER, 'utf8')) || 0;
  fs.writeFileSync(process.env.SHOW_COUNTER, String(count + 1));
  if (process.env.MOCK_CASE === 'large_issue') {
    // Real issue detail responses may include extensive comment histories.
    console.log(JSON.stringify({ description: 'x'.repeat(100_000), state: { id: 'checking' },
      allowed_transitions: actions.map((name) => ({ name })) }));
  } else if (process.env.MOCK_CASE === 'malformed_issue') {
    console.log('not-json');
  } else {
    console.log(JSON.stringify({ state: { id: count && process.env.MOCK_CASE === 'changed_state' ? 'elsewhere' : 'checking' }, allowed_transitions: actions.map((name) => ({ name })) }));
  }
} else if (event === 'issues artifacts list') {
  const count = Number(fs.existsSync(process.env.LIST_COUNTER) && fs.readFileSync(process.env.LIST_COUNTER, 'utf8')) || 0;
  fs.writeFileSync(process.env.LIST_COUNTER, String(count + 1));
  console.log(JSON.stringify({ items: process.env.MOCK_CASE === 'missing_pr' ? [] : [{ name: 'pr', artifact_type: 'pr', current_version: { version: process.env.MOCK_CASE === 'changed_artifact' && count > 0 ? 3 : 2, pr_repo_url: 'https://github.com/acme/app', pr_number: 123 } }] }));
} else if (event === 'issues artifacts attach') {
  if (process.env.MOCK_CASE === 'attach_fail') { console.error('forced attach failure'); process.exit(1); }
  console.log(JSON.stringify({ artifact_type: 'file', name: 'github-status-checks' }));
} else if (a[0] === 'issues' && a[1] === 'comment') {
  if (process.env.MOCK_CASE === 'comment_fail') { console.error('forced comment failure'); process.exit(1); }
  console.log(JSON.stringify({ id: 'comment-123', body: a[3] }));
} else if (a[0] === 'issues' && a[1] === 'move') {
  console.log(JSON.stringify({ state: { name: a[3] } }));
} else { console.error('unexpected tines command:', a); process.exit(3); }
`;
const mockGh = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.EVENT_LOG, JSON.stringify({ binary: 'gh', args: a }) + '\\n');
if (a[0] !== 'pr') process.exit(3);
if (a[1] === 'view') {
  const count = Number(fs.existsSync(process.env.GH_COUNTER) && fs.readFileSync(process.env.GH_COUNTER, 'utf8')) || 0;
  fs.writeFileSync(process.env.GH_COUNTER, String(count + 1));
  console.log(JSON.stringify({ number: 123, url: 'https://github.com/acme/app/pull/123', state: 'OPEN', isDraft: process.env.MOCK_CASE === 'draft_pr',
    headRefOid: process.env.MOCK_CASE === 'changed_head' && count > 0 ? 'b'.repeat(40) : 'a'.repeat(40), baseRefName: 'main',
    mergeable: ['conflict_initial', 'conflict_dirty'].includes(process.env.MOCK_CASE) ||
      ['conflict_no_checks', 'conflict_pending', 'conflict_after_checks'].includes(process.env.MOCK_CASE) && count > 0
      ? 'CONFLICTING' : process.env.MOCK_CASE === 'merge_unknown' ? 'UNKNOWN' : 'MERGEABLE',
    mergeStateStatus: process.env.MOCK_CASE === 'conflict_dirty' ? 'DIRTY' :
      process.env.MOCK_CASE === 'merge_blocked' ? 'BLOCKED' : 'CLEAN' }));
} else if (a[1] === 'checks') {
  if (a.includes('--watch')) { console.log('watching'); process.exit(0); }
  if (process.env.MOCK_CASE === 'no_checks' || process.env.MOCK_CASE === 'conflict_no_checks') { console.log('[]'); process.exit(0); }
  if (process.env.MOCK_CASE === 'no_checks_stderr') { console.error("no checks reported on the 'feature' branch"); process.exit(1); }
  if (process.env.MOCK_CASE === 'no_required_checks_stderr') { console.error("no required checks reported on the 'feature' branch"); process.exit(1); }
  if (process.env.MOCK_CASE === 'required_checks_late') {
    const count = Number(fs.existsSync(process.env.CHECK_COUNTER) && fs.readFileSync(process.env.CHECK_COUNTER, 'utf8')) || 0;
    fs.writeFileSync(process.env.CHECK_COUNTER, String(count + 1));
    if (count === 0) { console.error("no required checks reported on the 'feature' branch"); process.exit(1); }
  }
  if (process.env.MOCK_CASE === 'gh_error') { console.error('GitHub network failure'); process.exit(4); }
  if (process.env.MOCK_CASE === 'late_checks') {
    const count = Number(fs.existsSync(process.env.CHECK_COUNTER) && fs.readFileSync(process.env.CHECK_COUNTER, 'utf8')) || 0;
    fs.writeFileSync(process.env.CHECK_COUNTER, String(count + 1));
    if (count === 0) { console.log('[]'); process.exit(0); }
  }
  let bucket = 'pass'; let state = 'SUCCESS'; let exit = 0;
  if (process.env.MOCK_CASE === 'failed') { bucket = 'fail'; state = 'FAILURE'; exit = 1; }
  if (process.env.MOCK_CASE === 'cancelled') { bucket = 'cancel'; state = 'CANCELLED'; exit = 1; }
  if (process.env.MOCK_CASE === 'watch_pending' || process.env.MOCK_CASE === 'conflict_pending') {
    const count = Number(fs.existsSync(process.env.CHECK_COUNTER) && fs.readFileSync(process.env.CHECK_COUNTER, 'utf8')) || 0;
    fs.writeFileSync(process.env.CHECK_COUNTER, String(count + 1));
    if (count === 0) { bucket = 'pending'; state = 'IN_PROGRESS'; exit = 8; }
  }
  console.log(JSON.stringify([{ name: 'build', workflow: 'CI', state, bucket,
    link: 'https://github.com/acme/app/actions/runs/8', startedAt: '2026-09-23T00:00:00Z', completedAt: '2026-09-23T00:01:00Z' }]));
  process.exit(exit);
} else { console.error('unexpected gh command:', a); process.exit(3); }
`;

async function simulate(mode, { timeoutSeconds = 2, expected = '' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tines-check-test-'));
  const bin = join(dir, 'bin');
  const ws = join(dir, 'workspace');
  await mkdir(bin); await mkdir(ws);
  const tinesPath = join(bin, 'tines');
  const ghPath = join(bin, 'gh');
  await writeFile(tinesPath, mockTines); await writeFile(ghPath, mockGh);
  await chmod(tinesPath, 0o755); await chmod(ghPath, 0o755);
  await writeFile(join(ws, 'repos.json'), JSON.stringify([{ url: mode === 'repo_mismatch' ? 'https://github.com/acme/other' : 'git@github.com:acme/app.git', dir: 'app' }]));
  const prompt = join(ws, 'prompt.md');
  await writeFile(prompt, '# Supervisor run\nThis is run 123 on runner "test" for issue demo/4; timeout 30m\n');
  const result = spawnSync(process.execPath, [script, '--prompt', prompt, '--workspace', ws], {
    env: { ...process.env, PATH: bin + ':' + process.env.PATH,
      EVENT_LOG: join(dir, 'events.jsonl'), SHOW_COUNTER: join(dir, 'show_count'),
      GH_COUNTER: join(dir, 'gh_count'), CHECK_COUNTER: join(dir, 'check_count'),
      LIST_COUNTER: join(dir, 'list_count'),
      MOCK_CASE: mode, CHECK_TIMEOUT_SECONDS: String(timeoutSeconds), EXPECTED_CHECKS: expected,
      TINES_API_URL: 'https://example.test', TINES_API_KEY: 'fake' },
    encoding: 'utf8', timeout: 10_000,
  });
  let report;
  try { report = JSON.parse(await readFile(join(ws, 'github-status-checks.json'), 'utf8')); }
  catch { report = null; }
  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  await rm(dir, { recursive: true, force: true });
  return { result, report, events };
}

for (const [mode, status, action, reason] of [
  ['passed', 'passed', 'Checks passed', 'all_checks_passed'],
  ['failed', 'failed', 'Checks failed', 'completed_checks_failed'],
  ['cancelled', 'infrastructure_failed', 'Infrastructure failed', 'check_infrastructure_failure'],
  ['no_checks', 'infrastructure_failed', 'Infrastructure failed', 'no_checks'],
  ['no_checks_stderr', 'infrastructure_failed', 'Infrastructure failed', 'no_checks'],
  ['no_required_checks_stderr', 'infrastructure_failed', 'Infrastructure failed', 'no_checks'],
  ['gh_error', 'infrastructure_failed', 'Infrastructure failed', 'checks_unavailable'],
  ['changed_head', 'infrastructure_failed', 'Infrastructure failed', 'head_changed'],
  ['changed_artifact', 'infrastructure_failed', 'Infrastructure failed', 'pr_artifact_changed'],
  ['draft_pr', 'infrastructure_failed', 'Infrastructure failed', 'pr_not_ready'],
  ['missing_pr', 'infrastructure_failed', 'Infrastructure failed', 'pr_artifact_missing'],
  ['repo_mismatch', 'infrastructure_failed', 'Infrastructure failed', 'pr_repo_mismatch'],
  ['watch_pending', 'passed', 'Checks passed', 'all_checks_passed'],
]) {
  test(mode, async () => {
    const { result, report, events } = await simulate(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.result, status);
    assert.equal(report.reason, reason);
    assert.equal(report.schema_version, 1);
    const checks = events.filter((e) => e.binary === 'gh' && e.args[1] === 'checks');
    if (checks.length) assert.ok(checks.every((e) => e.args.includes('--required')), 'only required checks queried and watched');
    const attach = events.findIndex((e) => e.binary === 'tines' && e.args.slice(0, 3).join(' ') === 'issues artifacts attach');
    const move = events.findIndex((e) => e.binary === 'tines' && e.args.slice(0, 2).join(' ') === 'issues move');
    assert.ok(attach >= 0 && move > attach, 'report attached before transition');
    assert.equal(events[move].args[3], action);
    const comment = events.findIndex((e) => e.binary === 'tines' && e.args[1] === 'comment');
    if (mode === 'passed' || mode === 'failed' || mode === 'watch_pending') {
      assert.ok(comment > attach && comment < move, 'comment after report and before transition');
      assert.equal(events[comment].args[2], 'demo/4');
      assert.equal(events[comment].args[3],
        `Status checks ${status.toUpperCase()} for PR #123 at ${sha}`);
    } else {
      assert.equal(comment, -1, 'do not comment on infrastructure failures');
    }
    if (mode === 'watch_pending') assert.ok(events.some((e) => e.binary === 'gh' && e.args.includes('--watch')));
    if (mode === 'passed') assert.equal(checks.length, 1, 'no unnecessary settling query');
  });
}

test('no required checks stderr is retried until checks register', async () => {
  const { result, report, events } = await simulate('required_checks_late', { timeoutSeconds: 8 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.result, 'passed');
  assert.ok(events.filter((e) => e.binary === 'gh' && e.args[1] === 'checks').length >= 2);
});

test('checks that register late are retried until they appear', async () => {
  const { result, report, events } = await simulate('late_checks', { timeoutSeconds: 8 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.result, 'passed');
  assert.ok(events.filter((e) => e.binary === 'gh' && e.args[1] === 'checks').length >= 2);
});

test('missing expected required check waits until overall timeout', async () => {
  const { result, report, events } = await simulate('passed', { expected: 'build,audit' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.result, 'infrastructure_failed');
  assert.equal(report.reason, 'checks_timeout');
  assert.ok(!events.some((e) => e.binary === 'tines' && e.args[1] === 'comment'));
});

test('large issue JSON is not silently truncated', async () => {
  const { result, report, events } = await simulate('large_issue');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.result, 'passed');
  assert.ok(events.some((e) => e.binary === 'tines' && e.args[1] === 'move'));
});

test('malformed issue JSON reports the failing command without exposing response body', async () => {
  const { result, report, events } = await simulate('malformed_issue');
  assert.equal(result.status, 1);
  assert.equal(report, null);
  assert.match(result.stderr, /tines issues show demo\/4 returned invalid JSON \(9 bytes\)/);
  assert.doesNotMatch(result.stderr, /not-json/);
  assert.ok(!events.some((e) => e.binary === 'tines' && e.args[1] === 'move'));
});

test('merge conflicts route directly to implementation without waiting for CI', async () => {
  for (const mode of ['conflict_initial', 'conflict_dirty']) {
    const { result, report, events } = await simulate(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.result, 'failed');
    assert.equal(report.reason, 'merge_conflict');
    assert.deepEqual(report.checks, []);
    assert.ok(!events.some((e) => e.binary === 'gh' && e.args[1] === 'checks'),
      'do not query checks for known conflicts');
    const comment = events.find((e) => e.binary === 'tines' && e.args[1] === 'comment');
    assert.equal(comment.args[3],
      `Status checks BLOCKED for PR #123 at ${sha}: merge conflicts with main`);
    const move = events.find((e) => e.binary === 'tines' && e.args[1] === 'move');
    assert.equal(move.args[3], 'Checks failed');
  }
});

test('merge conflicts arising while waiting for checks are detected', async () => {
  for (const mode of ['conflict_no_checks', 'conflict_pending']) {
    const { result, report, events } = await simulate(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.result, 'failed');
    assert.equal(report.reason, 'merge_conflict');
    assert.ok(events.some((e) => e.binary === 'gh' && e.args[1] === 'checks'));
    assert.equal(events.find((e) => e.binary === 'tines' && e.args[1] === 'move').args[3],
      'Checks failed');
  }
});

test('merge conflicts arising after checks complete take precedence over success', async () => {
  const { result, report, events } = await simulate('conflict_after_checks');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.result, 'failed');
  assert.equal(report.reason, 'merge_conflict');
  assert.ok(events.some((e) => e.binary === 'gh' && e.args[1] === 'checks'));
  const comment = events.find((e) => e.binary === 'tines' && e.args[1] === 'comment');
  assert.match(comment.args[3], /Status checks BLOCKED/);
});

test('unknown mergeability and other BLOCKED merge states are not assumed to be conflicts', async () => {
  for (const mode of ['merge_unknown', 'merge_blocked']) {
    const { result, report } = await simulate(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.result, 'passed');
  }
});

test('comment failure logs warning but still transitions', async () => {
  const { result, report, events } = await simulate('comment_fail');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.result, 'passed');
  assert.match(result.stdout, /Warning: could not post status comment/);
  const comment = events.findIndex((e) => e.binary === 'tines' && e.args[1] === 'comment');
  const move = events.findIndex((e) => e.binary === 'tines' && e.args[1] === 'move');
  assert.ok(comment !== -1 && move > comment);
});

test('attachment failure prevents transition', async () => {
  const { result, report, events } = await simulate('attach_fail');
  assert.equal(result.status, 1);
  assert.equal(report.result, 'passed');
  assert.ok(!events.some((e) => e.binary === 'tines' && e.args[1] === 'move'));
  assert.ok(!events.some((e) => e.binary === 'tines' && e.args[1] === 'comment'));
});

test('concurrent issue state change prevents transition', async () => {
  const { result, report, events } = await simulate('changed_state');
  assert.equal(result.status, 1);
  assert.equal(report.result, 'passed');
  assert.ok(events.some((e) => e.binary === 'tines' && e.args[2] === 'attach'));
  assert.ok(!events.some((e) => e.binary === 'tines' && e.args[1] === 'move'));
  assert.ok(!events.some((e) => e.binary === 'tines' && e.args[1] === 'comment'));
});
