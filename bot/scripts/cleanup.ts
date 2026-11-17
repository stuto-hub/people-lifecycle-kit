/**
 * Deletes the bot's own Slack messages, given their links (Slack only lets the bot delete them).
 * Actions tab: "Clean up bot messages" -> paste links separated by spaces.
 */
import { slackApi } from '../lib/slack.js';

const links = (process.env.LINKS || '').split(/\s+/).filter(Boolean);
if (!links.length) { console.error('Paste one or more Slack message links.'); process.exit(1); }
let failed = 0;
for (const link of links) {
  const m = link.match(/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!m) { console.error('Not a Slack message link: ' + link); failed++; continue; }
  const j = await slackApi('chat.delete', { channel: m[1], ts: m[2] + '.' + m[3] });
  console.log((j.ok ? 'deleted ' : 'FAILED (' + j.error + ') ') + m[1] + ' ' + m[2] + '.' + m[3]);
  if (!j.ok) failed++;
}
process.exit(failed ? 1 : 0);
