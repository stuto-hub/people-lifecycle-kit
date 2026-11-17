/** Tiny CSV reader/writer (RFC 4180 quoting), so the tracker needs no spreadsheet library. */
import type { Row } from './types.js';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

export function toObjects(text: string): Row[] {
  const [head = [], ...rest] = parseCsv(text);
  return rest.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const quote = (v: string) => /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
export const stringifyCsv = (rows: string[][]) => rows.map(r => r.map(x => quote(String(x ?? ''))).join(',')).join('\n') + '\n';

/** Returns the CSV with one cell changed: the row whose first column is `id`, the column named `column` (or starting with it). */
export function setCellInCsv(text: string, id: string, column: string, value: string): string | null {
  const rows = parseCsv(text);
  const c = rows[0].findIndex(h => h === column || h.split(' ')[0] === column);
  const r = rows.findIndex((row, i) => i > 0 && row[0] === id);
  if (c < 0 || r < 0) return null;
  while (rows[r].length < rows[0].length) rows[r].push('');
  rows[r][c] = value;
  return stringifyCsv(rows);
}
