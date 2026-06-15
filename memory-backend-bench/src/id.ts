export function safeId(raw: string, fallback = 'id'): string {
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/[.\s]+/g, '-')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-');
  const out = cleaned || fallback;
  return out.slice(0, 180);
}

export function stableRunId(prefix = 'memory-bench'): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${stamp}`;
}
