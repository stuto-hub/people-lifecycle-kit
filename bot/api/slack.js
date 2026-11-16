/**
 * Vercel function: the one URL Slack calls (events, /people, buttons).
 * Slack wants an answer within 3 seconds, so slow work (Claude, Notion writes) runs
 * after the reply via waitUntil, which keeps the function alive until it finishes.
 */
import { verifySlack, respond } from '../lib/slack.js';
import { acceptEvent, answerChat, peopleCommand, buttonClick } from '../lib/assistant.js';

let waitUntil = null;
try { ({ waitUntil } = await import('@vercel/functions')); } catch { /* running locally or in tests */ }
// Same hook the package uses, in case the import is ever missing on Vercel.
const contextWaitUntil = () => globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil;

const pending = new Set();
/** Runs work after the reply. Returns a promise only when the caller has to wait for it itself. */
function later(fn) {
  const job = Promise.resolve().then(fn).catch(err => console.error('background job failed:', err));
  pending.add(job); job.finally(() => pending.delete(job));
  const keepAlive = waitUntil || contextWaitUntil();
  if (keepAlive) { keepAlive(job); return null; }
  return process.env.VERCEL ? job : null;          // last resort on Vercel: finish before replying
}
export const drain = () => Promise.all([...pending]);

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const ok = () => new Response('', { status: 200 });
const timeout = ms => new Promise(r => setTimeout(() => r(null), ms));

export async function POST(request) {
  const raw = await request.text();
  const h = request.headers;
  if (!process.env.SLACK_SIGNING_SECRET) { console.error('SLACK_SIGNING_SECRET is not set'); return new Response('not configured', { status: 500 }); }
  if (!verifySlack(h, raw, process.env.SLACK_SIGNING_SECRET)) return new Response('invalid signature', { status: 401 });

  // 1. Events API (JSON): DMs and @mentions
  if ((h.get('content-type') || '').includes('application/json')) {
    const body = JSON.parse(raw || '{}');
    if (body.type === 'url_verification') return json({ challenge: body.challenge });
    if (h.get('x-slack-retry-num')) return ok();  // a retry: the first delivery is already being answered
    const ev = acceptEvent(body);
    if (ev) await later(() => answerChat(ev));
    return ok();
  }

  const form = new URLSearchParams(raw);
  // 2. Button clicks
  if (form.get('payload')) {
    const payload = JSON.parse(form.get('payload'));
    await later(() => buttonClick(payload));
    return ok();
  }
  // 3. /people: answer inline if it is ready in time, otherwise acknowledge and follow up
  if (form.get('command')) {
    const work = peopleCommand(form);
    const done = await Promise.race([work, timeout(2500)]);
    if (done) { await later(done.after); return json(done.reply); }
    await later(async () => { const r = await work; await respond(form.get('response_url'), r.reply); await r.after(); });
    return json({ response_type: 'ephemeral', text: '🔎 Looking that up…' });
  }
  return ok();
}

/** Health check: open the URL in a browser to see the bot is deployed and which settings are filled. */
export function GET() {
  const has = k => (process.env[k] ? '✅' : '❌');
  return new Response(['People Ops Bot is running.',
    has('NOTION_TOKEN') + ' NOTION_TOKEN', has('SLACK_BOT_TOKEN') + ' SLACK_BOT_TOKEN',
    has('SLACK_SIGNING_SECRET') + ' SLACK_SIGNING_SECRET', has('ANTHROPIC_API_KEY') + ' ANTHROPIC_API_KEY (optional)'].join('\n'),
    { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
