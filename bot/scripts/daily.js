/**
 * Run by GitHub Actions every morning (and on demand from the Actions tab).
 *   node scripts/daily.js           nudges, escalations, digest
 *   node scripts/daily.js setup     one-time: adds the "Day 0 (synced)" column in Notion
 *   node scripts/daily.js preview   prints what would be sent, changes nothing
 */
import { dailyRun, setup } from '../lib/lifecycle.js';
import { todayIso } from '../lib/config.js';

const mode = (process.argv[2] || 'daily').trim();
const missing = ['NOTION_TOKEN', 'SLACK_BOT_TOKEN'].filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing secrets: ' + missing.join(', ') + '. Add them in GitHub: Settings > Secrets and variables > Actions.');
  process.exit(1);
}

try {
  if (mode === 'setup') await setup();
  else if (mode === 'daily' || mode === 'preview') {
    const out = await dailyRun({ dryRun: mode === 'preview' });
    console.log(mode + ' run for ' + todayIso() + ': ' + out.length + ' messages planned.');
  } else throw new Error('Unknown mode "' + mode + '". Use daily, setup or preview.');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
