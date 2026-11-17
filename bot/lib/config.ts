/**
 * Settings that are safe to keep in code. Secrets never live here: they come from
 * environment variables (Vercel project settings and GitHub Actions secrets).
 *   SLACK_BOT_TOKEN       xoxb-... from the Slack app (OAuth & Permissions)
 *   SLACK_SIGNING_SECRET  Slack app > Basic Information; proves a request came from Slack
 *   ANTHROPIC_API_KEY     Claude Console > API keys; powers chat answers (without it: rule-based answers)
 *   TRACKER_TOKEN         Vercel only: GitHub fine-grained token (this repo, Contents: read and write)
 *                         so "Mark done" in Slack can write Done into the tracker
 */
export const CONFIG = {
  TZ: 'Asia/Kolkata',
  REPO: 'stuto-hub/people-lifecycle-kit',
  TRACKER_DIR: 'bot/tracker',            // joiners.csv, leavers.csv, steps.csv, guides.csv, questions.csv
  CHANNEL: 'C0CJ554MD3K',               // #people-ops-alerts (system alerts, digest)
  REMINDERS: 'C0CJDTZKKGW',
  SHEET_ID: '1vO4cMp3LzLubqaS2REIaQlAgW-IKepr32tOFenz7-A4',   // the Tracker Google Sheet (tabs Joiners, Leavers, ...)             // #reminders (5 / 3 / 0-day countdown, team tags)
  ROLES: {                              // role -> Slack member ID. Lead/Buddy are used when the tracker row has a placeholder.
    'People Ops': 'U0AGY9M1J8M', 'People Ops lead': 'U0AGY9M1J8M',
    'Hiring coordinator': 'U0CHNNQ8ZRV', 'IT': 'U0CHNNQ8ZRV', 'Finance': 'U0CHNNQ8ZRV', 'Admin': 'U0CHNNQ8ZRV',
    'Lead': 'U0CHNNQ8ZRV', 'Buddy': 'U0CHNNQ8ZRV'
  } as Record<string, string>,
  DIRECTORY: {                          // names used in the Sheet (POC columns, Tools tab) -> Slack member ID
    'stuti': 'U0AGY9M1J8M', 'stuti mayekar': 'U0AGY9M1J8M', 'people ops': 'U0AGY9M1J8M',
    'alterplots': 'U0CHNNQ8ZRV', 'thealterplots': 'U0CHNNQ8ZRV'
  } as Record<string, string>,
  FALLBACK_USER: 'U0AGY9M1J8M',        // used when a Lead/Buddy ID in the tracker is a placeholder
  TEMPLATES: ['Spain|Contractor', 'Brazil|Employee', 'India|Contractor', 'United States|Contractor'],
  STALE_DAYS: 180,
  CLAUDE_MODEL: 'claude-haiku-5-5'      // fastest; switch to 'claude-sonnet-5-5' for richer answers
};

/** The Google Sheet that mirrors the CSVs (IMPORTDATA tabs), so people open a real sheet. GitHub stays the source of truth. */
export const SHEET = 'https://docs.google.com/spreadsheets/d/1vO4cMp3LzLubqaS2REIaQlAgW-IKepr32tOFenz7-A4/edit';
const SHEET_TABS: Record<string, string> = { 'joiners.csv': '670692284', 'leavers.csv': '883283007', 'steps.csv': '1778770704', 'questions.csv': '823496685', 'guides.csv': '1601903721' };
export const trackerUrl = (file = '') => SHEET + '#gid=' + (SHEET_TABS[file] || SHEET_TABS['joiners.csv']);
/** Where an edit actually happens (the CSV in GitHub). */
export const trackerEditUrl = (file = '') => 'https://github.com/' + CONFIG.REPO + '/edit/main/' + CONFIG.TRACKER_DIR + '/' + (file || 'joiners.csv');
export const env = (k: string) => process.env[k] || '';
export const isSlackId = (id: unknown) => /^[UWC][A-Z0-9]{6,}$/.test(String(id || ''));

/** Today in the company time zone. TODAY=YYYY-MM-DD overrides it for demos and tests. */
export function todayIso(): string {
  const forced = env('TODAY');
  if (forced) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(forced)) throw new Error('TODAY must look like 2026-11-16');
    return forced;
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
