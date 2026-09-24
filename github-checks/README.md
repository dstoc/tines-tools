# GitHub status checks runner

A dependency-free Node.js custom harness for Tines. It reads a PR artifact from its assigned issue, waits for GitHub status checks using `gh`, writes a versioned `github-status-checks` JSON-file artifact, then takes the corresponding named workflow transition.

## Requirements

- Node.js 20 or newer; the `tines` and `gh` CLIs on the runner's `PATH`.
- An authenticated `gh` session for the **OS user running the Tines daemon**, with permission to read PRs and checks on the relevant repositories (`gh auth status`).
- A Tines workflow state exposing the three transitions **Checks passed**, **Checks failed**, and **Infrastructure failed**. Route that state to this custom runner.
- A PR artifact named `pr` by default (set `PR_ARTIFACT_NAME` to choose another slot). The runner checks that its repository is among the effective `repos.json` entries when any are configured.

Install the runner on a machine with a copy of this directory, adjusting the script path:

```sh
TINES_API_KEY=tines_… tines runner install \
  --name github-checks \
  --harness custom \
  --command 'node /opt/tines-tools/github-checks/github-status-checks.mjs --prompt {prompt_file} --workspace {workspace}'
```

The Tines daemon substitutes and shell-quotes the placeholders, sets `TINES_API_URL` and an ephemeral per-run `TINES_API_KEY`, and starts the script in the per-run workspace. Ensure the daemon's service environment can find `node`, `tines` and `gh`; interactive-shell authentication or `PATH` alone may not carry into systemd/launchd.

## Behaviour

1. Read the Tines issue and PR artifact; validate its GitHub repository, PR number, open/non-draft status and HEAD SHA.
2. Wait for GitHub-required checks to register and complete using `gh pr checks --required --watch`, then fetch structured results. Optionally require specific check names when checks register asynchronously.
3. Re-check the PR's HEAD and artifact version to avoid publishing a result for a superseded PR.
4. Upload `github-status-checks.json` as the `github-status-checks` **file** artifact with `application/json`. For `passed` or `failed`, post a Tines issue comment containing the result, PR number and full HEAD SHA (for example, `Status checks PASSED for PR #163 at 579c27ba1becaa111e3b44dc5193cb59efb4db3e`). Then take exactly one transition. If attaching the report fails or the issue moved to another state, the runner exits non-zero **without commenting or transitioning**. Comment failures are logged but do not block the transition. Infrastructure failures do not generate a status comment.

| Result | Transition | Meaning |
| --- | --- | --- |
| `passed` | Checks passed | All observed, selected checks completed successfully (skipped checks are neutral). |
| `failed` | Checks failed | At least one check completed with a failure conclusion. |
| `infrastructure_failed` | Infrastructure failed | Missing/invalid PR, cancelled or timed-out checks, GitHub/CLI errors, no checks, runner deadline, or superseded PR. |

The report records the issue reference, PR and HEAD SHA, timestamp, per-check states/URLs and counts, overall result, and a machine-readable `reason` and `error` when applicable. This is a process report, not an attestation; GitHub status can change after the final read.

## Configuration

These are environment variables on the runner machine (or effective Tines environment context for the checking state):

| Variable | Default | Description |
| --- | --- | --- |
| `PR_ARTIFACT_NAME` | `pr` | Preferred PR artifact slot. A single PR artifact is accepted when no preferred slot exists. |
| `CHECK_TIMEOUT_SECONDS` | `1200` | Maximum time waiting for checks (20 minutes). Set below the Tines runner's per-run timeout. |
| `EXPECTED_CHECKS` | empty | Optional comma-separated exact names of required checks, for workflows whose required checks register at different times. |
| `WATCH_OUTPUT` | `0` | Set to `1` to include `gh --watch` progress in the Tines run log. |

The runner queries only GitHub-required checks. If none are reported yet, it retries until `CHECK_TIMEOUT_SECONDS`; there is no separate registration grace period or settling delay. `EXPECTED_CHECKS` is advisable for workflows with downstream/late-starting required checks: GitHub CLI can report all *currently visible* checks as complete before another required check registers. Set the Tines runner's `max_run_minutes` higher than the check timeout plus setup/report overhead (the Tines default is 30 minutes).

## Run locally

With `TINES_API_KEY`, `TINES_API_URL`, and `gh` authentication configured:

```sh
node github-status-checks.mjs --issue project/123 --workspace /path/to/workspace
```

When dispatched by Tines, use `--prompt {prompt_file} --workspace {workspace}` rather than specifying the issue manually.

Run the mock integration tests without GitHub or Tines credentials:

```sh
node --test github-status-checks.test.mjs
```

The runner buffers command stdout up to 16 MiB rather than silently truncating large Tines issue JSON. Invalid JSON failures identify the command and response size without logging the response (which may contain sensitive issue content). The runner exits non-zero before attaching a report or transitioning if its initial issue read cannot be parsed.

This is a prototype tested with mocked CLIs. Test it on a non-production workflow/PR before routing real work to it.
