# GitHub merge waiter

Tines custom harness for GitHub native auto-merge. Requires Node.js 20+, `gh`, `tines`, a PR artifact `pr`, and Tines transitions `Merged` and `Merge failed`.

Install using `tines runner install --name github-merge --harness custom --command 'node /opt/tines-tools/github-merge/github-merge.mjs --prompt {prompt_file} --workspace {workspace}'`.

Waits for merge completion, pending checks, or branch updates. Fails on conflicts, missing auto-merge, missing approval, failed/missing checks, or PR closure. A behind branch that GitHub REST reports as non-rebaseable on two consecutive polls of the same head and target branch fails with `rebase_conflict`. Unknown or stale rebaseability responses keep waiting, as do ordinary behind and blocked states. This harness does not rebase branches; merge-app remains responsible for automatic rebasing. Attaches `github-merge-status` before transition. Timeouts and operational errors do not transition.

Environment: `MERGE_TIMEOUT_SECONDS` (1200), `POLL_INTERVAL_SECONDS` (5), `MISSING_CHECK_GRACE_SECONDS` (30), `EXPECTED_CHECKS`, `PR_ARTIFACT_NAME`.
