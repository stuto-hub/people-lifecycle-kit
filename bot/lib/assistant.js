/**
 * Everything Slack sends to the bot:
 *   - DMs and @mentions -> Claude answers from the guides in bot/data
 *   - /people           -> fast rule-based answer, private to the asker
 *   - "Mark done" button -> saved to data/status.json (if GITHUB_TOKEN is set) and the message is updated
 * Anything that changes a record (a leaver request) only alerts People Ops: a human confirms and updates the data.
 */
import Core from './core.js';
import { CONFIG, todayIso } from './config.js';
import { load } from './store.js';
import { saveStatus } from './github.js';
import { send, postMessage, respond, slackApi, slackGet } from './slack.js';
import { askClaude } from './claude.js';

// ---------------- knowledge from the data files ----------------
const ACT = {
  'Answer + show personal checklist': 'my_checklist',
  'Answer + start leaver request (People Ops confirms)': 'notify_leaver',
  'Route to Finance (no guide yet)': 'route_finance',
  'Route to People Ops + log gap': 'route_people_ops'
};
export function clearKnowledgeCache() {}

export async function knowledge() {
  const d = load();
  const guides = d.guides.map(x => ({ guide_id: x.Guide, title: x.Guide, owner_role: x.Owner, last_updated: x['Last reviewed'], link: x.Link }));
  const intents = d.questions.map((x, i) => ({ intent_id: 'Q' + (i + 1), keywords: String(x.Keywords || '').split(',').map(k => k.trim()).join('|'),
    guide_id: x.Guide || '', answer: x.Answer, action: ACT[x.Action] || '', sensitive: x.Confidential ? 'Y' : 'N' }));
  return { guides, intents };
}

const match = (text, kb) => Core.matchQuestion(text, kb.intents, kb.guides, todayIso(), CONFIG.STALE_DAYS);

// ---------------- side effects shared by /people and chat ----------------
export async function routeActions(r, user, text, via) {
  if (r.action === 'notify_leaver')
    await send({ to: CONFIG.CHANNEL, kind: 'request', text: '📨 <@' + user + '> asked about their last day via ' + via +
      '. Nothing has been changed. Reach out privately, confirm dates, then add them to people.json as a leaver.' });
  if (r.action === 'route_finance')
    await send({ to: CONFIG.ROLES.Finance, kind: 'question', text: '❓ Question from <@' + user + '> via ' + via + ': "' + text + '" (no guide yet).' });
  if (r.action === 'route_people_ops' || r.matched === 'GAP')
    await send({ to: CONFIG.CHANNEL, kind: 'question', text: '❓ Unanswered question from <@' + user + '> via ' + via + ': "' + text + '" (logged as a guide gap).' });
}

// ---------------- DMs and @mentions: Claude ----------------
const seen = new Map();   // event_id -> time, so a Slack retry is never answered twice

/** Returns null when the event should be ignored, otherwise the work to do. */
export function acceptEvent(body) {
  if (body.type !== 'event_callback') return null;
  const ev = body.event || {};
  if (ev.bot_id || ev.subtype || !ev.text) return null;                 // ignore bots (incl. itself) and edits
  if (!(ev.type === 'app_mention' || (ev.type === 'message' && ev.channel_type === 'im'))) return null;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 3600000) seen.delete(k);
  if (seen.has(body.event_id)) return null;
  seen.set(body.event_id, now);
  return ev;
}

/**
 * Earlier messages in the same conversation, so follow-ups make sense ("and in Spain?").
 * Threads: the thread. DMs without a thread: messages from the last hour. Read live from Slack, nothing stored.
 */
export async function history(ev) {
  try {
    const j = ev.thread_ts ? await slackGet('conversations.replies', { channel: ev.channel, ts: ev.thread_ts, limit: '15' })
      : ev.channel_type === 'im' ? await slackGet('conversations.history', { channel: ev.channel, latest: ev.ts, limit: '8' })
      : null;
    if (!j || !j.ok) return [];
    let msgs = (j.messages || []).filter(m => m.ts !== ev.ts && m.text && !m.text.startsWith('🧠') && !m.text.startsWith('Sorry, I hit a problem'));   // skip placeholders and error replies
    if (!ev.thread_ts) msgs = msgs.filter(m => Number(m.ts) > Number(ev.ts) - 3600).reverse();   // history is newest first
    return msgs.slice(-8).map(m => ({ role: m.bot_id ? 'assistant' : 'user', content: m.text.replace(/<@[A-Z0-9]+>/g, '').trim() }));
  } catch { return []; }
}

export async function answerChat(ev) {
  const question = ev.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const thread_ts = ev.type === 'app_mention' ? (ev.thread_ts || ev.ts) : ev.thread_ts;
  const via = ev.type === 'app_mention' ? 'an @mention' : 'a DM to the bot';
  const thinking = await postMessage({ channel: ev.channel, text: '🧠 Thinking…', thread_ts });
  let answer;
  try {
    const [kb, past] = await Promise.all([knowledge(), history(ev)]);
    const r = match(question, kb);
    answer = await askClaude(question, kb, r, past);
    // A follow-up ('and in Spain?') rarely matches on its own; with earlier context Claude answers it, so it is not a guide gap.
    await routeActions(past.length && r.matched === 'GAP' ? { ...r, matched: 'FOLLOW_UP', action: '' } : r, ev.user, question, via);
  } catch (err) {
    console.error(err);
    answer = 'Sorry, I hit a problem answering that. People Ops has been told. You can also check the People Ops Hub: ' + CONFIG.HUB_URL;
    await send({ to: CONFIG.CHANNEL, kind: 'error', text: '❌ Chat answer failed for <@' + ev.user + '>: ' + err.message });
  }
  if (thinking && thinking.ok) return slackApi('chat.update', { channel: ev.channel, ts: thinking.ts, text: answer });
  return postMessage({ channel: ev.channel, text: answer, thread_ts });
}

// ---------------- /people: fast and rule-based (Slack allows 3 seconds) ----------------
export async function peopleCommand(form) {
  const text = form.get('text') || '';
  const kb = await knowledge();
  const r = match(text, kb);
  return { reply: { response_type: 'ephemeral', text: r.text + '\n_Tip: DM me for a fuller answer._' },
           after: () => routeActions(r, form.get('user_id'), text, '/people') };
}

// ---------------- "Mark done" button ----------------
export async function buttonClick(payload) {
  const a = (payload.actions || [])[0];
  if (!a || a.action_id !== 'mark_done') return;
  const who = payload.user.id;
  const saved = await saveStatus(a.value, { Status: 'Done', 'Done on': new Date().toISOString().slice(0, 10), 'Done by': who }, who);
  await respond(payload.response_url, { replace_original: true,
    text: '✅ Marked done by <@' + who + '>' + (saved ? ' (saved to status.json)' : ' (demo: not saved, add GITHUB_TOKEN to save)') });
}
