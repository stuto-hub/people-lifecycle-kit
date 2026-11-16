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
import { clearKnowledgeCache } from '../lib/assistant.js';
import { POST, GET, drain } from '../api/slack.js';

const SECRET = 'test-signing-secret';
beforeEach(() => {
  Object.assign(process.env, { NOTION_TOKEN: 'test', SLACK_BOT_TOKEN: 'test', ANTHROPIC_API_KEY: 'test', SLACK_SIGNING_SECRET: SECRET, TODAY: '2026-11-16' });
  clearKnowledgeCache();
});
const sentTo = (calls, kind) => calls.slack.filter(m => kind.test(m.text));
const person = (o) => ({ Status: 'Active', 'Lead (Slack ID)': 'U_LEAD_PLACEHOLDER', ...o });

// ---------------- the four test cases ----------------

test('Fake joiner: one task per step, correct due dates, first nudge today', async () => {
  const f = installFakes({ today: '2026-11-16', people: [person({ Name: 'TEST fake joiner', Flow: 'Joiner', Country: 'India', 'Worker type': 'Contractor', 'Day 0': '2026-11-30', Status: 'Test' })] });
  await dailyRun();
  const tasks = f.taskRows('TEST fake joiner');
  assert.equal(tasks.length, 14, 'one task per joiner step');
  assert.equal(tasks.find(t => t.Step === 'Send agreement (country template)').Due, '2026-11-16');
  assert.equal(tasks.find(t => t.Step === 'Day 30 check-in').Due, '2026-12-30');
  assert.equal(f.peopleRows()[0]['Day 0 (synced)'], '2026-11-30');
  assert.equal(sentTo(f.calls, /flow started/).length, 1);
  assert.equal(sentTo(f.calls, /No agreement template/).length, 0, 'India contractor template exists');
  const nudge = f.calls.slack.find(m => /🔔 Send TEST fake joiner's contractor agreement for India/.test(m.text));
  assert.ok(nudge, 'hiring coordinator nudged today');
  assert.match(nudge.text, /India contractor template/);
  assert.ok(nudge.blocks.some(b => b.type === 'actions'), 'nudge has a Mark done button');
  assert.ok(sentTo(f.calls, /✅ Lifecycle bot ran/).length === 1, 'heartbeat posted');
});

test('Edge case 1: start date moves, date-based steps reopen, others stay done', async () => {
  const f = installFakes({ today: '2026-10-21',
    people: [person({ Name: 'Demo joiner (Spain)', Flow: 'Joiner', Country: 'Spain', 'Worker type': 'Contractor', 'Day 0': '2026-11-03', 'Day 0 (synced)': '2026-10-27' })],
    tasks: ['Send agreement (country template)', 'Order laptop (deliver 2 days before start)', 'Assign security training']
      .map(Step => ({ person: 'Demo joiner (Spain)', Task: Step, Step, Status: 'Done', 'Offset (days)': -7 })) });
  process.env.TODAY = '2026-10-21';
  await dailyRun();
  const status = Object.fromEntries(f.taskRows('Demo joiner (Spain)').map(t => [t.Step, t.Status]));
  assert.equal(status['Send agreement (country template)'], 'Not started');
  assert.equal(status['Order laptop (deliver 2 days before start)'], 'Not started');
  assert.equal(status['Assign security training'], 'Done');
  const moved = sentTo(f.calls, /📅 Day 0 for \*Demo joiner \(Spain\)\* moved/)[0];
  assert.match(moved.text, /27 Oct → 3 Nov|Oct 27 → Nov 3|27 Oct.*3 Nov/);
  assert.equal(f.peopleRows()[0]['Day 0 (synced)'], '2026-11-03');
});

test('Edge case 2: contractor in a country with no template is flagged at once', async () => {
  const f = installFakes({ today: '2026-11-16', people: [person({ Name: 'TEST contractor in new country (Kenya)', Flow: 'Joiner', Country: 'Kenya', 'Worker type': 'Contractor', 'Day 0': '2026-11-30' })] });
  await dailyRun();
  assert.equal(sentTo(f.calls, /🚩 No agreement template for \*Contractor in Kenya\*/).length, 1);
  assert.match(sentTo(f.calls, /agreement for Kenya/)[0].text, /MISSING for Kenya/);
});

test('Edge case 3: leaver with shared logins, logins appear in the access step', async () => {
  const f = installFakes({ today: '2026-11-16', people: [person({ Name: 'Demo leaver (Brazil)', Flow: 'Leaver', Country: 'Brazil', 'Worker type': 'Employee', 'Day 0': '2026-11-19',
    'Shared logins': 'Canva team login; Ads manager account; shared 1Password vault' })] });
  await dailyRun();
  assert.equal(f.taskRows('Demo leaver (Brazil)').length, 9, 'one task per leaver step');
  assert.match(sentTo(f.calls, /asset and access list/)[0].text, /Canva team login; Ads manager account/);
  assert.equal(sentTo(f.calls, /no shared logins listed/).length, 0);
});

// ---------------- extras from the test plan ----------------

test('Extra: short-notice leaver with no shared logins: past steps pulled to today, red flag', async () => {
  const f = installFakes({ today: '2026-11-16', people: [person({ Name: 'TEST short-notice leaver', Flow: 'Leaver', Country: 'Brazil', 'Worker type': 'Employee', 'Day 0': '2026-11-18' })] });
  await dailyRun();
  const late = f.taskRows('TEST short-notice leaver').filter(t => /Short notice/.test(t.Notes));
  assert.equal(late.length, 3, 'day -7 and day -3 steps pulled to today');
  late.forEach(t => assert.equal(t.Due, '2026-11-16'));
  assert.match(sentTo(f.calls, /flow started/)[0].text, /Short notice: 3 steps are due today/);
  assert.equal(sentTo(f.calls, /🚩 \*TEST short-notice leaver\* is leaving and has no shared logins listed/).length, 1);
  assert.equal(sentTo(f.calls, /overdue/).length, 0, 'nothing is born overdue');
});

test('Extra: escalation ladder, confidential steps stay private', async () => {
  const f = installFakes({ today: '2026-11-16',
    people: [person({ Name: 'Escalation joiner', Flow: 'Joiner', Country: 'Spain', 'Worker type': 'Contractor', 'Day 0': '2026-11-20', 'Day 0 (synced)': '2026-11-20', 'Lead (Slack ID)': 'U0LEADAAA1' })],
    tasks: [
      { person: 'Escalation joiner', Task: 'a', Step: 'Order laptop (deliver 2 days before start)', 'Offset (days)': -5, Status: 'Not started', 'Owner role': 'People Ops' },                 // 1 day late
      { person: 'Escalation joiner', Task: 'b', Step: 'Assign security training', 'Offset (days)': -6, Status: 'Not started', 'Owner role': 'IT' },                                        // 2 days late
      { person: 'Escalation joiner', Task: 'c', Step: 'Agreement signed', 'Offset (days)': -5, Status: 'Not started', 'Owner role': 'Candidate', Critical: true },                         // critical, 1 day late
      { person: 'Escalation joiner', Task: 'd', Step: 'Collect payment details in payments platform', 'Offset (days)': -5, Status: 'Not started', 'Owner role': 'People Ops', Confidential: true },
      { person: 'Escalation joiner', Task: 'e', Step: 'Write a personal welcome message', 'Offset (days)': -4, Status: 'Blocked', 'Owner role': 'Lead', Notes: 'Lead on leave' }
    ] });
  await dailyRun();
  const e1 = sentTo(f.calls, /🟠 Escalation/), e2 = sentTo(f.calls, /🔴 Escalation/);
  assert.equal(e1.length, 3, 'day 1: People Ops lead hears about the three 1-day-late steps');
  assert.deepEqual(e2.map(m => m.channel).sort(), ['U0LEADAAA1', 'U0LEADAAA1'], 'day 2 (or critical day 1): the person\'s lead');
  assert.ok(e2.some(m => /Agreement signed.*critical/.test(m.text)));
  assert.ok(e2.some(m => /Assign security training.*2 day/.test(m.text)));
  const conf = e1.find(m => /confidential step/i.test(m.text));
  assert.ok(conf && !/payment/i.test(conf.text), 'confidential step is not named in escalations');
  assert.match(sentTo(f.calls, /⛔ Blocked/)[0].text, /Lead on leave/);
  assert.match(sentTo(f.calls, /Lifecycle bot ran/)[0].text, /6 escalations/);
});

test('Extra: a nudge that cannot be delivered is flagged in the channel without leaking confidential detail', async () => {
  const f = installFakes({ today: '2026-11-16', failSlackFor: ['U0BUDDYBAD'],
    people: [person({ Name: 'Buddy joiner', Flow: 'Joiner', Country: 'Spain', 'Worker type': 'Contractor', 'Day 0': '2026-11-16', 'Day 0 (synced)': '2026-11-16', 'Buddy (Slack ID)': 'U0BUDDYBAD' })],
    tasks: [{ person: 'Buddy joiner', Task: 'x', Step: 'Buddy intro', 'Offset (days)': 0, Status: 'Not started', 'Owner role': 'Buddy', 'Human moment': true }] });
  await dailyRun();
  const flag = sentTo(f.calls, /⚠️ Could not reach U0BUDDYBAD/)[0];
  assert.ok(flag && flag.channel === CONFIG.CHANNEL);
  assert.match(flag.text, /Buddy joiner starts today/);
});

test('Extra: silent failure is impossible: a Notion outage posts an error with the manual fallback', async () => {
  const f = installFakes({ today: '2026-11-16' });
  const real = globalThis.fetch;
  globalThis.fetch = (url, o) => String(url).includes('api.notion.com') ? Promise.resolve(new Response('{"message":"API token is invalid."}', { status: 401 })) : real(url, o);
  await assert.rejects(dailyRun(), /API token is invalid/);
  assert.match(f.calls.slack.at(-1).text, /❌ Lifecycle bot failed.*\n.*Needs action/);
});

test('Preview mode changes nothing and sends nothing', async () => {
  const f = installFakes({ today: '2026-11-16', people: [person({ Name: 'Preview joiner', Flow: 'Joiner', Country: 'India', 'Worker type': 'Contractor', 'Day 0': '2026-11-30' })] });
  const out = await dailyRun({ dryRun: true });
  assert.equal(f.calls.slack.length, 0);
  assert.equal(f.calls.notionWrites.length, 0);
  assert.ok(out.some(m => m.kind === 'digest'));
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
  installFakes({ today: '2026-11-16' });
  assert.equal((await POST(slackRequest({ type: 'url_verification', challenge: 'abc' }))).status, 200);
  assert.deepEqual(await (await POST(slackRequest({ type: 'url_verification', challenge: 'abc' }))).json(), { challenge: 'abc' });
  assert.equal((await POST(slackRequest(dm('E1', 'hi'), { secret: 'wrong' }))).status, 401);
  assert.equal((await POST(slackRequest(dm('E2', 'hi'), { ts: Math.floor(Date.now() / 1000) - 3600 }))).status, 401, 'replayed request rejected');
  assert.match(await GET().text(), /✅ SLACK_SIGNING_SECRET/);
});

test('Chat: a DM gets one Claude answer grounded in the Notion guides, even when Slack retries', async () => {
  const f = installFakes({ today: '2026-11-16' });
  await POST(slackRequest(dm('E10', 'how do I apply for leave in Brazil?')));
  await POST(slackRequest(dm('E10', 'how do I apply for leave in Brazil?')));                                    // duplicate delivery
  await POST(slackRequest(dm('E10', 'how do I apply for leave in Brazil?'), { headers: { 'x-slack-retry-num': '1' } }));  // Slack retry
  await POST(slackRequest(dm('E11', 'echo', { bot_id: 'B1' })));                                                // the bot's own message
  await drain();
  assert.equal(f.calls.claude.length, 1);
  assert.match(f.calls.claude[0].system, /Answer ONLY from the KNOWLEDGE/);
  assert.match(f.calls.claude[0].system, /Leave policy \| owner: People Ops \| review due/);
  assert.equal(f.calls.slack.length, 1);
  assert.equal(f.calls.slack[0].channel, 'D0TEST');
  assert.match(f.calls.slack[0].text, /Claude answer for: how do I apply for leave in Brazil\?/);
});

test('Chat: an @mention is answered in a thread; a question with no guide is logged as a gap', async () => {
  const f = installFakes({ today: '2026-11-16' });
  await POST(slackRequest({ type: 'event_callback', event_id: 'E20', event: { type: 'app_mention', channel: 'C0GENERAL', user: 'U0ASKER01', text: '<@U0BOT> where is the holiday calendar?', ts: '5.5' } }));
  await drain();
  const answer = f.calls.slack.find(m => m.channel === 'C0GENERAL');
  assert.equal(answer.thread_ts, '5.5');
  assert.equal(f.calls.claude[0].messages[0].content, 'where is the holiday calendar?');
  assert.ok(f.calls.slack.some(m => m.channel === CONFIG.CHANNEL && /Unanswered question/.test(m.text)));
});

test('Chat: if Claude is down the person still gets a reply and People Ops is told', async () => {
  const f = installFakes({ today: '2026-11-16', claudeDown: true });
  await POST(slackRequest(dm('E30', 'can I expense a coworking space?')));
  await drain();
  assert.match(f.calls.slack.find(m => m.channel === 'D0TEST').text, /Sorry, I hit a problem/);
  assert.ok(f.calls.slack.some(m => m.channel === CONFIG.CHANNEL && /Chat answer failed/.test(m.text)));
});

test('/people: private rule-based answer; a leaving question opens a pending row for People Ops to confirm', async () => {
  const f = installFakes({ today: '2026-11-16' });
  const slash = text => slackRequest({ command: '/people', text, user_id: 'U0ASKER01', response_url: 'https://hooks.slack.test/r1' }, { json: false });
  const pay = await (await POST(slash('when do contractors get paid this month?'))).json();
  assert.equal(pay.response_type, 'ephemeral');
  assert.match(pay.text, /Payroll calendar/);
  const leave = await (await POST(slash('my last day is Friday, what happens to my access?'))).json();
  assert.match(leave.text, /Leaver checklist/);
  await drain();
  const row = f.calls.notionWrites.find(w => w.op === 'create' && w.db === 'people');
  assert.equal(row.flat.Status, 'Pending confirmation');
  assert.equal(row.flat.Flow, 'Leaver');
  assert.ok(f.calls.slack.some(m => /asked about their last day via \/people/.test(m.text)));
});

test('Mark done button updates Notion and the Slack message', async () => {
  const f = installFakes({ today: '2026-11-16', people: [person({ Name: 'Button joiner', Flow: 'Joiner', Country: 'India', 'Worker type': 'Contractor', 'Day 0': '2026-11-20' })],
    tasks: [{ person: 'Button joiner', Task: 'x', Step: 'Assign security training', 'Offset (days)': -3, Status: 'Not started', 'Owner role': 'IT' }] });
  const id = f.taskRows('Button joiner')[0]._id;
  const payload = { type: 'block_actions', user: { id: 'U0CLICKER' }, response_url: 'https://hooks.slack.test/r2', actions: [{ action_id: 'mark_done', value: id }] };
  assert.equal((await POST(slackRequest({ payload: JSON.stringify(payload) }, { json: false }))).status, 200);
  await drain();
  assert.equal(f.page(id).Status, 'Done');
  assert.match(f.calls.responses[0].text, /Marked done in Notion by <@U0CLICKER>/);
});
