/**
 * Google Sheets as the tracker. The bot signs in as a Google service account (a robot user the Sheet is
 * shared with as Editor) and reads/writes cells through the Sheets API. No Apps Script, nothing in the Sheet.
 *   GOOGLE_SA_KEY  the service account's JSON key (Vercel environment variable)
 * Hidden tabs "_Joiners" / "_Leavers" keep the last version the bot has seen, so edits people type
 * straight into the Sheet can be spotted (pollSheet in sheet-sync.ts).
 */
import crypto from 'node:crypto';
import { CONFIG, env } from './config.js';
import { stringifyCsv } from './csv.js';

export const sheetOn = () => !!env('GOOGLE_SA_KEY');
const API = () => 'https://sheets.googleapis.com/v4/spreadsheets/' + CONFIG.SHEET_ID;
let token: { value: string; exp: number } | null = null;
let titles: { at: number; set: Set<string> } | null = null;

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** OAuth access token from the service account key (signed JWT -> token exchange), cached for ~55 minutes. */
async function accessToken(): Promise<string> {
  if (token && Date.now() < token.exp) return token.value;
  let key: any;
  try { key = JSON.parse(env('GOOGLE_SA_KEY')); } catch { throw new Error('GOOGLE_SA_KEY is not valid JSON: paste the whole key file'); }
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(key.private_key));
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig }) });
  const j: any = await res.json();
  if (!j.access_token) throw new Error('Google sign-in failed: ' + (j.error_description || j.error || res.status));
  token = { value: j.access_token, exp: Date.now() + 55 * 60000 };
  return token.value;
}

/** One Sheets API call. Google allows 60 reads a minute: on "quota exceeded" (429) wait and retry (2s, 6s, 15s). */
async function api(path: string, init: RequestInit = {}): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API() + path, { ...init, headers: { Authorization: 'Bearer ' + await accessToken(), 'content-type': 'application/json', ...(init.headers || {}) } });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok) return j;
    if (res.status === 429 && attempt < 3) { await new Promise(r => setTimeout(r, [2000, 6000, 15000][attempt])); continue; }
    throw new Error('Google Sheets: ' + ((j.error && j.error.message) || res.status));
  }
}

/** Several tabs in ONE read (counts once against the quota). Missing tabs come back as null. */
export async function readTabs(tabs: string[]): Promise<Record<string, string[][] | null>> {
  if (!titles || Date.now() - titles.at > 600000) {          // tab names change rarely: check every 10 minutes
    const meta = await api('?fields=sheets.properties.title');
    titles = { at: Date.now(), set: new Set((meta.sheets || []).map((s: any) => s.properties.title)) };
  }
  const have = titles.set;
  const want = tabs.filter(t => have.has(t));
  const out: Record<string, string[][] | null> = Object.fromEntries(tabs.map(t => [t, null]));
  if (!want.length) return out;
  const q = want.map(t => 'ranges=' + range(t)).join('&');
  const j = await api('/values:batchGet?' + q + '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER');
  (j.valueRanges || []).forEach((vr: any, i: number) => { out[want[i]] = normalise(vr.values || []); });
  return out;
}

const range = (tab: string, a1 = '') => encodeURIComponent("'" + tab + "'" + (a1 ? '!' + a1 : ''));

const DATE_COLS = /^(day 0|added on|last reviewed)$/i;
/** Google stores dates as day numbers counted from 30 Dec 1899. */
export const serialToIso = (n: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);

/**
 * A tab as rows of text, or null if the tab does not exist. Dates are read as real dates (not as displayed),
 * so the Sheet's locale or date format (13/1/27, 1/13/2027, 13 Jan 2027) never changes what the bot sees.
 */
export async function readTab(tab: string): Promise<string[][] | null> {
  let values: any[][];
  try { values = (await api('/values/' + range(tab) + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER')).values || []; }
  catch (err: any) { if (/Unable to parse range/i.test(err.message)) return null; throw err; }
  return normalise(values);
}

function normalise(values: any[][]): string[][] {
  const head = (values[0] || []).map(h => String(h ?? '').trim());
  return values.map((row, r) => row.map((v, c) => {
    if (r === 0 || !DATE_COLS.test(head[c] || '')) return String(v ?? '');
    if (typeof v === 'number') return serialToIso(v);
    return textDateToIso(String(v ?? ''));                 // a date typed as text ("25/11/2026") still counts
  }));
}

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "25/11/2026", "25-11-26", "25 Nov 2026", "Nov 25, 2026", "2026-11-25" -> 2026-11-25. Numbers are day/month unless impossible. Unreadable text is returned as is. */
export function textDateToIso(s: string): string {
  const t = s.trim(); if (!t) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31) ? (y < 100 ? 2000 + y : y) + '-' + pad(m) + '-' + pad(d) : t;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) { const a = +m[1], b = +m[2]; return b > 12 && a <= 12 ? iso(+m[3], a, b) : iso(+m[3], b, a); }
  m = t.toLowerCase().match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s+(\d{2,4})$/); if (m && MON.includes(m[2])) return iso(+m[3], MON.indexOf(m[2]) + 1, +m[1]);
  m = t.toLowerCase().match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/); if (m && MON.includes(m[1])) return iso(+m[3], MON.indexOf(m[1]) + 1, +m[2]);
  return t;
}
export const tabCsv = async (tab: string) => { const v = await readTab(tab); return v === null ? null : stringifyCsv(v); };

export const colLetter = (i: number): string => (i >= 26 ? colLetter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));

/** Writes one cell, typed as if a person entered it (so 2026-12-04 becomes a date). */
export async function writeCell(tab: string, a1: string, value: string) {
  await api('/values/' + range(tab, a1) + '?valueInputOption=USER_ENTERED', { method: 'PUT', body: JSON.stringify({ values: [[value]] }) });
}

/** Replaces a whole tab (used for the hidden snapshot tabs). */
export async function writeTab(tab: string, rows: string[][]) {
  await api('/values/' + range(tab) + ':clear', { method: 'POST', body: '{}' });
  if (rows.length) await api('/values/' + range(tab, 'A1') + '?valueInputOption=RAW', { method: 'PUT', body: JSON.stringify({ values: rows }) });
}

/** Adds a hidden tab if it is missing. */
export async function ensureHiddenTab(tab: string) {
  const meta = await api('?fields=sheets.properties.title');
  if ((meta.sheets || []).some((s: any) => s.properties.title === tab)) return false;
  await api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab, hidden: true } } }] }) });
  titles = null;
  return true;
}

/** Finds a person's row and a column (exact header, or a step ID like "J04") and writes the value there and in the snapshot. */
export async function setSheetCell(tab: 'Joiners' | 'Leavers', personId: string, column: string, value: string) {
  const rows = await readTab(tab);
  if (!rows || !rows.length) throw new Error('tab ' + tab + ' not found in the Sheet');
  const head = rows[0].map(h => String(h || '').trim());
  const c = head.findIndex(h => h === column || h.split(' ')[0] === column);
  const r = rows.findIndex((row, i) => i > 0 && String(row[0] || '').trim() === personId);
  if (c < 0 || r < 0) throw new Error(personId + ' / ' + column + ' not found in the ' + tab + ' tab');
  const a1 = colLetter(c) + (r + 1);
  await writeCell(tab, a1, value);
  try {     // the snapshot gets the same value (dates as YYYY-MM-DD, like readTab), so the next poll does not see this as an edit
    await api('/values/' + range('_' + tab, a1) + '?valueInputOption=RAW', { method: 'PUT', body: JSON.stringify({ values: [[value]] }) });
  } catch { /* snapshot tab not made yet: the next poll creates it */ }
}

/** Adds a row at the bottom of a tab (typed as if a person entered it, so dates become dates). */
export async function appendRow(tab: string, values: string[]) {
  await api('/values/' + range(tab, 'A1') + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', { method: 'POST', body: JSON.stringify({ values: [values] }) });
}
