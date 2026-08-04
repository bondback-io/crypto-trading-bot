/**
 * Sparse Zion commentary on Agent Decision Log events — separate from fight lane.
 * Logging only; never mutates coaching or trades.
 */

import { config } from './config';
import type { AgentDecisionEntry } from './agentDecisionLog';

let eventsSinceComment = 0;
let lastCommentAt = 0;
const MIN_EVENTS = 8;
const MIN_MS = 12 * 60 * 1000;

const LINES: Array<(e: AgentDecisionEntry) => string> = [
  (e) =>
    `Steady, team. ${e.agent} made the patient call there — ${e.target} can wait its turn.`,
  (e) =>
    `Nice touch from ${e.agent}. Soft influence, hard boundaries — that's the stack working.`,
  (e) =>
    `${e.agent} logged a ${e.decisionType.replace('_', ' ')}. Dad, the coaches are talking; we're listening.`,
  (e) =>
    `Optimistic note: ${e.target} got a nudge without anyone breaking the safety fence.`,
  (e) =>
    `Psalm 27:14 energy — wait on the Lord, and wait on Hybrid until readiness says go.`,
  (e) =>
    `MARL and friends hashing it out. I'll keep the popcorn; you keep the risk gates.`,
  (e) =>
    `Comment only: ${e.summary.slice(0, 120)}${e.summary.length > 120 ? '…' : ''}`,
  (e) =>
    `Light humor: if bots had coffee breaks, this is where they'd nod at ${e.agent}.`,
];

function pickLine(e: AgentDecisionEntry): string {
  const fn = LINES[Math.floor(Math.random() * LINES.length)] || LINES[0]!;
  return fn(e).slice(0, 280);
}

function commentsEnabled(): boolean {
  if (config.zionAgent?.personalityEnabled === false) return false;
  // Prefer dedicated flag when present; default ON when personality ON
  const flag = (config.zionAgent as { agentDecisionCommentsEnabled?: boolean } | undefined)
    ?.agentDecisionCommentsEnabled;
  if (flag === false) return false;
  return true;
}

function shouldComment(entry: AgentDecisionEntry): boolean {
  if (!commentsEnabled()) return false;
  if (entry.source === 'zion') return false;
  // Prefer mode changes, recommendations, ranks over pure observation spam
  const interesting =
    entry.decisionType === 'mode_change' ||
    entry.decisionType === 'recommendation' ||
    entry.decisionType === 'rank' ||
    entry.decisionType === 'soft_push' ||
    entry.decisionType === 'warning' ||
    entry.applied === 'applied';
  if (!interesting) {
    eventsSinceComment += 0.25;
  } else {
    eventsSinceComment += 1;
  }
  const now = Date.now();
  if (eventsSinceComment < MIN_EVENTS) return false;
  if (now - lastCommentAt < MIN_MS) return false;
  if (Math.random() > 0.32) return false;
  eventsSinceComment = 0;
  lastCommentAt = now;
  return true;
}

export function maybeZionAgentDecisionComment(entry: AgentDecisionEntry): void {
  try {
    if (!shouldComment(entry)) return;
    const { recordAgentDecision } =
      require('./agentDecisionLog') as typeof import('./agentDecisionLog');
    recordAgentDecision({
      agent: 'Zion',
      source: 'zion',
      decisionType: 'comment',
      profileId: entry.profileId,
      target: entry.target || 'Agent team',
      summary: pickLine(entry),
      detail: `Re: ${entry.agent} · ${entry.decisionType}`,
      applied: 'observation_only',
      mint: entry.mint,
      symbol: entry.symbol,
      dedupeKey: undefined,
    });
  } catch {
    /* fail-open */
  }
}
