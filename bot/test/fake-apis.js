/**
 * In-memory stand-ins for Notion, Slack and Claude, so the whole bot can be tested
 * offline with fictional people. Replaces global fetch; records every call.
 */
import { readFileSync } from 'node:fs';
import { CONFIG } from '../lib/config.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const diff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DAY);

const SCHEMA = {
  people: { Name: 'title', Flow: 'select', Country: 'select', 'Worker type': 'select', 'Day 0': 'date', 'Day 0 (synced)': 'date',
    'Lead (Slack ID)': 'rich_text', 'Buddy (Slack ID)': 'rich_text', 'Shared logins': 'rich_text', Status: 'select', Notes: 'rich_text', Tasks: 'relation' },
  steps: { Step: 'title', Flow: 'select', 'Offset (days)': 'number', 'Owner role': 'select', 'Human moment': 'checkbox', Critical: 'checkbox',
    Confidential: 'checkbox', 'Recheck if day 0 moves': 'checkbox', 'Nudge text': 'rich_text' },
  tasks: { Task: 'title', Person: 'relation', Step: 'rich_text', 'Offset (days)': 'number', Status: 'select', 'Owner role': 'select',
    Critical: 'checkbox', 'Human moment': 'checkbox', Confidential: 'checkbox', Notes: 'rich_text',
    Due: 'formula', Health: 'formula', 'Needs action': 'formula', 'Escalate to': 'formula' },
  guides: { Guide: 'title', Owner: 'select', 'Last reviewed': 'date', Link: 'url', 'Review status': 'formula' },
  questions: { Question: 'title', Guide: 'rich_text', Keywords: 'rich_text', Answer: 'rich_text', Action: 'select', Confidential: 'checkbox' }
};
const DB_NAME = Object.fromEntries(Object.entries(CONFIG.DB).map(([k, v]) => [v, k]));

export function installFakes({ today, people = [], tasks = [], failSlackFor = [], claudeDown = false, dmHistory = [] }) {
  let n = 0;
  const pages = [];
  const calls = { slack: [], updates: [], responses: [], notionWrites: [], claude: [] };
  const add = (db, flat) => { const id = db + '-' + (++n); pages.push({ id, db, url: 'https://notion.test/' + id, p: { ...flat } }); return id; };

  fixtures.steps.forEach(s => add('steps', s));
  fixtures.guides.forEach(g => add('guides', g));
  fixtures.questions.forEach(q => add('questions', q));
  const ids = {};
  people.forEach(p => { ids[p.Name] = add('people', p); });
  tasks.forEach(t => add('tasks', { ...t, Person: [ids[t.person]], person: undefined }));

  const byId = id => pages.find(x => x.id === id);
  const computed = (pg) => {
    const f = { ...pg.p, _id: pg.id };
    if (pg.db === 'people') f.Tasks = pages.filter(x => x.db === 'tasks' && (x.p.Person || []).includes(pg.id)).map(x => x.id);
    if (pg.db === 'tasks') {
      const person = byId((f.Person || [])[0]);
      f.Due = person && person.p['Day 0'] ? addDays(person.p['Day 0'], f['Offset (days)']) : '';
      const late = f.Due ? diff(today, f.Due) : -1;
      f['Needs action'] = f.Status !== 'Done' && late >= 0;
      f.Health = f.Status === 'Done' ? '✅ Done' : late > 0 ? '🔴 ' + late + 'd overdue' : late === 0 ? '🔔 Due today' : '⚪ Upcoming';
      f['Escalate to'] = f['Needs action'] && late >= 2 ? '🔴 lead' : '';
    }
    if (pg.db === 'guides') f['Review status'] = !f['Last reviewed'] ? '⚪ Never reviewed' : diff(today, f['Last reviewed']) > 180 ? '🟠 Review due' : '✅ Current';
    return f;
  };
  const render = (pg) => {
    const schema = SCHEMA[pg.db]; const f = computed(pg); const properties = {};
    for (const [k, type] of Object.entries(schema)) {
      const v = f[k];
      if (type === 'title' || type === 'rich_text') properties[k] = { type, [type]: v ? [{ plain_text: String(v) }] : [] };
      else if (type === 'select') properties[k] = { type, select: v ? { name: v } : null };
      else if (type === 'date') properties[k] = { type, date: v ? { start: v } : null };
      else if (type === 'relation') properties[k] = { type, relation: (v || []).map(id => ({ id })) };
      else if (type === 'formula') properties[k] = { type, formula: typeof v === 'boolean' ? { type: 'boolean', boolean: v }
        : k === 'Due' ? { type: 'date', date: v ? { start: v } : null } : { type: 'string', string: v || '' } };
      else properties[k] = { type, [type]: v ?? null };
    }
    return { id: pg.id, url: pg.url, properties };
  };
  const unwrap = (prop) => {
    if (prop.title) return prop.title.map(t => t.text.content).join('');
    if (prop.rich_text) return prop.rich_text.map(t => t.text.content).join('');
    if ('select' in prop) return prop.select && prop.select.name;
    if ('date' in prop) return prop.date && prop.date.start;
    if ('relation' in prop) return prop.relation.map(r => r.id);
    if ('checkbox' in prop) return prop.checkbox;
    if ('number' in prop) return prop.number;
    return null;
  };
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (url.startsWith('https://api.notion.com/v1')) {
      const path = url.slice('https://api.notion.com/v1'.length); const method = opts.method;
      let m;
      if ((m = path.match(/^\/databases\/(\w+)\/query$/))) {
        let rows = pages.filter(x => x.db === DB_NAME[m[1]]);
        const f = body.filter;
        if (f && f.relation) rows = rows.filter(x => (x.p[f.property] || []).includes(f.relation.contains));
        if (f && f.select && f.select.does_not_equal) rows = rows.filter(x => x.p[f.property] !== f.select.does_not_equal);
        return reply({ results: rows.map(render), has_more: false });
      }
      if (path === '/pages' && method === 'POST') {
        const db = DB_NAME[body.parent.database_id]; const flat = {};
        for (const [k, v] of Object.entries(body.properties)) flat[k] = unwrap(v);
        const id = add(db, flat); calls.notionWrites.push({ op: 'create', db, id, flat });
        return reply({ id });
      }
      if ((m = path.match(/^\/pages\/(.+)$/)) && method === 'PATCH') {
        const pg = byId(m[1]); if (!pg) return reply({ message: 'not found' }, 404);
        for (const [k, v] of Object.entries(body.properties)) pg.p[k] = unwrap(v);
        calls.notionWrites.push({ op: 'update', db: pg.db, id: pg.id, props: Object.keys(body.properties) });
        return reply({ id: pg.id });
      }
      if (path.startsWith('/databases/') && method === 'PATCH') { calls.notionWrites.push({ op: 'schema', props: Object.keys(body.properties) }); return reply({}); }
      return reply({ message: 'unexpected ' + method + ' ' + path }, 400);
    }
    if (url === 'https://slack.com/api/chat.postMessage') {
      calls.slack.push(body);
      return reply(failSlackFor.includes(body.channel) ? { ok: false, error: 'channel_not_found' } : { ok: true, ts: '9' + calls.slack.length + '.0' });
    }
    if (url === 'https://slack.com/api/chat.update') { calls.updates.push(body); return reply({ ok: true }); }
    if (url.startsWith('https://slack.com/api/conversations.')) return reply({ ok: true, messages: dmHistory });
    if (url.startsWith('https://hooks.slack.test/')) { calls.responses.push(body); return reply({ ok: true }); }
    if (url === 'https://api.anthropic.com/v1/messages') {
      calls.claude.push(body);
      if (claudeDown) return reply({ error: { message: 'overloaded' } }, 529);
      return reply({ content: [{ type: 'text', text: 'Claude answer for: ' + body.messages[0].content }] });
    }
    throw new Error('Unexpected fetch ' + url);
  };

  const peopleRows = () => pages.filter(x => x.db === 'people').map(computed);
  const taskRows = name => pages.filter(x => x.db === 'tasks' && (x.p.Person || []).includes(ids[name])).map(computed);
  return { calls, ids, peopleRows, taskRows, page: id => computed(byId(id)) };
}
