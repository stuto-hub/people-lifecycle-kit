/**
 * Vercel function: the one URL Slack calls (events, /people, buttons).
 * Slack wants an answer within 3 seconds, so slow work (Claude, writing to the tracker) runs
 * after the reply via waitUntil, which keeps the function alive until it finishes.
 */
import { waitUntil } from '@vercel/functions';
import { verifySlack, respond } from '../lib/slack.js';
import { acceptEvent, answerChat, peopleCommand, buttonClick } from '../lib/assistant.js';

const pending = new Set<Promise<unknown>>();
/** Runs work after the reply. Outside Vercel (tests) the work is tracked so drain() can wait for it. */
function later(fn: () => Promise<unknown>) {
  const job = Promise.resolve().then(fn).catch(err => console.error('background job failed:', err));
  pending.add(job); job.finally(() => pending.delete(job));
  if (process.env.VERCEL) waitUntil(job);
}
export const drain = () => Promise.all([...pending]);

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const ok = () => new Response('', { status: 200 });
const timeout = (ms: number) => new Promise<null>(r => setTimeout(() => r(null), ms));

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  const h = request.headers;
  const secret = process.env.SLACK_SIGNING_SECRET || '';
  if (!secret) { console.error('SLACK_SIGNING_SECRET is not set'); return new Response('not configured', { status: 500 }); }
  if (!verifySlack(h, raw, secret)) return new Response('invalid signature', { status: 401 });

  // 1. Events API (JSON): DMs and @mentions
  if ((h.get('content-type') || '').includes('application/json')) {
    const body = JSON.parse(raw || '{}');
    if (body.type === 'url_verification') return json({ challenge: body.challenge });
    if (h.get('x-slack-retry-num')) return ok();  // a retry: the first delivery is already being answered
    const ev = acceptEvent(body);
    if (ev) later(() => answerChat(ev));
    return ok();
  }

  const form = new URLSearchParams(raw);
  // 2. Button clicks
  const payload = form.get('payload');
  if (payload) { const p = JSON.parse(payload); later(() => buttonClick(p)); return ok(); }

  // 3. /people: answer inline if it is ready in time, otherwise acknowledge and follow up
  if (form.get('command')) {
    const work = peopleCommand(form);
    const done = await Promise.race([work, timeout(2500)]);
    if (done) { later(done.after); return json(done.reply); }
    later(async () => { const r = await work; await respond(form.get('response_url') || '', r.reply); await r.after(); });
    return json({ response_type: 'ephemeral', text: '🔎 Looking that up…' });
  }
  return ok();
}

/** Health check: open the URL in a browser to see the bot is deployed and which settings are filled. */
export function GET(): Response {
  const has = (k: string) => (process.env[k] ? '✅' : '❌');
  return new Response(['People Ops Bot is running.',
    has('SLACK_BOT_TOKEN') + ' SLACK_BOT_TOKEN', has('SLACK_SIGNING_SECRET') + ' SLACK_SIGNING_SECRET',
    has('ANTHROPIC_API_KEY') + ' ANTHROPIC_API_KEY (optional)', has('TRACKER_TOKEN') + ' TRACKER_TOKEN (Mark done writes to the tracker)'].join('\n'),
    { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
