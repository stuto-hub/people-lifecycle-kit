/**
 * The morning run (GitHub Actions, and the "Run workflow" button).
 *   npm run daily     nudges, escalations, digest
 *   npm run preview   prints what would be sent, sends nothing
 */
import { dailyRun } from '../lib/lifecycle.js';
import { todayIso } from '../lib/config.js';

const mode = (process.argv[2] || 'daily').trim();
if (mode !== 'preview' && !process.env.SLACK_BOT_TOKEN) {
  console.error('Missing SLACK_BOT_TOKEN. Add it in GitHub: Settings > Secrets and variables > Actions.');
  process.exit(1);
}
try {
  if (mode !== 'daily' && mode !== 'preview') throw new Error('Unknown mode "' + mode + '". Use daily or preview.');
  const out = await dailyRun({ dryRun: mode === 'preview' });
  console.log(mode + ' run for ' + todayIso() + ': ' + out.length + ' messages planned.');
} catch (err: any) {
  console.error(err.message);
  process.exit(1);
}
