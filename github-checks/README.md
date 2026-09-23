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
2. Wait for checks to register and complete using `gh pr checks --watch`, then fetch structured results. Optionally restrict to required checks and/or require specific check names.
3. Re-check the PR's HEAD and artifact version to avoid publishing a result for a superseded PR.
4. Upload `github-status-checks.json` as the `github-status-checks` **file** artifact with `application/json`, then take exactly one transition. If attaching the report fails or the issue moved to another state, the runner exits non-zero **without taking a transition**.

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
| `NO_CHECKS_GRACE_SECONDS` | `90` | Time allowed for checks to appear. |
| `SETTLE_SECONDS` | `10` | Delay before re-reading an apparently terminal result. |
| `REQUIRED_ONLY` | `0` | Set to `1` to query only GitHub-required checks. No matching checks triggers an infrastructure failure. |
| `EXPECTED_CHECKS` | empty | Comma-separated exact check names. The runner waits for all of them rather than declaring success early. |
| `WATCH_OUTPUT` | `0` | Set to `1` to include `gh --watch` progress in the Tines run log. |

`EXPECTED_CHECKS` is advisable when check suites start asynchronously; otherwise the settling window can close before late checks register. Set the Tines runner's `max_run_minutes` higher than the check timeout plus setup/report overhead (the Tines default is 30 minutes).

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

This is a prototype tested with mocked CLIs. Test it on a non-production workflow/PR before routing real work to it.
