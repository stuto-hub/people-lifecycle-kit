/**
 * Spots edits people type straight into the Google Sheet (called every 5 minutes via /api/cron?job=poll).
 * Compares the Joiners / Leavers tabs with hidden "_Joiners" / "_Leavers" copies of what the bot last saw,
 * reacts to each change exactly like a tracker save (flow started, Day 0 moved, Blocked, Done),
 * then refreshes the copies. The first run only creates the copies (nothing to compare yet).
 */
import { readTab, writeTab, ensureHiddenTab, sheetOn, writeCell, colLetter } from './sheets.js';
import { send } from './slack.js';
import { CONFIG } from './config.js';
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
    log.push(...await fixIds(tab, now, seen));
    const changes = diffTracker(tab, stringifyCsv(seen), stringifyCsv(now));
    for (const c of changes) {
      log.push(tab + ' ' + c.row.ID + ': ' + (c.columns.length === 1 ? c.columns[0] + ' "' + c.oldValue + '" -> "' + c.value + '"' : 'new row'));
      await onTrackerChange(c, today);
      const missing = [!String(c.row['Day 0'] || '').trim() && (tab === 'Joiners' ? 'start date (Day 0)' : 'last day (Day 0)'),
                       !String(c.row.Status || '').trim() && 'Status (Active to start)'].filter(Boolean);
      const isNew = c.columns.length !== 1;
      if (missing.length && (isNew || /^(day 0|status)$/i.test(c.columns[0] || '')) && c.row.Name)
        await send({ to: CONFIG.CHANNEL, kind: 'flag', text: '🚩 *' + c.row.Name + '* (' + c.row.ID + ') is in the ' + tab + ' tab but has no ' + missing.join(' and ') +
          '. Nothing starts (owners, nudges, countdown) until ' + (missing.length > 1 ? 'they are' : 'it is') + ' filled in.' });
    }
    if (changes.length) await writeTab('_' + tab, (await readTab(tab)) || now);   // re-read: the bot may have written (resets, Added on)
    else log.push(tab + ': no changes');
  }
  return log;
}

/**
 * A row copied from another one keeps its ID (two "J-103"s), and a new row may have no ID at all.
 * Gives such a row the next free ID (J-104), writes it into the Sheet and tells People Ops.
 * The row is then treated as new, so its flow starts like any other new joiner/leaver.
 */
export async function fixIds(tab: 'Joiners' | 'Leavers', now: string[][], seen: string[][]): Promise<string[]> {
  const head = (now[0] || []).map(h => String(h).trim()), idc = head.indexOf('ID'), namec = head.indexOf('Name');
  if (idc < 0) return [];
  const prefix = tab === 'Joiners' ? 'J-' : 'L-', used = new Set<string>(), log: string[] = [];
  let max = Math.max(100, ...now.slice(1).map(r => Number((String(r[idc] || '').match(/(\d+)/) || [])[1] || 0)));
  for (let r = 1; r < now.length; r++) {
    const id = String(now[r][idc] || '').trim(), name = String(now[r][namec] || '').trim();
    if (!name) { if (id) used.add(id); continue; }
    if (id && !used.has(id)) { used.add(id); continue; }
    const fresh = prefix + (++max);
    await writeCell(tab, colLetter(idc) + (r + 1), fresh);
    now[r][idc] = fresh; used.add(fresh);
    if (seen[r] && String(seen[r][idc] || '').trim() === id) seen.splice(r, 1, seen[r].map(() => ''));   // so the row counts as new
    log.push(tab + ' row ' + (r + 1) + ': ID "' + id + '" -> ' + fresh);
    await send({ to: CONFIG.CHANNEL, kind: 'flag', text: '🆔 Row ' + (r + 1) + ' in ' + tab + (id ? ' repeated the ID ' + id : ' had no ID') +
      ', so *' + name + '* now has the ID *' + fresh + '* in the Sheet.' });
  }
  return log;
}
