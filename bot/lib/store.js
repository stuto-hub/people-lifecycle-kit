/**
 * The data layer: plain JSON files in bot/data (fictional people), instead of an HR system.
 *   people.json     who is joining or leaving, day 0, lead, buddy, shared logins
 *   steps.json      the trigger table: step, flow, offset from day 0, owner role, flags, nudge text
 *   status.json     what is done or blocked, keyed "personId::stepId"
 *   guides.json     policies and guides, owner, last reviewed
 *   questions.json  common Slack questions -> guide, answer, action
 * Swapping in a real HRIS or Notion later only means replacing this file.
 */
import { readFileSync } from 'node:fs';
import Core from './core.js';
import { CONFIG } from './config.js';

const FILES = ['people', 'steps', 'status', 'guides', 'questions'];
let override = null;
export function setData(d) { override = d; }          // tests

export function load() {
  if (override) return override;
  const d = {};
  for (const f of FILES) d[f] = JSON.parse(readFileSync(new URL('../data/' + f + '.json', import.meta.url), 'utf8'));
  return d;
}

const fileUrl = f => 'https://github.com/' + CONFIG.REPO + '/blob/main/bot/data/' + f + '.json';
const live = p => /active|test/i.test(p.Status || '');

/**
 * Tasks are worked out, not stored: one per person x step of their flow.
 *  - due = day 0 + offset; steps already past when the person was added are pulled to that day (short notice)
 *  - a "recheck if day 0 moves" step done before the date changed counts as reopened
 */
export function buildTasks(d, today) {
  const tasks = [];
  for (const p of d.people.filter(p => p['Day 0'])) {
    for (const s of d.steps.filter(s => s.Flow === p.Flow)) {
      const key = p.id + '::' + s.id;
      const st = d.status[key] || {};
      let due = Core.addDays(p['Day 0'], Number(s['Offset (days)'])), notes = st.Notes || '';
      if (p['Added on'] && Core.diffDays(due, p['Added on']) < 0) { due = p['Added on']; notes = notes || 'Short notice: due date pulled to the day they were added'; }
      let status = st.Status || 'Not started';
      if (status === 'Done' && s['Recheck if day 0 moves'] && p['Day 0 changed on'] && st['Done on'] && st['Done on'] <= p['Day 0 changed on']) {
        status = 'Not started'; notes = 'Reopened: day 0 moved from ' + Core.pretty(p['Previous day 0']);
      }
      const late = Core.diffDays(today, due);
      const open = status !== 'Done';
      tasks.push({ _id: key, _url: fileUrl('status'), Person: [p.id], Step: s.Step, Due: due, Status: status, Notes: notes,
        'Owner role': s['Owner role'], Critical: s.Critical, 'Human moment': s['Human moment'], Confidential: s.Confidential,
        'Needs action': open && live(p) && late >= 0,
        Health: !open ? '✅ Done' : status === 'Blocked' ? '⛔ Blocked' : late > 0 ? '🔴 ' + late + 'd overdue' : late === 0 ? '🔔 Due today' : '⚪ Upcoming',
        'Escalate to': open && late >= (s.Critical ? 1 : 2) ? 'lead' : open && late >= 1 ? 'People Ops lead' : '' });
    }
  }
  return tasks;
}

export function people(d) { return d.people.map(p => ({ ...p, _id: p.id, _url: fileUrl('people') })); }
