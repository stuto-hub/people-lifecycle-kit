// ===== Core.gs (matching + date helpers) =====
/**
 * Core.gs — the lifecycle logic, with no Google or Slack calls.
 * Everything here works on plain objects (one per sheet row), so it can be
 * tested outside Apps Script. Dates are 'YYYY-MM-DD' strings.
 */
var Core = (function () {
  var DAY = 86400000;

  // ---------- small helpers ----------
  function ms(iso) { var p = String(iso).slice(0, 10).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function iso(t) { return new Date(t).toISOString().slice(0, 10); }
  function addDays(d, n) { return iso(ms(d) + n * DAY); }
  function diffDays(a, b) { return Math.round((ms(a) - ms(b)) / DAY); } // a minus b
  function weekday(d) { return new Date(ms(d)).getUTCDay(); }           // 0 Sun .. 6 Sat
  function yes(v) { return v === true || String(v).trim().toUpperCase() === 'Y'; }
  function blank(v) { return v === undefined || v === null || String(v).trim() === ''; }
  function pretty(d) {
    var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var x = new Date(ms(d)); return x.getUTCDate() + ' ' + m[x.getUTCMonth()];
  }
  function fill(tpl, vars) {
    return String(tpl).replace(/\{(\w+)\}/g, function (m, k) {
      return blank(vars[k]) ? '(not set)' : vars[k];
    });
  }
  function indexBy(rows, key) { var o = {}; rows.forEach(function (r) { o[r[key]] = r; }); return o; }
  function append(notes, line) { return blank(notes) ? line : notes + ' | ' + line; }

  // ---------- owners ----------
  // Lead and Buddy come from the person's row; every other role from the Roles tab.
  // If nobody is mapped, the message goes to the People Ops channel instead of disappearing.
  function resolveOwner(role, person, roles) {
    var id = role === 'Lead' ? person.lead_slack
           : role === 'Buddy' ? person.buddy_slack
           : (roles[role] || {}).slack_id;
    if (blank(id)) return { to: channel(roles), unmapped: true };
    return { to: id, unmapped: false };
  }
  function channel(roles) { return (roles['People Ops channel'] || {}).slack_id || 'PEOPLE_OPS_CHANNEL'; }
  function opsLead(roles) { return (roles['People Ops lead'] || {}).slack_id || channel(roles); }

  function vars(person, step, task, templates) {
    var tpl = templates[person.country + '|' + person.worker_type];
    return {
      name: person.name, country: person.country, worker_type: person.worker_type,
      day0: pretty(person.day0), due: pretty(task.due),
      deliver_by: pretty(addDays(person.day0, -2)),
      template: tpl ? tpl.agreement_template : 'MISSING for ' + person.country,
      shared_logins: blank(person.shared_logins) ? 'NONE LISTED, confirm with the lead' : person.shared_logins,
      lead: person.lead_slack ? '<@' + person.lead_slack + '>' : 'the lead'
    };
  }

  // ---------- 1. reconcile: people + step template -> tasks ----------
  // Creates missing tasks, re-dates open ones when day 0 moves, reopens steps that
  // depend on the date (agreement, laptop, welcome), and compresses short-notice cases.
  function reconcile(people, steps, tasks, today, templatesRows) {
    var events = [];
    var byId = indexBy(tasks, 'task_id');
    var templates = {};
    (templatesRows || []).forEach(function (t) { templates[t.country + '|' + t.worker_type] = t; });

    people.forEach(function (p) {
      if (blank(p.id) || blank(p.day0) || /cancel/i.test(p.status || '')) return;
      var flowSteps = steps.filter(function (s) { return s.flow === p.type; });
      var created = 0, compressed = 0, redated = [], reopened = [];

      flowSteps.forEach(function (s) {
        var id = p.id + '-' + s.step_id;
        var due = addDays(p.day0, Number(s.offset_days));
        var t = byId[id];
        if (!t) {
          t = { task_id: id, person_id: p.id, person_name: p.name, flow: p.type, step_id: s.step_id,
                step: s.step, owner_role: s.owner_role, due: due, status: 'open',
                escalation_level: 0, last_nudged: '', done_on: '', done_by: '', notes: '', basis_day0: p.day0 };
          if (diffDays(due, today) < 0) { t.due = today; t.notes = 'Short notice: due date pulled to today'; compressed++; }
          tasks.push(t); byId[id] = t; created++;
          return;
        }
        if (t.basis_day0 !== p.day0) {
          var from = t.due; t.basis_day0 = p.day0; t.escalation_level = 0;
          t.due = diffDays(due, today) < 0 ? today : due; // never re-date into the past
          if (t.status === 'done' && yes(s.recheck_if_date_moves)) {
            t.status = 'open'; t.done_on = ''; t.notes = append(t.notes, 'Reopened: start date moved, recheck');
            reopened.push(t.step);
          } else if (t.status === 'open') { redated.push(t.step + ' (' + pretty(from) + ' → ' + pretty(due) + ')'); }
        }
      });

      if (created) {
        events.push({ kind: 'created', person: p, count: created, compressed: compressed });
        if (p.type === 'joiner' && !templates[p.country + '|' + p.worker_type])
          events.push({ kind: 'missing_template', person: p });
        if (p.type === 'leaver' && blank(p.shared_logins))
          events.push({ kind: 'no_shared_logins', person: p });
      }
      if (redated.length || reopened.length)
        events.push({ kind: 'date_moved', person: p, redated: redated, reopened: reopened });
    });
    return events;
  }

  function eventMessages(events, roles) {
    var ch = channel(roles);
    return events.map(function (e) {
      var p = e.person;
      if (e.kind === 'created') return { to: ch, kind: 'flow_started', text:
        '🟢 ' + (p.type === 'joiner' ? 'Joiner' : 'Leaver') + ' flow started for *' + p.name + '* (' + p.country +
        ', ' + p.worker_type + '), day 0 = ' + pretty(p.day0) + '. ' + e.count + ' steps scheduled.' +
        (e.compressed ? ' ⚠️ Short notice: ' + e.compressed + ' steps are already due today.' : '') };
      if (e.kind === 'missing_template') return { to: ch, kind: 'flag', text:
        '🚩 No agreement template for *' + p.worker_type + ' in ' + p.country + '*. A human must check local rules before ' +
        p.name + '\'s agreement goes out. Add the template to the Templates tab once confirmed.' };
      if (e.kind === 'no_shared_logins') return { to: ch, kind: 'flag', text:
        '🚩 *' + p.name + '* is leaving and has no shared logins listed. Ask the lead to confirm before the access step.' };
      if (e.kind === 'date_moved') return { to: ch, kind: 'date_moved', text:
        '📅 Day 0 for *' + p.name + '* is now ' + pretty(p.day0) + '. ' +
        (e.redated.length ? 'Re-dated: ' + e.redated.length + ' open steps. ' : '') +
        (e.reopened.length ? 'Reopened to recheck: ' + e.reopened.join(', ') + '.' : '') };
      return null;
    }).filter(Boolean);
  }

  // ---------- 2. daily plan: who gets nudged / escalated today ----------
  function planDaily(today, ctx, cfg) {
    cfg = cfg || {};
    var roles = indexBy(ctx.roles, 'role');
    var people = indexBy(ctx.people, 'id');
    var steps = indexBy(ctx.steps, 'step_id');
    var templates = {};
    (ctx.templates || []).forEach(function (t) { templates[t.country + '|' + t.worker_type] = t; });
    var out = [], stuck = [];

    ctx.tasks.forEach(function (t) {
      if (t.status !== 'open') return;
      var p = people[t.person_id], s = steps[t.step_id];
      if (!p || !s || /cancel/i.test(p.status || '')) return;
      var late = diffDays(today, t.due);
      if (late < 0) return;

      var v = vars(p, s, t, templates);
      var human = yes(s.human_moment), crit = yes(s.critical), sens = yes(s.sensitive);
      // Candidate is not on Slack yet: People Ops chases by email.
      var owner = s.owner_role === 'Candidate'
        ? resolveOwner('People Ops', p, roles)
        : resolveOwner(s.owner_role, p, roles);
      var prefix = owner.unmapped ? '⚠️ No Slack owner mapped for role "' + s.owner_role + '". ' : '';
      // Never post a confidential step's details into a channel.
      if (sens && owner.unmapped) {
        out.push({ to: owner.to, kind: 'flag', task_id: t.task_id,
          text: '⚠️ A confidential step for *' + p.name + '* has no owner mapped. See the Tasks tab.' });
        t.last_nudged = today; return;
      }

      if (late === 0) {
        out.push({ to: owner.to, kind: 'nudge', task_id: t.task_id, button: true, sensitive: sens,
          text: prefix + (human ? '🤝 ' : '🔔 ') + fill(s.nudge_text, v) + (human ? ' _(Human moment: please do this personally.)_' : '') });
      } else {
        out.push({ to: owner.to, kind: 'overdue', task_id: t.task_id, button: true, sensitive: sens,
          text: prefix + '⏰ ' + late + ' day' + (late > 1 ? 's' : '') + ' overdue: ' + fill(s.nudge_text, v) });
        stuck.push({ t: t, p: p, late: late, sens: sens });

        var level = crit ? 2 : (late >= (cfg.managerAfter || 2) ? 2 : 1);
        var who = sens ? 'A confidential step for *' + p.name + '*' : '*' + t.step + '* for *' + p.name + '*';
        if (level >= 1 && Number(t.escalation_level) < 1) {
          out.push({ to: opsLead(roles), kind: 'escalation_1', task_id: t.task_id,
            text: '🟠 Escalation: ' + who + ' is ' + late + ' day(s) late (owner: ' + s.owner_role + ').' });
        }
        if (level >= 2 && Number(t.escalation_level) < 2) {
          var mgr = p.lead_slack || opsLead(roles);
          out.push({ to: mgr, kind: 'escalation_2', task_id: t.task_id,
            text: '🔴 Escalation: ' + who + ' is ' + late + ' day(s) late' + (crit ? ' and is critical' : '') +
                  '. Please help unblock (owner: ' + s.owner_role + ').' });
        }
        t.escalation_level = Math.max(Number(t.escalation_level) || 0, level);
      }
      t.last_nudged = today;
    });

    // Daily digest to the private People Ops channel
    var ch = channel(roles);
    var soon = ctx.people.filter(function (p) {
      var d = diffDays(p.day0, today); return d >= 0 && d <= 14 && !/cancel/i.test(p.status || '');
    }).map(function (p) { return '• ' + (p.type === 'joiner' ? '➡️ joining ' : '⬅️ leaving ') + pretty(p.day0) + ': ' + p.name; });
    var stuckLines = stuck.map(function (x) {
      return '• ' + x.p.name + ': ' + (x.sens ? 'confidential step' : x.t.step) + ' (' + x.late + 'd late, ' + x.t.owner_role + ')';
    });
    var digest = '*Lifecycle digest, ' + pretty(today) + '*\n' +
      '*Next 14 days*\n' + (soon.length ? soon.join('\n') : '• nobody') + '\n' +
      '*Stuck*\n' + (stuckLines.length ? stuckLines.join('\n') : '• nothing overdue 🎉');

    // Monday: stale guides + unanswered question gaps
    if (weekday(today) === 1) {
      var stale = (ctx.guides || []).filter(function (g) {
        return blank(g.last_updated) || diffDays(today, g.last_updated) > (cfg.staleDays || 180);
      }).map(function (g) { return '• ' + g.title + ' (' + g.owner_role + '): ' + (blank(g.last_updated) ? 'never reviewed' : 'last reviewed ' + Math.round(diffDays(today, g.last_updated) / 30) + ' months ago'); });
      var gaps = (ctx.questions || []).filter(function (q) { return q.matched === 'GAP' && diffDays(today, q.date) <= 7; });
      digest += '\n*Guides to review (stale)*\n' + (stale.length ? stale.join('\n') : '• all current') +
        '\n*Questions with no guide this week:* ' + gaps.length;
    }
    out.push({ to: ch, kind: 'digest', text: digest });
    var n = out.filter(function (m) { return m.kind === 'nudge' || m.kind === 'overdue'; }).length;
    var e = out.filter(function (m) { return /^escalation/.test(m.kind); }).length;
    out.push({ to: ch, kind: 'heartbeat', text: '✅ Lifecycle bot ran ' + pretty(today) + ': ' + n + ' nudges, ' + e + ' escalations.' });
    return out;
  }

  // ---------- 3. /people command: question -> guide, owner, answer, action ----------
  var COUNTRIES = ['brazil','spain','india','united states','usa','us','kenya','portugal','france','canada',
                   'singapore','philippines','indonesia','nigeria','pakistan','vietnam','mexico','germany','uk'];

  function matchQuestion(text, intents, guides, today, staleDays) {
    var q = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
    var best = null, bestScore = 0;
    intents.forEach(function (it) {
      var score = 0;
      String(it.keywords).split('|').forEach(function (k) {
        k = k.trim().toLowerCase(); if (!k) return;
        if (q.indexOf(' ' + k + ' ') >= 0) score += k.split(' ').length;
      });
      if (score > bestScore) { bestScore = score; best = it; }
    });
    var country = '';
    COUNTRIES.forEach(function (c) { if (!country && q.indexOf(' ' + c + ' ') >= 0) country = c; });
    if (!best) return { matched: 'GAP', sensitive: false, action: 'route_people_ops',
      text: "I couldn't find a guide for that yet. I've passed it to People Ops, and you'll hear back within 1 working day." };

    var g = indexBy(guides, 'guide_id')[best.guide_id];
    var countryNote = country ? ' for ' + country.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : '';
    var lines = [fill(best.answer, { country_note: countryNote })];
    if (g) {
      var age = blank(g.last_updated) ? null : diffDays(today, g.last_updated);
      var fresh = age === null ? '⚠️ never reviewed; owner asked to confirm'
                : age > (staleDays || 180) ? '⚠️ last reviewed ' + Math.round(age / 30) + ' months ago; owner asked to confirm'
                : 'reviewed ' + pretty(g.last_updated);
      lines.unshift('*' + g.title + '* (owner: ' + g.owner_role + ')');
      lines.push('🔗 <' + g.link + '|Open the guide> · ' + fresh);
    } else {
      lines.push('_No guide exists for this yet; logged as a gap for People Ops._');
    }
    if (yes(best.sensitive)) lines.push('🔒 Only you can see this reply.');
    return { matched: best.intent_id, guide: g, sensitive: yes(best.sensitive), action: best.action || '',
             stale: !!(g && (blank(g.last_updated) || diffDays(today, g.last_updated) > (staleDays || 180))),
             text: lines.join('\n') };
  }

  return { reconcile: reconcile, eventMessages: eventMessages, planDaily: planDaily,
           matchQuestion: matchQuestion, addDays: addDays, diffDays: diffDays, pretty: pretty };
})();

if (typeof module !== 'undefined') module.exports = Core; // for local tests only

// ===== Engine.gs (Notion -> Slack) =====
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
