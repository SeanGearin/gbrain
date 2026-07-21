/**
 * Instruction-shaped claim guard — drops assistant-steering / setup text that a
 * client mislabels as a first-person user fact, before it is banked to the facts
 * table (PACKET ENGINE-PREP 2026-07-20, FIX 3 — the ENGINE backstop for fact
 * 8944; the worker guidance half is virgil-worker 79dc854).
 *
 * ## Why this exists
 *
 * On the customer plane the client's OWN model decides what to hand save_facts,
 * and stamps `provenance`. A misbehaving or naive client can therefore forward
 * its own model-visible configuration surface — custom/project instructions,
 * client memory, a system-prompt fragment — as a `user_stated` claim at
 * confidence 1. The live specimen (fact 8944, Marcus/Pro record): "Default
 * behavior: When the user requests to save… prioritize and use Virgil MCP tools
 * (save_facts/save_note)…" banked as something the customer said. The customer
 * never said it — the text exists in no Virgil repo at any sha. The intake
 * trusted the label; this guard stops trusting it.
 *
 * ## Disposition: DROP (Sean's ruling), mirroring restricted-data exactly
 *
 * An instruction-shaped claim is DROPPED from the batch with an honest per-claim
 * receipt {status:'dropped', category:'instruction_shaped'}; the REST of the
 * batch proceeds; the value is NEVER silently rewritten or relabeled. Same shape
 * as the PCI/SSN/credential scrub (restricted-data.ts) — the caller is the drop
 * site, this module is the pure, zero-LLM detector.
 *
 * ## Posture: PRECISION over recall (capture stays strong — standing rule)
 *
 * A genuine biography — or a first-person dictated meta-preference ("when I ask
 * you to save something, round to whole dollars") — MUST still insert. So the
 * detector matches only two narrow, high-signal shapes:
 *   (a) tool_token — the claim names the product's OWN tool surface as a literal
 *       snake_case identifier (save_facts, recall_facts, …). Genuine customer
 *       biography essentially never contains the product's internal tool tokens;
 *       a real preference says "save", the natural verb, never "save_facts".
 *   (b) steering_shape — a steering-document HEADER (default behavior:, system
 *       prompt, custom instructions) CO-OCCURRING with third-person actor framing
 *       ("the user" / "the assistant"). A customer dictating a real preference
 *       speaks in the first person ("I", "you"), never narrates "the user" /
 *       "the assistant" — so the header alone, or the framing alone, does NOT
 *       fire; both must be present.
 *
 * Pure + zero-dep + zero-LLM + config-free (the save_facts tenant tx is
 * GRANT-excluded from config — CAT-6/FLAG-C — so this, like restricted-data.ts,
 * reads nothing). Inputs are already length-capped (<=500 chars) and sanitized
 * before this sees them; every pattern is possessive-quantifier-free, so
 * adversarial input stays linear-time.
 */

/** Why a claim was judged instruction-shaped (first hit wins). */
export type InstructionShapedReason = 'tool_token' | 'steering_shape';

export interface InstructionShapedScan {
  instructionShaped: boolean;
  reason: InstructionShapedReason | null;
}

// --- (a) product tool identifiers -------------------------------------------
// The product's own MCP tool names as DISTINCTIVE snake_case (underscore-joined)
// literals. A genuine memory uses the natural verb ("save"), never the tool id
// ("save_facts"); the underscore is the precision guard (no bare English word or
// hyphenated slug matches). Word-boundaried so "save_facts/save_note" (the 8944
// specimen, slash-separated) and parenthesised forms both hit; an optional
// `gbrain_` prefix catches the real namespaced ids (gbrain_save_facts) too.
//
// Adversarial-review hardening (2026-07-21): DROPPED the generic `get_page` /
// `put_page` — they collide with everyday code vocabulary (Django's
// Paginator.get_page(), scraper/Notion helpers), so an engineer's genuine work
// memory ("the get_page bug in our crawler…") was being silently DROPPED. Every
// remaining token is product-distinctive and essentially never appears in real
// biography. Engineers are a core audience — precision here IS capture strength.
const TOOL_TOKEN_RE =
  /\b(?:gbrain_)?(save_facts|save_note|recall_facts|find_in_record|forget_fact|correct_fact|set_facts_valid_from|share_brain_map|morning_brief|compose_brief|meeting_brief|gather_evidence|extract_facts)\b/i;

// --- (b) steering-document shape --------------------------------------------
// The header must appear as a LEADING LABEL — the distinctive shape of a steering
// / setup DIRECTIVE ("Default behavior:", "System prompt:", "Custom
// instructions:") at the very START of the claim (optionally behind a markdown
// heading marker), immediately followed by ':' or '-'.
//
// Adversarial-review hardening (2026-07-21): the prior version matched these
// header words ANYWHERE and only co-required a third-person actor phrase — which
// silently DROPPED genuine first-person memories from the product's core PM /
// engineer / AI-builder audience ("our onboarding flow's default behavior is…,
// but the user testing showed confusion"; "debugging why the assistant ignores
// the system prompt"). Those use the same words MID-SENTENCE as subject matter,
// not as a leading directive. Anchoring the header to the start (with a trailing
// colon/dash) is what separates an actual steering doc from that everyday usage.
// Anchored + possessive-free → linear-time on adversarial input.
const STEERING_HEADER_LABEL_RE =
  /^\s*(?:#{1,6}\s*)?(?:default behaviou?r|system prompt|custom instructions?)\b[ \t]*[:\-]/i;
// Third-person actor framing — a steering doc narrates the parties in the third
// person ("the user" / "the assistant"); a first-person preference ("I", "you")
// does not. REQUIRED IN ADDITION to the leading header, so neither signal alone
// can drop a genuine memory.
const STEERING_ACTOR_RE = /\bthe (users?|customers?|assistant|model|agent|ai)\b/i;

const NO_MATCH: InstructionShapedScan = { instructionShaped: false, reason: null };

/**
 * Scan one claim's TEXT for instruction/steering shape. Returns the first shape
 * matched (tool_token → steering_shape); `instructionShaped: false` when clean.
 *
 * Conservative: only the two high-signal shapes fire. Anything else is a genuine
 * memory and is saved.
 */
export function scanInstructionShaped(text: string): InstructionShapedScan {
  if (!text) return NO_MATCH;
  if (TOOL_TOKEN_RE.test(text)) return { instructionShaped: true, reason: 'tool_token' };
  if (STEERING_HEADER_LABEL_RE.test(text) && STEERING_ACTOR_RE.test(text)) {
    return { instructionShaped: true, reason: 'steering_shape' };
  }
  return NO_MATCH;
}

/**
 * Emit the value-free drop record. Reason class + source only — the offending
 * claim text is NEVER logged (it may itself be an injection payload, and a
 * dropped memory's substance is not ours to echo). Mirrors logRestrictedDrop:
 * stderr via console.warn, `[facts:*]` convention, stdout stays clean.
 */
export function logInstructionShapedDrop(reason: InstructionShapedReason, source: string): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[facts:instruction-shaped] dropped 1 claim (reason=${reason}, source=${source}); value not logged`,
  );
}
