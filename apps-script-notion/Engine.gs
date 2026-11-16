/**
 * People Ops lifecycle bot: Notion (system of record) -> Slack (nudges, escalations, /people).
 * Runs on Google Apps Script, free. Logic for /people matching lives in Core.gs.
 *
 * Script properties (Project Settings > Script properties), pasted by a human:
 *   NOTION_TOKEN     secret of the Notion connection "People Ops Bot"
 *   SLACK_BOT_TOKEN  xoxb-... from the Slack app (OAuth & Permissions)
 */
const CONFIG = {
  TZ: 'Asia/Kolkata',
  DB: {
    people:    '41ad2f02b3a6809a8ea2cdad215d5dd2',
    steps:     '41ad2f02b3a6808699eaf2df32497d4d',
    tasks:     '41ad2f02b3a6809595bbe87a1cd78f5c',
    guides:    '41ad2f02b3a6803aa2fbd6bd03ec3982',
    questions: '41ad2f02b3a68062b082d63172c1166b'
  },
  CHANNEL: 'C0CJ554MD3K',            // #people-ops-alerts
  ROLES: {                           // role -> Slack member ID (demo: everyone is you)
    'People Ops': 'U0AGY9M1J8M', 'People Ops lead': 'U0AGY9M1J8M',
    'Hiring coordinator': 'U0AGY9M1J8M', 'IT': 'U0AGY9M1J8M', 'Finance': 'U0AGY9M1J8M'
  },
  FALLBACK_USER: 'U0AGY9M1J8M',    // used when a Lead/Buddy ID in Notion is a placeholder
  TEMPLATES: ['Spain|Contractor', 'Brazil|Employee', 'India|Contractor', 'United States|Contractor'],
  HUB_URL: 'https://app.notion.com/p/People-Ops-Hub-41ad2f02b3a680a2a2ece93b6eee8ec5',
  NEEDS_ACTION_URL: 'https://app.notion.com/p/41ad2f02b3a6809595bbe87a1cd78f5c'
};

// ---------------- helpers ----------------
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function todayIso_() { return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd'); }
function isSlackId_(id) { return /^[UWC][A-Z0-9]{6,}$/.test(String(id || '')); }

function notion_(method, path, body) {
  const res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, {
    method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('NOTION_TOKEN'), 'Notion-Version': '2022-06-28' },
    payload: body ? JSON.stringify(body) : undefined });
  const j = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 300) throw new Error('Notion ' + path + ': ' + (j.message || res.getContentText()));
  return j;
}
function queryAll_(db, filter) {
  let out = [], cursor = null;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const j = notion_('post', '/databases/' + db + '/query', body);
    out = out.concat(j.results); cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out.map(row_);
}
function val_(p) {
  if (!p) return '';
  switch (p.type) {
    case 'title': return p.title.map(t => t.plain_text).join('');
    case 'rich_text': return p.rich_text.map(t => t.plain_text).join('');
    case 'select': return p.select ? p.select.name : '';
    case 'status': return p.status ? p.status.name : '';
    case 'number': return p.number;
    case 'checkbox': return p.checkbox;
    case 'date': return p.date ? p.date.start.slice(0, 10) : '';
    case 'url': return p.url || '';
    case 'relation': return p.relation.map(r => r.id);
    case 'formula': { const f = p.formula; return f.type === 'date' ? (f.date ? f.date.start.slice(0, 10) : '') : f[f.type]; }
    default: return '';
  }
}
function row_(page) { const o = { _id: page.id, _url: page.url }; Object.keys(page.properties).forEach(k => o[k] = val_(page.properties[k])); return o; }
const T = s => [{ type: 'text', text: { content: String(s || '') } }];

// ---------------- Slack ----------------
function send_(m) {
  if (!m || !m.to) return;
  const body = { channel: m.to, text: m.text, unfurl_links: false };
  if (m.taskId) {
    body.blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: m.text } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', action_id: 'mark_done', value: m.taskId, text: { type: 'plain_text', text: 'Mark done ✅' } },
        { type: 'button', action_id: 'open', url: m.url, text: { type: 'plain_text', text: 'Open in Notion' } } ] } ];
  }
  const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post', contentType: 'application/json; charset=utf-8', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('SLACK_BOT_TOKEN') }, payload: JSON.stringify(body) });
  const j = JSON.parse(res.getContentText() || '{}');
  console.log((j.ok ? 'sent ' : 'FAILED ') + m.kind + ' -> ' + m.to + (j.ok ? '' : ' ' + j.error));
  if (!j.ok && m.to !== CONFIG.CHANNEL) {
    send_({ to: CONFIG.CHANNEL, kind: 'flag', text: '⚠️ Could not reach ' + m.to + ' (' + j.error + '). ' +
      (m.confidential ? 'A confidential step needs attention; see Notion.' : 'Message was: ' + m.text) });
  }
}

function owner_(role, person) {
  let id = role === 'Lead' ? person['Lead (Slack ID)'] : role === 'Buddy' ? person['Buddy (Slack ID)']
         : role === 'Candidate' ? CONFIG.ROLES['People Ops'] : CONFIG.ROLES[role];
  if (isSlackId_(id)) return { id: id, note: '' };
  return { id: CONFIG.FALLBACK_USER, note: '_(demo: would go to ' + (role === 'Candidate' ? 'People Ops, to chase the candidate by email' : role) + ')_ ' };
}
function fill_(tpl, v) { return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (v[k] === undefined || v[k] === '') ? '(not set)' : v[k]); }

// ---------------- 1. new people -> tasks (the trigger) ----------------
function createMissingTasks_(people, steps, today, out) {
  people.filter(p => /active|test/i.test(p.Status) && p['Day 0'] && (!p.Tasks || !p.Tasks.length)).forEach(p => {
    const flow = p.Flow; let compressed = 0;
    steps.filter(s => s.Flow === flow).forEach(s => {
      let offset = Number(s['Offset (days)']); let note = '';
      if (Core.diffDays(Core.addDays(p['Day 0'], offset), today) < 0) { offset = Core.diffDays(today, p['Day 0']); note = 'Short notice: due date pulled to today'; compressed++; }
      notion_('post', '/pages', { parent: { database_id: CONFIG.DB.tasks }, properties: {
        'Task': { title: T(p.Name + ' · ' + s.Step) }, 'Person': { relation: [{ id: p._id }] },
        'Step': { rich_text: T(s.Step) }, 'Offset (days)': { number: offset },
        'Status': { select: { name: 'Not started' } }, 'Owner role': { select: { name: s['Owner role'] } },
        'Critical': { checkbox: !!s.Critical }, 'Human moment': { checkbox: !!s['Human moment'] },
        'Confidential': { checkbox: !!s.Confidential }, 'Notes': { rich_text: T(note) } } });
    });
    notion_('patch', '/pages/' + p._id, { properties: { 'Day 0 (synced)': { date: { start: p['Day 0'] } } } });
    out.push({ to: CONFIG.CHANNEL, kind: 'flow_started', text: '🟢 ' + flow + ' flow started for *' + p.Name + '* (' + p.Country + ', ' + p['Worker type'] +
      '), day 0 = ' + Core.pretty(p['Day 0']) + '.' + (compressed ? ' ⚠️ Short notice: ' + compressed + ' steps are due today.' : '') + ' <' + p._url + '|Open>' });
    if (flow === 'Joiner' && CONFIG.TEMPLATES.indexOf(p.Country + '|' + p['Worker type']) < 0)
      out.push({ to: CONFIG.CHANNEL, kind: 'flag', text: '🚩 No agreement template for *' + p['Worker type'] + ' in ' + p.Country + '*. A human checks local rules before the agreement goes out.' });
    if (flow === 'Leaver' && !p['Shared logins'])
      out.push({ to: CONFIG.CHANNEL, kind: 'flag', text: '🚩 *' + p.Name + '* is leaving and has no shared logins listed. Ask the lead to confirm before the access step.' });
  });
}

// ---------------- 2. day 0 moved -> reopen date-dependent steps ----------------
function handleDateMoves_(people, steps, today, out) {
  const recheck = steps.filter(s => s['Recheck if day 0 moves']).map(s => s.Step);
  people.filter(p => p['Day 0'] && p['Day 0 (synced)'] && p['Day 0'] !== p['Day 0 (synced)']).forEach(p => {
    const tasks = queryAll_(CONFIG.DB.tasks, { property: 'Person', relation: { contains: p._id } });
    const reopened = [];
    tasks.filter(t => t.Status === 'Done' && recheck.indexOf(t.Step) >= 0).forEach(t => {
      notion_('patch', '/pages/' + t._id, { properties: { 'Status': { select: { name: 'Not started' } }, 'Notes': { rich_text: T('Reopened: day 0 moved from ' + Core.pretty(p['Day 0 (synced)'])) } } });
      reopened.push(t.Step);
    });
    notion_('patch', '/pages/' + p._id, { properties: { 'Day 0 (synced)': { date: { start: p['Day 0'] } } } });
    out.push({ to: CONFIG.CHANNEL, kind: 'date_moved', text: '📅 Day 0 for *' + p.Name + '* moved ' + Core.pretty(p['Day 0 (synced)']) + ' → ' + Core.pretty(p['Day 0']) +
      '. All due dates re-dated.' + (reopened.length ? ' Reopened to recheck: ' + reopened.join(', ') + '.' : '') });
  });
}

// ---------------- 3. nudges + escalations ----------------
function planNudges_(tasks, peopleById, stepsByName, today, out) {
  tasks.forEach(t => {
    if (t.Status === 'Done' || !t.Due) return;
    const p = peopleById[(t.Person || [])[0]]; if (!p || !/active|test/i.test(p.Status)) return;
    const s = stepsByName[t.Step] || {}; const late = Core.diffDays(today, t.Due);
    if (late < 0) return;
    const o = owner_(t['Owner role'], p);
    const v = { name: p.Name, country: p.Country, worker_type: String(p['Worker type'] || '').toLowerCase(), day0: Core.pretty(p['Day 0']),
      deliver_by: Core.pretty(Core.addDays(p['Day 0'], -2)), shared_logins: p['Shared logins'] || 'NONE LISTED, confirm with the lead',
      template: CONFIG.TEMPLATES.indexOf(p.Country + '|' + p['Worker type']) >= 0 ? p.Country + ' ' + String(p['Worker type']).toLowerCase() + ' template' : 'MISSING for ' + p.Country };
    const human = t['Human moment'], conf = t.Confidential, crit = t.Critical;
    const what = conf ? 'A confidential step for *' + p.Name + '*' : '*' + t.Step + '* for *' + p.Name + '*';
    if (t.Status === 'Blocked') {
      if (late >= 0) out.push({ to: CONFIG.ROLES['People Ops lead'], kind: 'blocked', text: '⛔ Blocked: ' + what + '. ' + (conf ? '' : (t.Notes || '')) + ' <' + t._url + '|Open>' });
      return;
    }
    const text = late === 0 ? (human ? '🤝 ' : '🔔 ') + fill_(s['Nudge text'], v) + (human ? ' _(Human moment: please do this personally.)_' : '')
                            : '⏰ ' + late + ' day' + (late > 1 ? 's' : '') + ' overdue: ' + fill_(s['Nudge text'], v);
    out.push({ to: o.id, kind: late === 0 ? 'nudge' : 'overdue', taskId: t._id, url: t._url, confidential: conf, text: o.note + text });
    // Stateless escalation: fires once, on the day the step crosses each threshold.
    const lead = owner_('Lead', p);
    if (late === 1) out.push({ to: CONFIG.ROLES['People Ops lead'], kind: 'escalation_1', text: '🟠 Escalation: ' + what + ' is 1 day late (owner: ' + t['Owner role'] + '). <' + t._url + '|Open>' });
    if ((crit && late === 1) || (!crit && late === 2))
      out.push({ to: lead.id, kind: 'escalation_2', text: lead.note + '🔴 Escalation: ' + what + ' is ' + late + ' day(s) late' + (crit ? ' and is critical' : '') + '. Please help unblock (owner: ' + t['Owner role'] + '). <' + t._url + '|Open>' });
  });
}

// ---------------- 4. digest + heartbeat ----------------
function digest_(people, tasks, peopleById, today, out) {
  const soon = people.filter(p => p['Day 0'] && /active|test/i.test(p.Status) && Core.diffDays(p['Day 0'], today) >= 0 && Core.diffDays(p['Day 0'], today) <= 14)
    .map(p => '• ' + (p.Flow === 'Joiner' ? '➡️ joining ' : '⬅️ leaving ') + Core.pretty(p['Day 0']) + ': ' + p.Name);
  const action = tasks.filter(t => t['Needs action']).map(t => {
    const p = peopleById[(t.Person || [])[0]] || {};
    return '• ' + t.Health + ': ' + (t.Confidential ? 'confidential step' : t.Step) + ' for ' + p.Name + (t['Escalate to'] ? ' → ' + t['Escalate to'] : '');
  });
  let text = '*Lifecycle digest, ' + Core.pretty(today) + '*\n*Next 14 days*\n' + (soon.join('\n') || '• nobody') +
    '\n*Needs action* (<' + CONFIG.NEEDS_ACTION_URL + '|open in Notion>)\n' + (action.join('\n') || '• nothing 🎉');
  if (new Date(today + 'T00:00:00Z').getUTCDay() === 1) {
    const stale = queryAll_(CONFIG.DB.guides).filter(g => !/Current/.test(g['Review status'])).map(g => '• ' + g.Guide + ' (' + g.Owner + '): ' + g['Review status']);
    text += '\n*Guides to review*\n' + (stale.join('\n') || '• all current');
  }
  out.push({ to: CONFIG.CHANNEL, kind: 'digest', text: text });
}

// ---------------- entry points ----------------
function dailyRun() {
  const today = todayIso_(), out = [];
  try {
    const people = queryAll_(CONFIG.DB.people), steps = queryAll_(CONFIG.DB.steps);
    createMissingTasks_(people, steps, today, out);
    handleDateMoves_(people, steps, today, out);
    const peopleById = {}; queryAll_(CONFIG.DB.people).forEach(p => peopleById[p._id] = p);
    const stepsByName = {}; steps.forEach(s => stepsByName[s.Step] = s);
    const tasks = queryAll_(CONFIG.DB.tasks, { property: 'Status', select: { does_not_equal: 'Done' } });
    planNudges_(tasks, peopleById, stepsByName, today, out);
    digest_(Object.values(peopleById), tasks, peopleById, today, out);
    const n = out.filter(m => /nudge|overdue/.test(m.kind)).length, e = out.filter(m => /escalation|blocked/.test(m.kind)).length;
    out.push({ to: CONFIG.CHANNEL, kind: 'heartbeat', text: '✅ Lifecycle bot ran ' + Core.pretty(today) + ': ' + n + ' nudges, ' + e + ' escalations.' });
    out.forEach(send_);
  } catch (err) {
    send_({ to: CONFIG.CHANNEL, kind: 'error', text: '❌ Lifecycle bot failed: ' + err.message + '\nManual fallback: work from the 🚨 Needs action view in Notion: ' + CONFIG.NEEDS_ACTION_URL });
    throw err;
  }
}

function setup() {
  // One-time: adds the sync column used to detect a moved day 0, then installs the 9am trigger.
  notion_('patch', '/databases/' + CONFIG.DB.people, { properties: { 'Day 0 (synced)': { date: {} } } });
  queryAll_(CONFIG.DB.people).filter(p => p['Day 0'] && !p['Day 0 (synced)'] && p.Tasks && p.Tasks.length)
    .forEach(p => notion_('patch', '/pages/' + p._id, { properties: { 'Day 0 (synced)': { date: { start: p['Day 0'] } } } }));
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailyRun').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyRun').timeBased().everyDays(1).atHour(9).inTimezone(CONFIG.TZ).create();
}

// ---------------- Slack -> Apps Script: /people and the Mark done button ----------------
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doPost(e) {
  const p = (e && e.parameter) || {};
  if (p.payload) {                                   // button click
    const payload = JSON.parse(p.payload); const a = (payload.actions || [])[0];
    if (a && a.action_id === 'mark_done') {
      notion_('patch', '/pages/' + a.value, { properties: { 'Status': { select: { name: 'Done' } } } });
      UrlFetchApp.fetch(payload.response_url, { method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ replace_original: true, text: '✅ Marked done in Notion by <@' + payload.user.id + '>' }) });
    }
    return ContentService.createTextOutput('');
  }
  const today = todayIso_();
  const kb = knowledge_();
  const r = Core.matchQuestion(p.text, kb.intents, kb.guides, today, 180);
  let reply = r.text;
  if (r.action === 'notify_leaver') {
    notion_('post', '/pages', { parent: { database_id: CONFIG.DB.people }, properties: {
      'Name': { title: T('Leaver request from Slack user ' + p.user_id) }, 'Flow': { select: { name: 'Leaver' } },
      'Status': { select: { name: 'Pending confirmation' } }, 'Notes': { rich_text: T('Asked via /people: "' + p.text + '". People Ops confirms dates, then sets Status to Active.') } } });
    send_({ to: CONFIG.CHANNEL, kind: 'request', text: '📨 <@' + p.user_id + '> asked about their last day via /people. A pending leaver row was added in Notion. Reach out privately and confirm dates before setting it to Active.' });
  }
  if (r.action === 'route_finance') send_({ to: CONFIG.ROLES.Finance, kind: 'question', text: '❓ Question from <@' + p.user_id + '> via /people: "' + p.text + '" (no guide yet).' });
  if (r.action === 'route_people_ops' || r.matched === 'GAP') send_({ to: CONFIG.CHANNEL, kind: 'question', text: '❓ Unanswered /people question from <@' + p.user_id + '>: "' + p.text + '" (logged as a guide gap).' });
  return json_({ response_type: 'ephemeral', text: reply });
}

function knowledge_() {
  const cache = CacheService.getScriptCache(); const hit = cache.get('kb');
  if (hit) return JSON.parse(hit);
  const ACT = { 'Answer + show personal checklist': 'my_checklist', 'Answer + start leaver request (People Ops confirms)': 'notify_leaver',
    'Route to Finance (no guide yet)': 'route_finance', 'Route to People Ops + log gap': 'route_people_ops' };
  const guides = queryAll_(CONFIG.DB.guides).map(g => ({ guide_id: g.Guide, title: g.Guide, owner_role: g.Owner, last_updated: g['Last reviewed'], link: g.Link || g._url }));
  const intents = queryAll_(CONFIG.DB.questions).map((q, i) => ({ intent_id: 'Q' + (i + 1), keywords: String(q.Keywords || '').split(',').map(k => k.trim()).join('|'),
    guide_id: q.Guide, answer: q.Answer, action: ACT[q.Action] || '', sensitive: q.Confidential ? 'Y' : 'N' }));
  const kb = { guides: guides, intents: intents };
  cache.put('kb', JSON.stringify(kb), 600);
  return kb;
}

/** Run from the editor to test /people without Slack. */
function testPeopleCommand() {
  const kb = knowledge_();
  ['how do i apply for leave in brazil?', 'when do contractors get paid this month?', 'where is the holiday calendar?']
    .forEach(q => console.log(q + '\n' + Core.matchQuestion(q, kb.intents, kb.guides, todayIso_(), 180).text));
}
