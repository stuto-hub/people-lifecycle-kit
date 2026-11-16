/**
 * Settings that are safe to keep in code. Secrets never live here: they come from
 * environment variables (Vercel project settings and GitHub Actions secrets).
 *   SLACK_BOT_TOKEN       xoxb-... from the Slack app (OAuth & Permissions)
 *   SLACK_SIGNING_SECRET  from the Slack app (Basic Information), used to prove a request came from Slack
 *   ANTHROPIC_API_KEY     from console.anthropic.com, powers chat answers (optional: without it the bot uses rule-based answers)
 *   GITHUB_TOKEN          optional, Vercel only: lets "Mark done" save to data/status.json (fine-grained token, this repo, Contents: write)
 */
export const CONFIG = {
  TZ: 'Asia/Kolkata',
  REPO: 'stuto-hub/people-lifecycle-kit',   // the data files live in bot/data of this repo
  CHANNEL: 'C0CJ554MD3K',            // #people-ops-alerts
  ROLES: {                           // role -> Slack member ID (demo: everyone is the same person)
    'People Ops': 'U0AGY9M1J8M', 'People Ops lead': 'U0AGY9M1J8M',
    'Hiring coordinator': 'U0AGY9M1J8M', 'IT': 'U0AGY9M1J8M', 'Finance': 'U0AGY9M1J8M'
  },
  FALLBACK_USER: 'U0AGY9M1J8M',     // used when a Lead/Buddy ID in people.json is a placeholder
  TEMPLATES: ['Spain|Contractor', 'Brazil|Employee', 'India|Contractor', 'United States|Contractor'],
  HUB_URL: 'https://github.com/stuto-hub/people-lifecycle-kit/tree/main/bot/data',
  NEEDS_ACTION_URL: 'https://github.com/stuto-hub/people-lifecycle-kit/blob/main/bot/data/status.json',
  STALE_DAYS: 180,
  CLAUDE_MODEL: 'claude-haiku-5-5'   // fastest; switch to 'claude-sonnet-5-5' for richer answers
};

export const env = k => process.env[k] || '';
export const isSlackId = id => /^[UWC][A-Z0-9]{6,}$/.test(String(id || ''));

/** Today in the company time zone. TODAY=YYYY-MM-DD overrides it for demos and tests. */
export function todayIso() {
  const forced = env('TODAY');
  if (forced) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(forced)) throw new Error('TODAY must look like 2026-11-16');
    return forced;
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
