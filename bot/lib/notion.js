/** Minimal Notion API client (no SDK, no dependencies). */
import { env } from './config.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function notion(method, path, body, attempt = 0) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    method: method.toUpperCase(),
    headers: { Authorization: 'Bearer ' + env('NOTION_TOKEN'), 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  // Notion allows about 3 requests a second; wait and retry when it says slow down.
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleep(1000 * (Number(res.headers.get('retry-after')) || attempt + 1));
    return notion(method, path, body, attempt + 1);
  }
  const text = await res.text();
  const j = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error('Notion ' + path + ': ' + (j.message || res.status));
  return j;
}

export async function queryAll(db, filter) {
  let out = [], cursor = null;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const j = await notion('post', '/databases/' + db + '/query', body);
    out = out.concat(j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out.map(row);
}

/** Flatten one Notion property to a plain value. */
export function val(p) {
  if (!p) return '';
  switch (p.type) {
    case 'title': return p.title.map(t => t.plain_text).join('');
    case 'rich_text': return p.rich_text.map(t => t.plain_text).join('');
    case 'select': return p.select ? p.select.name : '';
    case 'status': return p.status ? p.status.name : '';
    case 'number': return p.number;
    case 'checkbox': return p.checkbox;
    case 'date': return p.date ? p.date.start.slice(0, 10) : '';
    case 'url': return p.url || '';
    case 'relation': return p.relation.map(r => r.id);
    case 'formula': { const f = p.formula; return f.type === 'date' ? (f.date ? f.date.start.slice(0, 10) : '') : f[f.type]; }
    default: return '';
  }
}

/** One Notion page as a flat object: { _id, _url, 'Column name': value, ... } */
export function row(page) {
  const o = { _id: page.id, _url: page.url };
  for (const k of Object.keys(page.properties)) o[k] = val(page.properties[k]);
  return o;
}

export const T = s => [{ type: 'text', text: { content: String(s || '').slice(0, 2000) } }];
