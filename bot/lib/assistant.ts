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
import { load, setCell, sheetLink, buildTasks, people as peopleOf, getRow, stepIdOf, addPerson, nextId } from './store.js';
import { onTrackerChange } from './tracker-events.js';
import { sheetOn } from './sheets.js';
import { pollSheet } from './sheet-sync.js';
import { trackerBlock, isTrackerQuestion, toolsBlock } from './tracker-context.js';
import { addDays } from './core.js';
import { owner, atRisk, riskLine } from './lifecycle.js';
import { pretty, diffDays } from './core.js';
import type { Person, Step } from './types.js';
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
    // The bot's own tool results (✅ step marked, 📅 date preview, 🔔 nudge...) were real actions, not model claims: label them so the model never "corrects" them.
    const ACTION = /^\s*(✅|📅|🔔|➡️|⬅️|✖️|❌|🤔|➕|:white_check_mark:|:date:|:bell:|:arrow_right:|:arrow_left:|:heavy_multiplication_x:|:x:|:thinking_face:|:heavy_plus_sign:)/;
    return msgs.slice(-8).map(m => {
      const text = m.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      return { role: m.bot_id ? 'assistant' : 'user', content: m.bot_id && ACTION.test(text) ? '[Done by the bot\'s tracker tools, already real in the Sheet/Slack] ' + text : text };
    });
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
  const d = await load();
  const p = findPerson(ev.text, peopleOf(d));
  const step = p ? stepFor(ev.text, d.steps.filter(x => x.Flow === p.Flow)) : undefined;   // "ship the laptop for J-104" -> J04
  for (const a of assignees) {
    const value = JSON.stringify({ r: ev.user, t: title.slice(0, 300), p: p?.id || '', s: step?.id || '' });
    const text = '👋 <@' + a + '>, <@' + ev.user + '> asked you to: *' + title + '*' +
      (p && step ? '\n_Tracker step: ' + (step.Confidential ? 'a confidential step' : step.Step) + ' for ' + p.Name + '. Done marks it Done in the Sheet._' : '');
    await postMessage({ channel: ev.channel, thread_ts, text, blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: text + '\nReply here when it is done, or use the buttons.' } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', action_id: 'task_done', value, text: { type: 'plain_text', text: 'Done ✅' } },
        { type: 'button', action_id: 'task_help', value, text: { type: 'plain_text', text: 'Need more info' } } ] } ] });
  }
}

// ---------------- "any update on X?" = tag the owners of X's open steps ----------------
const NOISE = new Set(['test', 'demo', 'joiner', 'leaver', 'contractor', 'employee', 'fake', 'short', 'notice', 'short-notice']);

export function findPerson(text: string, people: Person[]): Person | undefined {
  const id = (text.match(/\b([JL]-\d{3})\b/i) || [])[1];
  if (id) return people.find(p => p.id.toLowerCase() === id.toLowerCase());
  const t = text.toLowerCase();
  const full = people.find(p => t.includes(p.Name.toLowerCase()))          // exact name first: "TEST contractor (India)"
    || people.find(p => { const short = p.Name.toLowerCase().replace(/\(.*?\)/g, '').trim(); return short.length > 4 && t.includes(short); });
  if (full) return full;
  return people.find(p => (p.Name + ' ' + p.Country).toLowerCase().split(/[^a-z]+/).some(w => w.length > 3 && !NOISE.has(w) && new RegExp('\\b' + w + '\\b').test(t)));
}

export async function updateRequest(ev: SlackEvent, p: Person, thread_ts?: string): Promise<string> {
  const d = await load(); const today = todayIso(); const inDm = ev.channel.startsWith('D');
  const mine = buildTasks(d, today).filter(t => t.Person[0] === p.id).sort((a, b) => a.Due.localeCompare(b.Due));
  const open = mine.filter(t => t.Status !== 'Done'), done = mine.filter(t => t.Status === 'Done');
  const label = (t: any) => t.Confidential && !inDm ? 'a confidential step' : '*' + t.Step + '*';
  const head = (p.Flow === 'Joiner' ? '➡️ ' : '⬅️ ') + '*' + p.Name + '* (' + p.id + ', ' + p.Flow.toLowerCase() + ', day 0 ' + pretty(p['Day 0']) + ' ' + p['Day 0'].slice(0, 4) + ', ' + (p.Status || 'Status not set in the tracker') + '): ' + done.length + ' of ' + mine.length + ' steps done';
  if (!open.length) return head + '\nEverything is done 🎉';
  const risk = atRisk([p], mine, today)[0];
  const owners = new Set<string>();
  const lines = open.map(t => {
    const o = owner(t['Owner role'], p); owners.add(o.id);
    const late = diffDays(today, t.Due);
    const when = late > 0 ? '⏰ ' + late + ' day' + (late > 1 ? 's' : '') + ' overdue' : late === 0 ? '🔔 due today' : 'due ' + pretty(t.Due);
    return '• ' + label(t) + ': ' + t.Status + ', ' + when + ' → <@' + o.id + '>';
  });
  for (const t of open.filter(t => diffDays(t.Due, today) <= 7)) {   // owners of what is due within a week also get a DM with Mark done
    const o = owner(t['Owner role'], p);
    await send({ to: o.id, kind: 'nudge', taskId: t._id, url: t._url, confidential: t.Confidential,
      text: '🔔 <@' + ev.user + '> asked for an update: ' + (t.Confidential ? 'a confidential step' : '*' + t.Step + '*') + ' for *' + p.Name + '* (due ' + pretty(t.Due) + ').' });
  }
  return (risk ? riskLine(risk) + '\n' : '') + head + '\n*Open (' + open.length + ')*\n' + lines.join('\n') +
    (done.length ? '\n*Done (' + done.length + ')*: ' + done.map(t => t.Confidential && !inDm ? 'a confidential step' : t.Step).join(', ') : '') +
    '\n' + [...owners].map(o => '<@' + o + '>').join(' ') + ' please update this thread or click *Mark done* in your DM. <' + sheetLink(p.Flow === 'Joiner' ? 'joiners.csv' : 'leavers.csv') + '|Tracker>';
}

export async function answerChat(ev: SlackEvent) {
  const question = ev.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const thread_ts = ev.type === 'app_mention' ? (ev.thread_ts || ev.ts) : ev.thread_ts;
  const tagged = taggedPeople(ev);
  console.log('route:', JSON.stringify({ q: question.slice(0, 160), tagged: tagged.length, add: ADD_PERSON.test(question), nudge: NUDGE.test(question) }));
  if (tagged.length) return assignTask(ev, tagged, thread_ts);
  if (ADD_PERSON.test(question)) return previewAdd(ev, question, thread_ts);
  if (ev.thread_ts && question.length < 120) {      // "India" / "1 Dec" in reply to "To add a new joiner I need the country"
    const h = await history(ev);
    const lastBot = [...h].reverse().find(m => m.role === 'assistant');
    const asked = h.filter(m => m.role === 'user').map(m => m.content).reverse().find(t => ADD_PERSON.test(t));
    if (asked && lastBot && /To add a new (joiner|leaver) I need/.test(lastBot.content)) return previewAdd(ev, asked + ', ' + question, thread_ts);
  }
  let dateAsk = DATE_CHANGE.test(question) ? question : '';
  if (!dateAsk && ev.thread_ts && parseDate(question, todayIso())) {      // "this is the new date 14/1/2026" in the same thread
    const earlier = (await history(ev)).filter(m => m.role === 'user').map(m => m.content).join(' ');
    if (DATE_CHANGE.test(earlier)) dateAsk = earlier + ' ' + question;
  }
  if (REASSIGN.test(question)) {                     // "I changed X's date on the tracker, re-assign and tag them"
    const p = findPerson(question, peopleOf(await load()));
    if (p && !(DATE_CHANGE.test(question) && parseDate(question, todayIso()))) return reassign(ev, p, thread_ts);
  }
  if (dateAsk) {
    const p = findPerson(dateAsk, peopleOf(await load()));
    const iso = parseDate(question, todayIso()) || parseDate(dateAsk, todayIso());
    if (p && iso) return previewDateChange(ev, p, iso, thread_ts);
    if (p || iso) return postMessage({ channel: ev.channel, thread_ts, text: '🤔 I can move a start or last day, but I need ' +
      (!p ? 'the person (name, country or ID like J-102)' : 'the new date (e.g. 4 Dec)') + '. Try: _Spain joiner start date moves to 4 Dec_' });
  }
  if (STATUS_CHANGE.test(question)) return changeStatus(ev, question, thread_ts);
  if (NUDGE.test(question)) {                         // "chase / remind / nudge the owners for X" -> tag + DM them
    const p = findPerson(question, peopleOf(await load()));
    if (p) return postMessage({ channel: ev.channel, thread_ts, text: await updateRequest(ev, p, thread_ts) });
  }
  const via = ev.type === 'app_mention' ? 'an @mention' : 'a DM to the bot';
  const thinking = await postMessage({ channel: ev.channel, text: '🧠 Thinking…', thread_ts });
  let answer: string;
  try {
    const [kb, past] = await Promise.all([knowledge(), history(ev)]);
    const m = match(question, kb);
    // Tracker questions ("what's pending for X", "have we ordered the laptop", "who owns the welcome message")
    // are answered from the live Sheet: every step with its exact status, owner and due date.
    const context = question + ' ' + past.filter(t => t.role === 'user').map(t => t.content).join(' ');
    let d = await load();
    const named = findPerson(question, peopleOf(d)) || findPerson(context, peopleOf(d));
    const trackerAsk = !!named || (isTrackerQuestion(question) && !PERSONAL.test(question)) ||
      (!!past.length && FOLLOWUP.test(question) && isTrackerQuestion(context) && !PERSONAL.test(context));
    let tracker = '';
    if (trackerAsk && canSeeTracker(ev.user)) {
      if (sheetOn() && hasRepeatedIds(d)) { await pollSheet(); d = await load(); }      // give a copied row its own ID first
      tracker = trackerBlock(d, todayIso(), ev.channel.startsWith('D'));
    }
    // A follow-up ("and in Spain?") or a tracker question is not a guide gap.
    // In a thread, a short follow-up ("and for employees in Brazil?") belongs to the earlier topic, not to whatever keyword it matches.
    const followUp = past.length && (m.matched === 'GAP' || FOLLOWUP.test(question));
    const r = tracker ? { ...m, matched: 'TRACKER', action: '' } : followUp ? { ...m, matched: 'FOLLOW_UP', action: '' } : m;
    answer = await askClaude(question, kb, r, past, tracker || toolsBlock(d));
    if (tracker) {                                   // the readiness alert is never left to the model: it always leads
      const today = todayIso(), ps = peopleOf(d), tasks = buildTasks(d, today);
      const namedNow = findPerson(question, ps);       // only the person this question is about, or everyone for a tracker-wide question
      const risks = namedNow ? atRisk([namedNow], tasks, today) : isTrackerQuestion(question) && !PERSONAL.test(question) ? atRisk(ps, tasks, today) : [];
      if (risks.length && !/Serious escalation/i.test(answer)) answer = risks.map(riskLine).join('\n') + '\n\n' + answer;
    }
    await routeActions(r, ev.user, question, via);
  } catch (err: any) {
    console.error(err);
    answer = 'Sorry, I hit a problem answering that. People Ops has been told. You can also check the tracker: ' + sheetLink();
    await send({ to: CONFIG.CHANNEL, kind: 'error', text: '❌ Chat answer failed for <@' + ev.user + '>: ' + err.message });
  }
  answer = slackSafe(answer);
  if (thinking && thinking.ok) return slackApi('chat.update', { channel: ev.channel, ts: thinking.ts, text: answer });
  return postMessage({ channel: ev.channel, text: answer, thread_ts });
}

/** A bare "<" (e.g. "< 2 days") starts a Slack link and hides the rest of the message; keep real <@user>, <#chan>, <url|text>. */
export function slackSafe(t: string): string {
  return t.split(/(<(?:[@#!]|https?:\/\/|mailto:)[^<>\n]*>)/).map((part, i) => i % 2 ? part
    : part.replace(/&(?!(amp|lt|gt);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('');
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
  if (a && (a.action_id === 'date_confirm' || a.action_id === 'date_cancel')) return dateButton(payload, a);
  if (a && (a.action_id === 'add_confirm' || a.action_id === 'add_cancel')) return addButton(payload, a);
  if (!a || a.action_id !== 'mark_done') return;
  const who = payload.user.id;
  const [personId, stepId] = String(a.value).split('::');
  let saved = false, problem = '';
  try {
    saved = await setCell(personId, stepId, 'Done', 'marked done in Slack by ' + who);
    if (saved && sheetOn()) {                    // Sheet mode: log it like a tracker edit (✅ + % complete)
      const row = await getRow(personId);
      const col = row && Object.keys(row).find(h => stepIdOf(h) === stepId);
      if (row && col) await onTrackerChange({ tab: /^L/i.test(personId) ? 'Leavers' : 'Joiners', columns: [col], oldValue: 'Pending', value: 'Done', row });
    }
  } catch (err: any) { problem = err.message; }
  await respond(payload.response_url, { replace_original: !problem,
    text: problem ? '⚠️ Could not update the tracker (' + problem + '). Please mark it Done there: ' + sheetLink()
      : '✅ Marked done by <@' + who + '>' + (saved ? ' (tracker updated)' : ' (demo: tracker not connected)') });
}

// ---------------- task buttons (from a tag-to-assign message) ----------------
async function taskButton(payload: any, a: any) {
  const who = payload.user.id; const { r, t, p, s } = JSON.parse(a.value || '{}');
  const channel = payload.channel?.id, thread_ts = payload.message?.thread_ts || payload.message?.ts;
  if (a.action_id === 'task_done') {
    let note = '';
    if (p && s) {                                         // the task is a tracker step: mark it Done in the Sheet too
      try {
        const saved = await setCell(p, s, 'Done', 'done in Slack by ' + who);
        if (saved && sheetOn()) {
          const row = await getRow(p); const col = row && Object.keys(row).find(h => stepIdOf(h) === s);
          if (row && col) await onTrackerChange({ tab: /^L/i.test(p) ? 'Leavers' : 'Joiners', columns: [col], oldValue: 'Pending', value: 'Done', row });
        }
        note = saved ? ' (tracker updated)' : ' (tracker not connected)';
      } catch (err: any) { note = ' (could not update the tracker: ' + err.message + ')'; }
    }
    await respond(payload.response_url, { replace_original: true, text: '✅ <@' + who + '> completed: *' + t + '*' + note });
    return postMessage({ channel, thread_ts, text: '<@' + r + '> ✅ done by <@' + who + '>: *' + t + '*' + note });
  }
  return postMessage({ channel, thread_ts, text: '<@' + r + '> ❓ <@' + who + '> needs more info for: *' + t + '*. Please reply in this thread.' });
}

// ---------------- "X's start date moves to 4 Dec" -> preview -> Confirm ----------------
const DATE_CHANGE = /\b(start date|joining date|date of joining|doj|day 0|last day|leaving date|last working day)\b.*\b(move|moves|moved|moving|change|changes|changed|changing|shift|shifts|shifted|postpone[sd]?|prepone[sd]?|push(ed)?|is now|now on)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * "4 Dec", "Dec 4th", "2026-12-04", "14/1/2026" -> an ISO date. Numbers are read day/month (India) unless that
 * is impossible (12/31 = 31 Dec). "from X to Y" -> Y. Without a year: the next such date from today.
 */
export function parseDate(text: string, today: string): string {
  const t = text.toLowerCase(), pad = (n: number) => String(n).padStart(2, '0');
  const found: { at: number; iso: string; yearGiven: boolean }[] = [];
  const add = (at: number, y: number | null, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    const year = y === null ? Number(today.slice(0, 4)) : y < 100 ? 2000 + y : y;
    found.push({ at, iso: year + '-' + pad(m) + '-' + pad(d), yearGiven: y !== null });
  };
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) add(m.index!, Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of t.matchAll(/\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/g)) {
    const a = Number(m[1]), b = Number(m[2]), y = m[3] ? Number(m[3]) : null;
    if (b > 12 && a <= 12) add(m.index!, y, a, b); else add(m.index!, y, b, a);       // day/month unless impossible
  }
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?\b/g))
    add(m.index!, m[3] ? Number(m[3]) : null, MONTHS.indexOf(m[2]) + 1, Number(m[1]));
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/g))
    add(m.index!, m[3] ? Number(m[3]) : null, MONTHS.indexOf(m[1]) + 1, Number(m[2]));
  if (!found.length) return '';
  const toAt = t.lastIndexOf(' to ');
  found.sort((a, b) => a.at - b.at);
  const pick = (toAt >= 0 && found.filter(f => f.at > toAt).pop()) || found[found.length - 1];
  let out = pick.iso;
  if (!pick.yearGiven && out < addDays(today, -60)) out = (Number(out.slice(0, 4)) + 1) + out.slice(4);   // "4 Jan" said in December
  return out;
}

/** Steps that a moved Day 0 reopens, with their owner and new due date. */
function affected(p: Person, iso: string, steps: any[]) {
  return steps.filter(s => s.Flow === p.Flow && s['Recheck if day 0 moves'])
    .map(s => ({ s, o: owner(s['Owner role'], p), due: addDays(iso, s['Offset (days)']) }));
}

export async function previewDateChange(ev: SlackEvent, p: Person, iso: string, thread_ts?: string) {
  const d = await load();
  const what = p.Flow === 'Joiner' ? 'start date' : 'last day';
  if (p['Day 0'] === iso) return postMessage({ channel: ev.channel, thread_ts, text: '👍 *' + p.Name + '*\'s ' + what + ' is already ' + pretty(iso) + '. Nothing to change.' });
  const list = affected(p, iso, d.steps).map(a => '• ' + (a.s.Confidential ? 'a confidential step' : a.s.Step) + ' → <@' + a.o.id + '>, new due ' + pretty(a.due)).join('\n');
  const value = JSON.stringify({ id: p.id, iso, r: ev.user });
  const past = iso < todayIso() ? '\n⚠️ ' + pretty(iso) + ' ' + iso.slice(0, 4) + ' is in the past. If you meant another year, press Cancel and send it again.' : '';
  const text = '📅 Move *' + p.Name + '*\'s ' + what + ' from *' + (p['Day 0'] ? pretty(p['Day 0']) + ' ' + p['Day 0'].slice(0, 4) : 'no date') + '* to *' + pretty(iso) + ' ' + iso.slice(0, 4) + '*?' + past + '\nOn confirm I will update the tracker, set these back to Pending and tag the owners:\n' + (list || '• (no date-dependent steps)');
  return postMessage({ channel: ev.channel, thread_ts, text, blocks: [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'actions', elements: [
      { type: 'button', style: 'primary', action_id: 'date_confirm', value, text: { type: 'plain_text', text: 'Confirm' } },
      { type: 'button', action_id: 'date_cancel', value, text: { type: 'plain_text', text: 'Cancel' } } ] } ] });
}

async function dateButton(payload: any, a: any) {
  const who = payload.user.id; const { id, iso, r } = JSON.parse(a.value || '{}');
  const channel = payload.channel?.id, thread_ts = payload.message?.thread_ts || payload.message?.ts;
  if (a.action_id === 'date_cancel') return respond(payload.response_url, { replace_original: true, text: '✖️ Date change cancelled by <@' + who + '>.' });
  try {
    const before = await getRow(id);
    if (!before) throw new Error(id + ' is not in the tracker');
    const oldIso = (await load()).people.find(x => x.id === id)?.['Day 0'] || '';
    await setCell(id, 'Day 0', iso, 'moved in Slack by ' + who);
    const row = (await getRow(id)) || { ...before, 'Day 0': iso };
    const tab = /^L/i.test(id) ? 'Leavers' : 'Joiners';
    // Same handling as an edit in the tracker: date-dependent steps back to Pending, alert in #people-ops-alerts
    if (sheetOn() || !env('TRACKER_TOKEN')) await onTrackerChange({ tab, columns: ['Day 0'], oldValue: oldIso, value: row['Day 0'], row });
    const d = await load(); const p = d.people.find(x => x.id === id)!;
    const owners = affected(p, iso, d.steps);
    const tags = owners.map(a => '• <@' + a.o.id + '> ' + (a.s.Confidential ? 'a confidential step' : '*' + a.s.Step + '*') + ' by ' + pretty(a.due)).join('\n');
    await respond(payload.response_url, { replace_original: true, text: '✅ <@' + who + '> confirmed: *' + p.Name + '* now ' + (p.Flow === 'Joiner' ? 'starts' : 'leaves') + ' on *' + pretty(iso) + '* (tracker updated).' });
    await postMessage({ channel, thread_ts, text: '📅 *' + p.Name + '*\'s ' + (p.Flow === 'Joiner' ? 'start date' : 'last day') + ' moved ' + pretty(oldIso) + ' → *' + pretty(iso) + '* (asked by <@' + r + '>). Please redo:\n' + (tags || '• nothing date-dependent') +
      '\n<' + sheetLink(tab === 'Leavers' ? 'leavers.csv' : 'joiners.csv') + '|Open the tracker>' });
  } catch (err: any) {
    await respond(payload.response_url, { replace_original: false, text: '⚠️ Could not move the date: ' + err.message });
  }
}

// ---------------- "I changed X on the tracker, re-assign and tag them" ----------------
const REASSIGN = /\b(re-?assign|reassign|assign (the )?tasks|tag (them|the owners|owners|people|everyone|the team)|notify (them|the owners|owners|everyone)|(changed|updated|edited|moved) .*\b(tracker|sheet)\b|(tracker|sheet)\b.*\b(changed|updated|edited))/i;

/** Applies any Sheet edit right away (no waiting for the 5-minute check), then tags each owner with their task and due date in this thread. */
export async function reassign(ev: SlackEvent, who: Person, thread_ts?: string) {
  let applied: string[] = [];
  if (sheetOn()) { try { applied = (await pollSheet()).filter(l => /->|new row/.test(l)); } catch (err: any) { console.error('reassign poll:', err.message); } }
  const d = await load(); const today = todayIso();
  const p = d.people.find(x => x.id === who.id) || who;
  const open = buildTasks(d, today).filter(t => t.Person[0] === p.id && t.Status !== 'Done').sort((a, b) => a.Due.localeCompare(b.Due));
  const what = p.Flow === 'Joiner' ? 'starts' : 'leaves';
  if (!open.length) return postMessage({ channel: ev.channel, thread_ts, text: '✅ *' + p.Name + '* ' + what + ' on *' + pretty(p['Day 0']) + '* and every step is already done.' });
  const lines = open.slice(0, 10).map(t => {
    const o = owner(t['Owner role'], p); const late = diffDays(today, t.Due);
    return '• <@' + o.id + '> ' + (t.Confidential ? 'a confidential step' : '*' + t.Step + '*') + ' by ' + pretty(t.Due) + (late > 0 ? ' (⏰ ' + late + 'd overdue)' : '') + (t.Status === 'Blocked' ? ' ⛔ blocked' : '');
  });
  for (const t of open.slice(0, 10)) {
    const o = owner(t['Owner role'], p);
    await send({ to: o.id, kind: 'nudge', taskId: t._id, url: t._url, confidential: t.Confidential,
      text: '📅 *' + p.Name + '* ' + what + ' on ' + pretty(p['Day 0']) + '. Your task: ' + (t.Confidential ? 'a confidential step' : '*' + t.Step + '*') + ', due ' + pretty(t.Due) + '.' });
  }
  const note = applied.length ? '\n_I picked up your tracker edit just now (' + applied.length + ' change' + (applied.length > 1 ? 's' : '') + ') and reset the date-dependent steps._' : '';
  return postMessage({ channel: ev.channel, thread_ts, text: '📅 *' + p.Name + '* ' + what + ' on *' + pretty(p['Day 0']) + '*. Here is who does what:\n' + lines.join('\n') +
    (open.length > 10 ? '\n…and ' + (open.length - 10) + ' later steps.' : '') + note + '\nEach of you also has a DM with a *Mark done* button. <' + sheetLink(p.Flow === 'Joiner' ? 'joiners.csv' : 'leavers.csv') + '|Open the tracker>' });
}

// ---------------- who may see tracker details ----------------
const NUDGE = /\b(chase|nudge|remind|follow ?up with|ping|push (them|the owners?)|ask (them|the owners?) to)\b/i;
/** "I / my" questions are self-serve policy questions, not tracker lookups. */
const PERSONAL = /\b(my|mine|i'm|i am|can i|do i|should i|i start|i leave|i join|i need)\b/i;
/** People Ops, role owners and named POCs can ask about anyone in the tracker; others get policy answers only. */
export const canSeeTracker = (user: string) => Object.values(CONFIG.ROLES).includes(user) || Object.values(CONFIG.DIRECTORY).includes(user);
export const hasRepeatedIds = (d: { repeated?: string[] }) => !!(d.repeated && d.repeated.length);

/** The tracker step a task is about, from the words of the request ("ship the laptop" -> Order laptop). */
const SYNONYMS: Record<string, string> = { ship: 'laptop', dispatch: 'laptop', macbook: 'laptop', contract: 'agreement', sign: 'agreement',
  account: 'accounts', slack: 'accounts', google: 'accounts', notion: 'accounts', intro: 'buddy', welcome: 'welcome', exit: 'exit',
  revoke: 'access remove', remove: 'access', offboard: 'access remove', password: 'passwords', handover: 'handover', survey: 'survey', payment: 'payment' };
const STOP = new Set(['send', 'with', 'from', 'that', 'this', 'call', 'check', 'days', 'before', 'start', 'incl', 'and', 'the', 'end', 'day']);
export function stepFor(text: string, steps: Step[]): Step | undefined {
  const words = new Set(text.toLowerCase().split(/[^a-z]+/).flatMap(w => [w, ...(SYNONYMS[w] || '').split(' ')]).filter(Boolean));
  let best: Step | undefined, score = 0;
  for (const st of steps) {
    const n = st.Step.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3 && !STOP.has(w) && words.has(w)).length;
    if (n > score) { best = st; score = n; }
  }
  return best;
}

// ---------------- "New joiner starting 1 Jan 2027, full time in India, add them to the sheet" ----------------
const ADD_TO_SHEET = /\b(add|put|create|enter|log)\b.*\b(sheet|tracker)\b/i;
const START_WORDS = /\b(starting|starts|joining|joins|is leaving|leaves on|last day is)\b/i;
const ADD_PERSON = { test: (q: string) =>
  (/\b(new (joiner|hire|starter|leaver|employee|contractor)|someone|a person)\b/i.test(q) &&
    (ADD_TO_SHEET.test(q) || (START_WORDS.test(q) && /\d/.test(q) && !/\?\s*$/.test(q)))) ||
  (ADD_TO_SHEET.test(q) && START_WORDS.test(q) && /\d/.test(q)) };   // "xyz is joining on 30th Nov 2026, pls add this to the sheet"
const COUNTRIES = ['India', 'Brazil', 'Spain', 'Kenya', 'United States', 'USA', 'UK', 'United Kingdom', 'Germany', 'France', 'Mexico', 'Argentina', 'Colombia',
  'Nigeria', 'South Africa', 'Philippines', 'Indonesia', 'Canada', 'Australia', 'Portugal', 'Poland', 'Netherlands', 'Italy', 'Egypt', 'Pakistan', 'Vietnam', 'Chile', 'Peru', 'Ireland', 'Singapore'];

/** Pulls the fields out of the request; Claude finds the name if there is one, the rest is plain matching. */
export async function parseNewPerson(text: string, today: string) {
  const flow: 'Joiner' | 'Leaver' = /\b(leav|exit|resign|last day)/i.test(text) ? 'Leaver' : 'Joiner';
  const country = COUNTRIES.find(c => new RegExp('\\b' + c + '\\b', 'i').test(text)) || '';
  const worker = /\b(full[- ]?time|employee|fte|permanent)\b/i.test(text) ? 'Employee' : /\b(contr?act(or|er)?|freelanc|part[- ]?time)\w*/i.test(text) ? 'Contractor' : '';
  const day0 = parseDate(text, today);
  let name = (text.match(/\b(?:named|called|name is)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)/) || [])[1] || '';
  if (!name) {                                       // "new joiner XYZ, starting ..." / "new hire Priya Shah from ..."
    const m = text.replace(/<@[^>]+>/g, '').match(/\bnew (?:joiner|hire|starter|leaver|employee|contractor)\s+([A-Za-z][\w'-]*(?:\s+[A-Z][\w'-]*)?)/i);
    if (m && !/^(starting|starts|joining|in|from|on|is|who|that|for|with|named|called|at)$/i.test(m[1].split(/\s+/)[0])) name = m[1].split(/\s+/).filter(w => !/^(starting|starts|joining|in|from|on|is)$/i.test(w)).join(' ');
  }
  if (!name) name = (text.replace(/<@[^>]+>/g, '').trim().match(/^([A-Za-z][\w'-]*(?:\s+[A-Z][\w'-]*)?)\s+(?:is\s+)?(?:joining|starting|starts|joins|leaving)\b/) || [])[1] || '';
  if (!name && env('ANTHROPIC_API_KEY')) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
        headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: CONFIG.CLAUDE_MODEL, max_tokens: 30, system: 'Return only the name of the new person in the message, exactly as written (even a placeholder like XYZ), or NONE if no name is given. No other words.',
          messages: [{ role: 'user', content: text.replace(/<@[^>]+>/g, '') }] }) });
      const j: any = await res.json();
      const t = ((j.content || [])[0]?.text || '').trim();
      if (t && !/^none$/i.test(t) && t.length < 60) name = t;
    } catch { /* keep the placeholder */ }
  }
  return { flow, country, worker, day0, name };
}

export async function previewAdd(ev: SlackEvent, text: string, thread_ts?: string) {
  const today = todayIso();
  const f = await parseNewPerson(text, today);
  const missing = [!f.day0 && (f.flow === 'Joiner' ? 'start date' : 'last day'), !f.country && 'country'].filter(Boolean);
  if (missing.length) return postMessage({ channel: ev.channel, thread_ts, text: '🤔 To add a new ' + f.flow.toLowerCase() + ' I need the ' + missing.join(' and ') +
    '. Try: _New joiner Priya Shah starting 1 Jan 2027, full time in India, add them to the sheet_' });
  const d = await load();
  const name = f.name || 'New ' + f.flow.toLowerCase() + ' (' + f.country + ', ' + pretty(f.day0) + ')';
  const id = nextId(d, f.flow);
  const steps = d.steps.filter(s => s.Flow === f.flow);
  const value = JSON.stringify({ ...f, name, r: ev.user });
  const past = f.day0 < today ? '\n⚠️ ' + pretty(f.day0) + ' ' + f.day0.slice(0, 4) + ' is in the past.' : '';
  const txt = '➕ Add a new *' + f.flow.toLowerCase() + '* to the tracker?\n• *' + name + '* (' + id + ')' + (f.name ? '' : ' _no name given: edit it in the Sheet later_') +
    '\n• ' + (f.flow === 'Joiner' ? 'Starts' : 'Last day') + ': *' + pretty(f.day0) + ' ' + f.day0.slice(0, 4) + '*' + past + '\n• ' + f.country + ', ' + (f.worker || 'worker type not given') +
    '\n• Status Active, all ' + steps.length + ' steps Pending; owners get assigned and nudged.';
  return postMessage({ channel: ev.channel, thread_ts, text: txt, blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: txt } },
    { type: 'actions', elements: [
      { type: 'button', style: 'primary', action_id: 'add_confirm', value, text: { type: 'plain_text', text: 'Confirm' } },
      { type: 'button', action_id: 'add_cancel', value, text: { type: 'plain_text', text: 'Cancel' } } ] } ] });
}

async function addButton(payload: any, a: any) {
  const who = payload.user.id; const f = JSON.parse(a.value || '{}');
  const channel = payload.channel?.id, thread_ts = payload.message?.thread_ts || payload.message?.ts;
  if (a.action_id === 'add_cancel') return respond(payload.response_url, { replace_original: true, text: '✖️ Not added (cancelled by <@' + who + '>).' });
  try {
    const id = await addPerson(f.flow, { Name: f.name, Country: f.country, 'Worker type': f.worker, 'Day 0': f.day0, 'Added on': todayIso() });
    if (!id) throw new Error('the tracker is not connected');
    let started = '';
    if (sheetOn()) { const log = await pollSheet(); started = log.some(l => l.includes(id)) ? ' Flow started: owners are assigned in #people-ops-alerts.' : ''; }
    await respond(payload.response_url, { replace_original: true, text: '✅ <@' + who + '> added *' + f.name + '* (' + id + ') to the tracker: ' + (f.flow === 'Joiner' ? 'starts ' : 'last day ') + pretty(f.day0) + ' ' + f.day0.slice(0, 4) + '.' + started });
    const d = await load(); const p = d.people.find(x => x.id === id);
    if (p) await postMessage({ channel, thread_ts, text: await updateRequest({ user: who, channel, type: 'app_mention', text: '', ts: '' } as any, p) });
  } catch (err: any) {
    await respond(payload.response_url, { replace_original: false, text: '⚠️ Could not add them: ' + err.message });
  }
}

/** Messages that only make sense with the earlier ones: "and for employees?", "what about Spain?", "who owns it?". */
const FOLLOWUP = { test: (q: string) => q.split(/\s+/).filter(Boolean).length <= 8 || /^(and|what about|how about|also|then|so|but|ok|okay)\b/i.test(q.trim()) };

// ---------------- "mark the laptop as done for J-104" / "change it from pending to done" ----------------
const STATUS_CHANGE = /\b(mark|set|change|update|move|switch)\b[^?]*\b(done|complete[d]?|finished|pending|blocked|not done)\b/i;

export async function changeStatus(ev: SlackEvent, question: string, thread_ts?: string) {
  const d = await load(); const ppl = peopleOf(d);
  const earlier = ev.thread_ts ? (await history(ev)).map(t => t.content).join(' ') : '';
  const p = findPerson(question, ppl) || findPerson(earlier, ppl);
  const say = (text: string) => postMessage({ channel: ev.channel, thread_ts, text });
  if (!p) return say('🤔 Which person? Use their name or ID, e.g. _mark the laptop as done for J-104_.');
  if (!canSeeTracker(ev.user)) return say('Only People Ops and step owners can change the tracker.');
  const word = ((question.match(/\bto\s+(done|complete\w*|finished|pending|blocked|not done)\b/i) || question.match(/\b(done|complete\w*|finished|pending|blocked|not done)\b/i)) || [])[1] || '';
  const value = /blocked/i.test(word) ? 'Blocked' : /pending|not done/i.test(word) ? 'Pending' : 'Done';
  const steps = d.steps.filter(s => s.Flow === p.Flow);
  const step = stepFor(question, steps) || (ev.thread_ts ? stepFor(earlier, steps) : undefined);
  if (!step) {
    const open = buildTasks(d, todayIso()).filter(t => t.Person[0] === p.id && t.Status !== 'Done').map(t => t.StepId + ' ' + t.Step);
    return say('🤔 Which step for *' + p.Name + '*? Say e.g. _mark the laptop as done for ' + p.id + '_. Open steps: ' + open.join(', '));
  }
  const old = (d.status[p.id + '::' + step.id] || { Status: 'Pending' }).Status;
  const label = step.Confidential && !ev.channel.startsWith('D') ? 'a confidential step' : '*' + step.Step + '*';
  if (old === value) return say('👍 ' + label + ' for *' + p.Name + '* is already ' + value + '.');
  try {
    const saved = await setCell(p.id, step.id, value, 'set in Slack by ' + ev.user);
    if (saved && sheetOn()) {
      const row = await getRow(p.id); const col = row && Object.keys(row).find(h => stepIdOf(h) === step.id);
      if (row && col) await onTrackerChange({ tab: p.Flow === 'Joiner' ? 'Joiners' : 'Leavers', columns: [col], oldValue: old, value, row });
    }
    return say('✅ ' + label + ' for *' + p.Name + '* (' + p.id + '): ' + old + ' → *' + value + '*' + (saved ? ' in the Sheet.' : ' (tracker not connected).') +
      ' <' + sheetLink(p.Flow === 'Joiner' ? 'joiners.csv' : 'leavers.csv') + '|Open the tracker>');
  } catch (err: any) { return say('⚠️ Could not update the Sheet: ' + err.message); }
}
