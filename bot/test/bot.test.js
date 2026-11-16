/**
 * The test plan, automated. Fictional people only; Notion, Slack and Claude are faked.
 * Run: npm test
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { installFakes } from './fake-apis.js';
import { CONFIG } from '../lib/config.js';
import { dailyRun } from '../lib/lifecycle.js';
import { buildTasks, setData } from '../lib/store.js';
import { clearKnowledgeCache } from '../lib/assistant.js';
import { POST, GET, drain } from '../api/slack.js';

const SECRET = 'test-signing-secret';
beforeEach(() => {
  Object.assign(process.env, { SLACK_BOT_TOKEN: 'test', ANTHROPIC_API_KEY: 'test', SLACK_SIGNING_SECRET: SECRET, TODAY: '2026-11-16' });
  clearKnowledgeCache();
});
const sentTo = (calls, kind) => calls.slack.filter(m => kind.test(m.text));

// ---------------- the four test cases ----------------
const T = '2026-11-16';
const run = () => dailyRun({ today: T });
const taskOf = (f, step, pid = 'P1') => buildTasks(f.data, T).find(t => t._id.startsWith(pid + '::') && t.Step === step);

test('Fake joiner: one task per step, correct due dates, first nudge today', async () => {
  const f = installFakes({ people: [{ Name: 'TEST fake joiner', Flow: 'Joiner', Country: 'India', 'Worker type': 'Contractor', 'Day 0': '2026-11-30', 'Added on': T, Status: 'Test' }] });
  await run();
  assert.equal(buildTasks(f.data, T).length, 14, 'one task per joiner step');
  assert.equal(taskOf(f, 'Send agreement (country template)').Due, T);
  assert.equal(taskOf(f, 'Day 30 check-in').Due, '2026-12-30');
  assert.equal(sentTo(f.calls, /flow started/).length, 1);
  assert.equal(sentTo(f.calls, /No agreement template/).length, 0, 'India contractor template exists');
  const nudge = f.calls.slack.find(m => /🔔 Send TEST fake joiner's contractor agreement for India/.test(m.text));
  assert.ok(nudge, 'hiring coordinator nudged today');
  assert.match(nudge.text, /India contractor template/);
  assert.ok(nudge.blocks.some(b => b.type === 'actions'), 'nudge has a Mark done button');
  assert.equal(sentTo(f.calls, /✅ Lifecycle bot ran/).length, 1, 'heartbeat posted');
});

test('Edge case 1: start date moves, date-based steps reopen, others stay done', async () => {
  const done = { Status: 'Done', 'Done on': '2026-11-10' };
  const f = installFakes({ people: [{ Name: 'Demo joiner (Spain)', Flow: 'Joiner', Country: 'Spain', 'Worker type': 'Contractor', 'Day 0': '2026-11-27', 'Previous day 0': '2026-11-20', 'Day 0 changed on': T, 'Added on': '2026-11-01' }],
    status: { 'P1::J01': done, 'P1::J04': done, 'P1::J06': done } });
  await run();
  assert.equal(taskOf(f, 'Send agreement (country template)').Status, 'Not started');
  assert.equal(taskOf(f, 'Order laptop (deliver 2 days before start)').Status, 'Not started');
  assert.equal(taskOf(f, 'Assign security training').Status, 'Done');
  assert.equal(taskOf(f, 'Order laptop (deliver 2 days before start)').Due, '2026-11-20', 'due date follows the new day 0');
  assert.match(sentTo(f.calls, /📅 Day 0 for \*Demo joiner \(Spain\)\* moved/)[0].text, /20 Nov → 27 Nov.*Reopened to recheck: Send agreement/);
});

test('Edge case 2: contractor in a country with no template is flagged at once', async () => {
  const f = installFakes({ people: [{ Name: 'TEST contractor in new country (Kenya)', Flow: 'Joiner', Country: 'Kenya', 'Worker type': 'Contractor', 'Day 0': '2026-11-30', 'Added on': T }] });
  await run();
  assert.equal(sentTo(f.calls, /🚩 No agreement template for \*Contractor in Kenya\*/).length, 1);
  assert.match(sentTo(f.calls, /agreement for Kenya/)[0].text, /MISSING for Kenya/);
});

test('Edge case 3: leaver with shared logins, logins appear in the access step', async () => {
  const f = installFakes({ people: [{ Name: 'Demo leaver (Brazil)', Flow: 'Leaver', Country: 'Brazil', 'Worker type': 'Employee', 'Day 0': '2026-11-19', 'Added on': '2026-11-05',
    'Shared logins': 'Canva team login; Ads manager account; shared 1Password vault' }] });
  await run();
  assert.equal(buildTasks(f.data, T).length, 9, 'one task per leaver step');
  assert.match(sentTo(f.calls, /asset and access list/)[0].text, /Canva team login; Ads manager account/);
  assert.equal(sentTo(f.calls, /no shared logins listed/).length, 0);
});

// ---------------- extras from the test plan ----------------

test('Extra: short-notice leaver with no shared logins: past steps pulled to today, red flag', async () => {
  const f = installFakes({ people: [{ Name: 'TEST short-notice leaver', Flow: 'Leaver', Country: 'Brazil', 'Worker type': 'Employee', 'Day 0': '2026-11-18', 'Added on': T }] });
  await run();
  const late = buildTasks(f.data, T).filter(t => /Short notice/.test(t.Notes));
  assert.equal(late.length, 3, 'day -7 and day -3 steps pulled to today');
  late.forEach(t => assert.equal(t.Due, T));
  assert.match(sentTo(f.calls, /flow started/)[0].text, /Short notice: 3 steps are due today/);
  assert.equal(sentTo(f.calls, /🚩 \*TEST short-notice leaver\* is leaving and has no shared logins listed/).length, 1);
  assert.equal(sentTo(f.calls, /overdue/).length, 0, 'nothing is born overdue');
});

test('Extra: escalation ladder, confidential steps stay private', async () => {
  // day 0 = 22 Nov: payment details and laptop (day -7) were due 15 Nov, so they are 1 day late today
  const f = installFakes({ people: [{ Name: 'Escalation joiner', Flow: 'Joiner', Country: 'Spain', 'Worker type': 'Contractor', 'Day 0': '2026-11-22', 'Added on': '2026-11-01', 'Lead (Slack ID)': 'U0LEADAAA1' }],
    status: { 'P1::J01': { Status: 'Done' }, 'P1::J02': { Status: 'Done' }, 'P1::J07': { Status: 'Blocked', Notes: 'Lead on leave' } } });
  await run();
  const e1 = sentTo(f.calls, /🟠 Escalation/);
  assert.equal(e1.length, 2, 'day 1: People Ops lead hears about both 1-day-late steps');
  const conf = e1.find(m => /confidential step/i.test(m.text));
  assert.ok(conf && !/payment/i.test(conf.text), 'confidential step is not named in escalations');
  const f2 = installFakes({ people: [{ Name: 'Late joiner', Flow: 'Joiner', Country: 'Spain', 'Worker type': 'Contractor', 'Day 0': '2026-11-26', 'Added on': '2026-11-01', 'Lead (Slack ID)': 'U0LEADAAA1' }],
    status: { 'P1::J01': { Status: 'Done' } } });
  await run();
  assert.equal(sentTo(f2.calls, /🔴 Escalation/).length, 0, 'nothing is late yet');
  const f3 = installFakes({ people: [{ Name: 'Critical joiner', Flow: 'Joiner', Country: 'Spain', 'Worker type': 'Contractor', 'Day 0': '2026-11-25', 'Added on': '2026-11-01', 'Lead (Slack ID)': 'U0LEADAAA1' }],
    status: { 'P1::J01': { Status: 'Done' } } });
  await run();   // agreement signed (-10, critical) due 15 Nov -> 1 day late -> straight to the lead
  const e2 = sentTo(f3.calls, /🔴 Escalation/);
  assert.equal(e2.length, 1);
  assert.equal(e2[0].channel, 'U0LEADAAA1');
  assert.match(e2[0].text, /Agreement signed.*critical/);
  const f4 = installFakes({ people: [{ Name: 'Blocked joiner', Flow: 'Joiner', Country: 'Spain', 'Worker type': 'Contractor', 'Day 0': '2026-11-17', 'Added on': '2026-11-01' }],
    status: { 'P1::J07': { Status: 'Blocked', Notes: 'Lead on leave' } } });
  await run();
  assert.match(sentTo(f4.calls, /⛔ Blocked/)[0].text, /Lead on leave/);
});

test('Extra: a nudge that cannot be delivered is flagged in the channel', async () => {
  const f = installFakes({ failSlackFor: ['U0BUDDYBAD'],
    people: [{ Name: 'Buddy joiner', Flow: 'Joiner', Country: 'Spain', 'Worker type': 'Contractor', 'Day 0': T, 'Added on': '2026-11-01', 'Buddy (Slack ID)': 'U0BUDDYBAD' }] });
  await run();
  const flag = sentTo(f.calls, /⚠️ Could not reach U0BUDDYBAD/)[0];
  assert.ok(flag && flag.channel === CONFIG.CHANNEL);
  assert.match(flag.text, /Buddy joiner starts today/);
});

test('Extra: silent failure is impossible: a broken data file posts an error with the manual fallback', async () => {
  const f = installFakes();
  f.data.people = null;
  await assert.rejects(run());
  assert.match(f.calls.slack.at(-1).text, /❌ Lifecycle bot failed.*\n.*status file/);
});

test('Preview mode sends nothing', async () => {
  const f = installFakes({ people: [{ Name: 'Preview joiner', Flow: 'Joiner', Country: 'India', 'Worker type': 'Contractor', 'Day 0': '2026-11-30', 'Added on': T }] });
  const out = await dailyRun({ today: T, dryRun: true });
  assert.equal(f.calls.slack.length, 0);
  assert.ok(out.some(m => m.kind === 'digest'));
});

test('The real dummy data runs cleanly', async () => {
  setData(null);
  const f = installFakes(); setData(null);
  const out = await dailyRun({ today: T, dryRun: true });
  assert.ok(out.length > 5);
  void f;
});

// ---------------- Slack endpoint (Vercel function) ----------------

function slackRequest(body, { json = true, secret = SECRET, ts = Math.floor(Date.now() / 1000), headers = {} } = {}) {
  const raw = json ? JSON.stringify(body) : new URLSearchParams(body).toString();
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update('v0:' + ts + ':' + raw).digest('hex');
  return new Request('https://bot.test/api/slack', { method: 'POST', body: raw, headers: {
    'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
    'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig, ...headers } });
}
const dm = (id, text, extra = {}) => ({ type: 'event_callback', event_id: id, event: { type: 'message', channel_type: 'im', channel: 'D0TEST', user: 'U0ASKER01', text, ts: '1.1', ...extra } });

test('Security: only signed, fresh requests from Slack are accepted', async () => {
  installFakes();
  assert.equal((await POST(slackRequest({ type: 'url_verification', challenge: 'abc' }))).status, 200);
  assert.deepEqual(await (await POST(slackRequest({ type: 'url_verification', challenge: 'abc' }))).json(), { challenge: 'abc' });
  assert.equal((await POST(slackRequest(dm('E1', 'hi'), { secret: 'wrong' }))).status, 401);
  assert.equal((await POST(slackRequest(dm('E2', 'hi'), { ts: Math.floor(Date.now() / 1000) - 3600 }))).status, 401, 'replayed request rejected');
  assert.match(await GET().text(), /✅ SLACK_SIGNING_SECRET/);
});

test('Chat: a DM gets one Claude answer grounded in the guides, even when Slack retries', async () => {
  const f = installFakes();
  await POST(slackRequest(dm('E10', 'how do I apply for leave in Brazil?')));
  await POST(slackRequest(dm('E10', 'how do I apply for leave in Brazil?')));                                    // duplicate delivery
  await POST(slackRequest(dm('E10', 'how do I apply for leave in Brazil?'), { headers: { 'x-slack-retry-num': '1' } }));  // Slack retry
  await POST(slackRequest(dm('E11', 'echo', { bot_id: 'B1' })));                                                // the bot's own message
  await drain();
  assert.equal(f.calls.claude.length, 1);
  assert.match(f.calls.claude[0].system, /Answer ONLY from the KNOWLEDGE/);
  assert.match(f.calls.claude[0].system, /Leave policy \| owner: People Ops \| review due/);
  assert.equal(f.calls.slack.length, 1, 'one "Thinking…" message, nothing else');
  assert.equal(f.calls.slack[0].channel, 'D0TEST');
  assert.match(f.calls.slack[0].text, /Thinking/);
  assert.equal(f.calls.updates.length, 1, 'the Thinking message is replaced by the answer');
  assert.match(f.calls.updates[0].text, /Claude answer for: how do I apply for leave in Brazil\?/);
});

test('Chat: follow-up questions carry the earlier conversation', async () => {
  const now = Math.floor(Date.now() / 1000);
  const f = installFakes({ dmHistory: [
    { ts: String(now - 60), bot_id: 'B0BOT', text: 'Request leave in the leave tool. Country rules are in the Leave policy.' },
    { ts: String(now - 90), user: 'U0ASKER01', text: 'how do I apply for leave?' },
    { ts: String(now - 99999), user: 'U0ASKER01', text: 'an old unrelated question from yesterday' } ] });
  await POST(slackRequest(dm('E12', 'and in Spain?', { ts: String(now) })));
  await drain();
  const msgs = f.calls.claude[0].messages;
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(msgs[0].content, 'how do I apply for leave?');
  assert.equal(msgs[2].content, 'and in Spain?');
});

test('Chat: an @mention is answered in a thread; a question with no guide is logged as a gap', async () => {
  const f = installFakes();
  await POST(slackRequest({ type: 'event_callback', event_id: 'E20', event: { type: 'app_mention', channel: 'C0GENERAL', user: 'U0ASKER01', text: '<@U0BOT> where is the holiday calendar?', ts: '5.5' } }));
  await drain();
  const thinking = f.calls.slack.find(m => m.channel === 'C0GENERAL');
  assert.equal(thinking.thread_ts, '5.5', 'answered in a thread under the mention');
  assert.equal(f.calls.updates[0].channel, 'C0GENERAL');
  assert.equal(f.calls.claude[0].messages[0].content, 'where is the holiday calendar?');
  assert.ok(f.calls.slack.some(m => m.channel === CONFIG.CHANNEL && /Unanswered question/.test(m.text)));
});

test('Chat: if Claude is down the person still gets a reply and People Ops is told', async () => {
  const f = installFakes({ claudeDown: true });
  await POST(slackRequest(dm('E30', 'can I expense a coworking space?')));
  await drain();
  assert.match(f.calls.updates[0].text, /Sorry, I hit a problem/);
  assert.ok(f.calls.slack.some(m => m.channel === CONFIG.CHANNEL && /Chat answer failed/.test(m.text)));
});

test('/people: private rule-based answer; a leaving question alerts People Ops without changing anything', async () => {
  const f = installFakes();
  const slash = text => slackRequest({ command: '/people', text, user_id: 'U0ASKER01', response_url: 'https://hooks.slack.test/r1' }, { json: false });
  const pay = await (await POST(slash('when do contractors get paid this month?'))).json();
  assert.equal(pay.response_type, 'ephemeral');
  assert.match(pay.text, /Payroll calendar/);
  const leave = await (await POST(slash('my last day is Friday, what happens to my access?'))).json();
  assert.match(leave.text, /Leaver checklist/);
  await drain();
  assert.ok(f.calls.slack.some(m => /asked about their last day via \/people/.test(m.text)));
});

test('Mark done button saves to status.json and updates the Slack message', async () => {
  const f = installFakes({ github: true, people: [{ Name: 'Button joiner', Flow: 'Joiner', Country: 'India', 'Worker type': 'Contractor', 'Day 0': '2026-11-20' }] });
  const payload = { type: 'block_actions', user: { id: 'U0CLICKER' }, response_url: 'https://hooks.slack.test/r2', actions: [{ action_id: 'mark_done', value: 'P1::J06' }] };
  assert.equal((await POST(slackRequest({ payload: JSON.stringify(payload) }, { json: false }))).status, 200);
  await drain();
  assert.equal(f.data.status['P1::J06'].Status, 'Done');
  assert.equal(f.calls.github.at(-1).method, 'PUT');
  assert.match(f.calls.responses[0].text, /Marked done by <@U0CLICKER> \(saved/);
});

test('Mark done without a GitHub token still answers (demo mode)', async () => {
  const f = installFakes();
  const payload = { type: 'block_actions', user: { id: 'U0CLICKER' }, response_url: 'https://hooks.slack.test/r3', actions: [{ action_id: 'mark_done', value: 'P1::J06' }] };
  await POST(slackRequest({ payload: JSON.stringify(payload) }, { json: false }));
  await drain();
  assert.equal(f.calls.github.length, 0);
  assert.match(f.calls.responses[0].text, /demo: not saved/);
});
