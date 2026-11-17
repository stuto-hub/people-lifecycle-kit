/**
 * Runs when a commit changes the tracker (GitHub Actions: tracker-changed.yml).
 * Compares joiners.csv / leavers.csv before and after the commit and reacts to each change.
 *   BEFORE=<commit sha>  the version to compare with (the workflow passes the commit before the push)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CONFIG } from '../lib/config.js';
import { diffTracker, onTrackerChange } from '../lib/tracker-events.js';
import { send } from '../lib/slack.js';

const before = process.env.BEFORE || '';
/** The file as it was before the push, or null if it did not exist (first upload: nothing to react to). */
const show = (file: string): string | null => {
  if (!before || /^0+$/.test(before)) return null;
  try { return execFileSync('git', ['show', before + ':' + CONFIG.TRACKER_DIR + '/' + file], { cwd: '..', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
};

let failed = 0, count = 0;
for (const [tab, file] of [['Joiners', 'joiners.csv'], ['Leavers', 'leavers.csv']] as const) {
  const old = show(file);
  if (old === null) { console.log(file + ': no earlier version, nothing to compare.'); continue; }
  const changes = diffTracker(tab, old, readFileSync('tracker/' + file, 'utf8'));
  for (const c of changes) {
    count++;
    console.log(tab + ' ' + c.row.ID + ': ' + (c.columns.length === 1 ? c.columns[0] + ' "' + c.oldValue + '" -> "' + c.value + '"' : 'new row'));
    try { await onTrackerChange(c); } catch (err: any) { failed++; console.error(err); }
  }
}
if (failed) await send({ to: CONFIG.CHANNEL, kind: 'error', text: '❌ The bot could not process ' + failed + ' tracker change(s). Check the Actions tab: https://github.com/' + CONFIG.REPO + '/actions' });
console.log(count + ' change(s) processed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);
