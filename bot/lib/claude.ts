/** Chat answers from Claude, grounded only in the guides and Q&A kept in the tracker. */
import { diffDays } from './core.js';
import type { GuideRef, Intent, Match } from './core.js';
import { CONFIG, env, todayIso } from './config.js';
import { TRACKER_RULES } from './tracker-context.js';

export const SYSTEM_PROMPT = [
  'You are People Ops Bot, the Slack assistant for a fully remote, mostly async company of about 150 people in 30+ countries.',
  'Most people are contractors paid globally. You answer questions about policies, guides, forms, joining and leaving.',
  'Rules:',
  '- Answer ONLY from the KNOWLEDGE below. Never invent policy details, amounts, dates, eligibility or deadlines. If it is not covered, say so plainly and say People Ops has been told.',
  '- Point to the right guide with its link as <url|Guide name> and name the owner team.',
  '- When there is no guide for a question, say so; only point to another guide if it actually contains the answer (never imply it does).',
  '- If a guide is marked "review due" or "never reviewed", say it may be out of date and to confirm with the owner.',
  '- Pay, invoices, health, legal, performance and leaving are confidential: keep it general, point to the owner, suggest a private DM, and never ask for personal details in Slack.',
  '- You can see the joining/leaving tracker (TRACKER block, when present) but no other personal records; never guess about people.',
  '- You inform; humans decide. Never promise approvals, pay or outcomes.',
  '- Only mention follow-up actions listed under ACTIONS TAKEN. Never say someone was told or something was logged unless it is listed there.',
  '- Style: friendly, plain English, Slack formatting (*bold*, bullets), at most 6 short lines unless the tracker rules allow more.'
].join('\n');

export interface Knowledge { guides: GuideRef[]; intents: Intent[]; handbook?: string }
export interface Turn { role: 'user' | 'assistant'; content: string }

/** Turns the tracker's guides and questions into the context block Claude answers from. */
export function knowledgeBlock(kb: Knowledge, r: Match, today = todayIso()): string {
  const guides = kb.guides.map(g => {
    const age = g.last_updated ? diffDays(today, g.last_updated) : null;
    const status = age === null ? 'never reviewed' : age > CONFIG.STALE_DAYS ? 'review due (last reviewed ' + Math.round(age / 30) + ' months ago)' : 'current';
    return '- ' + g.title + ' | owner: ' + g.owner_role + ' | ' + status + ' | link: ' + g.link;
  }).join('\n');
  const qa = kb.intents.map(i => '- Topic keywords: ' + i.keywords.replace(/\|/g, ', ') + ' | guide: ' + (i.guide_id || 'none yet') +
    ' | answer: ' + i.answer + (i.sensitive === 'Y' ? ' | confidential' : '')).join('\n');
  const hint = r.matched === 'GAP' ? 'Best rule-based match: none (this is a gap).' : 'Best rule-based match: ' + r.text.replace(/\n/g, ' ');
  const handbook = kb.handbook ? '\nHandbook (the policy details; quote from here):\n' + kb.handbook.slice(0, 12000) + '\n' : '';
  return 'KNOWLEDGE\nGuides:\n' + guides + '\nKnown questions:\n' + qa + '\n' + handbook + '\n' + hint + '\n\nACTIONS TAKEN (for this message, just now)\n' + actionsTaken(r);
}

/** What the bot actually does after answering, so Claude describes it truthfully. */
export function actionsTaken(r: Match): string {
  if (r.matched === 'FOLLOW_UP') return '- none (follow-up question; nobody was notified)';
  if (r.action === 'notify_leaver') return '- People Ops was alerted privately to confirm the last day. No record was changed.';
  if (r.action === 'route_finance') return '- The question was sent to Finance. It was NOT logged as a gap.';
  if (r.action === 'route_people_ops' || r.matched === 'GAP') return '- The question was logged for People Ops as a missing guide.';
  return '- none (nobody was notified)';
}

/** Earlier turns + the new question, merged so roles alternate and the first one is the user's. */
export function toMessages(past: Turn[], question: string): Turn[] {
  const msgs: Turn[] = [];
  for (const m of [...past, { role: 'user' as const, content: question }]) {
    if (!m.content) continue;
    if (msgs.length && msgs[msgs.length - 1].role === m.role) msgs[msgs.length - 1].content += '\n' + m.content;
    else msgs.push({ role: m.role, content: m.content });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

export async function askClaude(question: string, kb: Knowledge, r: Match, past: Turn[] = [], tracker = ''): Promise<string> {
  const key = env('ANTHROPIC_API_KEY');
  if (!key) return r.text;                       // no Claude key: rule-based answer
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: CONFIG.CLAUDE_MODEL, max_tokens: 2048,
      system: SYSTEM_PROMPT + (tracker ? '\n' + TRACKER_RULES : '') + '\n\n' + knowledgeBlock(kb, r) + (tracker ? '\n\n' + tracker : ''), messages: toMessages(past, question) })
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Claude API: ' + ((j.error && j.error.message) || res.status));
  return (j.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim() || r.text;
}
