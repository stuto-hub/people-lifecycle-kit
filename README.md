# People Lifecycle Kit

Joiner and leaver checkpoints, Slack nudges and a `/people` self-serve command, built on a Google Sheet.
All data is fictional demo data.

## What's in here

| Path | What it is |
|---|---|
| `index.html` | The handbook page (GitHub Pages). Checkpoints, nudges, a working `/people` demo, guide library, test plan. |
| `Lifecycle-Kit.xlsx` | The sheet. Upload to Google Drive and open as a Google Sheet. Includes a simulated Outbox, so it shows results before any setup. |
| `apps-script/` | `Core.gs` (logic), `Sheets.gs` (menu, daily run, simulation), `Slack.gs` (nudges, `/people`, Mark done button). |
| `slack/manifest.yml` | Create the Slack app from this. |
| `sheet-template/` | The same tabs as CSV: People, Steps, Roles, Templates, Guides, Intents, TestPlan. |
| `test/` | Local replay of the simulation and the `/people` map (`node test/run.js`). |

## How it works

1. **People** is the trigger table. Add a joiner or leaver with day 0.
2. **Steps** is the playbook: step, owner, offset from day 0, and flags (human moment, critical, confidential, recheck if date moves).
3. Every morning the script creates **Tasks**, DMs each owner on the due date, and escalates late steps:
   1 day late → People Ops lead; 2 days late (or any critical step) → the person's lead.
4. If day 0 moves, open steps re-date and date-dependent steps reopen (agreement, laptop order, welcome).
5. A daily digest and a "bot ran ✅" heartbeat go to a private People Ops channel. Mondays add stale guides and unanswered questions.
6. `/people <question>` maps the question to a guide, owner, and an answer or started workflow (**Intents** + **Guides**). Replies are visible only to the asker.

## Publish the handbook page (GitHub Pages)

1. Create a repository on GitHub and upload these files (Add file → Upload files).
2. Settings → Pages → Deploy from branch → `main` / root → Save.
3. The page is live at `https://<your-username>.github.io/<repo-name>/` in a minute or two.

Free GitHub accounts need a **public** repository for Pages.

## Set up the sheet and the bot (about 20 minutes)

1. Upload `Lifecycle-Kit.xlsx` to Google Drive → open with Google Sheets → File → Save as Google Sheets.
2. Extensions → Apps Script → create `Core.gs`, `Sheets.gs`, `Slack.gs` and paste the code. Save, reload the sheet.
3. **Lifecycle kit** menu → *Simulate*. With `DRY_RUN = true` nothing goes to Slack; messages land in *Outbox (simulated)*.
4. Slack: api.slack.com/apps → Create New App → From an app manifest → paste `slack/manifest.yml`. Install to the workspace.
5. Apps Script → Project Settings → Script properties:
   `SLACK_BOT_TOKEN` (OAuth & Permissions) and `SLACK_VERIFICATION_TOKEN` (Basic Information).
6. Apps Script → Deploy → New deployment → Web app (execute as me, access: anyone). Paste the URL into the Slack app's slash command and interactivity settings.
7. Replace placeholder IDs (`U_...`, `C_...`) in **Roles** and **People**. Invite the bot to the private People Ops channel.
8. Set `DRY_RUN = false` in `Sheets.gs`, then menu → *Install daily 9am trigger*.

## Test plan

See the **TestPlan** tab. Core cases: a fake joiner (happy path), a start date that moves, a contractor in a new country, and a leaver with shared accounts. Extras: short notice, silent failure, a question with no guide, a sensitive question.

## Known limits (v1)

- Apps Script can't read request headers, so Slack's signing secret can't be checked; it uses the verification token. For production, move `doPost` to a small cloud function or Slack Workflow.
- Slack expects a reply within 3 seconds; a cold Apps Script start can occasionally miss it.
- Days are calendar days. v2: working days and local public holidays per country.
- Guide links point to placeholders until real links are added in the **Guides** tab.
