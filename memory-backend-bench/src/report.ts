import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResultRow } from './types.ts';
import { summarize, type SummaryRow } from './metrics.ts';

export function writeSummary(outputDir: string, rows: ResultRow[]): void {
  mkdirSync(outputDir, { recursive: true });
  const summary = summarize(rows);
  writeFileSync(join(outputDir, 'summary.json'), JSON.stringify({ summary, rows }, null, 2) + '\n');
  writeFileSync(join(outputDir, 'README.md'), renderMarkdown(summary, rows));
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function renderMarkdown(summary: SummaryRow[], rows: ResultRow[]): string {
  const first = rows[0];
  const methodology = first?.methodology;
  const budgets = first?.budgets;
  const lines: string[] = [];
  lines.push('# Memory Backend Benchmark Results', '');
  if (methodology) {
    lines.push(`Run date: ${methodology.run_date}`);
    lines.push(`Judge model: ${methodology.judge_model}`);
    lines.push(`Answer model: ${methodology.answer_model}`);
    lines.push(`Answer mode: ${methodology.answer_mode}`);
    lines.push(`Question order seed: ${methodology.question_order_seed}`);
    if (budgets) {
      lines.push(`Top K: ${budgets.top_k}`);
      lines.push(`Context token budget: ${budgets.context_token_budget}`);
      lines.push(`Answer max tokens: ${budgets.answer_max_tokens}`);
    }
    lines.push('');
  }
  lines.push('| Dataset | Backend | n | QA accuracy | Mean F1 | Median context tokens | Errors |');
  lines.push('|---|---|---:|---:|---:|---:|---:|');
  for (const row of summary) {
    lines.push(`| ${row.dataset} | ${row.backend} | ${row.n} | ${pct(row.qa_accuracy)} | ${row.mean_f1.toFixed(3)} | ${Math.round(row.median_context_tokens)} | ${row.errors} |`);
  }
  lines.push('', '## Caveats', '');
  lines.push('- Single judge model, single run. Treat close differences as directional until repeated across seeds.');
  lines.push('- Shared-context-reader mode measures backend context quality plus one fixed reader, not each product endpoint in its most optimized direct-answer mode.');
  lines.push('- Median context tokens are counted after the backend context is trimmed to the configured budget.');
  lines.push('- Datasets are public and fetched locally; raw dataset files are intentionally not committed.');
  lines.push('');
  return lines.join('\n');
}
