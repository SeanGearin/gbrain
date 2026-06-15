import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AdapterRunContext,
  BenchItem,
  BudgetConfig,
  ContextAnswer,
  MemoryAdapter,
  MemoryMessage,
  MemoryPeer,
  MemorySession,
} from '../types.ts';
import { safeId } from '../id.ts';
import { countTokens, trimToTokenBudget } from '../tokenize.ts';

interface GbrainModules {
  createBenchmarkBrain: () => Promise<any>;
  resetTables: (engine: any) => Promise<void>;
  importFromContent: (engine: any, slug: string, content: string, opts?: Record<string, unknown>) => Promise<unknown>;
  hybridSearch: (engine: any, query: string, opts?: Record<string, unknown>) => Promise<any[]>;
}

interface StoredSession {
  session: MemorySession;
  slug: string;
  content: string;
}

export class GbrainAdapter implements MemoryAdapter {
  readonly name = 'gbrain' as const;
  private engine: any | null = null;
  private modules: GbrainModules | null = null;
  private sessions = new Map<string, StoredSession>();
  private indexed = false;

  constructor(private opts: {
    repoPath: string;
    keywordOnly: boolean;
    searchMode: string;
  }) {}

  private async loadModules(): Promise<GbrainModules> {
    if (this.modules) return this.modules;
    const repo = resolve(this.opts.repoPath);
    const importTs = async (rel: string) => import(pathToFileURL(join(repo, rel)).href);
    const harness = await importTs('src/eval/longmemeval/harness.ts');
    const importer = await importTs('src/core/import-file.ts');
    const hybrid = await importTs('src/core/search/hybrid.ts');
    this.modules = {
      createBenchmarkBrain: harness.createBenchmarkBrain,
      resetTables: harness.resetTables,
      importFromContent: importer.importFromContent,
      hybridSearch: hybrid.hybridSearch,
    };
    return this.modules;
  }

  async reset(_item: BenchItem, _ctx: AdapterRunContext): Promise<void> {
    const mods = await this.loadModules();
    if (!this.engine) this.engine = await mods.createBenchmarkBrain();
    await mods.resetTables(this.engine);
    this.sessions.clear();
    this.indexed = false;
  }

  async upsert_peer(_peer: MemoryPeer): Promise<void> {
    // gbrain indexes conversation pages. Peer identity is represented in the page body.
  }

  async create_session(session: MemorySession): Promise<void> {
    const slug = `chat/${safeId(session.id, 'session').toLowerCase()}`;
    this.sessions.set(session.id, {
      session,
      slug,
      content: renderSessionPage(session),
    });
  }

  async add_messages(sessionId: string, messages: MemoryMessage[]): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) throw new Error(`gbrain session not created: ${sessionId}`);
    existing.session.messages.push(...messages);
    existing.content = renderSessionPage(existing.session);
    this.indexed = false;
  }

  async await_index(): Promise<void> {
    if (this.indexed) return;
    if (!this.engine) throw new Error('gbrain engine not initialized');
    const mods = await this.loadModules();
    for (const stored of this.sessions.values()) {
      await mods.importFromContent(this.engine, stored.slug, stored.content, {
        noEmbed: this.opts.keywordOnly,
      });
    }
    this.indexed = true;
  }

  async consolidate(_item: BenchItem): Promise<void> {
    // No benchmark-specific consolidation step. Retrieval uses the same imported pages.
  }

  async context_answer(item: BenchItem, budgets: BudgetConfig): Promise<ContextAnswer> {
    if (!this.engine) throw new Error('gbrain engine not initialized');
    await this.await_index();
    const mods = await this.loadModules();
    const results = this.opts.keywordOnly
      ? await this.engine.searchKeyword(item.question, { limit: budgets.topK })
      : await mods.hybridSearch(this.engine, item.question, {
          limit: budgets.topK,
          expansion: false,
          mode: this.opts.searchMode || undefined,
        });

    const bySlug = new Map([...this.sessions.values()].map((s) => [s.slug, s]));
    const seen = new Set<string>();
    const blocks: string[] = [];
    const retrievedIds: string[] = [];
    for (const result of results) {
      const slug = String(result.slug ?? '');
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const stored = bySlug.get(slug);
      const sessionId = stored?.session.label ?? stored?.session.id ?? slug.replace(/^chat\//, '');
      retrievedIds.push(sessionId);
      blocks.push(
        `<memory_session id="${escapeAttr(sessionId)}" date="${escapeAttr(stored?.session.date ?? '')}">\n` +
        `${stored?.content ?? result.chunk_text ?? ''}\n` +
        `</memory_session>`,
      );
    }
    const context = trimToTokenBudget(blocks.join('\n\n'), budgets.contextTokenBudget);
    return {
      context,
      contextTokens: countTokens(context),
      retrievedIds,
      metadata: {
        search: this.opts.keywordOnly ? 'keyword' : 'hybrid',
        search_mode: this.opts.searchMode,
        raw_result_count: results.length,
      },
    };
  }

  async cleanup(): Promise<void> {
    this.sessions.clear();
  }

  async teardown(): Promise<void> {
    await this.engine?.disconnect?.();
    this.engine = null;
    this.sessions.clear();
    this.indexed = false;
  }
}

function renderSessionPage(session: MemorySession): string {
  const fm = ['---', 'type: note'];
  if (session.date) fm.push(`date: ${session.date}`);
  fm.push(`session_id: ${session.label ?? session.id}`, '---', '');
  const body = session.messages.flatMap((message) => {
    const who = message.role ?? message.peerId;
    const when = message.createdAt ? ` (${message.createdAt})` : '';
    return [`**${who}${when}:** ${message.content}`, ''];
  });
  return fm.concat(body).join('\n');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
