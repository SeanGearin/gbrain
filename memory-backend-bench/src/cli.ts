import { resolve } from 'node:path';
import { allDatasetNames } from './datasets.ts';
import { envNumber, envString, loadDotEnv } from './env.ts';
import { stableRunId } from './id.ts';
import { runBench, type RunConfig } from './runner.ts';
import type { BackendName, DatasetName } from './types.ts';

loadDotEnv();

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function parseList<T extends string>(raw: string, allowed: readonly T[]): T[] {
  const values = raw.split(',').map((s) => s.trim()).filter(Boolean) as T[];
  for (const value of values) {
    if (!allowed.includes(value)) throw new Error(`Unsupported value "${value}". Allowed: ${allowed.join(', ')}`);
  }
  return values;
}

function printHelp(): void {
  process.stdout.write(`memory-backend-bench

Run:
  bun src/cli.ts --datasets longmemeval-s,locomo --backends gbrain,honcho

Options:
  --datasets LIST          longmemeval-s,locomo (default: both)
  --backends LIST          gbrain,honcho (default: both)
  --limit N                Limit questions per dataset after seeded shuffle
  --seed N                 Question-order seed
  --data-dir DIR           Dataset directory (default: ./data)
  --output-dir DIR         Output directory (default: ./results/<run-id>)
  --context-token-budget N Shared context budget per answer
  --answer-max-tokens N    Shared answer max tokens
  --top-k N                Backend retrieval/search depth
  --answer-mode MODE       shared-context-reader or backend-direct
`);
}

async function main(): Promise<void> {
  if (has('--help') || has('-h')) {
    printHelp();
    return;
  }

  const runId = envString('RUN_ID', stableRunId());
  const datasets = parseList<DatasetName>(
    arg('--datasets') ?? envString('BENCH_DATASETS', allDatasetNames().join(',')),
    allDatasetNames(),
  );
  const backends = parseList<BackendName>(
    arg('--backends') ?? envString('BENCH_BACKENDS', 'gbrain,honcho'),
    ['gbrain', 'honcho'],
  );
  const limitRaw = arg('--limit') ?? envString('BENCH_LIMIT', '');
  const limit = limitRaw ? Number(limitRaw) : null;
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive number, got ${limitRaw}`);
  }

  const answerMode = (arg('--answer-mode') ?? envString('ANSWER_MODE', 'shared-context-reader')) as RunConfig['answerMode'];
  if (answerMode !== 'shared-context-reader' && answerMode !== 'backend-direct') {
    throw new Error('--answer-mode must be shared-context-reader or backend-direct');
  }

  const config: RunConfig = {
    runId,
    dataDir: resolve(arg('--data-dir') ?? './data'),
    outputDir: resolve(arg('--output-dir') ?? `./results/${runId}`),
    datasets,
    backends,
    limit,
    seed: Number(arg('--seed') ?? envNumber('BENCH_SEED', 20260615)),
    budgets: {
      topK: Number(arg('--top-k') ?? envNumber('TOP_K', 8)),
      contextTokenBudget: Number(arg('--context-token-budget') ?? envNumber('CONTEXT_TOKEN_BUDGET', 4096)),
      answerMaxTokens: Number(arg('--answer-max-tokens') ?? envNumber('ANSWER_MAX_TOKENS', 512)),
    },
    answerModel: arg('--answer-model') ?? envString('ANSWER_MODEL', 'claude-sonnet-4-5'),
    judgeModel: arg('--judge-model') ?? envString('JUDGE_MODEL', 'gpt-4o-2024-08-06'),
    answerMode,
  };

  process.stderr.write(`[memory-bench] run_id=${config.runId}\n`);
  process.stderr.write(`[memory-bench] datasets=${config.datasets.join(',')} backends=${config.backends.join(',')}\n`);
  process.stderr.write(`[memory-bench] output=${config.outputDir}\n`);
  await runBench(config);
  process.stderr.write(`[memory-bench] wrote ${config.outputDir}/README.md\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
