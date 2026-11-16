# People Ops Bot (dummy data → Slack, JavaScript)

Onboarding and offboarding on free tools. Fictional people, steps and guides live in `data/` as JSON; the bot turns them into Slack nudges, escalations and answers.

| Piece | Where it runs | What it does |
|---|---|---|
| `data/*.json` | this repo | `people` (joiners/leavers), `steps` (trigger table: offset from day 0, owner, flags, nudge text), `status` (done/blocked), `guides`, `questions` |
| `scripts/daily.js` | GitHub Actions, 09:00 IST daily | Flow started + red flags on the day someone is added · day 0 moved → date-based steps reopen · due/overdue nudges with **Mark done** · escalation day 1 (People Ops lead) and day 2 (lead; day 1 if critical) · digest + ✅ heartbeat |
| `api/slack.js` | Vercel (free Hobby plan) | DMs and @mentions → "🧠 Thinking…" then a Claude answer from the guides only, with the earlier conversation as context · `/people` → instant private answer · **Mark done** → saved to `status.json` |
| `test/` | GitHub Actions on every push | The test plan as code: fake joiner + 3 edge cases + extras |

Tasks are not stored: each is person × step, due = day 0 + offset. Short notice (added after a step was due) pulls it to the day they were added.

## Safeguards
- Every Slack request is checked with the signing secret; requests older than 5 minutes are refused; retries answered once.
- Confidential steps (pay, exit) are never named in escalations or failure alerts.
- The bot never changes a person's record: a "my last day" question only alerts People Ops.
- A failed run posts ❌ with the manual fallback. No ✅ in the morning = check the Actions tab.
- Claude down or not configured → rule-based answer.

## Secrets (never in code)
| Name | GitHub Actions | Vercel |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | ✅ |
| `SLACK_SIGNING_SECRET` | | ✅ |
| `ANTHROPIC_API_KEY` | | ✅ (optional) |
| `GITHUB_TOKEN` | | optional: lets Mark done save to `status.json` |

## Run
- Tests: `npm test` · Preview without Slack: `npm run preview`
- Demo another day: Actions → *Daily lifecycle run* → Run workflow → `today = 2026-11-30`
- Health check: `https://<project>.vercel.app/api/slack`
