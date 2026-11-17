/**
 * Scheduled jobs, called by GitHub Actions (the clock) so the Google key only lives in Vercel.
 *   /api/cron?job=poll                       spot edits typed into the Sheet (every 5 minutes)
 *   /api/cron?job=daily                      nudges, escalations, countdown, digest (09:00 IST; skips if already sent today)
 *   /api/cron?job=countdown&today=2026-11-25 only the 5 / 3 / 0-day reminders (demo button)
 *   /api/cron?job=preview                    what the daily run would send, sends nothing
 * Jobs that can re-send (force, countdown, today=...) need ?key=CRON_SECRET when that variable is set.
 */
import { pollSheet } from '../lib/sheet-sync.js';
import { dailyRun } from '../lib/lifecycle.js';

const text = (s: string, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const job = q.get('job') || 'poll';
  const today = q.get('today') || undefined;
  const risky = job === 'countdown' || q.get('force') === 'true' || !!today;
  if (risky && process.env.CRON_SECRET && q.get('key') !== process.env.CRON_SECRET) return text('key required', 401);
  try {
    if (job === 'poll') return text((await pollSheet(today)).join('\n'));
    if (job === 'daily' || job === 'countdown' || job === 'preview') {
      const out = await dailyRun({ today, dryRun: job === 'preview', force: q.get('force') === 'true' || job === 'countdown', only: job === 'countdown' ? 'countdown' : '' });
      return text(job + ': ' + out.length + ' messages\n' + out.map(m => m.kind + ' -> ' + m.to + ': ' + m.text.replace(/\n/g, ' ')).join('\n'));
    }
    return text('unknown job ' + job, 400);
  } catch (err: any) {
    return text('failed: ' + err.message, 500);
  }
}
