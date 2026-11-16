/**
 * The daily lifecycle run: the data files are the system of record, Slack is where people get nudged.
 *   1. new joiner/leaver added      -> flow started (tasks = one per step), red flags at once
 *   2. day 0 moved                  -> date-dependent steps reopened
 *   3. due today / overdue          -> nudge the owner, escalate on day 1 and day 2
 *   4. digest + heartbeat           -> #people-ops-alerts
 * Messages are planned first, then sent, so a failure never sends half a run.
 */
import Core from './core.js';
import { CONFIG, isSlackId, todayIso } from './config.js';
import { load, buildTasks, people as peopleOf } from './store.js';
import { send } from './slack.js';

const isLive = p => /active|test/i.test(p.Status || '');

export function owner(role, person) {
  const id = role === 'Lead' ? person['Lead (Slack ID)'] : role === 'Buddy' ? person['Buddy (Slack ID)']
    : role === 'Candidate' ? CONFIG.ROLES['People Ops'] : CONFIG.ROLES[role];
  if (isSlackId(id)) return { id, note: '' };
  return { id: CONFIG.FALLBACK_USER, note: '_(demo: would go to ' + (role === 'Candidate' ? 'People Ops, to chase the candidate by email' : role) + ')_ ' };
}

const fill = (tpl, v) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (v[k] === undefined || v[k] === '') ? '(not set)' : v[k]);
const hasTemplate = p => CONFIG.TEMPLATES.includes(p.Country + '|' + p['Worker type']);

// ---------------- 1. new people -> flow started + red flags (on the day they are added) ----------------
export function flowStarts(people, tasks, today, out) {
  for (const p of people.filter(p => isLive(p) && p['Day 0'] && p['Added on'] === today)) {
    const compressed = tasks.filter(t => t.Person[0] === p._id && /Short notice/.test(t.Notes)).length;
    out.push({ to: CONFIG.CHANNEL, kind: 'flow_started', text: '🟢 ' + p.Flow + ' flow started for *' + p.Name + '* (' + p.Country + ', ' + p['Worker type'] +
      '), day 0 = ' + Core.pretty(p['Day 0']) + '.' + (compressed ? ' ⚠️ Short notice: ' + compressed + ' steps are due today.' : '') + ' <' + p._url + '|Open>' });
    if (p.Flow === 'Joiner' && !hasTemplate(p))
      out.push({ to: CONFIG.CHANNEL, kind: 'flag', text: '🚩 No agreement template for *' + p['Worker type'] + ' in ' + p.Country + '*. A human checks local rules before the agreement goes out.' });
    if (p.Flow === 'Leaver' && !p['Shared logins'])
      out.push({ to: CONFIG.CHANNEL, kind: 'flag', text: '🚩 *' + p.Name + '* is leaving and has no shared logins listed. Ask the lead to confirm before the access step.' });
  }
}

// ---------------- 2. day 0 moved -> reopen date-dependent steps ----------------
export function dateMoves(people, tasks, today, out) {
  for (const p of people.filter(p => isLive(p) && p['Day 0 changed on'] === today && p['Previous day 0'])) {
    const reopened = tasks.filter(t => t.Person[0] === p._id && /^Reopened/.test(t.Notes)).map(t => t.Step);
    out.push({ to: CONFIG.CHANNEL, kind: 'date_moved', text: '📅 Day 0 for *' + p.Name + '* moved ' + Core.pretty(p['Previous day 0']) + ' → ' + Core.pretty(p['Day 0']) +
      '. All due dates re-dated.' + (reopened.length ? ' Reopened to recheck: ' + reopened.join(', ') + '.' : '') });
  }
}

// ---------------- 3. nudges + escalations ----------------
export function planNudges(tasks, peopleById, stepsByName, today, out) {
  for (const t of tasks) {
    if (t.Status === 'Done' || !t.Due) continue;
    const p = peopleById[(t.Person || [])[0]]; if (!p || !isLive(p)) continue;
    const s = stepsByName[t.Step] || {}; const late = Core.diffDays(today, t.Due);
    if (late < 0) continue;
    const o = owner(t['Owner role'], p);
    const v = { name: p.Name, country: p.Country, worker_type: String(p['Worker type'] || '').toLowerCase(), day0: Core.pretty(p['Day 0']),
      deliver_by: Core.pretty(Core.addDays(p['Day 0'], -2)), shared_logins: p['Shared logins'] || 'NONE LISTED, confirm with the lead',
      template: hasTemplate(p) ? p.Country + ' ' + String(p['Worker type']).toLowerCase() + ' template' : 'MISSING for ' + p.Country };
    const human = t['Human moment'], conf = t.Confidential, crit = t.Critical;
    const what = conf ? 'A confidential step for *' + p.Name + '*' : '*' + t.Step + '* for *' + p.Name + '*';
    if (t.Status === 'Blocked') {
      out.push({ to: CONFIG.ROLES['People Ops lead'], kind: 'blocked', text: '⛔ Blocked: ' + what + '. ' + (conf ? '' : (t.Notes || '')) + ' <' + t._url + '|Open>' });
      continue;
    }
    const text = late === 0 ? (human ? '🤝 ' : '🔔 ') + fill(s['Nudge text'], v) + (human ? ' _(Human moment: please do this personally.)_' : '')
      : '⏰ ' + late + ' day' + (late > 1 ? 's' : '') + ' overdue: ' + fill(s['Nudge text'], v);
    out.push({ to: o.id, kind: late === 0 ? 'nudge' : 'overdue', taskId: t._id, url: t._url, confidential: conf, text: o.note + text });
    // Stateless escalation: fires once, on the day the step crosses each threshold.
    const lead = owner('Lead', p);
    if (late === 1) out.push({ to: CONFIG.ROLES['People Ops lead'], kind: 'escalation_1', text: '🟠 Escalation: ' + what + ' is 1 day late (owner: ' + t['Owner role'] + '). <' + t._url + '|Open>' });
    if ((crit && late === 1) || (!crit && late === 2))
      out.push({ to: lead.id, kind: 'escalation_2', text: lead.note + '🔴 Escalation: ' + what + ' is ' + late + ' day(s) late' + (crit ? ' and is critical' : '') +
        '. Please help unblock (owner: ' + t['Owner role'] + '). <' + t._url + '|Open>' });
  }
}

// ---------------- 4. digest ----------------
export function digest(people, tasks, peopleById, today, out, guides = []) {
  const soon = people.filter(p => p['Day 0'] && isLive(p) && Core.diffDays(p['Day 0'], today) >= 0 && Core.diffDays(p['Day 0'], today) <= 14)
    .map(p => '• ' + (p.Flow === 'Joiner' ? '➡️ joining ' : '⬅️ leaving ') + Core.pretty(p['Day 0']) + ': ' + p.Name);
  const action = tasks.filter(t => t['Needs action']).map(t => {
    const p = peopleById[(t.Person || [])[0]] || {};
    return '• ' + t.Health + ': ' + (t.Confidential ? 'confidential step' : t.Step) + ' for ' + p.Name + (t['Escalate to'] ? ' → ' + t['Escalate to'] : '');
  });
  let text = '*Lifecycle digest, ' + Core.pretty(today) + '*\n*Next 14 days*\n' + (soon.join('\n') || '• nobody') +
    '\n*Needs action* (<' + CONFIG.NEEDS_ACTION_URL + '|status file>)\n' + (action.join('\n') || '• nothing 🎉');
  if (new Date(today + 'T00:00:00Z').getUTCDay() === 1) {        // Mondays: guides due for review
    const stale = guides.map(g => ({ g, age: g['Last reviewed'] ? Core.diffDays(today, g['Last reviewed']) : null }))
      .filter(x => x.age === null || x.age > CONFIG.STALE_DAYS)
      .map(x => '• ' + x.g.Guide + ' (' + x.g.Owner + '): ' + (x.age === null ? 'never reviewed' : 'last reviewed ' + Core.pretty(x.g['Last reviewed'])));
    text += '\n*Guides to review*\n' + (stale.join('\n') || '• all current');
  }
  out.push({ to: CONFIG.CHANNEL, kind: 'digest', text });
}

// ---------------- entry point ----------------
/** Plans every message for the day from the data files, then sends them (or just prints them in preview). */
export async function dailyRun({ today = todayIso(), dryRun = false } = {}) {
  const out = [];
  try {
    const d = load();
    const people = peopleOf(d), tasks = buildTasks(d, today);
    const peopleById = {}; people.forEach(p => { peopleById[p._id] = p; });
    const stepsByName = {}; d.steps.forEach(s => { stepsByName[s.Step] = s; });
    flowStarts(people, tasks, today, out);
    dateMoves(people, tasks, today, out);
    planNudges(tasks, peopleById, stepsByName, today, out);
    digest(people, tasks, peopleById, today, out, d.guides);
    const n = out.filter(m => /nudge|overdue/.test(m.kind)).length, e = out.filter(m => /escalation|blocked/.test(m.kind)).length;
    out.push({ to: CONFIG.CHANNEL, kind: 'heartbeat', text: '✅ Lifecycle bot ran ' + Core.pretty(today) + ': ' + n + ' nudges, ' + e + ' escalations.' });
    if (dryRun) out.forEach(m => console.log('[preview] ' + m.kind + ' -> ' + m.to + ': ' + m.text.replace(/\n/g, ' ⏎ ')));
    else for (const m of out) await send(m);
    return out;
  } catch (err) {
    if (!dryRun) await send({ to: CONFIG.CHANNEL, kind: 'error', text: '❌ Lifecycle bot failed: ' + err.message +
      '\nManual fallback: work from the status file: ' + CONFIG.NEEDS_ACTION_URL });
    throw err;
  }
}
