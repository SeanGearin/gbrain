import { get_encoding } from '@dqbd/tiktoken';

let encoder: ReturnType<typeof get_encoding> | null = null;

function enc(): ReturnType<typeof get_encoding> {
  if (!encoder) encoder = get_encoding('o200k_base');
  return encoder;
}

export function countTokens(text: string): number {
  try {
    return enc().encode(text, ['<|endoftext|>']).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

export function trimToTokenBudget(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (countTokens(text) <= budget) return text;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + '\n[context truncated to budget]';
    if (countTokens(candidate) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '\n[context truncated to budget]';
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
