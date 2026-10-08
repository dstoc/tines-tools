# GitHub merge waiter

Tines custom harness for GitHub native auto-merge. Requires Node.js 20+, `gh`, `tines`, a PR artifact `pr`, and Tines transitions `Merged` and `Merge failed`.

Install using `tines runner install --name github-merge --harness custom --command 'node /opt/tines-tools/github-merge/github-merge.mjs --prompt {prompt_file} --workspace {workspace}'`.

Waits for merge completion, pending checks, or branch updates. Fails on conflicts, missing auto-merge, missing approval, failed/missing checks, blocked state, or PR closure. Attaches `github-merge-status` before transition. Timeouts and operational errors do not transition.

Environment: `MERGE_TIMEOUT_SECONDS` (1200), `POLL_INTERVAL_SECONDS` (5), `MISSING_CHECK_GRACE_SECONDS` (30), `EXPECTED_CHECKS`, `PR_ARTIFACT_NAME`.
