import { Honcho, type MessageInput } from '@honcho-ai/sdk';
import type {
  AdapterRunContext,
  BenchItem,
  BudgetConfig,
  ContextAnswer,
  DirectAnswer,
  MemoryAdapter,
  MemoryMessage,
  MemoryPeer,
  MemorySession,
} from '../types.ts';
import { safeId } from '../id.ts';
import { countTokens, trimToTokenBudget } from '../tokenize.ts';

type HonchoPeer = Awaited<ReturnType<Honcho['peer']>>;
type HonchoSession = Awaited<ReturnType<Honcho['session']>>;

export class HonchoAdapter implements MemoryAdapter {
  readonly name = 'honcho' as const;
  private client: Honcho | null = null;
  private workspaceId = '';
  private peers = new Map<string, HonchoPeer>();
  private sessions = new Map<string, HonchoSession>();
  private sessionLabels = new Map<string, string>();
  private observerIds: string[] = [];

  constructor(private opts: {
    baseURL: string;
    apiKey?: string;
    timeoutSeconds: number;
    cleanupWorkspace: boolean;
    skipDream: boolean;
    reasoningLevel?: string;
  }) {}

  async reset(item: BenchItem, ctx: AdapterRunContext): Promise<void> {
    this.workspaceId = safeId(`${ctx.runId}-${item.dataset}-${item.questionId}-${ctx.itemIndex}`, 'bench');
    this.client = new Honcho({
      workspaceId: this.workspaceId,
      baseURL: this.opts.baseURL,
      apiKey: this.opts.apiKey || undefined,
      timeout: this.opts.timeoutSeconds * 1000,
    });
    this.peers.clear();
    this.sessions.clear();
    this.sessionLabels.clear();
    this.observerIds = item.peers.map((p) => p.id);
  }

  async upsert_peer(peer: MemoryPeer): Promise<void> {
    if (!this.client) throw new Error('Honcho client not initialized');
    const created = await this.client.peer(peer.id, {
      metadata: { label: peer.label ?? peer.id },
      configuration: { observeMe: true },
    });
    this.peers.set(peer.id, created);
  }

  async create_session(session: MemorySession): Promise<void> {
    if (!this.client) throw new Error('Honcho client not initialized');
    const peerConfig = [...this.peers.keys()].map((peerId) => [
      peerId,
      { observeMe: true, observeOthers: false },
    ] as [string, { observeMe: boolean; observeOthers: boolean }]);
    const created = await this.client.session(session.id, {
      metadata: { label: session.label ?? session.id, date: session.date ?? null },
      configuration: { summary: { enabled: false } },
      peers: peerConfig,
    });
    this.sessions.set(session.id, created);
    this.sessionLabels.set(session.id, session.label ?? session.id);
  }

  async add_messages(sessionId: string, messages: MemoryMessage[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Honcho session not created: ${sessionId}`);
    const batch: MessageInput[] = [];
    for (const msg of messages) {
      const peer = this.peers.get(msg.peerId);
      if (!peer) throw new Error(`Honcho peer not created: ${msg.peerId}`);
      if (!msg.content.trim()) continue;
      batch.push(peer.message(msg.content, {
        metadata: msg.metadata,
        createdAt: msg.createdAt,
      }));
    }
    for (let i = 0; i < batch.length; i += 100) {
      await session.addMessages(batch.slice(i, i + 100));
    }
  }

  async await_index(): Promise<void> {
    await this.waitForQueue();
  }

  async consolidate(_item: BenchItem): Promise<void> {
    if (!this.client || this.opts.skipDream) return;
    const sessionIds = [...this.sessions.keys()];
    await Promise.all(this.observerIds.flatMap((observer) =>
      sessionIds.map((session) => this.client!.scheduleDream({ observer, observed: observer, session })),
    ));
    await this.waitForQueue();
  }

  async answer(item: BenchItem, _budgets: BudgetConfig): Promise<DirectAnswer> {
    const peer = this.peers.get(item.targetPeerId) ?? this.peers.values().next().value;
    if (!peer) throw new Error(`Honcho target peer not found: ${item.targetPeerId}`);
    const answer = await peer.chat(item.question, {
      reasoningLevel: this.opts.reasoningLevel,
    });
    return {
      answer: answer ?? '',
      metadata: {
        answer_mode: 'honcho-peer-chat',
        workspace_id: this.workspaceId,
      },
    };
  }

  async context_answer(item: BenchItem, budgets: BudgetConfig): Promise<ContextAnswer> {
    if (!this.client) throw new Error('Honcho client not initialized');
    const peer = this.peers.get(item.targetPeerId) ?? this.peers.values().next().value;
    if (!peer) throw new Error(`Honcho target peer not found: ${item.targetPeerId}`);

    const [representation, messages] = await Promise.all([
      peer.representation({
        searchQuery: item.question,
        searchTopK: budgets.topK,
        maxConclusions: Math.max(8, budgets.topK * 4),
      }).catch(() => ''),
      this.client.search(item.question, { limit: budgets.topK }).catch(() => []),
    ]);

    const blocks: string[] = [];
    if (representation.trim()) {
      blocks.push(`<peer_representation target="${item.targetPeerId}">\n${representation.trim()}\n</peer_representation>`);
    }
    const retrievedIds: string[] = [];
    for (const message of messages) {
      retrievedIds.push(`${message.sessionId}:${message.id}`);
      const label = this.sessionLabels.get(message.sessionId) ?? message.sessionId;
      blocks.push(
        `<message session_id="${escapeAttr(label)}" peer_id="${escapeAttr(message.peerId)}" created_at="${escapeAttr(message.createdAt)}">\n` +
        `${message.content}\n` +
        `</message>`,
      );
    }
    const context = trimToTokenBudget(blocks.join('\n\n'), budgets.contextTokenBudget);
    return {
      context,
      contextTokens: countTokens(context),
      retrievedIds,
      metadata: {
        workspace_id: this.workspaceId,
        base_url: this.opts.baseURL,
        representation_tokens: countTokens(representation),
        message_count: messages.length,
        skip_dream: this.opts.skipDream,
      },
    };
  }

  async cleanup(): Promise<void> {
    if (this.client && this.opts.cleanupWorkspace && this.workspaceId) {
      await this.client.deleteWorkspace(this.workspaceId).catch(() => undefined);
    }
    this.peers.clear();
    this.sessions.clear();
  }

  private async waitForQueue(): Promise<void> {
    if (!this.client) throw new Error('Honcho client not initialized');
    const start = Date.now();
    let delay = 250;
    while (true) {
      try {
        const status = await this.client.queueStatus();
        if (status.pendingWorkUnits === 0 && status.inProgressWorkUnits === 0) return;
      } catch {
        // The server may still be starting. Keep polling until the same timeout.
      }
      if (Date.now() - start > this.opts.timeoutSeconds * 1000) {
        throw new Error(`Honcho queue timeout after ${this.opts.timeoutSeconds}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(Math.round(delay * 1.5), 2000);
    }
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
