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
import { send, slackGet } from './slack.js';
import type { Guide, Msg, Person, Row, Step, Task } from './types.js';

const isLive = (p: Person) => /active|test/i.test(p.Status || '');
const hasTemplate = (p: Person) => CONFIG.TEMPLATES.includes(p.Country + '|' + p['Worker type']);

/** Lead and Buddy come from the person's row; other roles from CONFIG.ROLES. Placeholders fall back to the demo user. */
export function owner(role: string, person: Person): { id: string; note: string } {
  const id = role === 'Lead' ? person['Lead (Slack ID)'] : role === 'Buddy' ? person['Buddy (Slack ID)']
    : role === 'Candidate' ? CONFIG.ROLES['People Ops'] : CONFIG.ROLES[role];
  if (isSlackId(id)) return { id, note: '' };
  if (isSlackId(CONFIG.ROLES[role])) return { id: CONFIG.ROLES[role], note: '' };   // placeholder in the row: the role's default person
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

// ---------------- countdown: 5 days, 3 days and day 0, in #reminders ----------------
/**
 * Anyone with a Day 0 in the tracker (not Cancelled or Done) gets a countdown post on the days listed in
 * reminders.csv. {@Role} becomes a Slack tag for that role's owner, so each team sees its own task.
 */
export function countdown(people: Person[], reminders: Row[], today: string, out: Msg[]) {
  for (const p of people) {
    if (!p['Day 0'] || /cancel|done/i.test(p.Status || '')) continue;
    const left = diffDays(p['Day 0'], today);
    for (const r of reminders) {
      if (r.Flow !== p.Flow || Number(r['Days before']) !== left) continue;
      const text = fill(r.Message.replace(/\{@([^}]+)\}/g, (_, role) => '<@' + owner(role.trim(), p).id + '>'), {
        name: p.Name, day0: pretty(p['Day 0']), shared_logins: p['Shared logins'] || 'none listed, please confirm with the lead' });
      out.push({ to: CONFIG.REMINDERS, kind: 'countdown', text: text + ' <' + sheetLink(p.Flow === 'Joiner' ? 'joiners.csv' : 'leavers.csv') + '|Tracker>' });
    }
  }
}

// ---------------- readiness: day 0 is close but most of the prep is still open ----------------
export const READINESS_DAYS = 10;
export interface AtRisk { p: Person; left: number; pre: Task[]; pending: Task[] }

/** Joiners/leavers whose day 0 is within 10 days and at least half the steps due by day 0 are not Done. Blank status counts (they are still coming). */
export function atRisk(people: Person[], tasks: Task[], today: string): AtRisk[] {
  const res: AtRisk[] = [];
  for (const p of people) {
    if (!p['Day 0'] || /cancel|done|closed/i.test(p.Status || '')) continue;
    const left = diffDays(p['Day 0'], today);
    if (left < 0 || left > READINESS_DAYS) continue;
    const pre = tasks.filter(t => t.Person[0] === p.id && t.Due && t.Due <= p['Day 0']);
    const pending = pre.filter(t => t.Status !== 'Done');
    if (pre.length && pending.length * 2 >= pre.length) res.push({ p, left, pre, pending });
  }
  return res;
}

export function riskLine(r: AtRisk): string {
  return '🚨 *Serious escalation:* *' + r.p.Name + '* ' + (r.p.Flow === 'Joiner' ? 'joins' : 'leaves') + ' ' +
    (r.left === 0 ? 'today' : 'in ' + r.left + ' day' + (r.left > 1 ? 's' : '')) + ' (' + pretty(r.p['Day 0']) + ') but ' + r.pending.length + ' of ' + r.pre.length +
    ' steps due by day 0 are still pending.';
}

export function readiness(people: Person[], tasks: Task[], today: string, out: Msg[]) {
  for (const r of atRisk(people, tasks, today)) {
    const owners = new Set<string>();
    const lines = r.pending.sort((a, b) => a.Due.localeCompare(b.Due)).map(t => {
      const o = owner(t['Owner role'], r.p); owners.add(o.id);
      const late = diffDays(today, t.Due);
      return '• ' + (t.Confidential ? 'a confidential step' : t.Step) + ': ' + (late > 0 ? late + ' day' + (late > 1 ? 's' : '') + ' overdue' : late === 0 ? 'due today' : 'due ' + pretty(t.Due)) + ' → <@' + o.id + '>';
    });
    const lead = CONFIG.ROLES['People Ops lead'] || CONFIG.ROLES['People Ops'];
    const text = riskLine(r) + (r.p.Status ? '' : ' _(Status is blank in the tracker, so the normal nudges are off.)_') + '\n' + lines.join('\n') +
      '\n<@' + lead + '> please step in today. Owners: please update the tracker or reply here. <' + sheetLink(r.p.Flow === 'Joiner' ? 'joiners.csv' : 'leavers.csv') + '|Tracker>';
    out.push({ to: CONFIG.CHANNEL, kind: 'escalation-readiness', text });
    out.push({ to: CONFIG.REMINDERS, kind: 'readiness', text });
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
/** Run slots (IST): 9:00 full run; 15:30 and 22:00 catch-up runs (alerts channel + countdowns not yet posted today, no repeat DMs). */
export const SLOTS: Record<string, string> = { morning: '9:00 run', afternoon: '3:30 pm run', evening: '10 pm run' };
const heartbeat = (today: string, slot: string) => '✅ Lifecycle bot ran ' + pretty(today) + ' (' + (SLOTS[slot] || slot) + ')';

/** A slot that already posted its ✅ heartbeat today is skipped, so a delayed or repeated schedule never double-sends. */
async function alreadyRan(today: string, slot: string): Promise<boolean> {
  try {
    const j = await slackGet('conversations.history', { channel: CONFIG.CHANNEL, limit: '50' });
    return !!(j && j.ok && (j.messages || []).some((m: any) => String(m.text || '').startsWith(heartbeat(today, slot))));
  } catch { return false; }
}

/** Countdown texts already posted in #reminders today (so the catch-up runs only post what is new). */
async function postedToday(): Promise<string[]> {
  try {
    const since = new Date(); since.setUTCHours(since.getUTCHours() - 18);
    const j = await slackGet('conversations.history', { channel: CONFIG.REMINDERS, oldest: String(since.getTime() / 1000), limit: '100' });
    return j && j.ok ? (j.messages || []).map((m: any) => String(m.text || '')) : [];
  } catch { return []; }
}

export async function dailyRun({ today = todayIso(), dryRun = false, force = false, only = '', slot = 'morning' } = {}): Promise<Msg[]> {
  const out: Msg[] = [];
  if (!dryRun && !force && await alreadyRan(today, slot)) { console.log('The ' + slot + ' run already went out today (' + today + '); skipping.'); return out; }
  try {
    const d = await load();
    const people = peopleOf(d), tasks = buildTasks(d, today);
    const peopleById = Object.fromEntries(people.map(p => [p.id, p]));
    const stepsByName = Object.fromEntries(d.steps.map(s => [s.Step, s]));
    planNudges(tasks, peopleById, stepsByName, today, out);
    countdown(people, d.reminders || [], today, out);
    readiness(people, tasks, today, out);
    digest(people, tasks, peopleById, today, out, d.guides);
    const c = out.filter(m => m.kind === 'countdown').length;
    const n = out.filter(m => /nudge|overdue/.test(m.kind)).length, e = out.filter(m => /escalation|blocked/.test(m.kind)).length;
    if (slot !== 'morning') {                              // catch-up run: alerts channel + countdowns not posted yet today, no repeat DMs
      const seen = await postedToday();
      // Compare without the leading emoji: Slack stores it as a code (:closed_lock_with_key:), not the character.
      const key = (t: string) => t.replace(/^\s*(:[a-z0-9_+-]+:|[^\w*]+)\s*/i, '').split(' <')[0].slice(0, 50);
      const keep = out.filter(m => m.to === CONFIG.CHANNEL || (/^(countdown|readiness)$/.test(m.kind) && !seen.some(t => key(t) === key(m.text))));
      out.length = 0; out.push(...keep);
    }
    const c2 = out.filter(m => m.kind === 'countdown').length, n2 = out.filter(m => /nudge|overdue/.test(m.kind)).length;
    out.push({ to: CONFIG.CHANNEL, kind: 'heartbeat', text: heartbeat(today, slot) + ': ' + n2 + ' nudges, ' + e + ' escalations, ' + c2 + ' countdown reminders, ' + out.filter(m => m.kind === 'readiness').length + ' readiness alerts.' });
    void c; void n;
    if (only) { const keep = out.filter(m => m.kind === only); out.length = 0; out.push(...keep); }
    if (dryRun) out.forEach(m => console.log('[preview] ' + m.kind + ' -> ' + m.to + ': ' + m.text.replace(/\n/g, ' ⏎ ')));
    else for (const m of out) await send(m);
    return out;
  } catch (err: any) {
    if (!dryRun) await send({ to: CONFIG.CHANNEL, kind: 'error', text: '❌ Lifecycle bot failed: ' + err.message +
      '\nManual fallback: work straight from the tracker: ' + sheetLink() });
    throw err;
  }
}
