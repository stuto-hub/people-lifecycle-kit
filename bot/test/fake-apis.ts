/**
 * Stand-ins for Slack, Claude and GitHub, plus test data, so the whole bot runs offline.
 * Steps, guides and questions are the real tracker files; people come from each test.
 */
import { fromTexts, readTexts, personFromRow, setData } from '../lib/store.js';
import type { Data, Row } from '../lib/types.js';

export interface Calls { slack: any[]; updates: any[]; responses: any[]; claude: any[]; github: any[] }

export function installFakes({ joiners = [] as Row[], leavers = [] as Row[], failSlackFor = [] as string[], claudeDown = false,
  dmHistory = [] as any[], csv = '' } = {}) {
  const base = fromTexts(readTexts());
  const data: Data = { ...base, people: [], status: {} };
  for (const [tab, rows] of [['Joiners', joiners], ['Leavers', leavers]] as const)
    for (const row of rows) { const r = personFromRow(row, tab); data.people.push(r.person); Object.assign(data.status, r.status); }
  setData(data);
  const calls: Calls = { slack: [], updates: [], responses: [], claude: [], github: [] };
  let file = csv;                                   // the CSV the fake GitHub serves
  const reply = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  (globalThis as any).fetch = async (url: string | URL, opts: RequestInit = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(String(opts.body)) : {};
    if (u === 'https://slack.com/api/chat.postMessage') {
      calls.slack.push(body);
      return reply(failSlackFor.includes(body.channel) ? { ok: false, error: 'channel_not_found' } : { ok: true, ts: '9' + calls.slack.length + '.0' });
    }
    if (u === 'https://slack.com/api/chat.update') { calls.updates.push(body); return reply({ ok: true }); }
    if (u.startsWith('https://slack.com/api/conversations.')) return reply({ ok: true, messages: dmHistory });
    if (u.startsWith('https://hooks.slack.test/')) { calls.responses.push(body); return reply({ ok: true }); }
    if (u === 'https://api.anthropic.com/v1/messages') {
      calls.claude.push(body);
      if (claudeDown) return reply({ error: { message: 'overloaded' } }, 529);
      return reply({ content: [{ type: 'text', text: 'Claude answer for: ' + body.messages.at(-1).content }] });
    }
    if (u.startsWith('https://api.github.com/')) {
      const method = opts.method || 'GET';
      calls.github.push({ method, url: u, body });
      if (method === 'GET') return reply({ sha: 'sha1', content: Buffer.from(file).toString('base64') });
      file = Buffer.from(body.content, 'base64').toString('utf8');
      return reply({ content: {} }, 200);
    }
    throw new Error('Unexpected fetch ' + u);
  };
  return { calls, data, file: () => file };
}

/** A joiners.csv row with every step Pending unless given. */
export function joinerRow(o: Row = {}): Row {
  const steps = fromTexts(readTexts()).steps.filter(s => s.Flow === 'Joiner');
  const row: Row = { ID: 'J-900', Name: 'Test joiner', Country: 'India', 'Worker type': 'Contractor', 'Day 0': '2026-11-30', Status: 'Active',
    'Added on': '', POC: 'People Ops', 'Lead (Slack ID)': 'U_LEAD_PLACEHOLDER', 'Buddy (Slack ID)': '', Notes: '' };
  for (const s of steps) row[s.id + ' ' + s.Step] = 'Pending';
  for (const [k, v] of Object.entries(o)) { const col = Object.keys(row).find(c => c === k || c.split(' ')[0] === k) || k; row[col] = v; }
  return row;
}

export function leaverRow(o: Row = {}): Row {
  const steps = fromTexts(readTexts()).steps.filter(s => s.Flow === 'Leaver');
  const row: Row = { ID: 'L-900', Name: 'Test leaver', Country: 'Brazil', 'Worker type': 'Employee', 'Day 0': '2026-11-21', Status: 'Active',
    'Added on': '', POC: 'People Ops', 'Lead (Slack ID)': 'U_LEAD_PLACEHOLDER', 'Shared logins': '', Notes: '' };
  for (const s of steps) row[s.id + ' ' + s.Step] = 'Pending';
  for (const [k, v] of Object.entries(o)) { const col = Object.keys(row).find(c => c === k || c.split(' ')[0] === k) || k; row[col] = v; }
  return row;
}
