/**
 * The lifecycle rules. The tracker is the system of record, Slack is where people get nudged.
 *   On a tracker change (tracker-events.ts, within a minute of the save):
 *     Status -> Active/Test   flow started, owners assigned, red flags, today's nudges
 *     Day 0 edited            due dates move; date-dependent steps go back to Pending
 *   Every morning (dailyRun):
 *     due today / overdue     nudge the owner; escalate on day 1 (People Ops lead) and day 2 (the person's lead)
 *     digest + heartbeat      #people-ops-alerts; no ✅ in the morning = something broke
 * Messages are planned first, then sent, so a failure never sends half a run.
 */
import { addDays, diffDays, fill, pretty } from './core.js';
import { CONFIG, isSlackId, todayIso } from './config.js';
import { load, buildTasks, people as peopleOf, sheetLink } from './store.js';
import { send } from './slack.js';
import type { Guide, Msg, Person, Step, Task } from './types.js';

const isLive = (p: Person) => /active|test/i.test(p.Status || '');
const hasTemplate = (p: Person) => CONFIG.TEMPLATES.includes(p.Country + '|' + p['Worker type']);

/** Lead and Buddy come from the person's row; other roles from CONFIG.ROLES. Placeholders fall back to the demo user. */
export function owner(role: string, person: Person): { id: string; note: string } {
  const id = role === 'Lead' ? person['Lead (Slack ID)'] : role === 'Buddy' ? person['Buddy (Slack ID)']
    : role === 'Candidate' ? CONFIG.ROLES['People Ops'] : CONFIG.ROLES[role];
  if (isSlackId(id)) return { id, note: '' };
  return { id: CONFIG.FALLBACK_USER, note: '_(demo: would go to ' + (role === 'Candidate' ? 'People Ops, to chase the candidate by email' : role) + ')_ ' };
}

// ---------------- flow started: owners assigned + red flags ----------------
export function flowStarted(p: Person, tasks: Task[], out: Msg[]) {
  const mine = tasks.filter(t => t.Person[0] === p.id && t.Status !== 'Done');
  const compressed = mine.filter(t => /Short notice/.test(t.Notes)).length;
  const byRole: Record<string, string[]> = {};
  for (const t of mine) (byRole[t['Owner role']] ||= []).push((t.Confidential ? 'confidential step' : t.Step) + ' (' + pretty(t.Due) + ')');
  const owners = Object.entries(byRole).map(([role, list]) => '• *' + role + '*: ' + list.join(', ')).join('\n');
  out.push({ to: CONFIG.CHANNEL, kind: 'flow_started', text: '🟢 ' + p.Flow + ' flow started for *' + p.Name + '* (' + p.Country + ', ' + p['Worker type'] +
    '), day 0 = ' + pretty(p['Day 0']) + '.' + (compressed ? ' ⚠️ Short notice: ' + compressed + ' steps are due today.' : '') +
    '\n*Owners assigned*\n' + owners + '\n<' + sheetLink() + '|Open the tracker>' });
  if (p.Flow === 'Joiner' && !hasTemplate(p))
    out.push({ to: CONFIG.CHANNEL, kind: 'flag', text: '🚩 No agreement template for *' + p['Worker type'] + ' in ' + p.Country + '*. A human checks local rules before the agreement goes out.' });
  if (p.Flow === 'Leaver' && !p['Shared logins'])
    out.push({ to: CONFIG.CHANNEL, kind: 'flag', text: '🚩 *' + p.Name + '* is leaving and has no shared logins listed. Ask the lead to confirm before the access step.' });
}

// ---------------- nudges + escalations ----------------
export function planNudges(tasks: Task[], peopleById: Record<string, Person>, stepsByName: Record<string, Step>, today: string, out: Msg[]) {
  for (const t of tasks) {
    if (t.Status === 'Done' || !t.Due) continue;
    const p = peopleById[t.Person[0]]; if (!p || !isLive(p)) continue;
    const s = stepsByName[t.Step]; const late = diffDays(today, t.Due);
    if (late < 0) continue;
    const o = owner(t['Owner role'], p);
    const v = { name: p.Name, country: p.Country, worker_type: String(p['Worker type'] || '').toLowerCase(), day0: pretty(p['Day 0']),
      deliver_by: pretty(addDays(p['Day 0'], -2)), shared_logins: p['Shared logins'] || 'NONE LISTED, confirm with the lead',
      template: hasTemplate(p) ? p.Country + ' ' + String(p['Worker type']).toLowerCase() + ' template' : 'MISSING for ' + p.Country };
    const what = t.Confidential ? 'A confidential step for *' + p.Name + '*' : '*' + t.Step + '* for *' + p.Name + '*';
    if (t.Status === 'Blocked') {
      out.push({ to: CONFIG.ROLES['People Ops lead'], kind: 'blocked', text: '⛔ Blocked: ' + what + '. ' + (t.Confidential ? '' : (t.Notes || '')) + ' <' + t._url + '|Open>' });
      continue;
    }
    const nudge = fill(s ? s['Nudge text'] : t.Step, v);
    const text = late === 0 ? (t['Human moment'] ? '🤝 ' : '🔔 ') + nudge + (t['Human moment'] ? ' _(Human moment: please do this personally.)_' : '')
      : '⏰ ' + late + ' day' + (late > 1 ? 's' : '') + ' overdue: ' + nudge;
    out.push({ to: o.id, kind: late === 0 ? 'nudge' : 'overdue', taskId: t._id, url: t._url, confidential: t.Confidential, text: o.note + text });
    // Stateless escalation: fires once, on the day the step crosses each threshold.
    const lead = owner('Lead', p);
    if (late === 1) out.push({ to: CONFIG.ROLES['People Ops lead'], kind: 'escalation_1', text: '🟠 Escalation: ' + what + ' is 1 day late (owner: ' + t['Owner role'] + '). <' + t._url + '|Open>' });
    if ((t.Critical && late === 1) || (!t.Critical && late === 2))
      out.push({ to: lead.id, kind: 'escalation_2', text: lead.note + '🔴 Escalation: ' + what + ' is ' + late + ' day(s) late' + (t.Critical ? ' and is critical' : '') +
        '. Please help unblock (owner: ' + t['Owner role'] + '). <' + t._url + '|Open>' });
  }
}

// ---------------- digest ----------------
export function digest(people: Person[], tasks: Task[], peopleById: Record<string, Person>, today: string, out: Msg[], guides: Guide[] = []) {
  const soon = people.filter(p => p['Day 0'] && isLive(p) && diffDays(p['Day 0'], today) >= 0 && diffDays(p['Day 0'], today) <= 14)
    .map(p => '• ' + (p.Flow === 'Joiner' ? '➡️ joining ' : '⬅️ leaving ') + pretty(p['Day 0']) + ': ' + p.Name);
  const action = tasks.filter(t => t['Needs action']).map(t => {
    const p = peopleById[t.Person[0]];
    return '• ' + t.Health + ': ' + (t.Confidential ? 'confidential step' : t.Step) + ' for ' + (p ? p.Name : '?') + (t['Escalate to'] ? ' → ' + t['Escalate to'] : '');
  });
  let text = '*Lifecycle digest, ' + pretty(today) + '*\n*Next 14 days*\n' + (soon.join('\n') || '• nobody') +
    '\n*Needs action* (<' + sheetLink() + '|open the tracker>)\n' + (action.join('\n') || '• nothing 🎉');
  if (new Date(today + 'T00:00:00Z').getUTCDay() === 1) {        // Mondays: guides due for review
    const stale = guides.map(g => ({ g, age: g['Last reviewed'] ? diffDays(today, g['Last reviewed']) : null }))
      .filter(x => x.age === null || x.age > CONFIG.STALE_DAYS)
      .map(x => '• ' + x.g.Guide + ' (' + x.g.Owner + '): ' + (x.age === null ? 'never reviewed' : 'last reviewed ' + pretty(x.g['Last reviewed'])));
    text += '\n*Guides to review*\n' + (stale.join('\n') || '• all current');
  }
  out.push({ to: CONFIG.CHANNEL, kind: 'digest', text });
}

// ---------------- the morning run ----------------
export async function dailyRun({ today = todayIso(), dryRun = false } = {}): Promise<Msg[]> {
  const out: Msg[] = [];
  try {
    const d = await load();
    const people = peopleOf(d), tasks = buildTasks(d, today);
    const peopleById = Object.fromEntries(people.map(p => [p.id, p]));
    const stepsByName = Object.fromEntries(d.steps.map(s => [s.Step, s]));
    planNudges(tasks, peopleById, stepsByName, today, out);
    digest(people, tasks, peopleById, today, out, d.guides);
    const n = out.filter(m => /nudge|overdue/.test(m.kind)).length, e = out.filter(m => /escalation|blocked/.test(m.kind)).length;
    out.push({ to: CONFIG.CHANNEL, kind: 'heartbeat', text: '✅ Lifecycle bot ran ' + pretty(today) + ': ' + n + ' nudges, ' + e + ' escalations.' });
    if (dryRun) out.forEach(m => console.log('[preview] ' + m.kind + ' -> ' + m.to + ': ' + m.text.replace(/\n/g, ' ⏎ ')));
    else for (const m of out) await send(m);
    return out;
  } catch (err: any) {
    if (!dryRun) await send({ to: CONFIG.CHANNEL, kind: 'error', text: '❌ Lifecycle bot failed: ' + err.message +
      '\nManual fallback: work straight from the tracker: ' + sheetLink() });
    throw err;
  }
}
