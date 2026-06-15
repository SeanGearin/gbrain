import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeAdapter } from './adapters/index.ts';
import { loadDataset } from './datasets.ts';
import { ANSWER_PROMPT_ID, answerFromContext, judgeAnswer, judgePromptId } from './llm.ts';
import { tokenF1 } from './metrics.ts';
import { shuffled } from './random.ts';
import { writeSummary } from './report.ts';
import type {
  BackendName,
  BenchItem,
  BudgetConfig,
  DatasetName,
  MemoryAdapter,
  ResultRow,
} from './types.ts';

export interface RunConfig {
  runId: string;
  dataDir: string;
  outputDir: string;
  datasets: DatasetName[];
  backends: BackendName[];
  limit: number | null;
  seed: number;
  budgets: BudgetConfig;
  answerModel: string;
  judgeModel: string;
  answerMode: 'shared-context-reader' | 'backend-direct';
}

export async function runBench(config: RunConfig): Promise<ResultRow[]> {
  mkdirSync(config.outputDir, { recursive: true });
  const rows: ResultRow[] = [];
  const resultPath = join(config.outputDir, 'results.jsonl');

  for (const dataset of config.datasets) {
    const allItems = shuffled(loadDataset(dataset, config.dataDir), config.seed);
    const items = config.limit ? allItems.slice(0, config.limit) : allItems;
    for (const backend of config.backends) {
      const adapter = makeAdapter(backend);
      try {
        for (const [index, item] of items.entries()) {
          const row = await runOne({
            adapter,
            backend,
            item,
            itemIndex: index,
            config,
          });
          rows.push(row);
          appendFileSync(resultPath, JSON.stringify(row) + '\n');
          const status = row.error ? 'ERROR' : row.qa_passed ? 'PASS' : 'FAIL';
          process.stderr.write(`[${dataset}/${backend}] ${index + 1}/${items.length} ${item.questionId} ${status} f1=${row.f1.toFixed(3)} ctx=${row.context_tokens}\n`);
        }
      } finally {
        await adapter.teardown?.().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[${dataset}/${backend}] teardown warning: ${msg}\n`);
        });
      }
    }
  }

  writeSummary(config.outputDir, rows);
  return rows;
}

async function runOne(args: {
  adapter: MemoryAdapter;
  backend: BackendName;
  item: BenchItem;
  itemIndex: number;
  config: RunConfig;
}): Promise<ResultRow> {
  const { adapter, backend, item, itemIndex, config } = args;
  const started = Date.now();
  const timings = { ingest: 0, await_index: 0, consolidate: 0, answer: 0, judge: 0, total: 0 };
  let actual = '';
  let contextTokens = 0;
  let retrievedIds: string[] = [];
  let adapterMetadata: Record<string, unknown> = {};
  let error: string | null = null;
  let qaPassed = false;
  let qaAccuracy = 0;
  let f1 = 0;

  try {
    const ingestStart = Date.now();
    await adapter.reset(item, {
      runId: config.runId,
      dataset: item.dataset,
      backend,
      itemIndex,
    });
    for (const peer of item.peers) await adapter.upsert_peer(peer);
    for (const session of item.sessions) {
      await adapter.create_session({ ...session, messages: [] });
      await adapter.add_messages(session.id, session.messages);
    }
    timings.ingest = Date.now() - ingestStart;

    const indexStart = Date.now();
    await adapter.await_index();
    timings.await_index = Date.now() - indexStart;

    const consolidateStart = Date.now();
    await adapter.consolidate(item);
    timings.consolidate = Date.now() - consolidateStart;

    const answerStart = Date.now();
    if (config.answerMode === 'backend-direct') {
      if (!adapter.answer) throw new Error(`${backend} does not implement direct answer mode`);
      const direct = await adapter.answer(item, config.budgets);
      actual = direct.answer;
      contextTokens = direct.contextTokens ?? 0;
      retrievedIds = direct.retrievedIds ?? [];
      adapterMetadata = direct.metadata;
    } else {
      const ctx = await adapter.context_answer(item, config.budgets);
      actual = await answerFromContext({
        item,
        context: ctx.context,
        model: config.answerModel,
        maxTokens: config.budgets.answerMaxTokens,
      });
      contextTokens = ctx.contextTokens;
      retrievedIds = ctx.retrievedIds;
      adapterMetadata = ctx.metadata;
    }
    timings.answer = Date.now() - answerStart;

    const judgeStart = Date.now();
    const judgment = await judgeAnswer({ item, actual, model: config.judgeModel });
    timings.judge = Date.now() - judgeStart;
    qaPassed = judgment.passed;
    qaAccuracy = judgment.passed ? 1 : 0;
    f1 = tokenF1(item.answer, actual);
    adapterMetadata = {
      ...adapterMetadata,
      judge_reasoning: judgment.reasoning,
    };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await adapter.cleanup().catch(() => undefined);
    timings.total = Date.now() - started;
  }

  const runDate = new Date().toISOString();
  return {
    schema_version: 1,
    run_id: config.runId,
    backend,
    dataset: item.dataset,
    dataset_item_id: item.id,
    question_id: item.questionId,
    question_type: item.questionType,
    question: item.question,
    expected_answer: item.answer,
    actual_answer: actual,
    qa_accuracy: qaAccuracy,
    qa_passed: qaPassed,
    f1,
    context_tokens: contextTokens,
    median_context_tokens_basis: 'per-answer-context',
    retrieved_ids: retrievedIds,
    budgets: {
      top_k: config.budgets.topK,
      context_token_budget: config.budgets.contextTokenBudget,
      answer_max_tokens: config.budgets.answerMaxTokens,
    },
    methodology: {
      answer_mode: config.answerMode,
      answer_model: config.answerModel,
      judge_model: config.judgeModel,
      judge_prompt_id: judgePromptId(item.dataset),
      answer_prompt_id: ANSWER_PROMPT_ID,
      run_date: runDate,
      question_order_seed: config.seed,
    },
    timings_ms: timings,
    adapter_metadata: {
      ...adapterMetadata,
      source_meta: item.sourceMeta,
    },
    error,
  };
}
