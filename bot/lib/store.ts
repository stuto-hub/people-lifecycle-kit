/**
 * The data layer. System of record = the tracker: CSV files in bot/tracker, edited in GitHub.
 *   joiners.csv / leavers.csv  one row per person; one column per step (Pending / Done / Blocked / N/A)
 *   steps.csv                  the trigger table: step, flow, offset from day 0, owner role, flags, nudge text
 *   guides.csv / questions.csv what /people and the chat bot answer from
 * Every save in GitHub is a commit, so the change history doubles as an audit trail.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { addDays, diffDays } from './core.js';
import { CONFIG, env, trackerUrl } from './config.js';
import { toObjects, setCellInCsv } from './csv.js';
import type { Data, Person, Row, Step, StepStatus, Task } from './types.js';
import { sheetOn, tabCsv, setSheetCell, appendRow, readTab } from './sheets.js';

export const FILES = { Joiners: 'joiners.csv', Leavers: 'leavers.csv', Steps: 'steps.csv', Guides: 'guides.csv', Questions: 'questions.csv', Handbook: 'handbook.md', Reminders: 'reminders.csv', Tools: 'tools.csv' } as const;
export type Tab = keyof typeof FILES;
const OPTIONAL: string[] = ['Handbook', 'Reminders', 'Tools'];
export type Texts = Record<Tab, string>;

let override: Data | null = null;
export function setData(d: Data | null) { override = d; }          // tests

export const sheetLink = (file = '') => trackerUrl(file);

const gh = (p: string, init: RequestInit = {}) => fetch('https://api.github.com/repos/' + CONFIG.REPO + '/contents/' + p, { ...init,
  headers: { Authorization: 'Bearer ' + env('TRACKER_TOKEN'), Accept: 'application/vnd.github+json', 'User-Agent': 'people-ops-bot', ...(init.headers || {}) } });

// ---------------- reading ----------------
export function readTexts(dir = path.join(process.cwd(), 'tracker')): Texts {
  const out = {} as Texts;
  for (const [tab, file] of Object.entries(FILES)) out[tab as Tab] = existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), 'utf8') : '';
  return out;
}

let cache: { at: number; d: Data } | null = null;

/**
 * GitHub Actions and tests read the checked-out files. The Vercel bot reads the latest saved version
 * straight from GitHub (cached for a minute), so a tracker edit never needs a redeploy.
 */
export async function load(): Promise<Data> {
  if (override) return override;
  const dir = path.join(process.cwd(), 'tracker');
  if (existsSync(path.join(dir, FILES.Joiners))) return fromTexts(readTexts(dir));
  if (cache && Date.now() - cache.at < (sheetOn() ? 10000 : 60000)) return cache.d;
  const d = fromTexts(await loadTexts());
  cache = { at: Date.now(), d };
  return d;
}

/** Google Sheet mode: Joiners/Leavers (and any other tab that exists) come from the Sheet, the rest from GitHub. */
export async function loadTexts(): Promise<Texts> {
  const dir = path.join(process.cwd(), 'tracker');
  if (!sheetOn()) return existsSync(path.join(dir, FILES.Joiners)) ? readTexts(dir) : fetchTexts();
  const base = await fetchTexts();
  await Promise.all((['Joiners', 'Leavers', 'Steps', 'Guides', 'Questions', 'Reminders', 'Tools'] as Tab[]).map(async tab => {
    const csv = await tabCsv(tab);
    if (csv !== null) base[tab] = csv;
    else if (tab === 'Joiners' || tab === 'Leavers') throw new Error('the Sheet has no "' + tab + '" tab');
  }));
  return base;
}

/** One person's row as it is saved now (Sheet or CSV), headers as keys. */
export async function getRow(personId: string): Promise<Row | null> {
  if (override) {                                          // tests: rebuild the row from the in-memory data
    const p = override.people.find(x => x.id === personId); if (!p) return null;
    const row: Row = { ID: p.id, Name: p.Name, Country: p.Country, 'Worker type': p['Worker type'], 'Day 0': p['Day 0'], Status: p.Status,
      'Added on': p['Added on'], POC: p.POC, 'Lead (Slack ID)': p['Lead (Slack ID)'], 'Buddy (Slack ID)': p['Buddy (Slack ID)'], Notes: p.Notes };
    for (const s of override.steps.filter(x => x.Flow === p.Flow)) row[s.id + ' ' + s.Step] = (override.status[p.id + '::' + s.id] || { Status: 'Pending' }).Status;
    return row;
  }
  const t = await loadTexts();
  return toObjects(/^L/i.test(personId) ? t.Leavers : t.Joiners).find(r => r.ID === personId) || null;
}

async function fetchTexts(): Promise<Texts> {
  const out = {} as Texts;
  await Promise.all(Object.entries(FILES).map(async ([tab, file]) => {
    const p = CONFIG.TRACKER_DIR + '/' + file;
    let text: string;
    if (env('TRACKER_TOKEN')) {                              // fresh, authenticated
      const j: any = await (await gh(p + '?ref=main')).json();
      if (!j.content && OPTIONAL.includes(tab)) { out[tab] = ''; return; }
      if (!j.content) throw new Error('could not read tracker ' + file + ' (' + (j.message || 'no content') + ')');
      text = Buffer.from(j.content, 'base64').toString('utf8');
    } else {                                                 // public raw file (GitHub caches it for a few minutes)
      const r = await fetch('https://raw.githubusercontent.com/' + CONFIG.REPO + '/main/' + p);
      if (!r.ok && !OPTIONAL.includes(tab)) throw new Error('could not read tracker ' + file + ' (' + r.status + ')');
      text = r.ok ? await r.text() : '';
    }
    out[tab as Tab] = text;
  }));
  return out;
}

const yes = (v: unknown) => v === true || /^(yes|y|true|✓|x)$/i.test(String(v || '').trim());

/** Dates are typed as yyyy-mm-dd; anything else that parses is accepted too. */
export function normDate(v: unknown): string {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
}

/** Step columns are headed "J04 Order laptop ...": the ID before the first space links them to steps.csv. */
export const stepIdOf = (header: string) => (String(header || '').match(/^([JL]\d{2})\b/) || [])[1] || '';

/** One joiners/leavers row -> a person + the status of each of their steps. */
export function personFromRow(row: Row, tab: string): { person: Person; status: Record<string, StepStatus> } {
  const p: Person = { id: row.ID, Name: row.Name, Flow: tab === 'Leavers' ? 'Leaver' : 'Joiner', Country: row.Country, 'Worker type': row['Worker type'],
    'Day 0': normDate(row['Day 0']), Status: row.Status, 'Added on': normDate(row['Added on']), POC: row.POC,
    'Lead (Slack ID)': row['Lead (Slack ID)'] || '', 'Buddy (Slack ID)': row['Buddy (Slack ID)'] || '', 'Shared logins': row['Shared logins'] || '',
    Notes: row.Notes || '' };
  const status: Record<string, StepStatus> = {};
  for (const [h, v] of Object.entries(row)) {
    const sid = stepIdOf(h); const val = String(v || '').trim();
    if (!sid || !val || /^pending$/i.test(val)) continue;
    status[p.id + '::' + sid] = /^n\/?a$/i.test(val) ? { Status: 'Done', 'N/A': true }
      : { Status: /^done$/i.test(val) ? 'Done' : /^blocked$/i.test(val) ? 'Blocked' : val, Notes: /blocked/i.test(val) ? p.Notes : '' };
  }
  return { person: p, status };
}

export function fromTexts(t: Texts): Data {
  const people: Person[] = [], status: Record<string, StepStatus> = {}, repeated: string[] = [];
  for (const tab of ['Joiners', 'Leavers'] as const) for (const row of toObjects(t[tab])) {
    if (!row.Name && !row.ID) continue;
    if (!row.ID || people.some(x => x.id === row.ID)) { repeated.push(row.ID || '(no ID) ' + row.Name); continue; }   // fixed by the Sheet watcher (fixIds)
    const r = personFromRow(row, tab); people.push(r.person); Object.assign(status, r.status);
  }
  const steps: Step[] = toObjects(t.Steps).filter(s => s.ID).map(s => ({ id: s.ID, Step: s.Step, Flow: s.Flow as Step['Flow'],
    'Offset (days)': Number(s['Offset (days)']), 'Owner role': s['Owner role'], Critical: yes(s.Critical), 'Human moment': yes(s['Human moment']),
    Confidential: yes(s.Confidential), 'Recheck if day 0 moves': yes(s['Recheck if day 0 moves']), 'Nudge text': s['Nudge text'] }));
  const guides = toObjects(t.Guides).filter(g => g.Guide).map(g => ({ Guide: g.Guide, Owner: g.Owner, 'Last reviewed': normDate(g['Last reviewed']), Link: g.Link }));
  const questions = toObjects(t.Questions).filter(q => q.Question).map(q => ({ Question: q.Question, Guide: q.Guide, Keywords: q.Keywords,
    Answer: q.Answer, Action: q.Action, Confidential: yes(q.Confidential) }));
  const reminders = toObjects(t.Reminders || '').filter(r => r.Flow && r.Message);
  const tools = toObjects(t.Tools || '').filter(r => Object.values(r).some(v => String(v || '').trim()));
  return { people, steps, status, guides, questions, handbook: t.Handbook || '', reminders, tools, repeated, fromTracker: true };
}

// ---------------- writing (one cell, as a commit) ----------------

/**
 * Writes e.g. "Done" into a person's step column (column = step ID like "J04", or a column name like "Added on").
 * Returns false when no TRACKER_TOKEN is set (nothing written).
 */
export async function setCell(personId: string, column: string, value: string, note = ''): Promise<boolean> {
  if (override) {                                          // tests: update the in-memory data
    if (/^[JL]\d{2}$/.test(column)) override.status[personId + '::' + column] = { Status: value };
    else { const p = override.people.find(x => x.id === personId); if (p) (p as any)[column] = value; }
    return false;
  }
  if (sheetOn()) {                                        // the Google Sheet is the tracker
    await setSheetCell(/^L/i.test(personId) ? 'Leavers' : 'Joiners', personId, column, value);
    cache = null;
    return true;
  }
  if (!env('TRACKER_TOKEN')) return false;
  const file = CONFIG.TRACKER_DIR + '/' + (/^L/i.test(personId) ? FILES.Leavers : FILES.Joiners);
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur: any = await (await gh(file + '?ref=main')).json();
    if (!cur.content) throw new Error('could not read ' + file + ' (' + (cur.message || 'no content') + ')');
    const next = setCellInCsv(Buffer.from(cur.content, 'base64').toString('utf8'), personId, column, value);
    if (next === null) throw new Error(personId + ' / ' + column + ' not found in ' + file);
    const res = await gh(file, { method: 'PUT', body: JSON.stringify({ branch: 'main', sha: cur.sha,
      message: 'Tracker: ' + personId + ' ' + column + ' = ' + value + (note ? ' (' + note + ')' : ''),
      content: Buffer.from(next).toString('base64') }) });
    if (res.ok) return true;
    if (res.status !== 409) throw new Error('GitHub write failed: ' + res.status);   // 409 = someone saved in between: retry
  }
  throw new Error('GitHub write kept conflicting');
}

// ---------------- tasks ----------------
const live = (p: Person) => /active|test/i.test(p.Status || '');

/**
 * Tasks are worked out, not stored: one per person x step of their flow.
 * Due = day 0 + offset; steps already past when the person was added are pulled to that day (short notice).
 */
export function buildTasks(d: Data, today: string): Task[] {
  const tasks: Task[] = [];
  for (const p of d.people.filter(p => p['Day 0'])) {
    for (const s of d.steps.filter(s => s.Flow === p.Flow)) {
      const key = p.id + '::' + s.id;
      const st = d.status[key] || { Status: '' };
      let due = addDays(p['Day 0'], Number(s['Offset (days)'])), notes = st.Notes || '';
      if (p['Added on'] && diffDays(due, p['Added on']) < 0) { due = p['Added on']; notes = notes || 'Short notice: due date pulled to the day they were added'; }
      const status = st.Status || 'Pending';
      const late = diffDays(today, due);
      const open = status !== 'Done';
      tasks.push({ _id: key, _url: sheetLink(), Person: [p.id], Step: s.Step, StepId: s.id, Due: due, Status: status, Notes: notes,
        'Owner role': s['Owner role'], Critical: s.Critical, 'Human moment': s['Human moment'], Confidential: s.Confidential,
        'Needs action': open && live(p) && late >= 0,
        Health: !open ? '✅ Done' : status === 'Blocked' ? '⛔ Blocked' : late > 0 ? '🔴 ' + late + 'd overdue' : late === 0 ? '🔔 Due today' : '⚪ Upcoming',
        'Escalate to': open && late >= (s.Critical ? 1 : 2) ? 'lead' : open && late >= 1 ? 'People Ops lead' : '' });
    }
  }
  return tasks;
}

export const people = (d: Data): Person[] => d.people.map(p => ({ ...p, _id: p.id, _url: sheetLink() }));

/** Share of a person's steps that are Done (N/A counts as done). */
export function percentDone(d: Data, p: Person): string {
  const mine = d.steps.filter(s => s.Flow === p.Flow);
  if (!mine.length) return '';
  const done = mine.filter(s => (d.status[p.id + '::' + s.id] || { Status: '' }).Status === 'Done').length;
  return Math.round(100 * done / mine.length) + '%';
}

/** Next free ID for a tab: J-105 after J-104. */
export function nextId(d: Data, flow: 'Joiner' | 'Leaver'): string {
  const prefix = flow === 'Joiner' ? 'J-' : 'L-';
  const max = Math.max(flow === 'Joiner' ? 100 : 200, ...d.people.filter(p => p.Flow === flow).map(p => Number((p.id.match(/(\d+)/) || [])[1] || 0)));
  return prefix + (max + 1);
}

/**
 * Adds a new joiner / leaver row: the given fields, every step "Pending", Added on = today.
 * Returns the new ID, or '' when no tracker can be written (no Sheet and not in tests).
 */
export async function addPerson(flow: 'Joiner' | 'Leaver', fields: Record<string, string>): Promise<string> {
  const d = await load(); const id = nextId(d, flow);
  const tab = flow === 'Joiner' ? 'Joiners' : 'Leavers';
  const row: Record<string, string> = { ID: id, Status: 'Active', POC: 'People Ops', ...fields };
  if (override) {                                          // tests: in-memory
    const steps = override.steps.filter(s => s.Flow === flow);
    const { person } = personFromRow({ ...row, ...Object.fromEntries(steps.map(s => [s.id + ' ' + s.Step, 'Pending'])) } as any, tab);
    override.people.push(person);
    return id;
  }
  if (!sheetOn()) return '';
  const head = ((await readTab(tab)) || [[]])[0].map(h => String(h).trim());
  await appendRow(tab, head.map(h => h in row ? row[h] : /^[JL]\d{2}\b/.test(h) ? 'Pending' : ''));
  cache = null;
  return id;
}
