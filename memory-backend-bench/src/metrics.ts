import type { ResultRow } from './types.ts';
import { median } from './tokenize.ts';

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !['a', 'an', 'the'].includes(t));
}

export function tokenF1(expected: string, actual: string): number {
  const gold = normalize(expected);
  const pred = normalize(actual);
  if (gold.length === 0 && pred.length === 0) return 1;
  if (gold.length === 0 || pred.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of gold) counts.set(token, (counts.get(token) ?? 0) + 1);
  let overlap = 0;
  for (const token of pred) {
    const count = counts.get(token) ?? 0;
    if (count > 0) {
      overlap++;
      counts.set(token, count - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / pred.length;
  const recall = overlap / gold.length;
  return (2 * precision * recall) / (precision + recall);
}

export interface SummaryRow {
  dataset: string;
  backend: string;
  n: number;
  errors: number;
  qa_accuracy: number;
  mean_f1: number;
  median_context_tokens: number;
}

export function summarize(rows: ResultRow[]): SummaryRow[] {
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const key = `${row.dataset}::${row.backend}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [dataset, backend] = key.split('::');
    return {
      dataset,
      backend,
      n: group.length,
      errors: group.filter((r) => r.error).length,
      qa_accuracy: group.length ? group.reduce((sum, r) => sum + r.qa_accuracy, 0) / group.length : 0,
      mean_f1: group.length ? group.reduce((sum, r) => sum + r.f1, 0) / group.length : 0,
      median_context_tokens: median(group.map((r) => r.context_tokens)),
    };
  }).sort((a, b) => a.dataset.localeCompare(b.dataset) || a.backend.localeCompare(b.backend));
}
