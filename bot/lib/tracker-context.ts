/**
 * The tracker as plain text for Claude: every person, every step with its real status, owner and due date,
 * the step playbook (who owns what, when) and the Tools tab (who grants / removes each access).
 * Built fresh from the Sheet for each question, so answers always match what the Sheet says right now.
 */
import { CONFIG } from './config.js';
import { buildTasks } from './store.js';
import { owner } from './lifecycle.js';
import { pretty, diffDays } from './core.js';
import type { Data, Person } from './types.js';

const tag = (id: string) => '<@' + id + '>';
/** "Candidate" steps (signing the agreement) are done by the new joiner; People Ops chases them. */
const roleLabel = (r: string) => r === 'Candidate' ? 'the joiner (People Ops chases)' : r;
const dayLabel = (n: number) => n === 0 ? 'day 0' : n > 0 ? 'day +' + n : 'day ' + n;

/** A name from the Sheet ("Stuti", "Alterplots") as a Slack tag when known. */
export function nameToTag(name: string): string {
  const id = CONFIG.DIRECTORY[String(name || '').trim().toLowerCase()];
  return id ? tag(id) + ' (' + name + ')' : name || 'not set';
}

/** Words that mean the question is about people in the tracker or the joining / leaving process. */
const TRACKER = /\b(pending|done|completed?|status|progress|left to do|what's left|whats left|ordered|order(ed)? the laptop|laptop (sent|shipped|ordered|ready)|revok\w*|access(es)?|remove[ds]? access|owner|owns|responsible|who (does|handles|sends|writes)|joining|joiner|joiners|starts?|starting|leaver|leavers|leaving|exit\w*|offboard\w*|onboard\w*|day 0|day one|day 1|first day|last day|welcome (msg|message)|buddy|tracker|sheet|tools?|poc)\b/i;
export const isTrackerQuestion = (q: string) => TRACKER.test(q);

function personBlock(d: Data, p: Person, today: string, inPrivate: boolean): string {
  const tasks = buildTasks(d, today).filter(t => t.Person[0] === p.id);
  const flow = p.Flow === 'Joiner' ? 'JOINER, starts (day 0) ' : 'LEAVER, last day (day 0) ';
  const left = p['Day 0'] ? diffDays(p['Day 0'], today) : null;
  const when = left === null ? 'no Day 0 set' : pretty(p['Day 0']) + ' ' + p['Day 0'].slice(0, 4) + (left > 0 ? ' (in ' + left + ' days)' : left === 0 ? ' (today)' : ' (' + -left + ' days ago)');
  const lead = owner('Lead', p), buddy = owner('Buddy', p);
  const lines = [p.id + ' | ' + p.Name + ' | ' + flow + when + ' | ' + p.Country + ', ' + (p['Worker type'] || '?') + ' | tracker status: ' + (p.Status || '?') +
    ' | lead: ' + tag(lead.id) + (p.Flow === 'Joiner' ? ' | buddy: ' + tag(buddy.id) : ' | shared logins: ' + (p['Shared logins'] || 'none listed')) +
    (p.Notes ? ' | notes: ' + p.Notes : '')];
  const name = (t: any) => t.Confidential && !inPrivate ? 'Confidential step (details only by DM)' : t.Step;
  for (const t of tasks) {
    const late = diffDays(today, t.Due);
    const health = t.Status === 'Done' ? 'DONE' : t.Status === 'Blocked' ? 'BLOCKED' + (t.Notes ? ' (' + t.Notes + ')' : '') : (t.Status.toUpperCase()) + (late > 0 ? ', ' + late + ' days overdue' : late === 0 ? ', due today' : '');
    lines.push('   ' + t.StepId + ' ' + name(t) + ' -> ' + health + ' | due ' + pretty(t.Due) + ' ' + t.Due.slice(0, 4) + ' | owner: ' + roleLabel(t['Owner role']) + ' ' + tag(owner(t['Owner role'], p).id));
  }
  const done = tasks.filter(t => t.Status === 'Done').length;
  lines.push('   Summary: ' + done + ' of ' + tasks.length + ' steps done, ' + (tasks.length - done) + ' open.');
  return lines.join('\n');
}

/** The Tools tab alone (not personal data): which tools exist and who grants / removes access. */
export function toolsBlock(d: Data): string {
  const byDept: Record<string, string[]> = {};
  for (const r of d.tools || []) { const tool = r.Tools || r.Tool || ''; if (tool) (byDept[(r.Department || 'Other') + '|' + (r.POC || '')] ||= []).push(tool); }
  const lines = Object.entries(byDept).map(([k, v]) => '   ' + k.split('|')[0] + ' tools, access owner (POC) ' + nameToTag(k.split('|')[1]) + ': ' + v.join(', '));
  return lines.length ? 'TOOLS AND ACCESS OWNERS (Tools tab; the POC grants access on joining and removes it on leaving; you may share this with anyone):\n' + lines.join('\n') : '';
}

export function trackerBlock(d: Data, today: string, inPrivate: boolean): string {
  const ppl = d.people.filter(p => !/cancel/i.test(p.Status || ''));
  const playbook = ['Joiner', 'Leaver'].map(f => f + ' steps (same for everyone):\n' + d.steps.filter(s => s.Flow === f).map(s =>
    '   ' + s.id + ' ' + (s.Confidential && !inPrivate ? 'Confidential step' : s.Step) + ' | when: ' + dayLabel(s['Offset (days)']) +
    ' | owner role: ' + roleLabel(s['Owner role']) + (s.Critical ? ' | critical' : '') + (s['Human moment'] ? ' | human moment (personal, not automated)' : '')).join('\n')).join('\n');
  const roles = Object.entries(CONFIG.ROLES).map(([r, id]) => r + ' = ' + tag(id)).join(', ');
  const byDept: Record<string, { poc: string; tools: string[] }> = {};
  for (const r of d.tools || []) {
    const tool = r.Tools || r.Tool || '', dept = r.Department || 'Other', poc = r.POC || '';
    if (!tool) continue;
    (byDept[dept + '|' + poc] ||= { poc, tools: [] }).tools.push(tool);
  }
  const tools = Object.entries(byDept).map(([k, v]) => '   ' + k.split('|')[0] + ' tools, access owner (POC) ' + nameToTag(v.poc) + ': ' + v.tools.join(', ')).join('\n');
  return [
    'TRACKER (live from the Google Sheet; today is ' + pretty(today) + ' ' + today.slice(0, 4) + ')',
    'People (each step listed with its exact status from the Sheet):',
    ppl.map(p => personBlock(d, p, today, inPrivate)).join('\n') || '   (nobody in the tracker)',
    '',
    'Step playbook:', playbook,
    '',
    'Role owners (default person for each role; Lead/Buddy apply when a row has no lead/buddy set): ' + roles,
    '',
    'Tools and access owners (Tools tab; the POC grants access on joining and removes it on leaving):',
    tools || '   (Tools tab empty or missing)'
  ].join('\n');
}

export const TRACKER_RULES = [
  'Tracker questions (people joining or leaving, what is pending or done, who owns a step, laptops, accesses, tools):',
  '- Answer ONLY from the TRACKER block. Statuses there are exact: never change, guess or summarise them away.',
  '- "What is pending / what is done" for a person: list EVERY open step (with status, due date and owner tag) and EVERY done step. Do not drop steps.',
  '- A specific step ("have we ordered the laptop?"): give that step\'s exact status, due date and owner for each relevant person.',
  '- "Who owns X": name the step, when it happens and the owner tag. Use the <@ID> tags exactly as written so Slack notifies them.',
  '- Accesses on leaving: list the leaver\'s access steps (L03, L04, L05) with exact statuses and the shared logins, then list every tool by department with its POC who must remove it. Say which are confirmed removed (step Done) and which are still pending.',
  '- Dates like "next month" or "this week" are relative to today in the TRACKER block.',
  '- If the person asked about is not in the tracker, say so and list who is.',
  '- Never reveal a confidential step\'s details in a channel; say it is confidential and handled by DM.',
  '- For tracker answers you may use up to 25 short lines.'
].join('\n');
