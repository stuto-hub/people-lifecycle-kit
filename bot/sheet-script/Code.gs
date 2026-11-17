/**
 * People Ops Tracker: the small script attached to the Google Sheet.
 *   doGet          the bot reads every tab (only with the shared password)
 *   doPost         the bot writes one cell back, e.g. "Done" after "Mark done" in Slack
 *   onEditTrigger  tells the bot about each edit on Joiners / Leavers, so it can react at once
 * Setup: Project Settings > Script properties > BOT_SECRET (same value as SHEET_SECRET in Vercel and GitHub),
 * then run setup() once and deploy as a web app (Execute as: me, Who has access: Anyone).
 */
const BOT_URL = 'https://people-lifecycle-kit-bot.vercel.app/api/sheet';
const TABS = ['Joiners', 'Leavers', 'Steps', 'Guides', 'Questions'];
const PEOPLE_TABS = ['Joiners', 'Leavers'];

const secret_ = () => PropertiesService.getScriptProperties().getProperty('BOT_SECRET');
const out_ = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
const ok_ = key => !!secret_() && key === secret_();

function rows_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) return [];
  const v = sh.getDataRange().getDisplayValues();
  const h = v[0];
  return v.slice(1).filter(r => r.some(c => c !== '')).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

function doGet(e) {
  if (!ok_(e.parameter.key)) return out_({ error: 'forbidden' });
  const o = {};
  TABS.forEach(t => { o[t] = rows_(t); });
  return out_(o);
}

/** { key, action: 'set', id: 'J-102', column: 'J04', value: 'Done' }  (column = step ID or full header) */
function doPost(e) {
  const b = JSON.parse((e.postData && e.postData.contents) || '{}');
  if (!ok_(b.key)) return out_({ error: 'forbidden' });
  if (b.action !== 'set') return out_({ error: 'unknown action' });
  for (const t of PEOPLE_TABS) {
    const sh = SpreadsheetApp.getActive().getSheetByName(t);
    const v = sh.getDataRange().getDisplayValues();
    const c = v[0].findIndex(x => x === b.column || x.split(' ')[0] === b.column);
    const r = v.findIndex(row => row[0] === b.id);
    if (c >= 0 && r > 0) { sh.getRange(r + 1, c + 1).setValue(b.value); return out_({ ok: true }); }
  }
  return out_({ error: 'not found' });
}

function onEditTrigger(e) {
  const sh = e.range.getSheet();
  const tab = sh.getName();
  if (PEOPLE_TABS.indexOf(tab) < 0 || e.range.getRow() < 2) return;
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  const rowNum = e.range.getRow();
  // Stamp "Added on" the first time a flow starts, so short notice can be spotted.
  const statusCol = headers.indexOf('Status') + 1, addedCol = headers.indexOf('Added on') + 1;
  if (statusCol && addedCol && /active|test/i.test(sh.getRange(rowNum, statusCol).getDisplayValue()) && !sh.getRange(rowNum, addedCol).getDisplayValue())
    sh.getRange(rowNum, addedCol).setValue(Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd'));
  const values = sh.getRange(rowNum, 1, 1, lastCol).getDisplayValues()[0];
  const row = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  const columns = [];
  for (let c = e.range.getColumn(); c < e.range.getColumn() + e.range.getNumColumns(); c++) columns.push(headers[c - 1]);
  const single = e.range.getNumRows() === 1 && e.range.getNumColumns() === 1;
  UrlFetchApp.fetch(BOT_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ key: secret_(), tab, columns, oldValue: single ? String(e.oldValue || '') : '',
      value: single ? values[e.range.getColumn() - 1] : '', row }) });
}

/** Run once: installs the edit trigger (needed because the script calls the bot). */
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onEditTrigger').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
}
