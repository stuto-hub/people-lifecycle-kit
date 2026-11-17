/**
 * Pure rules with no Slack or GitHub calls, so they can be tested offline:
 * date maths and matching a question to the right guide.
 */
const DAY = 86400000;
const ms = (d: string) => { const p = String(d).slice(0, 10).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); };
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';

export const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
/** a minus b, in days */
export const diffDays = (a: string, b: string) => Math.round((ms(a) - ms(b)) / DAY);
export const pretty = (d: string) => {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const x = new Date(ms(d)); return x.getUTCDate() + ' ' + m[x.getUTCMonth()];
};
export const fill = (tpl: string, vars: Record<string, string>) =>
  String(tpl || '').replace(/\{(\w+)\}/g, (_m, k) => blank(vars[k]) ? '(not set)' : vars[k]);

export interface Intent { intent_id: string; keywords: string; guide_id: string; answer: string; action: string; sensitive: 'Y' | 'N' }
export interface GuideRef { guide_id: string; title: string; owner_role: string; last_updated: string; link: string }
export interface Match { matched: string; guide?: GuideRef; sensitive: boolean; action: string; stale?: boolean; text: string }

const COUNTRIES = ['brazil', 'spain', 'india', 'united states', 'usa', 'us', 'kenya', 'portugal', 'france', 'canada',
  'singapore', 'philippines', 'indonesia', 'nigeria', 'pakistan', 'vietnam', 'mexico', 'germany', 'uk'];

/** Scores each known question by whole-word keyword hits; no match = a gap People Ops should hear about. */
export function matchQuestion(text: string, intents: Intent[], guides: GuideRef[], today: string, staleDays = 180): Match {
  const q = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  let best: Intent | null = null, bestScore = 0;
  for (const it of intents) {
    let score = 0;
    for (const raw of String(it.keywords).split('|')) {
      const k = raw.trim().toLowerCase();
      if (k && q.includes(' ' + k + ' ')) score += k.split(' ').length;
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  if (!best) return { matched: 'GAP', sensitive: false, action: 'route_people_ops',
    text: "I couldn't find a guide for that yet. I've passed it to People Ops, and you'll hear back within 1 working day." };

  const country = COUNTRIES.find(c => q.includes(' ' + c + ' ')) || '';
  const g = guides.find(x => x.guide_id === best!.guide_id);
  const countryNote = country ? ' for ' + country.replace(/\b\w/g, c => c.toUpperCase()) : '';
  const lines = [fill(best.answer, { country_note: countryNote })];
  let stale = false;
  if (g) {
    const age = blank(g.last_updated) ? null : diffDays(today, g.last_updated);
    stale = age === null || age > staleDays;
    const fresh = age === null ? '⚠️ never reviewed; owner asked to confirm'
      : age > staleDays ? '⚠️ last reviewed ' + Math.round(age / 30) + ' months ago; owner asked to confirm'
      : 'reviewed ' + pretty(g.last_updated);
    lines.unshift('*' + g.title + '* (owner: ' + g.owner_role + ')');
    lines.push('🔗 <' + g.link + '|Open the guide> · ' + fresh);
  } else lines.push('_No guide exists for this yet; logged as a gap for People Ops._');
  const sensitive = best.sensitive === 'Y';
  if (sensitive) lines.push('🔒 Only you can see this reply.');
  return { matched: best.intent_id, guide: g, sensitive, action: best.action || '', stale, text: lines.join('\n') };
}
