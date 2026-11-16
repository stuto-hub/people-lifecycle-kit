/** Slack Web API calls (no SDK). */
import crypto from 'node:crypto';
import { CONFIG, env } from './config.js';

export async function slackApi(method, body) {
  const res = await fetch('https://slack.com/api/' + method, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env('SLACK_BOT_TOKEN'), 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  });
  return res.json();
}

/** Read methods (conversations.history / replies) take query parameters. */
export async function slackGet(method, params) {
  const res = await fetch('https://slack.com/api/' + method + '?' + new URLSearchParams(params), {
    headers: { Authorization: 'Bearer ' + env('SLACK_BOT_TOKEN') } });
  return res.json();
}

export const postMessage = body => slackApi('chat.postMessage', { unfurl_links: false, ...body });

/** Reply through a response_url (slash commands and button clicks). */
export async function respond(url, body) {
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/**
 * Send one planned message. Messages tied to a task get a "Mark done" button.
 * If Slack refuses (wrong ID, user not found), the channel is told instead, without
 * leaking the content of confidential steps.
 */
export async function send(m) {
  if (!m || !m.to) return;
  const body = { channel: m.to, text: m.text };
  if (m.taskId) {
    body.blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: m.text } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', action_id: 'mark_done', value: m.taskId, text: { type: 'plain_text', text: 'Mark done ✅' } },
        { type: 'button', action_id: 'open', url: m.url, text: { type: 'plain_text', text: 'Open in Notion' } } ] }
    ];
  }
  const j = await postMessage(body);
  console.log((j.ok ? 'sent ' : 'FAILED ') + m.kind + ' -> ' + m.to + (j.ok ? '' : ' ' + j.error));
  if (!j.ok && m.to !== CONFIG.CHANNEL) {
    await send({ to: CONFIG.CHANNEL, kind: 'flag', text: '⚠️ Could not reach ' + m.to + ' (' + j.error + '). ' +
      (m.confidential ? 'A confidential step needs attention; see Notion.' : 'Message was: ' + m.text) });
  }
  return j;
}

/**
 * Proves a request really came from Slack: HMAC-SHA256 of "v0:timestamp:body" with the
 * signing secret, and the timestamp must be within 5 minutes (stops replayed requests).
 */
export function verifySlack(headers, rawBody, secret, nowMs = Date.now()) {
  const ts = headers.get('x-slack-request-timestamp');
  const sig = headers.get('x-slack-signature') || '';
  if (!secret || !ts || Math.abs(nowMs / 1000 - Number(ts)) > 300) return false;
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update('v0:' + ts + ':' + rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
