/**
 * Everything Slack sends to the bot:
 *   - DMs and @mentions  -> Claude answers from the guides in the tracker
 *   - /people            -> fast rule-based answer, private to the asker
 *   - "Mark done" button -> "Done" written into the tracker (a commit) and the message updated
 * Anything that would change a record (e.g. "my last day is Friday") only alerts People Ops: a human confirms.
 */
import { matchQuestion } from './core.js';
import type { GuideRef, Intent, Match } from './core.js';
import { CONFIG, env, todayIso } from './config.js';
import { load, setCell, sheetLink, buildTasks, people as peopleOf } from './store.js';
import { owner } from './lifecycle.js';
import { pretty, diffDays } from './core.js';
import type { Person } from './types.js';
import { send, postMessage, respond, slackApi, slackGet } from './slack.js';
import { askClaude } from './claude.js';
import type { Knowledge, Turn } from './claude.js';

// ---------------- knowledge from the tracker ----------------
const ACT: Record<string, string> = {
  'Answer + show personal checklist': 'my_checklist',
  'Answer + start leaver request (People Ops confirms)': 'notify_leaver',
  'Route to Finance (no guide yet)': 'route_finance',
  'Route to People Ops + log gap': 'route_people_ops'
};

export async function knowledge(): Promise<Knowledge> {
  const d = await load();
  const guides: GuideRef[] = d.guides.map(x => ({ guide_id: x.Guide, title: x.Guide, owner_role: x.Owner, last_updated: x['Last reviewed'], link: x.Link }));
  const intents: Intent[] = d.questions.map((x, i) => ({ intent_id: 'Q' + (i + 1), keywords: String(x.Keywords || '').split(',').map(k => k.trim()).join('|'),
    guide_id: x.Guide || '', answer: x.Answer, action: ACT[x.Action] || '', sensitive: x.Confidential ? 'Y' : 'N' }));
  return { guides, intents, handbook: d.handbook };
}

const match = (text: string, kb: Knowledge) => matchQuestion(text, kb.intents, kb.guides, todayIso(), CONFIG.STALE_DAYS);

// ---------------- side effects shared by /people and chat ----------------
export async function routeActions(r: Match, user: string, text: string, via: string) {
  if (r.action === 'notify_leaver')
    await send({ to: CONFIG.CHANNEL, kind: 'request', text: '📨 <@' + user + '> asked about their last day via ' + via +
      '. Nothing has been changed. Reach out privately, confirm dates, then add them to the Leavers tracker.' });
  if (r.action === 'route_finance')
    await send({ to: CONFIG.ROLES.Finance, kind: 'question', text: '❓ Question from <@' + user + '> via ' + via + ': "' + text + '" (no guide yet).' });
  if (r.action === 'route_people_ops' || r.matched === 'GAP')
    await send({ to: CONFIG.CHANNEL, kind: 'question', text: '❓ Unanswered question from <@' + user + '> via ' + via + ': "' + text + '" (logged as a guide gap).' });
}

// ---------------- DMs and @mentions: Claude ----------------
export interface SlackEvent { bot_user?: string; type: string; channel: string; channel_type?: string; user: string; text: string; ts: string; thread_ts?: string; bot_id?: string; subtype?: string }
const seen = new Map<string, number>();   // event_id -> time, so a Slack retry is never answered twice

/** Returns null when the event should be ignored, otherwise the event to answer. */
export function acceptEvent(body: any): SlackEvent | null {
  if (body.type !== 'event_callback') return null;
  const ev: SlackEvent = body.event || {};
  if (ev.bot_id || ev.subtype || !ev.text) return null;                 // ignore bots (incl. itself) and edits
  if (!(ev.type === 'app_mention' || (ev.type === 'message' && ev.channel_type === 'im'))) return null;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 3600000) seen.delete(k);
  if (seen.has(body.event_id)) return null;
  seen.set(body.event_id, now);
  ev.bot_user = (body.authorizations || [])[0]?.user_id || '';
  return ev;
}

/**
 * Earlier messages in the same conversation, so follow-ups make sense ("and in Spain?").
 * Threads: the thread. DMs without a thread: messages from the last hour. Read live from Slack, nothing stored.
 */
export async function history(ev: SlackEvent): Promise<Turn[]> {
  try {
    const j = ev.thread_ts ? await slackGet('conversations.replies', { channel: ev.channel, ts: ev.thread_ts, limit: '15' })
      : ev.channel_type === 'im' ? await slackGet('conversations.history', { channel: ev.channel, latest: ev.ts, limit: '8' })
      : null;
    if (!j || !j.ok) return [];
    let msgs: any[] = (j.messages || []).filter((m: any) => m.ts !== ev.ts && m.text && !m.text.startsWith('🧠') && !m.text.startsWith('Sorry, I hit a problem'));
    if (!ev.thread_ts) msgs = msgs.filter(m => Number(m.ts) > Number(ev.ts) - 3600).reverse();   // history is newest first
    return msgs.slice(-8).map(m => ({ role: m.bot_id ? 'assistant' : 'user', content: m.text.replace(/<@[A-Z0-9]+>/g, '').trim() }));
  } catch { return []; }
}

// ---------------- tag someone = assign them a task ----------------
/** People tagged in the message, other than the bot and the sender. For an @mention the first tag is the bot. */
export function taggedPeople(ev: SlackEvent): string[] {
  const ids = [...ev.text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map(m => m[1]);
  if (ev.type === 'app_mention' && !ev.bot_user) ids.shift();
  return [...new Set(ids.filter(id => id !== ev.bot_user && id !== ev.user))];
}

/** Turns "can you please assign X's date of joining to @y" into "Assign X's date of joining". Falls back to the text itself. */
async function taskTitle(text: string): Promise<string> {
  const plain = text.replace(/<@[A-Z0-9|a-z._-]+>/g, '').replace(/\s+/g, ' ').trim();
  const key = env('ANTHROPIC_API_KEY');
  if (!key) return plain;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: CONFIG.CLAUDE_MODEL, max_tokens: 200,
        system: 'Rewrite the request as one short task title starting with a verb, under 15 words. Keep names, dates and details. Output only the title.',
        messages: [{ role: 'user', content: plain }] }) });
    const j: any = await res.json();
    const t = (j.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').trim();
    return t || plain;
  } catch { return plain; }
}

export async function assignTask(ev: SlackEvent, assignees: string[], thread_ts?: string) {
  const title = await taskTitle(ev.text);
  for (const a of assignees) {
    const value = JSON.stringify({ r: ev.user, t: title.slice(0, 300) });
    const text = '👋 <@' + a + '>, <@' + ev.user + '> asked you to: *' + title + '*';
    await postMessage({ channel: ev.channel, thread_ts, text, blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: text + '\nReply here when it is done, or use the buttons.' } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', action_id: 'task_done', value, text: { type: 'plain_text', text: 'Done ✅' } },
        { type: 'button', action_id: 'task_help', value, text: { type: 'plain_text', text: 'Need more info' } } ] } ] });
  }
}

// ---------------- "any update on X?" = tag the owners of X's open steps ----------------
const UPDATE = /\b(update|status|pending|delay|delayed|chase|follow ?up|remind|stuck|where are we|progress)\b/i;
const NOISE = new Set(['test', 'demo', 'joiner', 'leaver', 'contractor', 'employee', 'fake', 'short', 'notice', 'short-notice']);

export function findPerson(text: string, people: Person[]): Person | undefined {
  const id = (text.match(/\b([JL]-\d{3})\b/i) || [])[1];
  if (id) return people.find(p => p.id.toLowerCase() === id.toLowerCase());
  const t = text.toLowerCase();
  return people.find(p => (p.Name + ' ' + p.Country).toLowerCase().split(/[^a-z]+/).some(w => w.length > 3 && !NOISE.has(w) && new RegExp('\\b' + w + '\\b').test(t)));
}

export async function updateRequest(ev: SlackEvent, p: Person, thread_ts?: string): Promise<string> {
  const d = await load(); const today = todayIso();
  const open = buildTasks(d, today).filter(t => t.Person[0] === p.id && t.Status !== 'Done').sort((a, b) => a.Due.localeCompare(b.Due));
  const soon = open.filter(t => diffDays(t.Due, today) <= 3);
  const list = (soon.length ? soon : open.slice(0, 3));
  const head = (p.Flow === 'Joiner' ? '➡️ ' : '⬅️ ') + '*' + p.Name + '* (' + p.Flow.toLowerCase() + ', day 0 ' + pretty(p['Day 0']) + ', ' + p.Status + ')';
  if (!list.length) return head + '\nNothing open 🎉 every step is done.';
  const owners = new Set<string>();
  const lines = list.map(t => {
    const o = owner(t['Owner role'], p); owners.add(o.id);
    const late = diffDays(today, t.Due);
    const when = late > 0 ? '⏰ ' + late + ' day' + (late > 1 ? 's' : '') + ' overdue' : late === 0 ? '🔔 due today' : 'due ' + pretty(t.Due);
    return '• ' + (t.Confidential ? 'A confidential step' : '*' + t.Step + '*') + ' (' + t.Status + ', ' + when + ') → <@' + o.id + '>';
  });
  for (const t of list) {                                  // each owner also gets a DM with a Mark done button
    const o = owner(t['Owner role'], p);
    await send({ to: o.id, kind: 'nudge', taskId: t._id, url: t._url, confidential: t.Confidential,
      text: '🔔 <@' + ev.user + '> asked for an update: ' + (t.Confidential ? 'a confidential step' : '*' + t.Step + '*') + ' for *' + p.Name + '* (due ' + pretty(t.Due) + ').' });
  }
  return head + '\n' + lines.join('\n') + '\n' + [...owners].map(o => '<@' + o + '>').join(' ') +
    ' please update this thread or click *Mark done* in your DM. <' + sheetLink(p.Flow === 'Joiner' ? 'joiners.csv' : 'leavers.csv') + '|Tracker>';
}

export async function answerChat(ev: SlackEvent) {
  const question = ev.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const thread_ts = ev.type === 'app_mention' ? (ev.thread_ts || ev.ts) : ev.thread_ts;
  const tagged = taggedPeople(ev);
  if (tagged.length) return assignTask(ev, tagged, thread_ts);
  if (UPDATE.test(question)) {
    const p = findPerson(question, peopleOf(await load()));
    if (p) return postMessage({ channel: ev.channel, thread_ts, text: await updateRequest(ev, p, thread_ts) });
  }
  const via = ev.type === 'app_mention' ? 'an @mention' : 'a DM to the bot';
  const thinking = await postMessage({ channel: ev.channel, text: '🧠 Thinking…', thread_ts });
  let answer: string;
  try {
    const [kb, past] = await Promise.all([knowledge(), history(ev)]);
    const m = match(question, kb);
    // A follow-up ("and in Spain?") rarely matches on its own; with earlier context Claude answers it, so it is not a guide gap.
    const r = past.length && m.matched === 'GAP' ? { ...m, matched: 'FOLLOW_UP', action: '' } : m;
    answer = await askClaude(question, kb, r, past);
    await routeActions(r, ev.user, question, via);
  } catch (err: any) {
    console.error(err);
    answer = 'Sorry, I hit a problem answering that. People Ops has been told. You can also check the tracker: ' + sheetLink();
    await send({ to: CONFIG.CHANNEL, kind: 'error', text: '❌ Chat answer failed for <@' + ev.user + '>: ' + err.message });
  }
  if (thinking && thinking.ok) return slackApi('chat.update', { channel: ev.channel, ts: thinking.ts, text: answer });
  return postMessage({ channel: ev.channel, text: answer, thread_ts });
}

// ---------------- /people: fast and rule-based (Slack allows 3 seconds) ----------------
export async function peopleCommand(form: URLSearchParams) {
  const text = form.get('text') || '';
  const kb = await knowledge();
  const r = match(text, kb);
  return { reply: { response_type: 'ephemeral', text: r.text + '\n_Tip: DM me for a fuller answer._' },
           after: () => routeActions(r, form.get('user_id') || '', text, '/people') };
}

// ---------------- "Mark done" button ----------------
export async function buttonClick(payload: any) {
  const a = (payload.actions || [])[0];
  if (a && (a.action_id === 'task_done' || a.action_id === 'task_help')) return taskButton(payload, a);
  if (!a || a.action_id !== 'mark_done') return;
  const who = payload.user.id;
  const [personId, stepId] = String(a.value).split('::');
  let saved = false, problem = '';
  try { saved = await setCell(personId, stepId, 'Done', 'marked done in Slack by ' + who); } catch (err: any) { problem = err.message; }
  await respond(payload.response_url, { replace_original: !problem,
    text: problem ? '⚠️ Could not update the tracker (' + problem + '). Please mark it Done there: ' + sheetLink()
      : '✅ Marked done by <@' + who + '>' + (saved ? ' (tracker updated)' : ' (demo: tracker not connected)') });
}

// ---------------- task buttons (from a tag-to-assign message) ----------------
async function taskButton(payload: any, a: any) {
  const who = payload.user.id; const { r, t } = JSON.parse(a.value || '{}');
  const channel = payload.channel?.id, thread_ts = payload.message?.thread_ts || payload.message?.ts;
  if (a.action_id === 'task_done') {
    await respond(payload.response_url, { replace_original: true, text: '✅ <@' + who + '> completed: *' + t + '*' });
    return postMessage({ channel, thread_ts, text: '<@' + r + '> ✅ done by <@' + who + '>: *' + t + '*' });
  }
  return postMessage({ channel, thread_ts, text: '<@' + r + '> ❓ <@' + who + '> needs more info for: *' + t + '*. Please reply in this thread.' });
}
