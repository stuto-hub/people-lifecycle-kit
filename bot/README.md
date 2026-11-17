# People Ops Bot (TypeScript · GitHub + Slack)

Onboarding and offboarding run from a tracker that lives in this repo, with Slack doing the chasing.

## The tracker (`tracker/`)
| File | What it holds |
|---|---|
| `joiners.csv` / `leavers.csv` | One row per person. One column per step: `Pending`, `Done`, `Blocked` or `N/A` |
| `steps.csv` | The trigger table: offset from day 0, owner role, critical, human moment, confidential, recheck if day 0 moves, nudge text |
| `guides.csv` / `questions.csv` | What `/people` and the chat bot answer from (Data F and G) |

Edit a CSV in GitHub (pencil icon) and commit. Every save is a commit, so the history is the audit trail.

## What happens
| When | Where it runs | What the bot does |
|---|---|---|
| Status set to `Active` (or `Test`) | GitHub Actions, *Tracker changed* | Flow started, owners assigned, 🚩 red flags (no template, no shared logins), today's nudges, `Added on` stamped |
| `Day 0` edited | *Tracker changed* | Due dates move; date-dependent steps that were Done go back to Pending |
| A step set to `Blocked` / `Done` | *Tracker changed* | Leads alerted / logged (confidential steps never named) |
| Every morning, 09:00 IST | *Daily lifecycle run* | 🔔 due today, ⏰ overdue, 🟠 day-1 escalation to the People Ops lead, 🔴 day-2 (day-1 if critical) to the person's lead, digest, ✅ heartbeat |
| Any time | Vercel, `api/slack.ts` | DM / @mention → Claude answers from the guides only · `/people` → instant private answer · **Mark done** → writes Done into the tracker |

## Safeguards
- Slack requests are checked with the signing secret; replays older than 5 minutes are refused; retries answered once.
- Confidential steps (pay, exit) are never named in channels, escalations or failure alerts.
- Human moments (welcome, buddy intro, exit call) are nudged, never automated.
- "My last day is Friday" only alerts People Ops: a human confirms before anything changes.
- A failed run posts ❌ with the manual fallback (work straight from the tracker). No ✅ in the morning = check the Actions tab.
- Claude down or not configured → rule-based answer.

## Secrets (never in code)
| Name | GitHub Actions | Vercel |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | ✅ |
| `SLACK_SIGNING_SECRET` | | ✅ |
| `ANTHROPIC_API_KEY` | | ✅ (optional) |
| `TRACKER_TOKEN` | (uses the built-in token) | ✅ fine-grained GitHub token, this repo, Contents: read and write |

## Run
- `npm test` (type-check: `npm run typecheck`) · preview without Slack: `npm run preview`
- Demo another day: Actions → *Daily lifecycle run* → Run workflow → `today = 2026-11-30`
- Health check: `https://<project>.vercel.app/api/slack`
