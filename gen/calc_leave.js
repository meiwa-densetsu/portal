// 自動生成（tools/build.js）。直接編集しない。正本: shared/calc_leave.js
/**
 * 画面とサーバーで共有する休暇の計算（正本）。GAS のサービスは使わない純粋な JS。
 * tools/build.js が GAS 用（server/gen_calc_leave.js）とブラウザ用（web/gen/calc_leave.js）を生成する。生成物は直接編集しない。
 *
 * 計画 docs/plans/stage2-leave-plan.md 第4・5章。数字はすべて引数 rules（サーバーの RULES.LEAVE と RULES.WORK）から読む。
 * 量はすべて整数の「分」。日付は 'YYYY-MM-DD' の文字。
 *
 * つながり:
 *   grantSchedule(入社日, いつまで, rules) → 付与の表の並び [{ no, date, days }]
 *   requestMinutes({ unit, from, to }, 1日の分, rules) → 休みの量
 *   careLimit(社員履歴の並び, 年度の初めの日, rules) → 看護・介護の枠（第18章）
 *   replay(input, rules) → 振り分け（申請ごと・日ごと）と控え（summary）
 *   at(summary, 今日, rules) → 今日の時点の残り（控えから引き出す。計算し直さない）
 *   warnings(summary, settings, 今日, rules) → 注意（設定の値と比べる。控えには入れない）
 *   attendance(input, replayの答え, 付与日, 前の付与日) → 出勤率
 *   digest(parts) → 照合値
 */
var CalcLeave = (function () {
  'use strict';

  /** このファイルの計算の版。中身を変えたら上げる（控えの照合値に入る） */
  var VERSION = 1;

  /** 単位（シートの値は UNIT_LABEL） */
  var UNITS = ['day', 'half', 'hour'];
  var UNIT_LABEL = { day: '1日', half: '半日', hour: '時間' };
  /** 種類（2c で看護・介護） */
  var KINDS = ['leave', 'kango', 'kaigo'];
  var KIND_LABEL = { leave: '休み', kango: '看護', kaigo: '介護' };

  function calcError_(code, message) {
    var e = new Error(message);
    e.calcCode = code;
    return e;
  }

  function isWhole_(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  // ---------------------------------------------------------------- 日付

  function dayNumber(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var ms = Date.UTC(y, mo - 1, d);
    var back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return Math.round(ms / 86400000);
  }

  function dateOf(num) {
    var t = new Date(num * 86400000);
    var mo = t.getUTCMonth() + 1, d = t.getUTCDate();
    return t.getUTCFullYear() + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
  }

  function shift(date, days) { return dateOf(dayNumber(date) + days); }

  /** 月を足す（日は、その月に無ければ月末にそろえる。2028-02-29 + 12 → 2029-02-28） */
  function addMonths(date, months) {
    var y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)) - 1 + months, d = Number(date.slice(8, 10));
    y += Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return dateOf(Math.round(Date.UTC(y, m, Math.min(d, last)) / 86400000));
  }

  /** 入社月の初日（月の途中の入社は、入社月の初日に入社したものとみなす。仕様書 第6章） */
  function baseDate(hireDate) {
    if (dayNumber(hireDate) === null) return null;
    return String(hireDate).slice(0, 8) + '01';
  }

  // ---------------------------------------------------------------- 決まりの形

  function checkRules(rules) {
    var L = rules && rules.LEAVE;
    var W = rules && rules.WORK;
    var bad = function (what) { throw calcError_('BAD_RULES', '休暇の決まりの形が違います: ' + what); };
    if (!L || typeof L !== 'object') bad('LEAVE');
    if (!W || typeof W !== 'object') bad('WORK');
    if (!Array.isArray(L.GRANT_TABLE) || !L.GRANT_TABLE.length) bad('GRANT_TABLE');
    var prev = -1;
    L.GRANT_TABLE.forEach(function (g) {
      if (!g || !isWhole_(g.months) || !isWhole_(g.days) || g.months <= prev || g.days < 0) bad('GRANT_TABLE');
      prev = g.months;
    });
    ['GRANT_EVERY_MONTHS', 'EXPIRE_MONTHS', 'HALF_DAY_DIV', 'STEP_MIN', 'PER_DAY_MAX', 'BATCH_MAX', 'NOTE_MAX', 'CANDIDATE_AHEAD_DAYS', 'SOON_EXPIRE_DAYS', 'SUMMARY_KEEP_YEARS'].forEach(function (k) {
      if (!isWhole_(L[k]) || L[k] <= 0) bad(k);
    });
    if (typeof L.LUNCH_EXCLUDE !== 'boolean') bad('LUNCH_EXCLUDE');
    if (!Array.isArray(L.ORDER) || L.ORDER.join(',') !== 'PAID,FURIKAE,ABSENT') bad('ORDER');
    if (typeof L.AUTO_FILL !== 'boolean') bad('AUTO_FILL');
    if (!L.FIVE_DAY || !isWhole_(L.FIVE_DAY.MIN_GRANT_DAYS) || !isWhole_(L.FIVE_DAY.NEED_DAYS) || !isWhole_(L.FIVE_DAY.WITHIN_MONTHS) || typeof L.FIVE_DAY.COUNT_HOURLY !== 'boolean') bad('FIVE_DAY');
    if (typeof L.ATTENDANCE_RATIO !== 'number' || !(L.ATTENDANCE_RATIO > 0 && L.ATTENDANCE_RATIO <= 1)) bad('ATTENDANCE_RATIO');
    // 看護・介護の枠は日数（1 日の分は年度の初めの日の所定。第18章）。前の形（MINUTES・PAID_MINUTES）が混ざっていたら通さない
    var C = L.CARE;
    if (!C || typeof C !== 'object' || Object.keys(C).sort().join(',') !== 'DAYS,PAID_DAYS,STEP_MIN') bad('CARE');
    if (!isWhole_(C.DAYS) || C.DAYS <= 0 || !isWhole_(C.PAID_DAYS) || C.PAID_DAYS < 0 || C.PAID_DAYS > C.DAYS || !isWhole_(C.STEP_MIN) || C.STEP_MIN <= 0) bad('CARE');
    if (!isWhole_(W.LUNCH_FROM) || !isWhole_(W.LUNCH_TO) || W.LUNCH_FROM >= W.LUNCH_TO) bad('WORK.LUNCH');
    return true;
  }

  // ---------------------------------------------------------------- 付与の表

  /**
   * 付与の日・回・日数の並び（入社月の初日が起点。表の最後の後は GRANT_EVERY_MONTHS ごとに最後の日数）。
   * untilDate までの分（その日を含む）。入社日が日付でなければ空
   */
  function grantSchedule(hireDate, untilDate, rules) {
    var base = baseDate(hireDate);
    if (!base || dayNumber(untilDate) === null) return [];
    var L = rules.LEAVE;
    var out = [];
    var no = 0;
    for (var i = 0; i < L.GRANT_TABLE.length; i++) {
      var d = addMonths(base, L.GRANT_TABLE[i].months);
      if (d > untilDate) return out;
      out.push({ no: ++no, date: d, days: L.GRANT_TABLE[i].days });
    }
    var last = L.GRANT_TABLE[L.GRANT_TABLE.length - 1];
    for (var k = 1; k < 200; k++) {
      var d2 = addMonths(base, last.months + L.GRANT_EVERY_MONTHS * k);
      if (d2 > untilDate) break;
      out.push({ no: ++no, date: d2, days: last.days });
    }
    return out;
  }

  /** その日の後で次に来る付与（無ければ null） */
  function nextGrant(schedule, date) {
    for (var i = 0; i < (schedule || []).length; i++) if (schedule[i].date > date) return schedule[i];
    return null;
  }

  /** 社員履歴の行として使えるか（適用開始日が日付として正しく、1 日の分が正の整数。第18章 18-8 (3)） */
  function validDayMin_(h) {
    return !!h && typeof h.since === 'string' && dayNumber(h.since) !== null && isWhole_(h.min) && h.min > 0;
  }

  /** その日の 1 日の分（社員履歴の並び [{ since, min }]。その日より前の行が無ければ最初の行。使える行が無ければ null） */
  function dayMinAt(dayMins, date) {
    var best = null;
    (dayMins || []).forEach(function (h) {
      if (!validDayMin_(h)) return;
      if (h.since <= date && (!best || h.since > best.since)) best = h;
    });
    if (best) return best.min;
    var first = null;
    (dayMins || []).forEach(function (h) { if (validDayMin_(h) && (!first || h.since < first.since)) first = h; });
    return first ? first.min : null;
  }

  /**
   * 看護・介護の枠（対象者 1 人・年度 1 つ。第18章）: 年度の初めの日の 1 日の分 × 日数。
   * 年度の途中で所定が変わっても、その年度の枠は年度の初めの日の値のまま。1 日の分が取れなければ null
   * 返す値: { dayMin, paid（有給の枠）, total（全体の枠） } / null
   */
  function careLimit(dayMins, yearStart, rules) {
    var C = rules.LEAVE.CARE;
    var dm = dayMinAt(dayMins, yearStart);
    if (!dm) return null;
    return { dayMin: dm, paid: C.PAID_DAYS * dm, total: C.DAYS * dm };
  }

  /** 看護・介護の年度・時間の休みの上限の 1 年の初め（その日以前で一番新しい付与の日。無ければ入社月の初日。Q17・Q20） */
  function yearStartOf(schedule, base, date) {
    var start = base;
    (schedule || []).forEach(function (s) { if (s.date <= date) start = s.date; });
    return start;
  }

  // ---------------------------------------------------------------- 休みの量

  /**
   * 1日・半日・時間の量（分）。item: { unit, from, to }（時間のときだけ from・to = その日の 0 時からの分）。
   * 返す値: { ok: true, minutes } / { ok: false, code: 'UNIT' | 'STEP' | 'ORDER' | 'RANGE' | 'ZERO' | 'DAYMIN' }
   * step を渡せば時間の単位はそれ（看護・介護の CARE.STEP_MIN）。省けば LEAVE.STEP_MIN
   */
  function requestMinutes(item, dayMin, rules, step) {
    var L = rules.LEAVE, W = rules.WORK;
    if (!item || UNITS.indexOf(item.unit) < 0) return { ok: false, code: 'UNIT' };
    if (!isWhole_(dayMin) || dayMin <= 0) return { ok: false, code: 'DAYMIN' };
    if (item.unit === 'day') return { ok: true, minutes: dayMin };
    var from = item.from, to = item.to, s = step || L.STEP_MIN;
    if (item.unit === 'half') {
      // 半日: 量は 1 日の分 ÷ 2（時刻の長さに左右されない）。時刻があれば形を確かめる（休暇の計画 第17章 17-2。時刻の無い前の行は量だけ）
      if ((from === null || from === undefined) && (to === null || to === undefined)) return { ok: true, minutes: Math.floor(dayMin / L.HALF_DAY_DIV) };
      if (!isWhole_(from) || !isWhole_(to) || from < 0 || to > 1440 || from > 1440 || to < 0) return { ok: false, code: 'RANGE' };
      if (from % s !== 0 || to % s !== 0) return { ok: false, code: 'STEP' };
      if (to <= from) return { ok: false, code: 'ORDER' };
      return { ok: true, minutes: Math.floor(dayMin / L.HALF_DAY_DIV) };
    }
    if (!isWhole_(from) || !isWhole_(to)) return { ok: false, code: 'RANGE' };
    if (from < 0 || to > 1440 || from > 1440 || to < 0) return { ok: false, code: 'RANGE' };
    if (from % s !== 0 || to % s !== 0) return { ok: false, code: 'STEP' };
    if (to <= from) return { ok: false, code: 'ORDER' };
    var m = to - from;
    if (L.LUNCH_EXCLUDE) m -= Math.max(0, Math.min(to, W.LUNCH_TO) - Math.max(from, W.LUNCH_FROM));
    if (m <= 0) return { ok: false, code: 'ZERO' };
    return { ok: true, minutes: m };
  }

  /** 休みの時刻の区間 [from, to)（時間・半日で時刻があるとき。1日・時刻の無い半日は null） */
  function intervalOf(item) {
    if (!item || (item.unit !== 'hour' && item.unit !== 'half')) return null;
    return isWhole_(item.from) && isWhole_(item.to) && item.to > item.from ? [item.from, item.to] : null;
  }

  /**
   * 日付 D の日報に渡す休みの区間（休暇の計画 第17章 17-1・17-7 (2)）: D の休みの区間と、D+1 の休みの区間を 1440 ずらしたもの
   * （夜勤の帰属日の時間軸）。items は { unit, from, to } の並び（取り消した休みは入れない）
   */
  function reportLeaves(dayItems, nextItems) {
    var out = [];
    (dayItems || []).forEach(function (it) { var iv = intervalOf(it); if (iv) out.push(iv); });
    (nextItems || []).forEach(function (it) { var iv = intervalOf(it); if (iv) out.push([iv[0] + 1440, iv[1] + 1440]); });
    return out.sort(function (x, y) { return x[0] - y[0] || x[1] - y[1]; });
  }

  // ---------------------------------------------------------------- 振り分け

  function sortById_(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

  /**
   * 第4章 4-3 の振り分け。起点の日から日付の順に、その人の分だけ計算する。
   * input: {
   *   startDate, lastDate, hireDate,
   *   dayMins: [{ since, min }], schedule: [{ no, date, days }],
   *   grants: [{ grantId, date, minutes, kind('auto'|'initial'|'manual'), no, days, expire }]（確定した付与。取り消した分は入れない）,
   *   initialFurikae, adjustments: [{ id, date, minutes }],
   *   days: { 日付: { sched, earned, shortage, worked } }（起点〜最後の日。無い日は勤務の無い日）,
   *   requests: [{ leaveId, date, unit, from, to, kind, targetId }]（取り消した分は入れない）,
   *   autoFrom（2b。'' なら自動の埋めをしない）, careInitial: { 対象者ID: 分 }
   * }
   * 返す値: { requests: { 申請ID: { minutes, paid: [{ g, m }], f, a, cp, cu } }, auto: { 日付: {...} }, days: { 日付: [[ID, 有給, 振替, 欠勤, 看護有給, 看護無給], ...] }, summary }
   */
  function replay(input, rules) {
    var L = rules.LEAVE;
    var start = input.startDate, last = input.lastDate;
    if (dayNumber(start) === null || dayNumber(last) === null) throw calcError_('BAD_INPUT', '起点か最後の日の形が違います');
    var base = baseDate(input.hireDate) || start;
    var schedule = input.schedule || [];
    var dayMins = input.dayMins || [];
    var f = isWhole_(input.initialFurikae) ? input.initialFurikae : 0;
    var earnedCum = 0, usedCum = 0;
    // 付与（期限の日の 0 時に消える）。起点より前の付与（初めの残高）は起点の時点で残りがある
    var grants = (input.grants || []).map(function (g) {
      return { id: g.grantId, date: g.date, expire: g.expire, minutes: g.minutes, kind: g.kind, no: g.no || null, days: g.days, rem: 0, offset: 0, expired: 0, started: false };
    }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : sortById_(a, b); });
    grants.forEach(function (g) {
      if (g.date < start) { g.started = true; g.rem = g.expire > start ? g.minutes : 0; }
    });
    var byDate = function (list, key) {
      var m = {};
      (list || []).forEach(function (x) { (m[x[key]] = m[x[key]] || []).push(x); });
      return m;
    };
    var reqByDate = byDate((input.requests || []).map(function (r) { return Object.assign({ id: r.leaveId }, r); }), 'date');
    var adjByDate = byDate(input.adjustments, 'date');
    var days = input.days || {};
    var careUsed = {}; // 対象者ID|年度の初め → [有給, 無給]
    // 年度の初めの日 → 枠（1 日の分が取れなければ有給 0・全体 0。第18章 18-3）
    var careLimits = {};
    var careLimitOf = function (ys) {
      if (!careLimits[ys]) careLimits[ys] = careLimit(dayMins, ys, rules) || { dayMin: null, paid: 0, total: 0 };
      return careLimits[ys];
    };
    Object.keys(input.careInitial || {}).forEach(function (tid) {
      var ys = yearStartOf(schedule, base, start);
      var x = input.careInitial[tid];
      if (!isWhole_(x) || x <= 0) return;
      var lim = careLimitOf(ys);
      var p = Math.min(x, lim.paid);
      careUsed[tid + '|' + ys] = [p, Math.max(0, Math.min(x - p, lim.total - p))];
    });
    var out = { requests: {}, auto: {}, days: {} };
    var timeline = [];
    var uses = []; // [日付, [[付与ID, 分]...], 振替, 欠勤]（予約の差し引きに使う）
    var fiveUses = []; // [日付, 日数（小数）]（年 5 日の数え。1日・半日の休みの有給の分だけ）
    var hourlyUses = []; // [日付, 分]（時間の休みの年の上限の数え。本人が申請した時間の休みだけ）

    var borrowLimit = function (d) {
      var ng = nextGrant(schedule, d);
      var dm = dayMinAt(dayMins, d);
      return ng && dm ? ng.days * dm : 0;
    };
    var allocate = function (m, d) {
      var res = { paid: [], f: 0, a: 0 };
      var rest = m;
      L.ORDER.forEach(function (kind) {
        if (rest <= 0) return;
        if (kind === 'PAID') {
          grants.forEach(function (g) {
            if (rest <= 0 || !g.started || g.rem <= 0 || !(g.date <= d && g.expire > d)) return;
            var t = Math.min(rest, g.rem);
            g.rem -= t;
            rest -= t;
            res.paid.push({ g: g.id, m: t });
          });
        } else if (kind === 'FURIKAE') {
          var avail = f + borrowLimit(d);
          var t2 = Math.min(rest, Math.max(0, avail));
          f -= t2;
          usedCum += t2;
          rest -= t2;
          res.f = t2;
        } else {
          res.a = rest;
          rest = 0;
        }
      });
      return res;
    };
    var paidSum = function (res) { return res.paid.reduce(function (s, p) { return s + p.m; }, 0); };

    for (var n = dayNumber(start); n <= dayNumber(last); n++) {
      var d = dateOf(n);
      var changed = n === dayNumber(start);
      // ① 消える付与
      grants.forEach(function (g) {
        if (g.started && g.rem > 0 && g.expire <= d) { g.expired += g.rem; g.rem = 0; changed = true; }
      });
      // ② その日の付与（相殺を先に）
      grants.forEach(function (g) {
        if (g.started || g.date !== d) return;
        g.started = true;
        g.rem = g.expire > d ? g.minutes : 0;
        if (f < 0 && g.rem > 0) {
          var off = Math.min(-f, g.rem);
          g.rem -= off;
          g.offset = off;
          f += off;
        }
        changed = true;
      });
      // 調整
      (adjByDate[d] || []).slice().sort(sortById_).forEach(function (a) {
        if (isWhole_(a.minutes)) { f += a.minutes; changed = true; }
      });
      // ③ 振替出勤
      var day = days[d];
      if (day && isWhole_(day.earned) && day.earned > 0) { f += day.earned; earnedCum += day.earned; changed = true; }
      // ④ 申請（申請ID の順）
      var dm = dayMinAt(dayMins, d);
      var leaveMin = 0;
      var hasDay = false;
      var rowList = [];
      (reqByDate[d] || []).slice().sort(sortById_).forEach(function (r) {
        var q = requestMinutes(r, dm, rules, r.kind === 'leave' ? null : L.CARE.STEP_MIN);
        var m = q.ok ? q.minutes : 0;
        leaveMin += m;
        if (r.unit === 'day') hasDay = true;
        var cp = 0, cu = 0, rest = m;
        if (r.kind === 'kango' || r.kind === 'kaigo') {
          var ys = yearStartOf(schedule, base, d);
          var key = r.targetId + '|' + ys;
          var lim = careLimitOf(ys);
          var used = careUsed[key] || [0, 0];
          var total = lim.total - used[0] - used[1];
          cp = Math.max(0, Math.min(rest, lim.paid - used[0], total));
          rest -= cp;
          cu = Math.max(0, Math.min(rest, total - cp));
          rest -= cu;
          careUsed[key] = [used[0] + cp, used[1] + cu];
        }
        var res = allocate(rest, d);
        var rec = { minutes: m, paid: res.paid, f: res.f, a: res.a, cp: cp, cu: cu };
        out.requests[r.leaveId] = rec;
        rowList.push([r.leaveId, paidSum(res), res.f, res.a, cp, cu]);
        if (res.paid.length || res.f || res.a) uses.push([d, res.paid.map(function (p) { return [p.g, p.m]; }), res.f, res.a]);
        if (r.kind === 'leave' && (r.unit === 'day' || r.unit === 'half') && paidSum(res) > 0 && dm) fiveUses.push([d, Math.round(paidSum(res) / dm * 1000) / 1000]);
        if (r.kind === 'leave' && r.unit === 'hour' && m > 0) hourlyUses.push([d, m]);
        changed = true;
      });
      // ⑤ 自動の埋め（2b。所定より短く働いた日の足りない時間。1日の休みの日は埋まったとみなす。Q12）
      if (input.autoFrom && d >= input.autoFrom && day && day.worked && isWhole_(day.shortage) && day.shortage > 0 && !hasDay) {
        var need = day.shortage - leaveMin;
        if (need > 0) {
          var ar = allocate(need, d);
          out.auto[d] = { minutes: need, paid: ar.paid, f: ar.f, a: ar.a, cp: 0, cu: 0 };
          rowList.push(['auto', paidSum(ar), ar.f, ar.a, 0, 0]);
          uses.push([d, ar.paid.map(function (p) { return [p.g, p.m]; }), ar.f, ar.a]);
          changed = true;
        }
      }
      if (rowList.length) out.days[d] = rowList;
      if (changed) {
        var gm = {};
        grants.forEach(function (g) { if (g.started && g.rem > 0) gm[g.id] = g.rem; });
        timeline.push({ d: d, g: gm, f: f, e: earnedCum, u: usedCum });
      }
    }
    out.summary = {
      v: VERSION, start: start, last: last, base: base,
      grants: grants.map(function (g) { return { id: g.id, date: g.date, expire: g.expire, minutes: g.minutes, offset: g.offset, expired: g.expired, kind: g.kind, no: g.no, days: g.days, rem: g.rem }; }),
      timeline: compact_(timeline, last, L.SUMMARY_KEEP_YEARS), uses: uses, fiveUses: fiveUses, hourlyUses: hourlyUses,
      schedule: schedule, dayMins: dayMins, careUsed: careUsed,
    };
    return out;
  }

  /** 控えの「日ごとの値の並び」を細かく持つのは最後の日から keepYears 年。それより古い年は年の終わりの値 1 つに */
  function compact_(timeline, last, keepYears) {
    var cut = String(Number(last.slice(0, 4)) - keepYears) + last.slice(4);
    var out = [];
    for (var i = 0; i < timeline.length; i++) {
      var t = timeline[i];
      if (t.d >= cut) { out.push(t); continue; }
      var nx = timeline[i + 1];
      if (!nx || nx.d.slice(0, 4) !== t.d.slice(0, 4) || nx.d >= cut) out.push(t);
    }
    return out;
  }

  // ---------------------------------------------------------------- 今日の時点（控えから）

  /**
   * 今日の時点の残り。summary は replay の summary。計算し直しはしない。
   * 返す値: { paid（今日使える有給の分）, paidReserved（今日の後の申請で、今日ある付与から使う分）, furikae, earned, used,
   *          borrowLimit, borrowed, soon: [{ grantId, expire, minutes }], grants: [{ grantId, date, expire, rem }], pending: [{ no, date, days }] }
   */
  function at(summary, today, rules) {
    var L = rules.LEAVE;
    var tl = summary.timeline || [];
    var entry = null;
    for (var i = 0; i < tl.length; i++) { if (tl[i].d <= today) entry = tl[i]; else break; }
    var active = {};
    (summary.grants || []).forEach(function (g) { if (g.date <= today && g.expire > today) active[g.id] = g; });
    var paid = 0;
    var grantList = [];
    if (entry) {
      Object.keys(entry.g).forEach(function (id) {
        if (!active[id]) return;
        paid += entry.g[id];
        grantList.push({ grantId: id, date: active[id].date, expire: active[id].expire, rem: entry.g[id] });
      });
    }
    grantList.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var reserved = 0, reservedF = 0, reservedA = 0;
    (summary.uses || []).forEach(function (u) {
      if (u[0] <= today) return;
      u[1].forEach(function (p) { if (active[p[0]]) reserved += p[1]; });
      reservedF += u[2];
      reservedA += u[3];
    });
    var soonLimit = shift(today, L.SOON_EXPIRE_DAYS);
    var soon = grantList.filter(function (g) { return g.expire <= soonLimit && g.rem > 0; })
      .map(function (g) { return { grantId: g.grantId, expire: g.expire, minutes: g.rem }; });
    var ng = nextGrant(summary.schedule, today);
    var dm = dayMinAt(summary.dayMins, today);
    var limit = ng && dm ? ng.days * dm : 0;
    var f = entry ? entry.f : 0;
    var decided = {};
    (summary.grants || []).forEach(function (g) { if (g.no) decided[g.no] = true; });
    var aheadTo = shift(today, L.CANDIDATE_AHEAD_DAYS);
    var pending = (summary.schedule || []).filter(function (s) { return s.date >= summary.start && s.date <= aheadTo && !decided[s.no]; });
    return {
      today: today, paid: paid, paidReserved: reserved, furikaeReserved: reservedF, absentReserved: reservedA,
      furikae: f, earned: entry ? entry.e : 0, used: entry ? entry.u : 0,
      borrowLimit: limit, borrowed: Math.max(0, -f), soon: soon, grants: grantList, pending: pending, dayMin: dm,
    };
  }

  /**
   * 注意（設定の値と比べる。控えには入れない。計画 4-4 の 6 回目 high）。
   * settings: { LEAVE_BORROW_WARN_PCT, LEAVE_FIVE_WARN_MONTHS }
   * 返す値: [{ code: 'BORROW_OVER' | 'BORROW_NEAR' | 'SOON_EXPIRE' | 'GRANT_PENDING' | 'FIVE_DAY', ... }]
   */
  function warnings(summary, settings, today, rules) {
    var L = rules.LEAVE;
    var now = at(summary, today, rules);
    var out = [];
    if (now.borrowed > 0 && now.borrowed > now.borrowLimit) out.push({ code: 'BORROW_OVER', borrowed: now.borrowed, limit: now.borrowLimit });
    else if (now.borrowed > 0 && now.borrowLimit > 0 && now.borrowed * 100 >= now.borrowLimit * settings.LEAVE_BORROW_WARN_PCT) {
      out.push({ code: 'BORROW_NEAR', borrowed: now.borrowed, limit: now.borrowLimit });
    }
    if (now.soon.length) out.push({ code: 'SOON_EXPIRE', items: now.soon });
    if (now.pending.length) out.push({ code: 'GRANT_PENDING', items: now.pending });
    five(summary, today, rules).forEach(function (x) {
      if (x.monthsSince >= settings.LEAVE_FIVE_WARN_MONTHS && x.taken + x.planned < L.FIVE_DAY.NEED_DAYS) out.push(Object.assign({ code: 'FIVE_DAY' }, x));
    });
    return out;
  }

  /** 年 5 日の数え（2b）: 年 10 日以上の付与ごとに、付与から 1 年の中の取った日数（今日まで）と予定（今日の後） */
  function five(summary, today, rules) {
    var F = rules.LEAVE.FIVE_DAY;
    var out = [];
    (summary.grants || []).forEach(function (g) {
      if (!(isWhole_(g.days) && g.days >= F.MIN_GRANT_DAYS) || g.date > today) return;
      var end = addMonths(g.date, F.WITHIN_MONTHS);
      if (today >= end) return;
      var taken = 0, planned = 0;
      (summary.fiveUses || []).forEach(function (u) {
        if (u[0] < g.date || u[0] >= end) return;
        if (u[0] <= today) taken += u[1]; else planned += u[1];
      });
      var months = 0;
      while (months < 24 && addMonths(g.date, months + 1) <= today) months++;
      out.push({ grantId: g.id, date: g.date, end: end, taken: Math.round(taken * 100) / 100, planned: Math.round(planned * 100) / 100, monthsSince: months });
    });
    return out;
  }

  /**
   * 時間の休みの年の上限（Q20）: その日を含む 1 年（付与日〜次の付与日の前日）に申請した時間の休みの分と、上限の分。
   * maxDays が 0 なら上限なし（limit: null）。「◯日分」は 1 年の初めの日の 1 日の分 × 日数で固定
   */
  function hourlyUsage(summaryLike, date, maxDays) {
    var start = yearStartOf(summaryLike.schedule, summaryLike.base, date);
    var ng = nextGrant(summaryLike.schedule, date);
    var end = ng ? ng.date : '9999-12-31';
    var used = 0;
    (summaryLike.hourlyUses || []).forEach(function (u) { if (u[0] >= start && u[0] < end) used += u[1]; });
    var dm = dayMinAt(summaryLike.dayMins, start);
    return { from: start, to: ng ? shift(end, -1) : null, used: used, limit: maxDays > 0 && dm ? maxDays * dm : null };
  }

  /**
   * 出勤率（第5章）: 期間 = 前の付与日（1 回目は入社月の初日）〜付与日の前日。全労働日 = 会社用の所定がある日、
   * 出勤 = 日報の勤務がある日 ＋ 1日・半日の休みで有給に振り分けられた分がある日。起点より前を含む期間は insufficient
   */
  function attendance(input, result, grantDate, prevDate) {
    var from = prevDate, to = shift(grantDate, -1);
    var paidDay = {};
    (input.requests || []).forEach(function (r) {
      if (r.unit !== 'day' && r.unit !== 'half') return;
      var a = result.requests[r.leaveId];
      if (a && a.paid.length) paidDay[r.date] = true;
    });
    var workDays = 0, attended = 0;
    var insufficient = from < input.startDate;
    for (var n = dayNumber(from); n <= dayNumber(to); n++) {
      var d = dateOf(n);
      if (d < input.startDate) continue;
      var day = (input.days || {})[d];
      if (!day || !(day.sched > 0)) continue;
      workDays++;
      if (day.worked || paidDay[d]) attended++;
    }
    return { from: from, to: to, workDays: workDays, attended: attended, ratio: workDays ? Math.round(attended / workDays * 1000) / 1000 : null, insufficient: insufficient };
  }

  // ---------------------------------------------------------------- 照合値

  function fnv_(text, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    var hex = h.toString(16);
    return '00000000'.slice(hex.length) + hex;
  }

  /** 照合値（FNV-1a を 2 つの種で。16 進 16 桁） */
  function digest(parts) {
    var text = JSON.stringify(parts);
    return fnv_(text, 0x811c9dc5) + fnv_(text, 0x01234567);
  }

  return {
    VERSION: VERSION,
    UNITS: UNITS,
    UNIT_LABEL: UNIT_LABEL,
    KINDS: KINDS,
    KIND_LABEL: KIND_LABEL,
    dayNumber: dayNumber,
    dateOf: dateOf,
    shift: shift,
    addMonths: addMonths,
    baseDate: baseDate,
    checkRules: checkRules,
    grantSchedule: grantSchedule,
    nextGrant: nextGrant,
    dayMinAt: dayMinAt,
    yearStartOf: yearStartOf,
    careLimit: careLimit,
    requestMinutes: requestMinutes,
    intervalOf: intervalOf,
    reportLeaves: reportLeaves,
    replay: replay,
    at: at,
    warnings: warnings,
    five: five,
    hourlyUsage: hourlyUsage,
    attendance: attendance,
    digest: digest,
  };
})();
