/** Optional: "Mark done" saves to data/status.json through the GitHub API (needs GITHUB_TOKEN on Vercel). */
import { CONFIG, env } from './config.js';

const PATH = 'bot/data/status.json';
const api = (path, opts = {}) => fetch('https://api.github.com/repos/' + CONFIG.REPO + '/contents/' + path, {
  ...opts, headers: { Authorization: 'Bearer ' + env('GITHUB_TOKEN'), Accept: 'application/vnd.github+json', 'User-Agent': 'people-ops-bot', ...(opts.headers || {}) } });

export async function saveStatus(key, entry, who) {
  if (!env('GITHUB_TOKEN')) return false;
  const cur = await (await api(PATH + '?ref=main')).json();
  const data = JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8'));
  data[key] = entry;
  const res = await api(PATH, { method: 'PUT', body: JSON.stringify({ message: 'Mark done: ' + key + ' (by ' + who + ' in Slack)', sha: cur.sha, branch: 'main',
    content: Buffer.from(JSON.stringify(data, null, 1) + '\n').toString('base64') }) });
  if (!res.ok) throw new Error('GitHub save failed: ' + res.status);
  return true;
}
