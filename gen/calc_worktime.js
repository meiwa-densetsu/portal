// 自動生成（tools/build.js）。直接編集しない。正本: shared/calc_worktime.js
/**
 * 画面とサーバーで共有する計算（正本）。GAS のサービス（SpreadsheetApp など）は使わない純粋な JS。
 * tools/build.js が GAS 用（server/gen_calc_worktime.js）とブラウザ用（web/gen/calc_worktime.js）を生成する。
 * 生成物は直接編集しない。
 *
 * 手順4（計画 docs/plans/stage1-step4-plan.md）: 休憩・実働・振替・法律上の時間外の計算。
 * 計算の数字はすべて引数 rules（サーバーの RULES.WORK）から読む。コードに数字を直接書かない。
 * 関数は引数を書き換えない。時刻は「出社した日の 0:00 からの分」の整数で扱い、途中で丸めない。
 *
 * つながり:
 *   validateShift(文字の入力, rules) → shift（分）
 *   calcShift(shift, breakType, rules) → calc（休憩・実働）
 *   splitShift(shift, calc, date, rules) → 暦日・深夜・法定休日の区分け（推計）
 *   dayBalance([{ calc, night }], 会社用の所定, rules) → 振替に積む分・足りない分
 *   legalOvertime({ period, applied, days, neighbors, asOf }, rules) → 法律上の時間外（推計）
 *   payPeriodOf(date, rules) → 締めの期間
 */
var CalcWorktime = (function () {
  'use strict';

  /** 計算のコードの版。計算の中身を変えたら上げる（日報に「計算の世代」として残す） */
  var VERSION = 2;

  var DAY_MIN = 1440;
  var SHIFT_FIELDS = ['arrive', 'start', 'end', 'leave'];

  // ---------------------------------------------------------------------------
  // 時刻・日付の変換
  // ---------------------------------------------------------------------------

  /**
   * 'H:MM' または 'HH:MM' を「その日の0時からの分」に変える。形が違えば null。
   * maxMinutes … 受け付ける最大の分（出勤は 23:59 = 1439、退勤は日またぎを含めて 47:59 = 2879）
   */
  function parseHm(text, maxMinutes) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
    if (!m) return null;
    var h = Number(m[1]);
    var min = Number(m[2]);
    if (min > 59) return null;
    var total = h * 60 + min;
    var max = typeof maxMinutes === 'number' ? maxMinutes : 1439;
    if (total > max) return null;
    return total;
  }

  /** 分を 'H:MM' に変える（510 → '8:30'、1530 → '25:30'）。整数でない・負の値は null */
  function formatHm(minutes) {
    if (typeof minutes !== 'number' || !isFinite(minutes) || minutes < 0 || Math.floor(minutes) !== minutes) return null;
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return h + ':' + (m < 10 ? '0' + m : String(m));
  }

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

  function mustDay_(text, what) {
    var n = dayNumber(text);
    if (n === null) throw calcError_('BAD_DATE', what + 'の日付の形が違います: ' + text);
    return n;
  }

  function calcError_(code, message) {
    var e = new Error(message);
    e.calcCode = code;
    return e;
  }

  function isWhole_(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
  }

  // ---------------------------------------------------------------------------
  // 1-1. 時刻の入力の確かめ
  // ---------------------------------------------------------------------------

  /**
   * 1回の勤務の4つの時刻を確かめ、分に直す。
   * input: { arrive, start, end, leave }（'H:MM' の文字）と night（夜勤の印）
   * 返す値: { ok, errors: [{ field, code }], shift: { arrive, start, end, leave, night } | null }
   *   code: EMPTY / FORMAT / STEP / ORDER / NEEDS_NIGHT / SAME / TOO_LONG
   */
  function validateShift(input, rules) {
    var src = input || {};
    var errors = [];
    var raw = [];
    for (var i = 0; i < SHIFT_FIELDS.length; i++) {
      var f = SHIFT_FIELDS[i];
      var text = src[f];
      if (text === null || text === undefined || String(text).trim() === '') {
        errors.push({ field: f, code: 'EMPTY' });
        continue;
      }
      var v = parseHm(text, DAY_MIN - 1);
      if (v === null) { errors.push({ field: f, code: 'FORMAT' }); continue; }
      if (v % rules.TIME_STEP_MIN !== 0) { errors.push({ field: f, code: 'STEP' }); continue; }
      raw.push(v);
    }
    if (errors.length) return { ok: false, errors: errors, shift: null };

    var night = src.night === true;
    // 前の時刻より小さくなったら、その時刻とそれより後のすべてに 1440 を足す（1回まで）
    var out = [raw[0]];
    var offset = 0;
    for (var k = 1; k < raw.length; k++) {
      var val = raw[k] + offset;
      if (val < out[k - 1]) {
        if (offset > 0) return { ok: false, errors: [{ field: SHIFT_FIELDS[k], code: 'ORDER' }], shift: null };
        offset = DAY_MIN;
        val = raw[k] + offset;
      }
      out.push(val);
    }
    if (offset > 0 && !night) {
      // 夜勤の印が無いのに前へ戻る: 退社が出社より前なら日をまたいだ勤務（夜勤にするか聞く）、そうでなければ並びの誤り
      var code = raw[3] < raw[0] ? 'NEEDS_NIGHT' : 'ORDER';
      return { ok: false, errors: [{ field: code === 'NEEDS_NIGHT' ? 'leave' : firstBackward_(raw), code: code }], shift: null };
    }
    var stay = out[3] - out[0];
    if (stay === 0) return { ok: false, errors: [{ field: 'leave', code: 'SAME' }], shift: null };
    if (stay >= DAY_MIN) return { ok: false, errors: [{ field: 'leave', code: 'TOO_LONG' }], shift: null };
    return { ok: true, errors: [], shift: { arrive: out[0], start: out[1], end: out[2], leave: out[3], night: night } };
  }

  function firstBackward_(raw) {
    for (var i = 1; i < raw.length; i++) if (raw[i] < raw[i - 1]) return SHIFT_FIELDS[i];
    return 'leave';
  }

  // ---------------------------------------------------------------------------
  // 1-2. 休憩と実働
  // ---------------------------------------------------------------------------

  /** 夜勤の印と休憩方式から、使う計算の決まり（SITE / OFFICE / NIGHT）を決める */
  function breakMode_(night, breakType, rules, warnings) {
    if (night) return 'NIGHT';
    var mode = rules.BREAK_RULES[breakType];
    if (!mode) throw calcError_('BAD_BREAK_TYPE', '休憩方式が分かりません: ' + breakType);
    if (mode === 'NIGHT') {
      warnings.push('NIGHT_TYPE_ON_DAY');
      mode = rules.BREAK_RULES[rules.NIGHT_TYPE_DAY_RULE];
      if (!mode || mode === 'NIGHT') throw calcError_('BAD_BREAK_TYPE', 'NIGHT_TYPE_DAY_RULE が日勤の休憩方式ではありません');
    }
    return mode;
  }

  /**
   * 休憩（決まった休憩・長く働いた日の追加の休憩）と実働。
   * shift は validateShift を通ったもの。breakType は社員履歴の休憩方式（現場日中 / 事務 / 夜勤）。
   * いつも成り立つこと: rawStay = deemedExcluded + adjustedStay、adjustedStay = baseBreak + extraBreak + work、
   *   baseBreak + extraBreak = (lunch の長さ) + otherBreak
   */
  function calcShift(shift, breakType, rules) {
    var warnings = [];
    var mode = breakMode_(shift.night === true, breakType, rules, warnings);
    var rawStay = shift.leave - shift.arrive;
    var a = shift.arrive;
    var b = shift.leave;
    var L0 = rules.LUNCH_FROM;
    var L1 = rules.LUNCH_TO;
    if (mode !== 'NIGHT') {
      // 12時台のみなし（日勤だけ）: 12時台の出社は昼休みの終わり、12時台の退社は昼休みの始まりとみなす
      if (a >= L0 && a < L1) a = L1;
      if (b > L0 && b < L1) b = L0;
    }
    if (b <= a) {
      // みなした後に働いた区間が無い（例 12:00〜12:30）
      warnings.push('NO_WORK');
      return {
        rawStay: rawStay, deemedExcluded: rawStay, adjustedStay: 0, adjArrive: null, adjLeave: null,
        lunch: null, otherBreak: 0, baseBreak: 0, extraBreak: 0, work: 0, warnings: warnings,
      };
    }
    var adjustedStay = b - a;

    // 決まった休憩
    var lunchLen = 0;
    var otherBase = 0;
    if (mode === 'SITE') {
      if (b <= L0) otherBase = rules.SITE_AM_BREAK;            // 午前のみ
      else if (a >= L1) otherBase = rules.SITE_PM_BREAK;       // 午後のみ
      else { lunchLen = L1 - L0; otherBase = rules.SITE_AM_BREAK + rules.SITE_PM_BREAK; }
    } else if (mode === 'OFFICE') {
      if (a <= L0 && b >= L1) lunchLen = L1 - L0;
    } else {
      otherBase = rules.NIGHT_BREAK;
    }

    var base = lunchLen + otherBase;
    if (base >= adjustedStay) {
      // 休憩が会社にいた時間以上: 休憩は会社にいた時間まで、実働 0
      var lunchKeep = Math.min(lunchLen, adjustedStay);
      warnings.push('NO_WORK');
      return {
        rawStay: rawStay, deemedExcluded: rawStay - adjustedStay, adjustedStay: adjustedStay, adjArrive: a, adjLeave: b,
        lunch: lunchKeep > 0 ? { from: L0, to: L1 } : null, otherBreak: adjustedStay - lunchKeep,
        baseBreak: adjustedStay, extraBreak: 0, work: 0, warnings: warnings,
      };
    }

    // 長く働いた日の追加の休憩（上から順に、超えた分だけ引く）
    var L = adjustedStay - base;
    var extra = 0;
    for (var i = 0; i < rules.EXTRA_BREAKS.length; i++) {
      var over = rules.EXTRA_BREAKS[i][0];
      var minutes = rules.EXTRA_BREAKS[i][1];
      var cut = Math.min(minutes, Math.max(0, L - over));
      L -= cut;
      extra += cut;
    }

    // 法律で決まった休憩に、会社の決まりの休憩が足りない勤務の形（警告だけ）
    var totalBreak = base + extra;
    for (var j = 0; j < rules.LEGAL_BREAKS.length; j++) {
      if (L > rules.LEGAL_BREAKS[j][0] && totalBreak < rules.LEGAL_BREAKS[j][1]) {
        warnings.push('LEGAL_BREAK_SHORT');
        break;
      }
    }

    return {
      rawStay: rawStay, deemedExcluded: rawStay - adjustedStay, adjustedStay: adjustedStay, adjArrive: a, adjLeave: b,
      lunch: lunchLen > 0 ? { from: L0, to: L1 } : null, otherBreak: otherBase + extra,
      baseBreak: base, extraBreak: extra, work: L, warnings: warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // 1-3. 暦日・深夜・法定休日に分ける（推計）
  // ---------------------------------------------------------------------------

  function inDeepNight_(minuteOfDay, rules) {
    var s = rules.DEEP_NIGHT[0], e = rules.DEEP_NIGHT[1];
    return s > e ? (minuteOfDay >= s || minuteOfDay < e) : (minuteOfDay >= s && minuteOfDay < e);
  }

  /**
   * 実働を、暦日（0:00 区切り）× 深夜 × 法定休日 に分ける。date は帰属日（出社した日 'YYYY-MM-DD'）。
   * 昼休みはその時刻から引き、時刻の決まっていない休憩（otherBreak）は区分の長さに比例して引く
   * （切り捨て、余りは長い区分から1分ずつ。同じ長さなら時刻の早い区分から）。
   * 返す値: { byDate: { 'YYYY-MM-DD': { work, deepNight, legalHoliday } }, work, deepNight, legalHoliday, estimated: true }
   */
  function splitShift(shift, calc, date, rules) {
    var base = mustDay_(date, '帰属日');
    var result = { byDate: {}, work: 0, deepNight: 0, legalHoliday: 0, estimated: true };
    if (calc.adjArrive === null || calc.adjLeave === null) return result;

    // 働いた区間（昼休みを除く）
    var spans = [];
    if (calc.lunch) {
      if (calc.adjArrive < calc.lunch.from) spans.push([calc.adjArrive, calc.lunch.from]);
      if (calc.lunch.to < calc.adjLeave) spans.push([calc.lunch.to, calc.adjLeave]);
    } else {
      spans.push([calc.adjArrive, calc.adjLeave]);
    }

    // 区切りの時刻（0:00 と深夜の始まり・終わり）で切り、区分ごとに長さを足す
    var cats = {};
    var order = [];
    for (var s = 0; s < spans.length; s++) {
      var t = spans[s][0];
      var end = spans[s][1];
      while (t < end) {
        var dayIdx = Math.floor(t / DAY_MIN);
        var dayStart = dayIdx * DAY_MIN;
        var cuts = [dayStart + DAY_MIN, dayStart + rules.DEEP_NIGHT[0], dayStart + rules.DEEP_NIGHT[1]];
        var next = end;
        for (var c = 0; c < cuts.length; c++) if (cuts[c] > t && cuts[c] < next) next = cuts[c];
        var segDate = dateOf(base + dayIdx);
        var deep = inDeepNight_(t - dayStart, rules);
        var holiday = dowOf(base + dayIdx) === rules.LEGAL_HOLIDAY_DOW;
        var key = segDate + '|' + (deep ? 1 : 0) + '|' + (holiday ? 1 : 0);
        if (!cats[key]) {
          cats[key] = { date: segDate, deep: deep, holiday: holiday, len: 0, first: t };
          order.push(key);
        }
        cats[key].len += next - t;
        t = next;
      }
    }

    // 時刻の決まっていない休憩を比例で引く
    var total = 0;
    for (var i = 0; i < order.length; i++) total += cats[order[i]].len;
    var other = calc.otherBreak;
    var used = 0;
    for (var j = 0; j < order.length; j++) {
      var cat = cats[order[j]];
      cat.cut = total > 0 ? Math.floor(other * cat.len / total) : 0;
      used += cat.cut;
    }
    var rest = other - used;
    var byLen = order.slice().sort(function (x, y) {
      var dx = cats[y].len - cats[x].len;
      return dx !== 0 ? dx : cats[x].first - cats[y].first;
    });
    for (var r = 0; rest > 0 && byLen.length; r = (r + 1) % byLen.length) {
      var target = cats[byLen[r]];
      if (target.cut < target.len) { target.cut++; rest--; }
    }

    for (var k = 0; k < order.length; k++) {
      var g = cats[order[k]];
      var w = g.len - g.cut;
      if (!result.byDate[g.date]) result.byDate[g.date] = { work: 0, deepNight: 0, legalHoliday: 0 };
      var bucket = result.byDate[g.date];
      bucket.work += w;
      result.work += w;
      if (g.deep) { bucket.deepNight += w; result.deepNight += w; }
      if (g.holiday) { bucket.legalHoliday += w; result.legalHoliday += w; }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // 1-5. 会社の運用の数字（振替に積む分・足りない分）
  // ---------------------------------------------------------------------------

  /**
   * items: その日の勤務の [{ calc, night }]。companyScheduled: 会社用の所定（分。休みは 0）。
   * 返す値: { work, furikae, shortage }
   */
  function dayBalance(items, companyScheduled, rules) {
    if (!isWhole_(companyScheduled) || companyScheduled < 0) throw calcError_('BAD_SCHEDULED', '所定の分が正しくありません: ' + companyScheduled);
    if (rules.NIGHT_SHORTFALL !== 'CALENDAR' && rules.NIGHT_SHORTFALL !== 'NONE') {
      throw calcError_('BAD_RULES', 'NIGHT_SHORTFALL が分かりません: ' + rules.NIGHT_SHORTFALL);
    }
    var work = 0;
    var anyNight = false;
    for (var i = 0; i < items.length; i++) {
      work += items[i].calc.work;
      if (items[i].night === true) anyNight = true;
    }
    var furikae = Math.max(0, work - companyScheduled);
    var shortage = Math.max(0, companyScheduled - work);
    if (anyNight && rules.NIGHT_SHORTFALL === 'NONE') shortage = 0;
    return { work: work, furikae: furikae, shortage: shortage };
  }

  // ---------------------------------------------------------------------------
  // 1-6. 法律上の時間外（1年単位の変形労働時間制。推計）
  // ---------------------------------------------------------------------------

  var DAY_STATUSES = { work: true, off: true, leave: true, missing: true };

  /**
   * input: {
   *   period:  { from, to }   対象期間（協定の期間）
   *   applied: { from, to }   本人に変形が当たる期間（period の中）
   *   days: [{ date, status, legalScheduled, work, legalHoliday, deepNight }]  applied の全日（抜け・重なり・外の日はエラー）
   *   neighbors: { before, after }  applied の外の同じ週の日（境目の週の数え方を決めたときに使う。今は使わない）
   *   asOf: 'YYYY-MM-DD'      何日までの日報で計算するか
   * }
   * 返す値は計画 1-6 の7。未確定の数字は「少なくとも」の値（下限）として扱う。
   */
  function legalOvertime(input, rules) {
    if (!input || typeof input !== 'object') throw calcError_('BAD_RANGE', '入力がありません');
    var pFrom = mustDay_(input.period && input.period.from, '対象期間の初め');
    var pTo = mustDay_(input.period && input.period.to, '対象期間の終わり');
    var aFrom = mustDay_(input.applied && input.applied.from, '適用期間の初め');
    var aTo = mustDay_(input.applied && input.applied.to, '適用期間の終わり');
    var asOf = mustDay_(input.asOf, 'asOf');
    if (pFrom > pTo || aFrom > aTo || aFrom < pFrom || aTo > pTo) throw calcError_('BAD_RANGE', '期間の並びが正しくありません');

    // applied の全日を、抜け・重なり・外の日なく受け取る
    var byNum = {};
    var list = input.days || [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var n = mustDay_(d && d.date, '日報');
      if (n < aFrom || n > aTo) throw calcError_('DAYS_INVALID', '適用期間の外の日があります: ' + d.date);
      if (byNum[n]) throw calcError_('DAYS_INVALID', '同じ日が2回あります: ' + d.date);
      if (!Object.prototype.hasOwnProperty.call(DAY_STATUSES, d.status)) throw calcError_('DAYS_INVALID', '状態が分かりません: ' + d.date + ' ' + d.status);
      if (!isWhole_(d.legalScheduled) || d.legalScheduled < 0) throw calcError_('DAYS_INVALID', '所定が正しくありません: ' + d.date);
      if (d.status === 'work') {
        if (!isWhole_(d.work) || !isWhole_(d.legalHoliday) || !isWhole_(d.deepNight) ||
            d.work < 0 || d.legalHoliday < 0 || d.deepNight < 0 || d.legalHoliday > d.work || d.deepNight > d.work) {
          throw calcError_('DAYS_INVALID', '時間が正しくありません: ' + d.date);
        }
      }
      byNum[n] = d;
    }
    for (var m = aFrom; m <= aTo; m++) {
      if (!byNum[m]) throw calcError_('DAYS_INVALID', '日が抜けています: ' + dateOf(m));
    }

    var dailyLimit = rules.DAILY_LIMIT_MIN;
    var weeklyLimit = rules.WEEKLY_LIMIT_MIN;
    var outDays = [];
    var outWeeks = [];
    var reasonsAll = {};
    var sumBase = 0;   // Σ(W − dayOT) − Σ weekOT（年の総枠と比べる分）
    var deepNight = 0;
    var legalHoliday = 0;

    // 週（WEEK_START_DOW 始まり）ごとに見る
    var wkStart = aFrom - ((dowOf(aFrom) - rules.WEEK_START_DOW + 7) % 7);
    for (; wkStart <= aTo; wkStart += 7) {
      var wkEnd = wkStart + 6;
      var from = Math.max(wkStart, aFrom);
      var to = Math.min(wkEnd, aTo);
      var boundary = from !== wkStart || to !== wkEnd;
      var reasons = {};
      if (boundary) reasons.BOUNDARY_WEEK = true;
      if (to > asOf) reasons.NOT_YET = true;

      var sumS = 0;
      var rows = [];
      for (var x = from; x <= to; x++) {
        var day = byNum[x];
        sumS += day.legalScheduled;
        var counted = day.status === 'work' && x <= asOf;
        if (day.status === 'missing' && x <= asOf) reasons.MISSING = true;
        var W = counted ? day.work - day.legalHoliday : 0;
        var dayOT = Math.max(0, W - Math.max(day.legalScheduled, dailyLimit));
        if (counted) { deepNight += day.deepNight; legalHoliday += day.legalHoliday; }
        rows.push({ num: x, W: W, dayOT: dayOT });
      }
      var T = Math.max(sumS, weeklyLimit);
      var C = 0;
      var weekOT = 0;
      var provisional = Object.keys(reasons).length > 0;
      for (var y = 0; y < rows.length; y++) {
        var prev = C;
        C += rows[y].W - rows[y].dayOT;
        var inc = Math.max(0, C - T) - Math.max(0, prev - T);
        weekOT += inc;
        sumBase += rows[y].W - rows[y].dayOT - inc;
        outDays.push({ date: dateOf(rows[y].num), dayOT: rows[y].dayOT, weekOT: inc, yearOT: 0, settlementOT: 0, provisional: provisional });
      }
      var reasonList = Object.keys(reasons).sort();
      reasonList.forEach(function (k) { reasonsAll[k] = true; });
      outWeeks.push({ from: dateOf(from), to: dateOf(to), weekOT: weekOT, boundaryWeek: boundary, provisionalReasons: reasonList });
    }
    if (aTo > asOf) reasonsAll.NOT_YET = true;

    var nDays = aTo - aFrom + 1;
    var frame = Math.floor(weeklyLimit * nDays / 7);
    var overFrame = Math.max(0, sumBase - frame);
    var reasonsOut = Object.keys(reasonsAll).sort();
    var final = reasonsOut.length === 0;
    var isFull = aFrom === pFrom && aTo === pTo;
    var yearOT = null;
    var settlementOT = null;
    if (final) {
      yearOT = isFull ? overFrame : 0;
      settlementOT = isFull ? 0 : overFrame;
      var last = outDays[outDays.length - 1];
      last.yearOT = yearOT;
      last.settlementOT = settlementOT;
    }
    return {
      final: final,
      provisionalReasons: reasonsOut,
      days: outDays,
      weeks: outWeeks,
      yearOT: yearOT,
      settlementOT: settlementOT,
      yearOTSoFar: final ? null : overFrame,
      frame: frame,
      remainingToFrame: Math.max(0, frame - sumBase),
      deepNight: deepNight,
      legalHoliday: legalHoliday,
    };
  }

  // ---------------------------------------------------------------------------
  // 1-7. 締めの期間
  // ---------------------------------------------------------------------------

  function monthEnd_(y, mo) {
    return Math.round(Date.UTC(y, mo, 0) / 86400000); // mo は 1〜12。翌月の0日 = その月の末日
  }

  function ymd_(num) {
    var t = new Date(num * 86400000);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }

  /**
   * その日が入る締めの期間。返す値: { id: 'from_to', from, to, label }
   * rules.PAY_CLOSING: [{ from, closeDay: 数 | 'END' }]（日付の早い順）
   */
  function payPeriodOf(date, rules) {
    var n = mustDay_(date, '締めを調べる日');
    var list = rules.PAY_CLOSING;
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (mustDay_(list[i].from, '締めの切り替え') <= n) idx = i;
    if (idx < 0) throw calcError_('BAD_DATE', '締めの決まりより前の日です: ' + date);
    var rule = list[idx];
    var ruleFrom = mustDay_(rule.from, '締めの切り替え');
    var nextFrom = idx + 1 < list.length ? mustDay_(list[idx + 1].from, '締めの切り替え') : null;
    var p = ymd_(n);
    var start, end;
    if (rule.closeDay === 'END') {
      start = Math.round(Date.UTC(p.y, p.m - 1, 1) / 86400000);
      end = monthEnd_(p.y, p.m);
    } else {
      var N = rule.closeDay;
      if (!isWhole_(N) || N < 1 || N > 28) throw calcError_('BAD_RULES', '締めの日が正しくありません: ' + N);
      if (p.d <= N) {
        end = Math.round(Date.UTC(p.y, p.m - 1, N) / 86400000);
        start = Math.round(Date.UTC(p.y, p.m - 2, N + 1) / 86400000);
      } else {
        end = Math.round(Date.UTC(p.y, p.m, N) / 86400000);
        start = Math.round(Date.UTC(p.y, p.m - 1, N + 1) / 86400000);
      }
    }
    if (start < ruleFrom) start = ruleFrom;
    if (nextFrom !== null && end >= nextFrom) end = nextFrom - 1;
    var s = ymd_(start), e = ymd_(end);
    return {
      id: dateOf(start) + '_' + dateOf(end),
      from: dateOf(start),
      to: dateOf(end),
      label: e.y + '年' + e.m + '月分（' + s.m + '/' + s.d + '〜' + e.m + '/' + e.d + '）',
    };
  }

  // ---------------------------------------------------------------------------
  // 計算の決まりの照合値
  // ---------------------------------------------------------------------------

  function canonical_(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical_).join(',') + ']';
    var keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonical_(v[k]); }).join(',') + '}';
  }

  /** 計算の決まりを、キーを並べ替えた JSON の文字にする（保存して、同じ照合値で中身が違わないか比べる） */
  function rulesCanonical(rules) {
    return canonical_(rules);
  }

  /** 計算の決まりの照合値（FNV-1a 32bit、16進8桁）。短い目印。偶然の一致は rulesCanonical の比較で見つける */
  function rulesKey(rules) {
    var text = canonical_(rules);
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    var hex = h.toString(16);
    return '00000000'.slice(hex.length) + hex;
  }

  return {
    VERSION: VERSION,
    parseHm: parseHm,
    formatHm: formatHm,
    dayNumber: dayNumber,
    dateOf: dateOf,
    validateShift: validateShift,
    calcShift: calcShift,
    splitShift: splitShift,
    dayBalance: dayBalance,
    legalOvertime: legalOvertime,
    payPeriodOf: payPeriodOf,
    rulesCanonical: rulesCanonical,
    rulesKey: rulesKey,
  };
})();
