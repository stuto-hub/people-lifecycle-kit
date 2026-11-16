/** Chat answers from Claude, grounded only in the guides and Q&A kept in Notion. */
import Core from './core.js';
import { CONFIG, env, todayIso } from './config.js';

export const SYSTEM_PROMPT = [
  'You are People Ops Bot, the Slack assistant for a fully remote, mostly async company of about 150 people in 30+ countries.',
  'Most people are contractors paid globally. You answer questions about policies, guides, forms, joining and leaving.',
  'Rules:',
  '- Answer ONLY from the KNOWLEDGE below. Never invent policy details, amounts, dates, eligibility or deadlines. If it is not covered, say so plainly and say People Ops has been told.',
  '- Point to the right guide with its link as <url|Guide name> and name the owner team.',
  '- If a guide is marked "review due" or "never reviewed", say it may be out of date and to confirm with the owner.',
  '- Pay, invoices, health, legal, performance and leaving are confidential: keep it general, point to the owner, suggest a private DM, and never ask for personal details in Slack.',
  '- You cannot see anyone\'s personal records and must not guess about other people.',
  '- You inform; humans decide. Never promise approvals, pay or outcomes.',
  '- Style: friendly, plain English, Slack formatting (*bold*, bullets), at most 6 short lines.'
].join('\n');

/** Turns the Notion knowledge into the context block Claude answers from. */
export function knowledgeBlock(kb, r, today = todayIso()) {
  const guides = kb.guides.map(g => {
    const age = g.last_updated ? Core.diffDays(today, g.last_updated) : null;
    const status = age === null ? 'never reviewed' : age > CONFIG.STALE_DAYS ? 'review due (last reviewed ' + Math.round(age / 30) + ' months ago)' : 'current';
    return '- ' + g.title + ' | owner: ' + g.owner_role + ' | ' + status + ' | link: ' + g.link;
  }).join('\n');
  const qa = kb.intents.map(i => '- Topic keywords: ' + i.keywords.replace(/\|/g, ', ') + ' | guide: ' + (i.guide_id || 'none yet') +
    ' | answer: ' + i.answer + (i.sensitive === 'Y' ? ' | confidential' : '')).join('\n');
  const hint = r.matched === 'GAP' ? 'Best rule-based match: none (this is a gap).' : 'Best rule-based match: ' + r.text.replace(/\n/g, ' ');
  return 'KNOWLEDGE\nGuides:\n' + guides + '\nKnown questions:\n' + qa + '\n\n' + hint;
}

/** Earlier turns + the new question, merged so roles alternate and the first one is the user's. */
export function toMessages(past, question) {
  const msgs = [];
  for (const m of [...past, { role: 'user', content: question }]) {
    if (!m.content) continue;
    if (msgs.length && msgs[msgs.length - 1].role === m.role) msgs[msgs.length - 1].content += '\n' + m.content;
    else msgs.push({ role: m.role, content: m.content });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

export async function askClaude(question, kb, r, past = []) {
  const key = env('ANTHROPIC_API_KEY');
  if (!key) return r.text;                       // no Claude key yet: rule-based answer
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CONFIG.CLAUDE_MODEL, max_tokens: 500,
      system: SYSTEM_PROMPT + '\n\n' + knowledgeBlock(kb, r),
      messages: toMessages(past, question)
    })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Claude API: ' + ((j.error && j.error.message) || res.status));
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || r.text;
}
