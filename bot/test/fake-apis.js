/**
 * Stand-ins for Slack, Claude and GitHub, plus test data, so the bot runs fully offline.
 * Uses the real steps/guides/questions from bot/data; people and status come from each test.
 */
import { readFileSync } from 'node:fs';
import { setData } from '../lib/store.js';

const real = f => JSON.parse(readFileSync(new URL('../data/' + f + '.json', import.meta.url), 'utf8'));

export function installFakes({ people = [], status = {}, failSlackFor = [], claudeDown = false, dmHistory = [], github = false } = {}) {
  const data = { people: people.map((p, i) => ({ id: 'P' + (i + 1), Status: 'Active', 'Lead (Slack ID)': 'U_LEAD_PLACEHOLDER', ...p })),
    steps: real('steps'), guides: real('guides'), questions: real('questions'), status: { ...status } };
  setData(data);
  if (github) process.env.GITHUB_TOKEN = 'test'; else delete process.env.GITHUB_TOKEN;
  const calls = { slack: [], updates: [], responses: [], claude: [], github: [] };
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (url === 'https://slack.com/api/chat.postMessage') {
      calls.slack.push(body);
      return reply(failSlackFor.includes(body.channel) ? { ok: false, error: 'channel_not_found' } : { ok: true, ts: '9' + calls.slack.length + '.0' });
    }
    if (url === 'https://slack.com/api/chat.update') { calls.updates.push(body); return reply({ ok: true }); }
    if (url.startsWith('https://slack.com/api/conversations.')) return reply({ ok: true, messages: dmHistory });
    if (url.startsWith('https://hooks.slack.test/')) { calls.responses.push(body); return reply({ ok: true }); }
    if (url === 'https://api.anthropic.com/v1/messages') {
      calls.claude.push(body);
      if (claudeDown) return reply({ error: { message: 'overloaded' } }, 529);
      return reply({ content: [{ type: 'text', text: 'Claude answer for: ' + body.messages.at(-1).content }] });
    }
    if (url.startsWith('https://api.github.com/')) {
      calls.github.push({ method: opts.method || 'GET', body });
      if ((opts.method || 'GET') === 'GET') return reply({ sha: 'abc', content: Buffer.from(JSON.stringify(data.status)).toString('base64') });
      Object.assign(data.status, JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')));
      return reply({ ok: true });
    }
    throw new Error('Unexpected fetch ' + url);
  };
  return { calls, data };
}
