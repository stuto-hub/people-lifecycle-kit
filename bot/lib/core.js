/**
 * core.js: the lifecycle rules (dates, matching a question to a guide), with no Notion or Slack calls.
 * Pure functions on plain objects, so they can be tested offline. Dates are YYYY-MM-DD strings.
 */
var Core = (function () {
  var DAY = 86400000;

  // ---------- small helpers ----------
  function ms(iso) { var p = String(iso).slice(0, 10).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function iso(t) { return new Date(t).toISOString().slice(0, 10); }
  function addDays(d, n) { return iso(ms(d) + n * DAY); }
  function diffDays(a, b) { return Math.round((ms(a) - ms(b)) / DAY); } // a minus b
  function weekday(d) { return new Date(ms(d)).getUTCDay(); }           // 0 Sun .. 6 Sat
  function yes(v) { return v === true || String(v).trim().toUpperCase() === 'Y'; }
  function blank(v) { return v === undefined || v === null || String(v).trim() === ''; }
  function pretty(d) {
    var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var x = new Date(ms(d)); return x.getUTCDate() + ' ' + m[x.getUTCMonth()];
  }
  function fill(tpl, vars) {
    return String(tpl).replace(/\{(\w+)\}/g, function (m, k) {
      return blank(vars[k]) ? '(not set)' : vars[k];
    });
  }
  function indexBy(rows, key) { var o = {}; rows.forEach(function (r) { o[r[key]] = r; }); return o; }
  function append(notes, line) { return blank(notes) ? line : notes + ' | ' + line; }

  // ---------- owners ----------
  // Lead and Buddy come from the person's row; every other role from the Roles tab.
  // If nobody is mapped, the message goes to the People Ops channel instead of disappearing.
  function resolveOwner(role, person, roles) {
    var id = role === 'Lead' ? person.lead_slack
           : role === 'Buddy' ? person.buddy_slack
           : (roles[role] || {}).slack_id;
    if (blank(id)) return { to: channel(roles), unmapped: true };
    return { to: id, unmapped: false };
  }
  function channel(roles) { return (roles['People Ops channel'] || {}).slack_id || 'PEOPLE_OPS_CHANNEL'; }
  function opsLead(roles) { return (roles['People Ops lead'] || {}).slack_id || channel(roles); }

  function vars(person, step, task, templates) {
    var tpl = templates[person.country + '|' + person.worker_type];
    return {
      name: person.name, country: person.country, worker_type: person.worker_type,
      day0: pretty(person.day0), due: pretty(task.due),
      deliver_by: pretty(addDays(person.day0, -2)),
      template: tpl ? tpl.agreement_template : 'MISSING for ' + person.country,
      shared_logins: blank(person.shared_logins) ? 'NONE LISTED, confirm with the lead' : person.shared_logins,
      lead: person.lead_slack ? '<@' + person.lead_slack + '>' : 'the lead'
    };
  }

  // ---------- 1. reconcile: people + step template -> tasks ----------
  // Creates missing tasks, re-dates open ones when day 0 moves, reopens steps that
  // depend on the date (agreement, laptop, welcome), and compresses short-notice cases.
  function reconcile(people, steps, tasks, today, templatesRows) {
    var events = [];
    var byId = indexBy(tasks, 'task_id');
    var templates = {};
    (templatesRows || []).forEach(function (t) { templates[t.country + '|' + t.worker_type] = t; });

    people.forEach(function (p) {
      if (blank(p.id) || blank(p.day0) || /cancel/i.test(p.status || '')) return;
      var flowSteps = steps.filter(function (s) { return s.flow === p.type; });
      var created = 0, compressed = 0, redated = [], reopened = [];

      flowSteps.forEach(function (s) {
        var id = p.id + '-' + s.step_id;
        var due = addDays(p.day0, Number(s.offset_days));
        var t = byId[id];
        if (!t) {
          t = { task_id: id, person_id: p.id, person_name: p.name, flow: p.type, step_id: s.step_id,
                step: s.step, owner_role: s.owner_role, due: due, status: 'open',
                escalation_level: 0, last_nudged: '', done_on: '', done_by: '', notes: '', basis_day0: p.day0 };
          if (diffDays(due, today) < 0) { t.due = today; t.notes = 'Short notice: due date pulled to today'; compressed++; }
          tasks.push(t); byId[id] = t; created++;
          return;
        }
        if (t.basis_day0 !== p.day0) {
          var from = t.due; t.basis_day0 = p.day0; t.escalation_level = 0;
          t.due = diffDays(due, today) < 0 ? today : due; // never re-date into the past
          if (t.status === 'done' && yes(s.recheck_if_date_moves)) {
            t.status = 'open'; t.done_on = ''; t.notes = append(t.notes, 'Reopened: start date moved, recheck');
            reopened.push(t.step);
          } else if (t.status === 'open') { redated.push(t.step + ' (' + pretty(from) + ' → ' + pretty(due) + ')'); }
        }
      });

      if (created) {
        events.push({ kind: 'created', person: p, count: created, compressed: compressed });
        if (p.type === 'joiner' && !templates[p.country + '|' + p.worker_type])
          events.push({ kind: 'missing_template', person: p });
        if (p.type === 'leaver' && blank(p.shared_logins))
          events.push({ kind: 'no_shared_logins', person: p });
      }
      if (redated.length || reopened.length)
        events.push({ kind: 'date_moved', person: p, redated: redated, reopened: reopened });
    });
    return events;
  }

  function eventMessages(events, roles) {
    var ch = channel(roles);
    return events.map(function (e) {
      var p = e.person;
      if (e.kind === 'created') return { to: ch, kind: 'flow_started', text:
        '🟢 ' + (p.type === 'joiner' ? 'Joiner' : 'Leaver') + ' flow started for *' + p.name + '* (' + p.country +
        ', ' + p.worker_type + '), day 0 = ' + pretty(p.day0) + '. ' + e.count + ' steps scheduled.' +
        (e.compressed ? ' ⚠️ Short notice: ' + e.compressed + ' steps are already due today.' : '') };
      if (e.kind === 'missing_template') return { to: ch, kind: 'flag', text:
        '🚩 No agreement template for *' + p.worker_type + ' in ' + p.country + '*. A human must check local rules before ' +
        p.name + '\'s agreement goes out. Add the template to the Templates tab once confirmed.' };
      if (e.kind === 'no_shared_logins') return { to: ch, kind: 'flag', text:
        '🚩 *' + p.name + '* is leaving and has no shared logins listed. Ask the lead to confirm before the access step.' };
      if (e.kind === 'date_moved') return { to: ch, kind: 'date_moved', text:
        '📅 Day 0 for *' + p.name + '* is now ' + pretty(p.day0) + '. ' +
        (e.redated.length ? 'Re-dated: ' + e.redated.length + ' open steps. ' : '') +
        (e.reopened.length ? 'Reopened to recheck: ' + e.reopened.join(', ') + '.' : '') };
      return null;
    }).filter(Boolean);
  }

  // ---------- 2. daily plan: who gets nudged / escalated today ----------
  function planDaily(today, ctx, cfg) {
    cfg = cfg || {};
    var roles = indexBy(ctx.roles, 'role');
    var people = indexBy(ctx.people, 'id');
    var steps = indexBy(ctx.steps, 'step_id');
    var templates = {};
    (ctx.templates || []).forEach(function (t) { templates[t.country + '|' + t.worker_type] = t; });
    var out = [], stuck = [];

    ctx.tasks.forEach(function (t) {
      if (t.status !== 'open') return;
      var p = people[t.person_id], s = steps[t.step_id];
      if (!p || !s || /cancel/i.test(p.status || '')) return;
      var late = diffDays(today, t.due);
      if (late < 0) return;

      var v = vars(p, s, t, templates);
      var human = yes(s.human_moment), crit = yes(s.critical), sens = yes(s.sensitive);
      // Candidate is not on Slack yet: People Ops chases by email.
      var owner = s.owner_role === 'Candidate'
        ? resolveOwner('People Ops', p, roles)
        : resolveOwner(s.owner_role, p, roles);
      var prefix = owner.unmapped ? '⚠️ No Slack owner mapped for role "' + s.owner_role + '". ' : '';
      // Never post a confidential step's details into a channel.
      if (sens && owner.unmapped) {
        out.push({ to: owner.to, kind: 'flag', task_id: t.task_id,
          text: '⚠️ A confidential step for *' + p.name + '* has no owner mapped. See the Tasks tab.' });
        t.last_nudged = today; return;
      }

      if (late === 0) {
        out.push({ to: owner.to, kind: 'nudge', task_id: t.task_id, button: true, sensitive: sens,
          text: prefix + (human ? '🤝 ' : '🔔 ') + fill(s.nudge_text, v) + (human ? ' _(Human moment: please do this personally.)_' : '') });
      } else {
        out.push({ to: owner.to, kind: 'overdue', task_id: t.task_id, button: true, sensitive: sens,
          text: prefix + '⏰ ' + late + ' day' + (late > 1 ? 's' : '') + ' overdue: ' + fill(s.nudge_text, v) });
        stuck.push({ t: t, p: p, late: late, sens: sens });

        var level = crit ? 2 : (late >= (cfg.managerAfter || 2) ? 2 : 1);
        var who = sens ? 'A confidential step for *' + p.name + '*' : '*' + t.step + '* for *' + p.name + '*';
        if (level >= 1 && Number(t.escalation_level) < 1) {
          out.push({ to: opsLead(roles), kind: 'escalation_1', task_id: t.task_id,
            text: '🟠 Escalation: ' + who + ' is ' + late + ' day(s) late (owner: ' + s.owner_role + ').' });
        }
        if (level >= 2 && Number(t.escalation_level) < 2) {
          var mgr = p.lead_slack || opsLead(roles);
          out.push({ to: mgr, kind: 'escalation_2', task_id: t.task_id,
            text: '🔴 Escalation: ' + who + ' is ' + late + ' day(s) late' + (crit ? ' and is critical' : '') +
                  '. Please help unblock (owner: ' + s.owner_role + ').' });
        }
        t.escalation_level = Math.max(Number(t.escalation_level) || 0, level);
      }
      t.last_nudged = today;
    });

    // Daily digest to the private People Ops channel
    var ch = channel(roles);
    var soon = ctx.people.filter(function (p) {
      var d = diffDays(p.day0, today); return d >= 0 && d <= 14 && !/cancel/i.test(p.status || '');
    }).map(function (p) { return '• ' + (p.type === 'joiner' ? '➡️ joining ' : '⬅️ leaving ') + pretty(p.day0) + ': ' + p.name; });
    var stuckLines = stuck.map(function (x) {
      return '• ' + x.p.name + ': ' + (x.sens ? 'confidential step' : x.t.step) + ' (' + x.late + 'd late, ' + x.t.owner_role + ')';
    });
    var digest = '*Lifecycle digest, ' + pretty(today) + '*\n' +
      '*Next 14 days*\n' + (soon.length ? soon.join('\n') : '• nobody') + '\n' +
      '*Stuck*\n' + (stuckLines.length ? stuckLines.join('\n') : '• nothing overdue 🎉');

    // Monday: stale guides + unanswered question gaps
    if (weekday(today) === 1) {
      var stale = (ctx.guides || []).filter(function (g) {
        return blank(g.last_updated) || diffDays(today, g.last_updated) > (cfg.staleDays || 180);
      }).map(function (g) { return '• ' + g.title + ' (' + g.owner_role + '): ' + (blank(g.last_updated) ? 'never reviewed' : 'last reviewed ' + Math.round(diffDays(today, g.last_updated) / 30) + ' months ago'); });
      var gaps = (ctx.questions || []).filter(function (q) { return q.matched === 'GAP' && diffDays(today, q.date) <= 7; });
      digest += '\n*Guides to review (stale)*\n' + (stale.length ? stale.join('\n') : '• all current') +
        '\n*Questions with no guide this week:* ' + gaps.length;
    }
    out.push({ to: ch, kind: 'digest', text: digest });
    var n = out.filter(function (m) { return m.kind === 'nudge' || m.kind === 'overdue'; }).length;
    var e = out.filter(function (m) { return /^escalation/.test(m.kind); }).length;
    out.push({ to: ch, kind: 'heartbeat', text: '✅ Lifecycle bot ran ' + pretty(today) + ': ' + n + ' nudges, ' + e + ' escalations.' });
    return out;
  }

  // ---------- 3. /people command: question -> guide, owner, answer, action ----------
  var COUNTRIES = ['brazil','spain','india','united states','usa','us','kenya','portugal','france','canada',
                   'singapore','philippines','indonesia','nigeria','pakistan','vietnam','mexico','germany','uk'];

  function matchQuestion(text, intents, guides, today, staleDays) {
    var q = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
    var best = null, bestScore = 0;
    intents.forEach(function (it) {
      var score = 0;
      String(it.keywords).split('|').forEach(function (k) {
        k = k.trim().toLowerCase(); if (!k) return;
        if (q.indexOf(' ' + k + ' ') >= 0) score += k.split(' ').length;
      });
      if (score > bestScore) { bestScore = score; best = it; }
    });
    var country = '';
    COUNTRIES.forEach(function (c) { if (!country && q.indexOf(' ' + c + ' ') >= 0) country = c; });
    if (!best) return { matched: 'GAP', sensitive: false, action: 'route_people_ops',
      text: "I couldn't find a guide for that yet. I've passed it to People Ops, and you'll hear back within 1 working day." };

    var g = indexBy(guides, 'guide_id')[best.guide_id];
    var countryNote = country ? ' for ' + country.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : '';
    var lines = [fill(best.answer, { country_note: countryNote })];
    if (g) {
      var age = blank(g.last_updated) ? null : diffDays(today, g.last_updated);
      var fresh = age === null ? '⚠️ never reviewed; owner asked to confirm'
                : age > (staleDays || 180) ? '⚠️ last reviewed ' + Math.round(age / 30) + ' months ago; owner asked to confirm'
                : 'reviewed ' + pretty(g.last_updated);
      lines.unshift('*' + g.title + '* (owner: ' + g.owner_role + ')');
      lines.push('🔗 <' + g.link + '|Open the guide> · ' + fresh);
    } else {
      lines.push('_No guide exists for this yet; logged as a gap for People Ops._');
    }
    if (yes(best.sensitive)) lines.push('🔒 Only you can see this reply.');
    return { matched: best.intent_id, guide: g, sensitive: yes(best.sensitive), action: best.action || '',
             stale: !!(g && (blank(g.last_updated) || diffDays(today, g.last_updated) > (staleDays || 180))),
             text: lines.join('\n') };
  }

  return { reconcile: reconcile, eventMessages: eventMessages, planDaily: planDaily,
           matchQuestion: matchQuestion, addDays: addDays, diffDays: diffDays, pretty: pretty };
})();


export default Core;
