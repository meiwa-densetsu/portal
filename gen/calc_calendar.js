// 自動生成（tools/build.js）。直接編集しない。正本: shared/calc_calendar.js
/**
 * 画面とサーバーで共有する、会社カレンダーの計算（正本）。GAS のサービスは使わない純粋な JS。
 * tools/build.js が GAS 用（server/gen_calc_calendar.js）とブラウザ用（web/gen/calc_calendar.js）を生成する。
 * 生成物は直接編集しない。
 *
 * 手順5（計画 docs/plans/stage1-step5-plan.md 2-1・2-6）: 1年分の日の区分と、その社員・その日の所定。
 * 数字は引数 rules（サーバーの RULES.WORK）から読む。関数は引数を書き換えない。
 *
 * 日の区分は1日1文字: W = 出勤 / H = 休み / P = 有給推奨（出勤日に数える）。
 * 1期間（CAL_PERIOD_START_MD から1年）の区分を、日数ぶんの文字列で持つ（365〜366文字）。
 *
 *   periodOf(date, rules)                → { from, to, days }
 *   defaultDays(period, rules)           → 月〜金 W・土日 H の文字列
 *   validateDays(text, period, rules)    → { ok, errors: [{ code, date }] }
 *   summarize(text, period, rules)       → 出勤日数・休みの日数・年間の所定・月ごとの出勤日数
 *   resolveDay(input, date, rules)       → その社員・その日の所定（法律用と会社用）
 *   appliedRanges(history, period)       → 割り当てごとに分けた期間（手順6の清算に使う）
 */
var CalcCalendar = (function () {
  'use strict';

  var TYPES = { WORK: 'W', OFF: 'H', PAID: 'P' };
  var STATUS = { OK: 'OK', UNASSIGNED: 'UNASSIGNED', NO_PERIOD: 'NO_PERIOD', DRAFT: 'DRAFT' };

  // ---------------------------------------------------------------------------
  // 日付（手順4の calc_worktime.js と同じ答えになる。生成がファイルごとなので、ここにも持つ）
  // ---------------------------------------------------------------------------

  /** 'YYYY-MM-DD' を通し番号（1970-01-01 からの日数）に変える。実在しない日付は null */
  function dayNumber(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var ms = Date.UTC(y, mo - 1, d);
    var back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return Math.round(ms / 86400000);
  }

  /** 通し番号を 'YYYY-MM-DD' に戻す */
  function dateOf(num) {
    var t = new Date(num * 86400000);
    var mo = t.getUTCMonth() + 1, d = t.getUTCDate();
    return t.getUTCFullYear() + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
  }

  /** 曜日（0=日曜 … 6=土曜）。端末のタイムゾーンに左右されない */
  function dowOf(num) {
    return new Date(num * 86400000).getUTCDay();
  }

  function calcError_(code, message) {
    var e = new Error(message);
    e.calcCode = code;
    return e;
  }

  function mustDay_(text, what) {
    var n = dayNumber(text);
    if (n === null) throw calcError_('BAD_DATE', what + 'の日付の形が違います: ' + text);
    return n;
  }

  function startMd_(rules) {
    var md = rules && rules.CAL_PERIOD_START_MD;
    if (typeof md !== 'string' || !/^\d{2}-\d{2}$/.test(md) || dayNumber('2001-' + md) === null) {
      throw calcError_('BAD_RULES', 'CAL_PERIOD_START_MD の形が違います');
    }
    return md;
  }

  function dayMin_(rules) {
    var v = rules && rules.CAL_DAY_MIN;
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || Math.floor(v) !== v) throw calcError_('BAD_RULES', 'CAL_DAY_MIN の形が違います');
    return v;
  }

  // ---------------------------------------------------------------------------
  // 期間
  // ---------------------------------------------------------------------------

  /** その日が入る期間 { from, to, days }（例 2026-05-01〜2027-04-30、365日） */
  function periodOf(date, rules) {
    var n = mustDay_(date, 'その日');
    var md = startMd_(rules);
    var y = Number(String(date).slice(0, 4));
    var start = dayNumber(y + '-' + md);
    if (n < start) { y -= 1; start = dayNumber(y + '-' + md); }
    var next = dayNumber((y + 1) + '-' + md);
    return { from: dateOf(start), to: dateOf(next - 1), days: next - start };
  }

  /** period が periodOf の答えと同じ形か（初めが期間の初めの日で、終わり・日数が合う）。違えば例外 */
  function checkPeriod_(period, rules) {
    if (!period || typeof period !== 'object') throw calcError_('BAD_PERIOD', '期間がありません');
    var p = periodOf(period.from, rules);
    if (p.from !== period.from || p.to !== period.to) throw calcError_('BAD_PERIOD', '期間の形が違います: ' + period.from + '〜' + period.to);
    return { from: p.from, to: p.to, days: p.days, start: dayNumber(p.from) };
  }

  /** 新しい期間の初めの区分（月〜金 W、土日 H） */
  function defaultDays(period, rules) {
    var p = checkPeriod_(period, rules);
    var out = '';
    for (var i = 0; i < p.days; i++) {
      var dow = dowOf(p.start + i);
      out += dow === 0 || dow === 6 ? TYPES.OFF : TYPES.WORK;
    }
    return out;
  }

  /**
   * 区分の文字列を確かめる。errors の code:
   *   LENGTH（長さが期間の日数と違う）/ CHAR（W・H・P 以外の文字。date はその日）/
   *   SUNDAY（法定休日〔LEGAL_HOLIDAY_DOW〕が W・P。date はその日）
   */
  function validateDays(text, period, rules) {
    var p = checkPeriod_(period, rules);
    var errors = [];
    if (typeof text !== 'string' || text.length !== p.days) {
      errors.push({ code: 'LENGTH', date: null });
      return { ok: false, errors: errors };
    }
    for (var i = 0; i < p.days; i++) {
      var c = text.charAt(i);
      if (c !== TYPES.WORK && c !== TYPES.OFF && c !== TYPES.PAID) {
        errors.push({ code: 'CHAR', date: dateOf(p.start + i) });
        continue;
      }
      if (c !== TYPES.OFF && dowOf(p.start + i) === rules.LEGAL_HOLIDAY_DOW) errors.push({ code: 'SUNDAY', date: dateOf(p.start + i) });
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /** その区分の所定（分）。W・P は CAL_DAY_MIN、H は 0 */
  function scheduledOf(type, rules) {
    if (type === TYPES.WORK || type === TYPES.PAID) return dayMin_(rules);
    if (type === TYPES.OFF) return 0;
    throw calcError_('BAD_TYPE', '日の区分が違います: ' + type);
  }

  /**
   * 出勤日数（W＋P）・休みの日数・有給推奨の日数・年間の所定（分）・月ごとの出勤日数。
   * 協定の数字と見比べるための目安（確かめはしない。ユーザー決定）
   */
  function summarize(text, period, rules) {
    var v = validateDays(text, period, rules);
    if (v.errors.some(function (e) { return e.code !== 'SUNDAY'; })) throw calcError_('BAD_DAYS', '区分の文字列が正しくありません');
    var p = checkPeriod_(period, rules);
    var dayMin = dayMin_(rules);
    var work = 0, paid = 0, off = 0;
    var months = [];
    var cur = null;
    for (var i = 0; i < p.days; i++) {
      var month = dateOf(p.start + i).slice(0, 7);
      if (!cur || cur.month !== month) { cur = { month: month, workDays: 0, offDays: 0 }; months.push(cur); }
      var c = text.charAt(i);
      if (c === TYPES.OFF) { off++; cur.offDays++; continue; }
      work++;
      cur.workDays++;
      if (c === TYPES.PAID) paid++;
    }
    return { workDays: work, offDays: off, paidDays: paid, scheduledMinutes: work * dayMin, months: months };
  }

  // ---------------------------------------------------------------------------
  // その社員・その日の所定
  // ---------------------------------------------------------------------------

  /** history の中で、適用開始日が date 以前で一番新しい行（無ければ null） */
  function effectiveRow_(history, date) {
    var best = null;
    (history || []).forEach(function (h) {
      if (!h || typeof h.since !== 'string' || h.since > date) return;
      if (!best || h.since > best.since) best = h;
    });
    return best;
  }

  /**
   * その社員・その日の答え。
   * input:
   *   history   … [{ since, calendarId }]（その社員の社員履歴。calendarId が '' は未設定）
   *   calendars … [{ calendarId, from, to, days, confirmedDays, confirmed }]（カレンダーの日の行。期間ごと）
   *   swaps     … [{ swapId, items: [{ date, type }], cancelled }]（その社員の入れ替え。**並びが古い順**）
   * 答え:
   *   { status, calendarId, legalType, companyType, legalScheduled, companyScheduled, swapId }
   *   - legalType  … 法律用（確定時の日の区分。確定後の変更・入れ替えを重ねない＝ユーザー決定 A）
   *   - companyType … 会社用（カレンダーの今の区分 ＋ 取り消していない一番新しい入れ替え）
   *   - UNASSIGNED（割り当てが未設定）・NO_PERIOD（その期間の行が無い）・DRAFT（下書き）は、区分も所定も null。0 として黙って計算しない
   */
  function resolveDay(input, date, rules) {
    var n = mustDay_(date, 'その日');
    var out = { status: STATUS.UNASSIGNED, calendarId: '', legalType: null, companyType: null, legalScheduled: null, companyScheduled: null, swapId: null };
    var row = effectiveRow_(input && input.history, date);
    if (!row || !row.calendarId) return out;
    out.calendarId = row.calendarId;
    var cal = null;
    ((input && input.calendars) || []).forEach(function (c) {
      if (c && c.calendarId === row.calendarId && typeof c.from === 'string' && c.from <= date && c.to >= date) cal = c;
    });
    if (!cal) { out.status = STATUS.NO_PERIOD; return out; }
    if (!cal.confirmed) { out.status = STATUS.DRAFT; return out; }
    var idx = n - mustDay_(cal.from, '期間の初め');
    var legal = String(cal.confirmedDays || '').charAt(idx);
    var company = String(cal.days || '').charAt(idx);
    var swaps = (input && input.swaps) || [];
    for (var i = swaps.length - 1; i >= 0; i--) {
      var s = swaps[i];
      if (!s || s.cancelled) continue;
      var hit = null;
      (s.items || []).forEach(function (it) { if (it && it.date === date) hit = it; });
      if (hit) { company = hit.type; out.swapId = s.swapId; break; }
    }
    out.status = STATUS.OK;
    out.legalType = legal;
    out.companyType = company;
    out.legalScheduled = scheduledOf(legal, rules);
    out.companyScheduled = scheduledOf(company, rules);
    return out;
  }

  /**
   * その社員の割り当てを、period（{ from, to }）の中で、続いている区間ごとに分ける。
   * 答え: [{ from, to, calendarId }]（日付の順。calendarId '' は未設定の区間。最初の適用開始日より前は入れない）
   * 手順6は、区間ごとに legalOvertime の applied にして清算する（途中で割り当てが変わった人）
   */
  function appliedRanges(history, period) {
    var pFrom = mustDay_(period && period.from, '期間の初め');
    var pTo = mustDay_(period && period.to, '期間の終わり');
    var rows = (history || []).filter(function (h) { return h && dayNumber(h.since) !== null; })
      .slice().sort(function (a, b) { return a.since < b.since ? -1 : a.since > b.since ? 1 : 0; });
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var from = Math.max(dayNumber(rows[i].since), pFrom);
      var to = Math.min(i + 1 < rows.length ? dayNumber(rows[i + 1].since) - 1 : pTo, pTo);
      if (from > to) continue;
      var id = rows[i].calendarId || '';
      var last = out[out.length - 1];
      if (last && last.calendarId === id && dayNumber(last.to) + 1 === from) { last.to = dateOf(to); continue; }
      out.push({ from: dateOf(from), to: dateOf(to), calendarId: id });
    }
    return out;
  }

  return {
    TYPES: TYPES,
    STATUS: STATUS,
    dayNumber: dayNumber,
    dateOf: dateOf,
    dowOf: dowOf,
    periodOf: periodOf,
    defaultDays: defaultDays,
    validateDays: validateDays,
    scheduledOf: scheduledOf,
    summarize: summarize,
    resolveDay: resolveDay,
    appliedRanges: appliedRanges,
  };
})();
