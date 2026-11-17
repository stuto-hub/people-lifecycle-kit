/**
 * Spots edits people type straight into the Google Sheet (called every 5 minutes via /api/cron?job=poll).
 * Compares the Joiners / Leavers tabs with hidden "_Joiners" / "_Leavers" copies of what the bot last saw,
 * reacts to each change exactly like a tracker save (flow started, Day 0 moved, Blocked, Done),
 * then refreshes the copies. The first run only creates the copies (nothing to compare yet).
 */
import { readTab, writeTab, ensureHiddenTab, sheetOn } from './sheets.js';
import { stringifyCsv } from './csv.js';
import { diffTracker, onTrackerChange } from './tracker-events.js';
import { setData } from './store.js';
import { todayIso } from './config.js';

export async function pollSheet(today = todayIso()): Promise<string[]> {
  if (!sheetOn()) return ['Google Sheet not connected (GOOGLE_SA_KEY missing): nothing to poll.'];
  setData(null);
  const log: string[] = [];
  for (const tab of ['Joiners', 'Leavers'] as const) {
    const now = await readTab(tab);
    if (!now) { log.push(tab + ': tab missing'); continue; }
    if (await ensureHiddenTab('_' + tab)) { await writeTab('_' + tab, now); log.push(tab + ': first run, snapshot created'); continue; }
    const seen = (await readTab('_' + tab)) || [];
    const changes = diffTracker(tab, stringifyCsv(seen), stringifyCsv(now));
    for (const c of changes) {
      log.push(tab + ' ' + c.row.ID + ': ' + (c.columns.length === 1 ? c.columns[0] + ' "' + c.oldValue + '" -> "' + c.value + '"' : 'new row'));
      await onTrackerChange(c, today);
    }
    if (changes.length) await writeTab('_' + tab, (await readTab(tab)) || now);   // re-read: the bot may have written (resets, Added on)
    else log.push(tab + ': no changes');
  }
  return log;
}
