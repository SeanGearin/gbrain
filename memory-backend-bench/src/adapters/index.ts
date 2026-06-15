import type { BackendName, MemoryAdapter } from '../types.ts';
import { GbrainAdapter } from './gbrain.ts';
import { HonchoAdapter } from './honcho.ts';

export function makeAdapter(name: BackendName): MemoryAdapter {
  if (name === 'gbrain') {
    return new GbrainAdapter({
      repoPath: process.env.GBRAIN_REPO || '..',
      keywordOnly: process.env.GBRAIN_KEYWORD_ONLY === '1',
      searchMode: process.env.GBRAIN_SEARCH_MODE || 'balanced',
    });
  }
  return new HonchoAdapter({
    baseURL: process.env.HONCHO_BASE_URL || process.env.HONCHO_URL || 'http://localhost:8000',
    apiKey: process.env.HONCHO_API_KEY || undefined,
    timeoutSeconds: Number(process.env.HONCHO_TIMEOUT_SECONDS || '600'),
    cleanupWorkspace: process.env.HONCHO_CLEANUP_WORKSPACE === '1',
    skipDream: process.env.HONCHO_SKIP_DREAM === '1',
    reasoningLevel: process.env.HONCHO_REASONING_LEVEL || undefined,
  });
}
