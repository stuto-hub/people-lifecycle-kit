/**
 * Reacts to each change saved in the tracker (scripts/on-change.ts compares the CSVs before and after a commit).
 *   Status -> Active/Test   flow started: owners assigned, red flags, today's nudges sent, "Added on" stamped
 *   Day 0 changed           due dates move with it; date-dependent steps that were Done go back to Pending
 *   a step -> Blocked       People Ops lead and the person's lead are told
 *   a step -> Done          logged in #people-ops-alerts (confidential steps not named)
 */
import { pretty } from './core.js';
import { CONFIG, todayIso } from './config.js';
import { load, buildTasks, personFromRow, stepIdOf, normDate, setCell, sheetLink, percentDone } from './store.js';
import { flowStarted, planNudges, owner } from './lifecycle.js';
import { send } from './slack.js';
import { toObjects } from './csv.js';
import type { Msg, Row, TrackerChange } from './types.js';

const isLive = (s: string) => /active|test/i.test(s || '');

/** Compares two versions of joiners.csv / leavers.csv and lists what changed, cell by cell. New rows come as one change. */
export function diffTracker(tab: TrackerChange['tab'], before: string, after: string): TrackerChange[] {
  const old = Object.fromEntries((before ? toObjects(before) : []).map(r => [r.ID, r]));
  const changes: TrackerChange[] = [];
  for (const row of toObjects(after)) {
    if (!row.ID) continue;
    const prev: Row | undefined = old[row.ID];
    if (!prev) { changes.push({ tab, columns: Object.keys(row), oldValue: '', value: '', row }); continue; }
    for (const col of Object.keys(row)) {
      if ((prev[col] || '') !== (row[col] || '')) changes.push({ tab, columns: [col], oldValue: prev[col] || '', value: row[col] || '', row });
    }
  }
  return changes;
}

export async function onTrackerChange(evt: TrackerChange, today = todayIso()): Promise<Msg[]> {
  const { person: p, status: rowStatus } = personFromRow(evt.row, evt.tab);
  if (!p.id) return [];
  const cols = evt.columns, single = cols.length === 1;
  const out: Msg[] = [];
  const loaded = await load();
  // The changed row is the truth for this person (the deployed copy may be a commit behind).
  const d = { ...loaded, people: [...loaded.people.filter(x => x.id !== p.id), p], status: { ...loaded.status, ...rowStatus } };
  const step = (id: string) => d.steps.find(s => s.id === id);

  // 1. flow started
  if (cols.includes('Status') && isLive(p.Status) && !(single && isLive(evt.oldValue))) {
    if (!p['Day 0']) out.push({ to: CONFIG.CHANNEL, kind: 'flag', text: '🚩 *' + p.Name + '* was set to ' + p.Status + ' but has no Day 0. Add it and the flow will start.' });
    else {
      if (!p['Added on']) { p['Added on'] = today; await setCell(p.id, 'Added on', today, 'flow started'); }
      const tasks = buildTasks({ ...d, people: [p] }, today);
      flowStarted(p, tasks, out);
      planNudges(tasks.filter(t => t.Due === today), { [p.id]: { ...p, _id: p.id } },
        Object.fromEntries(d.steps.map(s => [s.Step, s])), today, out);
    }
  }

  // 2. day 0 moved
  if (single && cols[0] === 'Day 0' && isLive(p.Status)) {
    const before = normDate(evt.oldValue), after = p['Day 0'];
    if (before && after && before !== after) {
      const reopen = d.steps.filter(s => s.Flow === p.Flow && s['Recheck if day 0 moves'])
        .filter(s => /^done$/i.test(Object.entries(evt.row).find(([h]) => stepIdOf(h) === s.id)?.[1] || ''));
      for (const s of reopen) await setCell(p.id, s.id, 'Pending', 'day 0 moved');
      out.push({ to: CONFIG.CHANNEL, kind: 'date_moved', text: '📅 Day 0 for *' + p.Name + '* moved ' + pretty(before) + ' → ' + pretty(after) +
        '. All due dates moved with it.' + (reopen.length ? ' Set back to Pending to recheck: ' + reopen.map(s => s.Step).join(', ') + '.' : '') });
    }
  }

  // 3. a step changed
  const sid = single ? stepIdOf(cols[0]) : '';
  const s = sid ? step(sid) : undefined;
  if (s && isLive(p.Status)) {
    const what = s.Confidential ? 'a confidential step' : '*' + s.Step + '*';
    if (/^blocked$/i.test(evt.value)) {
      const lead = owner('Lead', p);
      const text = '⛔ Blocked: ' + what + ' for *' + p.Name + '*.' + (s.Confidential ? '' : (p.Notes ? ' Note: ' + p.Notes : '')) + ' <' + sheetLink() + '|Open the tracker>';
      out.push({ to: CONFIG.ROLES['People Ops lead'], kind: 'blocked', text });
      if (lead.id !== CONFIG.ROLES['People Ops lead']) out.push({ to: lead.id, kind: 'blocked', text: lead.note + text });
    }
    if (/^done$/i.test(evt.value) && !/^done$/i.test(evt.oldValue)) {
      const pct = percentDone(d, p);
      out.push({ to: CONFIG.CHANNEL, kind: 'done', text: '✅ ' + what.replace(/^a /, 'A ') + ' done for *' + p.Name + '*' + (pct ? ' (' + pct + ' complete)' : '') + '.' });
    }
  }

  for (const m of out) await send(m);
  return out;
}
