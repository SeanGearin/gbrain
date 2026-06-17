# Test Harness Fix Findings - 2026-06-16

## Context

- Repo: `/Users/gfunk/indistinct/gbrain`
- Branch: `codex/test-harness-hermetic`
- Starting tip confirmed: `ec787013194ee8e8a236250de183230cf86b196c`
- Session: `test-harness-hermetic`

## Change made

The default unit wrapper now caps effective file-level concurrency at the harness
level. `scripts/run-unit-parallel.sh` still defaults to up to 4 shard processes,
but each shard now runs Bun with `--max-concurrency=1` unless explicitly
overridden. The default effective file concurrency is therefore 4 instead of the
previous 16.

Docs now identify `bun run test` as the canonical capped full unit command.
Plain `bun test` remains best-effort because Bun does not expose a supported
`--max-concurrency` setting in `bunfig.toml`.

No test assertions were weakened and no files were reclassified to serial,
integration, or slow.

## Validation

Focused runner regression:

```text
bun test test/scripts/run-unit-parallel.test.ts
7 pass, 0 fail
```

Single full wrapper run:

```text
bun run test
[unit-parallel] N=4 shards | --max-concurrency=1 | effective-file-concurrency=4 | timeout=7200s
elapsed=3315s | pass=12496 fail=6 skip=18
exit code 1
```

Parallel capped shards all completed cleanly:

```text
shard 1/4: pass=3805 fail=0 skip=0 rc=0
shard 2/4: pass=2963 fail=0 skip=12 rc=0
shard 3/4: pass=2716 fail=0 skip=3 rc=0
shard 4/4: pass=3012 fail=0 skip=3 rc=0
```

This confirms the harness-level cap stopped the parallel PGLite setup starvation
class in the default wrapper path.

## Remaining serial failures from the same single run

The serial post-pass failed in three files:

- `test/admin-embed-spawn.serial.test.ts`: 4 failures. Each spawned
  `serve --http` and timed out after 30s while stderr still showed PGLite
  migrations applying through `admin_dashboard_columns_v0_26_3`.
- `test/doctor-remote.serial.test.ts`: 1 unnamed before/after hook timeout at
  120s. The visible error was `Failed to start server. Is port 0 in use?`.
- `test/worker-registry.serial.test.ts`: 1 assertion failure in the PID-reuse
  guard; expected zero live workers, received one.

These are serial-pass failures, not new parallel shard failures. Per Sean's
instruction, I did not start another full lap or reclassify more files.

## Notes

The logs contain expected negative-path `EPERM` strings from passing tests
(`classifyHolderLiveness` and best-effort audit-write coverage). I did not see
parallel-shard hook-timeout, real-home, or thin-client fallback signatures.

## Next action

Land the wrapper cap change, then handle the serial-pass failures as a separate
targeted follow-up. Do not merge or deploy from this session.
