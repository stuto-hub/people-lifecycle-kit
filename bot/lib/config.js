/**
 * Settings that are safe to keep in code. Secrets never live here: they come from
 * environment variables (Vercel project settings and GitHub Actions secrets).
 *   NOTION_TOKEN          secret of the Notion connection "People Ops Bot"
 *   SLACK_BOT_TOKEN       xoxb-... from the Slack app (OAuth & Permissions)
 *   SLACK_SIGNING_SECRET  from the Slack app (Basic Information), used to prove a request came from Slack
 *   ANTHROPIC_API_KEY     from console.anthropic.com, powers chat answers (optional: without it the bot uses rule-based answers)
 */
export const CONFIG = {
  TZ: 'Asia/Kolkata',
  DB: {
    people:    '41ad2f02b3a6809a8ea2cdad215d5dd2',
    steps:     '41ad2f02b3a6808699eaf2df32497d4d',
    tasks:     '41ad2f02b3a6809595bbe87a1cd78f5c',
    guides:    '41ad2f02b3a6803aa2fbd6bd03ec3982',
    questions: '41ad2f02b3a68062b082d63172c1166b'
  },
  CHANNEL: 'C0CJ554MD3K',            // #people-ops-alerts
  ROLES: {                           // role -> Slack member ID (demo: everyone is the same person)
    'People Ops': 'U0AGY9M1J8M', 'People Ops lead': 'U0AGY9M1J8M',
    'Hiring coordinator': 'U0AGY9M1J8M', 'IT': 'U0AGY9M1J8M', 'Finance': 'U0AGY9M1J8M'
  },
  FALLBACK_USER: 'U0AGY9M1J8M',     // used when a Lead/Buddy ID in Notion is a placeholder
  TEMPLATES: ['Spain|Contractor', 'Brazil|Employee', 'India|Contractor', 'United States|Contractor'],
  HUB_URL: 'https://app.notion.com/p/People-Ops-Hub-41ad2f02b3a680a2a2ece93b6eee8ec5',
  NEEDS_ACTION_URL: 'https://app.notion.com/p/41ad2f02b3a6809595bbe87a1cd78f5c',
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
