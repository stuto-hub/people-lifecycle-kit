/**
 * The test plan, automated. Fictional people only; Slack, Claude and GitHub are faked.
 * Run: npm test
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { installFakes, joinerRow, leaverRow } from './fake-apis.js';
import { CONFIG } from '../lib/config.js';
import { dailyRun } from '../lib/lifecycle.js';
import { buildTasks, setData, setCell, fromTexts, readTexts } from '../lib/store.js';
import { diffTracker, onTrackerChange } from '../lib/tracker-events.js';
import { parseCsv, stringifyCsv, setCellInCsv } from '../lib/csv.js';
import { POST, GET, drain } from '../api/slack.js';
import type { Row } from '../lib/types.js';

const T = '2026-11-16';
const SECRET = 'test-signing-secret';
beforeEach(() => {
  Object.assign(process.env, { SLACK_BOT_TOKEN: 'test', ANTHROPIC_API_KEY: 'test', SLACK_SIGNING_SECRET: SECRET, TODAY: T });
  delete process.env.TRACKER_TOKEN;
});
const sentTo = (calls: { slack: any[] }, re: RegExp) => calls.slack.filter(m => re.test(m.text));
const run = () => dailyRun({ today: T });
/** Saving a row in the tracker: Status changed from "Not started". */
const activate = (row: Row, tab: 'Joiners' | 'Leavers' = 'Joiners') =>
  onTrackerChange({ tab, columns: ['Status'], oldValue: 'Not started', value: row.Status, row }, T);

// ---------------- the tracker itself ----------------

test('Tracker files: every row, step column and setting is read', () => {
  const d = fromTexts(readTexts());
  assert.equal(d.people.filter(p => p.Flow === 'Joiner').length, 3);
  assert.equal(d.people.filter(p => p.Flow === 'Leaver').length, 2);
  assert.equal(d.steps.length, 23);
  assert.equal(d.status['J-102::J01'].Status, 'Done');
  assert.equal(d.status['L-201::L02'].Status, 'Blocked');
  assert.equal(d.steps.find(s => s.id === 'J01')!['Offset (days)'], -14);
  assert.equal(d.guides.length, 8);
  assert.equal(d.questions.length, 10);
});

test('CSV: quotes, commas and line breaks survive a round trip; one cell can be changed', () => {
  const rows = [['ID', 'Notes', 'J01 Send agreement'], ['J-1', 'Lead on leave, back "Thursday"', 'Pending']];
  assert.deepEqual(parseCsv(stringifyCsv(rows)), rows);
  const next = setCellInCsv(stringifyCsv(rows), 'J-1', 'J01', 'Done')!;
  assert.equal(parseCsv(next)[1][2], 'Done');
  assert.equal(setCellInCsv(next, 'J-404', 'J01', 'Done'), null);
});

test('Changes: a new row and single-cell edits are told apart', () => {
  const before = stringifyCsv([['ID', 'Name', 'Day 0'], ['J-1', 'A', '2026-11-20']]);
  const after = stringifyCsv([['ID', 'Name', 'Day 0'], ['J-1', 'A', '2026-11-27'], ['J-2', 'B', '2026-12-01']]);
  const c = diffTracker('Joiners', before, after);
  assert.equal(c.length, 2);
  assert.deepEqual([c[0].columns, c[0].oldValue, c[0].value], [['Day 0'], '2026-11-20', '2026-11-27']);
  assert.equal(c[1].row.ID, 'J-2');
  assert.ok(c[1].columns.length > 1, 'a new row is one change');
});

// ---------------- the four test cases ----------------

test('Fake joiner: flow starts on save, owners assigned, first nudge today, Added on stamped', async () => {
  const row = joinerRow({ ID: 'J-101', Name: 'TEST fake joiner', Status: 'Test', 'Day 0': '2026-11-30' });
  const f = installFakes({ joiners: [row] });
  await activate(row);
  const started = sentTo(f.calls, /Joiner flow started for \*TEST fake joiner\*/)[0];
  assert.ok(started);
  assert.match(started.text, /Owners assigned[\s\S]*Hiring coordinator\*: Send agreement \(country template\) \(16 Nov\)/);
  assert.match(started.text, /Lead\*: .*Day 30 check-in \(30 Dec\)/);
  assert.equal(sentTo(f.calls, /No agreement template/).length, 0, 'India contractor template exists');
  const nudge = f.calls.slack.find(m => /🔔 Send TEST fake joiner's contractor agreement for India/.test(m.text));
  assert.ok(nudge && nudge.blocks.some((b: any) => b.type === 'actions'), 'nudged today, with a Mark done button');
  assert.equal(f.data.people[0]['Added on'], T, 'Added on stamped');
  assert.equal(buildTasks(f.data, T).length, 14, 'one task per joiner step');
});

test('Edge case 1: start date moves, date-based steps go back to Pending, others stay done', async () => {
  const row = joinerRow({ ID: 'J-102', Name: 'Demo joiner (Spain)', Country: 'Spain', 'Day 0': '2026-11-27', J01: 'Done', J02: 'Done', J04: 'Done', J06: 'Done' });
  const f = installFakes({ joiners: [row] });
  await onTrackerChange({ tab: 'Joiners', columns: ['Day 0'], oldValue: '2026-11-20', value: '2026-11-27', row }, T);
  const msg = sentTo(f.calls, /📅 Day 0 for \*Demo joiner \(Spain\)\* moved 20 Nov → 27 Nov/)[0];
  assert.match(msg.text, /Send agreement.*Agreement signed.*Order laptop/);
  assert.equal(f.data.status['J-102::J04'].Status, 'Pending');
  assert.equal(f.data.status['J-102::J06'].Status, 'Done', 'security training is not date-dependent');
  const laptop = buildTasks(f.data, T).find(t => t._id === 'J-102::J04')!;
  assert.equal(laptop.Due, '2026-11-20', 'due date follows the new day 0');
});

test('Edge case 2: contractor in a country with no template is flagged at once', async () => {
  const row = joinerRow({ ID: 'J-103', Name: 'TEST contractor (Kenya)', Country: 'Kenya', 'Day 0': '2026-11-30' });
  const f = installFakes({ joiners: [row] });
  await activate(row);
  assert.equal(sentTo(f.calls, /🚩 No agreement template for \*Contractor in Kenya\*/).length, 1);
  assert.match(sentTo(f.calls, /agreement for Kenya/)[0].text, /MISSING for Kenya/);
});

test('Edge case 3: leaver with shared logins, logins appear in the access step', async () => {
  const f = installFakes({ leavers: [leaverRow({ ID: 'L-201', Name: 'Demo leaver (Brazil)', 'Day 0': '2026-11-19', 'Added on': '2026-11-05',
    'Shared logins': 'Canva team login; Ads manager account; shared 1Password vault', L01: 'Done', L02: 'Done' })] });
  await run();
  assert.match(sentTo(f.calls, /asset and access list/)[0].text, /Canva team login; Ads manager account/);
  assert.equal(sentTo(f.calls, /no shared logins listed/).length, 0);
});

// ---------------- extras ----------------

test('Extra: short-notice leaver with no shared logins: past steps pulled to today, red flag', async () => {
  const row = leaverRow({ ID: 'L-202', Name: 'TEST short-notice leaver', 'Day 0': '2026-11-18' });
  const f = installFakes({ leavers: [row] });
  await activate(row, 'Leavers');
  assert.match(sentTo(f.calls, /Leaver flow started/)[0].text, /Short notice: 3 steps are due today/);
  assert.equal(sentTo(f.calls, /🚩 \*TEST short-notice leaver\* is leaving and has no shared logins listed/).length, 1);
  assert.equal(sentTo(f.calls, /overdue/).length, 0, 'nothing is born overdue');
  assert.ok(sentTo(f.calls, /exit call/i).length, 'the exit call is nudged today');
});

test('Extra: switching between Active and Test does not restart a flow; no Day 0 is flagged', async () => {
  const row = joinerRow();
  const f = installFakes({ joiners: [row] });
  await onTrackerChange({ tab: 'Joiners', columns: ['Status'], oldValue: 'Active', value: 'Test', row: { ...row, Status: 'Test' } }, T);
  assert.equal(sentTo(f.calls, /flow started/).length, 0);
  await activate({ ...row, 'Day 0': '' });
  assert.equal(sentTo(f.calls, /has no Day 0/).length, 1);
});

test('Extra: escalation ladder, confidential steps stay private', async () => {
  // day 0 = 22 Nov: payment details and laptop (day -7) were due 15 Nov, so they are 1 day late today
  const f = installFakes({ joiners: [joinerRow({ ID: 'J-1', Name: 'Escalation joiner', Country: 'Spain', 'Day 0': '2026-11-22', 'Added on': '2026-11-01', J01: 'Done', J02: 'Done' })] });
  await run();
  const e1 = sentTo(f.calls, /🟠 Escalation/);
  assert.equal(e1.length, 2, 'day 1: People Ops lead hears about both 1-day-late steps');
  const conf = e1.find(m => /confidential step/i.test(m.text));
  assert.ok(conf && !/payment/i.test(conf.text), 'confidential step is not named');
  const f2 = installFakes({ joiners: [joinerRow({ ID: 'J-2', Name: 'Critical joiner', Country: 'Spain', 'Day 0': '2026-11-25', 'Added on': '2026-11-01', 'Lead (Slack ID)': 'U0LEADAAA1', J01: 'Done' })] });
  await run();   // agreement signed (day -10, critical) was due 15 Nov: 1 day late goes straight to the lead
  const e2 = sentTo(f2.calls, /🔴 Escalation/);
  assert.equal(e2.length, 1);
  assert.equal(e2[0].channel, 'U0LEADAAA1');
  assert.match(e2[0].text, /Agreement signed.*critical/);
});

test('Extra: Blocked alerts the leads, Done is logged, confidential stays private', async () => {
  const row = joinerRow({ ID: 'J-5', Name: 'Blocked joiner', Notes: 'Lead on leave', J02: 'Blocked' });
  const f = installFakes({ joiners: [row] });
  await onTrackerChange({ tab: 'Joiners', columns: [Object.keys(row).find(c => c.startsWith('J02'))!], oldValue: 'Pending', value: 'Blocked', row }, T);
  assert.match(sentTo(f.calls, /⛔ Blocked/)[0].text, /Agreement signed.*Lead on leave/);
  const done = { ...row, [Object.keys(row).find(c => c.startsWith('J03'))!]: 'Done' };
  await onTrackerChange({ tab: 'Joiners', columns: [Object.keys(row).find(c => c.startsWith('J03'))!], oldValue: 'Pending', value: 'Done', row: done }, T);
  const log = sentTo(f.calls, /done for/)[0];
  assert.match(log.text, /A confidential step done for \*Blocked joiner\* \(7% complete\)/);
  assert.ok(!/payment/i.test(log.text));
});

test('Extra: a nudge that cannot be delivered is flagged in the channel', async () => {
  const f = installFakes({ failSlackFor: ['U0BUDDYBAD'],
    joiners: [joinerRow({ Name: 'Buddy joiner', Country: 'Spain', 'Day 0': T, 'Added on': '2026-11-01', 'Buddy (Slack ID)': 'U0BUDDYBAD',
      J01: 'Done', J02: 'Done', J03: 'Done', J04: 'Done', J05: 'Done', J06: 'Done', J07: 'Done' })] });
  await run();
  const flag = sentTo(f.calls, /⚠️ Could not reach U0BUDDYBAD/)[0];
  assert.ok(flag && flag.channel === CONFIG.CHANNEL);
});

test('Extra: silent failure is impossible: a broken tracker posts an error with the manual fallback', async () => {
  const f = installFakes();
  (f.data as any).people = null;
  await assert.rejects(run());
  assert.match(f.calls.slack.at(-1).text, /❌ Lifecycle bot failed[\s\S]*tracker/);
});

test('Preview mode sends nothing; the real tracker runs cleanly', async () => {
  const f = installFakes();
  setData(null);
  const out = await dailyRun({ today: T, dryRun: true });
  assert.equal(f.calls.slack.length, 0);
  assert.ok(out.some(m => m.kind === 'digest') && out.some(m => m.kind === 'blocked'));
});

test('Mark done writes Done into the tracker as a GitHub commit', async () => {
  const csv = stringifyCsv([['ID', 'Name', 'J04 Order laptop'], ['J-102', 'Demo joiner (Spain)', 'Pending']]);
  const f = installFakes({ csv });
  setData(null);
  process.env.TRACKER_TOKEN = 'test';
  assert.equal(await setCell('J-102', 'J04', 'Done', 'test'), true);
  const put = f.calls.github.find(c => c.method === 'PUT');
  assert.match(put.url, /bot\/tracker\/joiners\.csv$/);
  assert.match(put.body.message, /J-102 J04 = Done/);
  assert.equal(parseCsv(f.file())[1][2], 'Done');
});

// ---------------- Slack endpoint (Vercel function) ----------------

function slackRequest(body: any, { json = true, secret = SECRET, ts = Math.floor(Date.now() / 1000), headers = {} as Record<string, string> } = {}) {
  const raw = json ? JSON.stringify(body) : new URLSearchParams(body).toString();
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update('v0:' + ts + ':' + raw).digest('hex');
  return new Request('https://bot.test/api/slack', { method: 'POST', body: raw, headers: {
    'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
    'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig, ...headers } });
}
const dm = (id: string, text: string, extra = {}) => ({ type: 'event_callback', event_id: id, event: { type: 'message', channel_type: 'im', channel: 'D0TEST', user: 'U0ASKER01', text, ts: '1.1', ...extra } });

test('Security: only signed, fresh requests from Slack are accepted', async () => {
  installFakes();
  assert.deepEqual(await (await POST(slackRequest({ type: 'url_verification', challenge: 'abc' }))).json(), { challenge: 'abc' });
  assert.equal((await POST(slackRequest(dm('E1', 'hi'), { secret: 'wrong' }))).status, 401);
  assert.equal((await POST(slackRequest(dm('E2', 'hi'), { ts: Math.floor(Date.now() / 1000) - 3600 }))).status, 401, 'replayed request rejected');
  assert.match(await GET().text(), /✅ SLACK_SIGNING_SECRET/);
});

test('Chat: a DM gets one Claude answer grounded in the guides, even when Slack retries', async () => {
  const f = installFakes();
  await POST(slackRequest(dm('E10', 'how do I apply for leave in Brazil?')));
  await POST(slackRequest(dm('E10', 'how do I apply for leave in Brazil?')));
  await POST(slackRequest(dm('E10', 'how do I apply for leave in Brazil?'), { headers: { 'x-slack-retry-num': '1' } }));
  await POST(slackRequest(dm('E11', 'echo', { bot_id: 'B1' })));
  await drain();
  assert.equal(f.calls.claude.length, 1);
  assert.match(f.calls.claude[0].system, /Answer ONLY from the KNOWLEDGE/);
  assert.match(f.calls.claude[0].system, /Leave policy \| owner: People Ops \| review due/);
  assert.equal(f.calls.slack.length, 1, 'one "Thinking…" message');
  assert.match(f.calls.updates[0].text, /Claude answer for: how do I apply for leave in Brazil\?/);
});

test('Chat: follow-up questions carry the earlier conversation and are not logged as gaps', async () => {
  const now = Math.floor(Date.now() / 1000);
  const f = installFakes({ dmHistory: [
    { ts: String(now - 60), bot_id: 'B0BOT', text: 'Request leave in the leave tool.' },
    { ts: String(now - 90), user: 'U0ASKER01', text: 'how do I apply for leave?' },
    { ts: String(now - 99999), user: 'U0ASKER01', text: 'an old unrelated question' } ] });
  await POST(slackRequest(dm('E12', 'and in Spain?', { ts: String(now) })));
  await drain();
  assert.deepEqual(f.calls.claude[0].messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
  assert.ok(!f.calls.slack.some(m => /Unanswered question/.test(m.text)));
});

test('Chat: an @mention is answered in a thread; a question with no guide is logged as a gap', async () => {
  const f = installFakes();
  await POST(slackRequest({ type: 'event_callback', event_id: 'E20', event: { type: 'app_mention', channel: 'C0GENERAL', user: 'U0ASKER01', text: '<@U0BOT> where is the holiday calendar?', ts: '5.5' } }));
  await drain();
  assert.equal(f.calls.slack.find(m => m.channel === 'C0GENERAL').thread_ts, '5.5');
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
  const slash = (text: string) => slackRequest({ command: '/people', text, user_id: 'U0ASKER01', response_url: 'https://hooks.slack.test/r1' }, { json: false });
  const pay = await (await POST(slash('when do contractors get paid this month?'))).json();
  assert.equal(pay.response_type, 'ephemeral');
  assert.match(pay.text, /Payroll calendar/);
  assert.match((await (await POST(slash('my last day is Friday, what happens to my access?'))).json()).text, /Leaver checklist/);
  await drain();
  assert.ok(f.calls.slack.some(m => /asked about their last day via \/people/.test(m.text)));
});

test('Mark done button updates the tracker and the Slack message', async () => {
  const f = installFakes({ joiners: [joinerRow({ ID: 'J-7' })] });
  const payload = { type: 'block_actions', user: { id: 'U0CLICKER' }, response_url: 'https://hooks.slack.test/r2', actions: [{ action_id: 'mark_done', value: 'J-7::J06' }] };
  assert.equal((await POST(slackRequest({ payload: JSON.stringify(payload) }, { json: false }))).status, 200);
  await drain();
  assert.equal(f.data.status['J-7::J06'].Status, 'Done');
  assert.match(f.calls.responses[0].text, /Marked done by <@U0CLICKER>/);
});
