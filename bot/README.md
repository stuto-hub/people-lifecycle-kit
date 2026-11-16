# People Ops Bot (Notion → Slack, JavaScript)

Onboarding and offboarding on free tools. Notion holds the people, steps and guides; this bot turns them into Slack nudges, escalations and answers.

| Piece | Where it runs | What it does |
|---|---|---|
| `scripts/daily.js` | GitHub Actions, 09:00 IST daily (`.github/workflows/daily.yml`) | New person in Notion → one task per step · day 0 moved → date-based steps reopen · due/overdue nudges with a **Mark done** button · escalation on day 1 (People Ops lead) and day 2 (the person's lead) · digest + ✅ heartbeat |
| `api/slack.js` | Vercel (free Hobby plan) | DMs and @mentions → Claude answers only from the Notion guides · `/people` → instant private answer · **Mark done** → Notion updated |
| `test/` | GitHub Actions on every push | The test plan as code: fake joiner + 3 edge cases + extras, with Notion, Slack and Claude faked |

No dependencies except `@vercel/functions` (keeps the function alive after replying to Slack within 3 seconds).

## Safeguards
- Every Slack request is checked with the signing secret; requests older than 5 minutes are refused.
- Slack retries are answered once.
- Confidential steps (pay, exit) are never named in escalations or failure alerts.
- The bot never changes a person's record on its own: a "my last day" question only creates a *Pending confirmation* row for People Ops.
- If a run fails, `#people-ops-alerts` gets ❌ plus the manual fallback (the 🚨 Needs action view in Notion). No ✅ in the morning = check the Actions tab.
- If Claude is down or not configured, the bot falls back to the rule-based answer.

## Secrets (never in code)
| Name | GitHub Actions | Vercel |
|---|---|---|
| `NOTION_TOKEN` | ✅ | ✅ |
| `SLACK_BOT_TOKEN` | ✅ | ✅ |
| `SLACK_SIGNING_SECRET` | | ✅ |
| `ANTHROPIC_API_KEY` | | ✅ (optional) |

## Run
- Tests: `npm test`
- One-time Notion column: Actions → *Daily lifecycle run* → Run workflow → `setup`
- Demo a different day: Run workflow → `daily` (or `preview`) with `today = 2026-11-30`
- Health check: open `https://<your-project>.vercel.app/api/slack`

## Settings
`lib/config.js`: Notion database IDs, alert channel, role → Slack member, countries with agreement templates, Claude model.
