/**
 * Run by GitHub Actions every morning (and on demand from the Actions tab).
 *   node scripts/daily.js           nudges, escalations, digest
 *   node scripts/daily.js preview   prints what would be sent, changes nothing
 */
import { dailyRun } from '../lib/lifecycle.js';
import { todayIso } from '../lib/config.js';

const mode = (process.argv[2] || 'daily').trim();
const mode0 = (process.argv[2] || 'daily').trim();
const missing = mode0 === 'preview' ? [] : ['SLACK_BOT_TOKEN'].filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing secrets: ' + missing.join(', ') + '. Add them in GitHub: Settings > Secrets and variables > Actions.');
  process.exit(1);
}

try {
  if (mode === 'daily' || mode === 'preview') {
    const out = await dailyRun({ dryRun: mode === 'preview' });
    console.log(mode + ' run for ' + todayIso() + ': ' + out.length + ' messages planned.');
  } else throw new Error('Unknown mode "' + mode + '". Use daily or preview.');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
