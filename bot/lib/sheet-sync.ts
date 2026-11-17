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

/** Re-saves the snapshot from the Sheet without reacting (after a format change, or to start fresh). */
export async function resyncSheet(): Promise<string[]> {
  if (!sheetOn()) return ['Google Sheet not connected'];
  const log: string[] = [];
  for (const tab of ['Joiners', 'Leavers'] as const) {
    const now = await readTab(tab); if (!now) continue;
    await ensureHiddenTab('_' + tab); await writeTab('_' + tab, now); log.push(tab + ': snapshot refreshed (' + (now.length - 1) + ' rows)');
  }
  return log;
}

export async function pollSheet(today = todayIso()): Promise<string[]> {
  if (!sheetOn()) return ['Google Sheet not connected (GOOGLE_SA_KEY missing): nothing to poll.'];
  setData(null);
  const log: string[] = [];
  for (const tab of ['Joiners', 'Leavers'] as const) {
    const now = await readTab(tab);
    if (!now) { log.push(tab + ': tab missing'); continue; }
    if (await ensureHiddenTab('_' + tab)) { await writeTab('_' + tab, now); log.push(tab + ': first run, snapshot created'); continue; }
    const seen = (await readTab('_' + tab)) || [];
    // Snapshot saved by an older version with dates as displayed (e.g. 13/1/27): refresh it quietly, no reactions.
    const dc = (seen[0] || []).map((h, i) => /^(day 0|added on)$/i.test(String(h).trim()) ? i : -1).filter(i => i >= 0);
    if (seen.slice(1).some(r => dc.some(i => r[i] && !/^\d{4}-\d{2}-\d{2}$/.test(r[i])))) { await writeTab('_' + tab, now); log.push(tab + ': snapshot migrated to real dates'); continue; }
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
