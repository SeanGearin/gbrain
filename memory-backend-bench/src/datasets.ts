import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchItem, DatasetName, MemoryMessage, MemorySession } from './types.ts';
import { safeId } from './id.ts';

interface LongMemTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface LongMemSessionObject {
  session_id?: string;
  turns?: LongMemTurn[];
}

interface LongMemQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date?: string;
  haystack_sessions: LongMemSessionObject[] | LongMemTurn[][];
  haystack_session_ids?: string[];
  haystack_dates?: string[];
  answer_session_ids?: string[];
}

function readJsonOrJsonl(path: string): unknown[] {
  if (!existsSync(path)) throw new Error(`Dataset not found: ${path}`);
  const raw = readFileSync(path, 'utf8');
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`Dataset is not a JSON array: ${path}`);
    return parsed;
  }
  return raw.split('\n').filter(Boolean).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`Invalid JSONL at ${path}:${i + 1}: ${String(err)}`);
    }
  });
}

function parseLongMemDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})(?: \([^)]+\))? (\d{2}):(\d{2})$/);
  if (!match) return raw;
  const [, y, m, d, hh, mm] = match;
  return `${y}-${m}-${d}T${hh}:${mm}:00Z`;
}

function normalizeLongMemSessions(q: LongMemQuestion): Array<{ id: string; date?: string; turns: LongMemTurn[] }> {
  const ids = q.haystack_session_ids ?? [];
  const dates = q.haystack_dates ?? [];
  const sessions: Array<{ id: string; date?: string; turns: LongMemTurn[] }> = [];
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const raw = q.haystack_sessions[i] as LongMemSessionObject | LongMemTurn[];
    if (Array.isArray(raw)) {
      sessions.push({
        id: ids[i] ?? `lme-${q.question_id}-${i}`,
        date: parseLongMemDate(dates[i]),
        turns: raw,
      });
    } else if (raw && Array.isArray(raw.turns)) {
      sessions.push({
        id: raw.session_id ?? ids[i] ?? `lme-${q.question_id}-${i}`,
        date: parseLongMemDate(dates[i]),
        turns: raw.turns,
      });
    }
  }
  return sessions;
}

export function loadLongMemEvalS(path: string): BenchItem[] {
  return readJsonOrJsonl(path).map((raw, index) => {
    const q = raw as LongMemQuestion;
    const targetPeerId = q.question_type === 'single-session-assistant' ? 'assistant' : 'user';
    const sessions: MemorySession[] = normalizeLongMemSessions(q).map((s, sessionIndex) => ({
      id: safeId(s.id, `lme-${index}-${sessionIndex}`),
      label: s.id,
      date: s.date,
      messages: s.turns
        .filter((turn) => turn.content && turn.content.trim().length > 0)
        .map((turn): MemoryMessage => ({
          peerId: turn.role,
          role: turn.role,
          content: turn.content,
          createdAt: s.date,
          metadata: { original_session_id: s.id },
        })),
    }));
    const question = q.question_date ? `[${q.question_date}] ${q.question}` : q.question;
    return {
      dataset: 'longmemeval-s',
      id: q.question_id,
      questionId: q.question_id,
      questionType: q.question_type,
      question,
      answer: q.answer,
      targetPeerId,
      assistantPeerId: 'assistant',
      peers: [
        { id: 'user', label: 'user' },
        { id: 'assistant', label: 'assistant' },
      ],
      sessions,
      answerSessionIds: q.answer_session_ids ?? [],
      sourceMeta: {
        split: 'S',
        answer_session_ids: q.answer_session_ids ?? [],
      },
    };
  });
}

interface LocomoMessage {
  speaker?: string;
  text?: string;
  dia_id?: string;
  img_url?: string | string[];
  blip_caption?: string;
  query?: string;
}

interface LocomoQa {
  question?: string;
  answer?: string;
  category?: number;
  evidence?: string[];
}

interface LocomoConversation {
  sample_id?: string;
  conversation: Record<string, unknown>;
  qa?: LocomoQa[];
}

const LOCOMO_CATEGORY_NAMES: Record<number, string> = {
  1: 'single_hop',
  2: 'multi_hop',
  3: 'temporal',
  4: 'commonsense',
  5: 'adversarial',
};

function parseLocomoDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(' on ', ' ');
  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function locomoSessions(conversation: Record<string, unknown>, peerMap: Map<string, string>): MemorySession[] {
  const keys = Object.keys(conversation)
    .filter((key) => /^session_\d+$/.test(key))
    .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
  return keys.map((key) => {
    const num = key.split('_')[1];
    const date = parseLocomoDate(String(conversation[`session_${num}_date_time`] ?? ''));
    const messages = (conversation[key] as LocomoMessage[] | undefined) ?? [];
    return {
      id: safeId(key),
      label: key,
      date,
      messages: messages.flatMap((msg): MemoryMessage[] => {
        const speaker = String(msg.speaker ?? '');
        const peerId = peerMap.get(speaker) ?? safeId(speaker, 'speaker');
        const caption = msg.blip_caption ? `\n\n[Image shared: ${msg.blip_caption}]` : '';
        const content = `${msg.text ?? ''}${caption}`.trim();
        if (!content) return [];
        return [{
          peerId,
          role: 'speaker',
          content,
          createdAt: date,
          metadata: {
            speaker,
            dia_id: msg.dia_id ?? '',
            img_url: msg.img_url ?? null,
            blip_caption: msg.blip_caption ?? null,
            image_query: msg.query ?? null,
          },
        }];
      }),
    };
  });
}

function evidenceContext(conversation: Record<string, unknown>, evidenceIds: string[] | undefined): string | undefined {
  if (!evidenceIds || evidenceIds.length === 0) return undefined;
  const sessions = Object.keys(conversation)
    .filter((key) => /^session_\d+$/.test(key))
    .flatMap((key) => ((conversation[key] as LocomoMessage[] | undefined) ?? []));
  const byId = new Map<string, LocomoMessage>();
  for (const msg of sessions) {
    if (msg.dia_id) byId.set(msg.dia_id, msg);
  }
  const lines = evidenceIds.flatMap((id) => {
    const msg = byId.get(id);
    if (!msg) return [];
    const caption = msg.blip_caption ? ` [Image: ${msg.blip_caption}]` : '';
    return [`[${id}] ${msg.speaker ?? 'speaker'}: ${(msg.text ?? '').trim()}${caption}`];
  });
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function targetSpeaker(question: string, speakerA: string, speakerB: string): string {
  const q = question.toLowerCase();
  const a = speakerA.toLowerCase();
  const b = speakerB.toLowerCase();
  const aHit = q.includes(a) || q.includes(`${a}'s`);
  const bHit = q.includes(b) || q.includes(`${b}'s`);
  if (aHit && !bHit) return speakerA;
  if (bHit && !aHit) return speakerB;
  return speakerA;
}

export function loadLoCoMo(path: string): BenchItem[] {
  const rows = readJsonOrJsonl(path) as LocomoConversation[];
  const out: BenchItem[] = [];
  for (const sample of rows) {
    const conversation = sample.conversation ?? {};
    const sampleId = String(sample.sample_id ?? `locomo-${out.length}`);
    const speakerA = String(conversation.speaker_a ?? 'speaker_a');
    const speakerB = String(conversation.speaker_b ?? 'speaker_b');
    const peerMap = new Map([
      [speakerA, safeId(speakerA, 'speaker-a')],
      [speakerB, safeId(speakerB, 'speaker-b')],
    ]);
    const sessions = locomoSessions(conversation, peerMap);
    for (const [qaIndex, qa] of (sample.qa ?? []).entries()) {
      const question = String(qa.question ?? '');
      const answer = String(qa.answer ?? '');
      if (!question || !answer) continue;
      const category = Number(qa.category ?? 0);
      const target = targetSpeaker(question, speakerA, speakerB);
      out.push({
        dataset: 'locomo',
        id: `${sampleId}:q${qaIndex + 1}`,
        questionId: `${sampleId}:q${qaIndex + 1}`,
        questionType: LOCOMO_CATEGORY_NAMES[category] ?? `category_${category}`,
        question,
        answer,
        targetPeerId: peerMap.get(target) ?? safeId(target),
        assistantPeerId: peerMap.get(speakerB) ?? safeId(speakerB, 'speaker-b'),
        peers: [
          { id: peerMap.get(speakerA)!, label: speakerA },
          { id: peerMap.get(speakerB)!, label: speakerB },
        ],
        sessions,
        evidenceContext: evidenceContext(conversation, qa.evidence),
        sourceMeta: {
          sample_id: sampleId,
          category,
          category_name: LOCOMO_CATEGORY_NAMES[category] ?? `category_${category}`,
          evidence: qa.evidence ?? [],
          speaker_a: speakerA,
          speaker_b: speakerB,
          target_speaker: target,
        },
      });
    }
  }
  return out;
}

export function loadDataset(dataset: DatasetName, dataDir: string): BenchItem[] {
  if (dataset === 'longmemeval-s') {
    return loadLongMemEvalS(join(dataDir, 'longmemeval', 'longmemeval_s.json'));
  }
  return loadLoCoMo(join(dataDir, 'locomo', 'locomo10.json'));
}

export function allDatasetNames(): DatasetName[] {
  return ['longmemeval-s', 'locomo'];
}
