export type DatasetName = 'longmemeval-s' | 'locomo';
export type BackendName = 'gbrain' | 'honcho';

export interface MemoryPeer {
  id: string;
  label?: string;
}

export interface MemoryMessage {
  peerId: string;
  role?: 'user' | 'assistant' | 'speaker';
  content: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySession {
  id: string;
  label?: string;
  date?: string;
  messages: MemoryMessage[];
}

export interface BenchItem {
  dataset: DatasetName;
  id: string;
  questionId: string;
  questionType: string;
  question: string;
  answer: string;
  targetPeerId: string;
  assistantPeerId: string;
  peers: MemoryPeer[];
  sessions: MemorySession[];
  evidenceContext?: string;
  answerSessionIds?: string[];
  sourceMeta: Record<string, unknown>;
}

export interface BudgetConfig {
  topK: number;
  contextTokenBudget: number;
  answerMaxTokens: number;
}

export interface AdapterRunContext {
  runId: string;
  dataset: DatasetName;
  backend: BackendName;
  itemIndex: number;
}

export interface ContextAnswer {
  context: string;
  contextTokens: number;
  retrievedIds: string[];
  metadata: Record<string, unknown>;
}

export interface DirectAnswer {
  answer: string;
  context?: string;
  contextTokens?: number;
  retrievedIds?: string[];
  metadata: Record<string, unknown>;
}

export interface MemoryAdapter {
  readonly name: BackendName;
  reset(item: BenchItem, ctx: AdapterRunContext): Promise<void>;
  upsert_peer(peer: MemoryPeer): Promise<void>;
  create_session(session: MemorySession): Promise<void>;
  add_messages(sessionId: string, messages: MemoryMessage[]): Promise<void>;
  await_index(): Promise<void>;
  consolidate(item: BenchItem): Promise<void>;
  answer?(item: BenchItem, budgets: BudgetConfig): Promise<DirectAnswer>;
  context_answer(item: BenchItem, budgets: BudgetConfig): Promise<ContextAnswer>;
  cleanup(): Promise<void>;
  teardown?(): Promise<void>;
}

export interface JudgeResult {
  passed: boolean;
  score: number;
  reasoning: string;
  raw: string;
}

export interface ResultRow {
  schema_version: 1;
  run_id: string;
  backend: BackendName;
  dataset: DatasetName;
  dataset_item_id: string;
  question_id: string;
  question_type: string;
  question: string;
  expected_answer: string;
  actual_answer: string;
  qa_accuracy: number;
  qa_passed: boolean;
  f1: number;
  context_tokens: number;
  median_context_tokens_basis: 'per-answer-context';
  retrieved_ids: string[];
  budgets: {
    top_k: number;
    context_token_budget: number;
    answer_max_tokens: number;
  };
  methodology: {
    answer_mode: 'shared-context-reader' | 'backend-direct';
    answer_model: string;
    judge_model: string;
    judge_prompt_id: string;
    answer_prompt_id: string;
    run_date: string;
    question_order_seed: number;
  };
  timings_ms: {
    ingest: number;
    await_index: number;
    consolidate: number;
    answer: number;
    judge: number;
    total: number;
  };
  adapter_metadata: Record<string, unknown>;
  error: string | null;
}
