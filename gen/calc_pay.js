// 自動生成（tools/build.js）。直接編集しない。正本: shared/calc_pay.js
/**
 * 画面とサーバーで共有する、給与の目安の計算（正本）。GAS のサービスは使わない純粋な JS。
 * tools/build.js が GAS 用（server/gen_calc_pay.js）とブラウザ用（web/gen/calc_pay.js）を生成する。生成物は直接編集しない。
 *
 * 計画 docs/plans/stage3-pay-estimate-plan.md（第12〜14章が前の章より優先）。管理者だけが見る「目安」で、正式な給与計算ではない。
 * 数字（段の境目・単価に入れる項目・丸め方）は引数 rules（サーバーの RULES.PAY_ESTIMATE）、割増率は引数 rates（「設定」シートの値）から読む。
 * 関数は引数を書き換えない。金額は分子・分母を整数（BigInt）で持ち、欄ごとに最後に 1 回だけ丸める。
 *
 *   estimate(input, rules, rates) → 1 人・1 締めの期間の目安（合計の目安・参考: 法律で数えた残業代の目安）
 *   tierWeight(a, b, rules, rates) → 時間外を並べたときの a 分目より後〜b 分目までの「率 × 分」の合計（千分率 × 分）
 *   dailyPaid(days, settles, D)   → 日給制の人の、日給で払った時間外・法定休日の分（13-3・14-2）
 *   roundYen(n, d, mode)          → 分数 n/d（BigInt）を円の整数に
 *
 * input: {
 *   type: 'monthly' | 'daily' | null（雇用区分が分からない）
 *   pay: { 13 項目の key: 0 以上の整数 | null（未入力）| 文字（読めない値） }
 *   dailyMin: 1日の所定労働時間 D（分。整数 | null | 文字）
 *   yearWorkDays: その期間の最後の日のカレンダーの 1 年の出勤日数（確定。無い・下書きは null）
 *   days: [{ ordinary, holiday, overtime }]   締めの期間の中（今日まで）の働いた日。overtime = 1 日と週の時間外
 *   settles: [{ minutes, unpaidOrdinary }]    年の総枠・途中の清算の時間外（区間の最後の日が期間の中のもの）と、その区間の U（14-2）
 *   deepNight, nightCount, workDays           期間の深夜（分）・夜勤の回数・出勤日数
 * }
 */
var CalcPay = (function () {
  'use strict';

  /** このファイルの計算の版 */
  var VERSION = 1;

  /** 項目の名前（社員履歴の 13 項目の key。server/config.js の PAY_ITEMS と同じ） */
  var KEY = { BASE: 'basePay', FIXED_OT_PAY: 'fixedOvertimePay', FIXED_OT_MIN: 'fixedOvertimeMinutes', NIGHT_PAY: 'nightShiftPay' };
  var PAY_KEYS = ['basePay', 'evalPay', 'incentive', 'lifePlanPrepay', 'officerAllowance', 'positionAllowance', 'licenseAllowance',
    'housingMealAllowance', 'fixedOvertimePay', 'familyAllowance', 'commute', 'fixedOvertimeMinutes', 'nightShiftPay'];
  var RATE_KEYS = ['OVERTIME', 'OVER_45', 'OVER_60', 'LEGAL_HOLIDAY', 'DEEP_NIGHT'];

  function calcError_(code, message) {
    var e = new Error(message);
    e.calcCode = code;
    return e;
  }

  function isWhole_(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= 0;
  }

  function mustWhole_(n, what) {
    if (!isWhole_(n)) throw calcError_('BAD_INPUT', what + ' は 0 以上の整数にしてください: ' + n);
    return n;
  }

  /** 項目の値の状態: 'ok'（0 以上の整数）/ 'missing'（null）/ 'bad'（読めない値） */
  function stateOf_(v) {
    if (v === null || v === undefined) return 'missing';
    return isWhole_(v) ? 'ok' : 'bad';
  }

  // ---------------------------------------------------------------------------
  // 分数（BigInt）
  // ---------------------------------------------------------------------------

  function B(n) { return BigInt(n); }
  function frac_(n, d) { return { n: n, d: d }; }
  function add_(x, y) { return frac_(x.n * y.d + y.n * x.d, x.d * y.d); }
  function sub_(x, y) { return frac_(x.n * y.d - y.n * x.d, x.d * y.d); }
  function mulInt_(x, k) { return frac_(x.n * B(k), x.d); }
  function divInt_(x, k) { return frac_(x.n, x.d * B(k)); }
  function max0_(x) { return x.n < B(0) ? frac_(B(0), B(1)) : x; }

  /** 分数 n/d（d > 0）を丸める。mode: 'HALF_UP'（四捨五入。0 から遠い方）/ 'FLOOR'（切り捨て）/ 'CEIL'（切り上げ） */
  function roundYen(n, d, mode) {
    if (typeof n !== 'bigint' || typeof d !== 'bigint' || d <= B(0)) throw calcError_('BAD_INPUT', '丸める分数が正しくありません');
    var neg = n < B(0);
    var a = neg ? -n : n;
    var q;
    if (mode === 'HALF_UP') q = (a * B(2) + d) / (d * B(2));
    else if (mode === 'FLOOR') q = neg ? (a + d - B(1)) / d : a / d;
    else if (mode === 'CEIL') q = neg ? a / d : (a + d - B(1)) / d;
    else throw calcError_('BAD_RULES', '丸め方が分かりません: ' + mode);
    return Number(neg ? -q : q);
  }

  // ---------------------------------------------------------------------------
  // 段の率（13-2）
  // ---------------------------------------------------------------------------

  function checkRates_(rates) {
    if (!rates || typeof rates !== 'object') throw calcError_('BAD_RATES', '割増率がありません');
    RATE_KEYS.forEach(function (k) {
      if (!isWhole_(rates[k]) || rates[k] < 1) throw calcError_('BAD_RATES', '割増率が正しくありません: ' + k);
    });
  }

  /** 時間外の 3 つの率が OVERTIME ≤ OVER_45 ≤ OVER_60 の順か（13-5） */
  function ratesInOrder(rates) {
    checkRates_(rates);
    return rates.OVERTIME <= rates.OVER_45 && rates.OVER_45 <= rates.OVER_60;
  }

  /** 時間外を並べたときの a 分目より後〜b 分目までの分に、その位置の率を掛けた合計（千分率 × 分。BigInt） */
  function tierWeight(a, b, rules, rates) {
    mustWhole_(a, 'a');
    mustWhole_(b, 'b');
    checkRates_(rates);
    var o45 = rules.OVER_45_MIN, o60 = rules.OVER_60_MIN;
    if (!isWhole_(o45) || !isWhole_(o60) || o45 > o60) throw calcError_('BAD_RULES', '段の境目が正しくありません');
    var bands = [[0, o45, rates.OVERTIME], [o45, o60, rates.OVER_45], [o60, Infinity, rates.OVER_60]];
    var sum = B(0);
    bands.forEach(function (bd) {
      var m = Math.max(0, Math.min(b, bd[1]) - Math.max(a, bd[0]));
      sum += B(m) * B(bd[2]);
    });
    return sum;
  }

  // ---------------------------------------------------------------------------
  // 日給制の人の、日給で払った分（13-3・14-2）
  // ---------------------------------------------------------------------------

  /**
   * days: [{ ordinary, holiday, overtime }]、settles: [{ minutes, unpaidOrdinary }]、D: 1日の所定（分）。
   * 返す値: { co, ch }（日給で払った時間外・法定休日の分の合計）
   * 日ごとに、ふつう → 法定休日 → 時間外 の順に D 分まで。年の総枠・清算の分は、日給で払っていないふつうの時間（U）から先に当てる
   */
  function dailyPaid(days, settles, D) {
    mustWhole_(D, 'D');
    var co = 0, ch = 0;
    (days || []).forEach(function (x) {
      var a = mustWhole_(x.ordinary, 'ordinary'), h = mustWhole_(x.holiday, 'holiday'), o = mustWhole_(x.overtime, 'overtime');
      ch += Math.min(h, Math.max(0, D - a));
      co += Math.min(o, Math.max(0, D - a - h));
    });
    (settles || []).forEach(function (s) {
      var Y = mustWhole_(s.minutes, 'settle.minutes'), U = mustWhole_(s.unpaidOrdinary, 'settle.unpaidOrdinary');
      co += Math.max(0, Y - U);
    });
    return { co: co, ch: ch };
  }

  // ---------------------------------------------------------------------------
  // 欄（金額 | 計算できない理由）
  // ---------------------------------------------------------------------------

  /** 計算できない欄 { yen: null, missing, unreadable, codes }。0 円とは出さない（13-4） */
  function fail_(missing, unreadable, codes) {
    return { yen: null, missing: (missing || []).slice(), unreadable: (unreadable || []).slice(), codes: (codes || []).slice() };
  }

  function okCell_(yen) { return { yen: yen }; }

  function isOk_(c) { return c.yen !== null; }

  /** 計算できない欄の理由をまとめる（重ならないように） */
  function merge_(cells) {
    var m = [], u = [], c = [];
    var push = function (arr, v) { if (arr.indexOf(v) < 0) arr.push(v); };
    cells.forEach(function (x) {
      if (isOk_(x)) return;
      x.missing.forEach(function (v) { push(m, v); });
      x.unreadable.forEach(function (v) { push(u, v); });
      x.codes.forEach(function (v) { push(c, v); });
    });
    return fail_(m, u, c);
  }

  /** 欄の足し算（どれか 1 つでも計算できなければ、計算できない） */
  function sumCells_(cells) {
    if (cells.every(isOk_)) return okCell_(cells.reduce(function (s, x) { return s + x.yen; }, 0));
    return merge_(cells);
  }

  function roundCell_(f, rules) { return okCell_(roundYen(f.n, f.d, rules.ROUNDING)); }

  // ---------------------------------------------------------------------------
  // 1 分あたりの単価（2-1・13-6）
  // ---------------------------------------------------------------------------

  /**
   * 返す値: { cell: 計算できないときの理由（できるときは null）, u: 1 分あたり（分数）, ud: そのうち日給の分（日給制だけ） }
   */
  function unitOf_(input, rules) {
    var missing = [], unreadable = [], codes = [];
    var pay = input.pay;
    if (input.type !== 'monthly' && input.type !== 'daily') codes.push('NO_TYPE');
    rules.HOURLY_BASE_ITEMS.forEach(function (k) {
      var st = stateOf_(pay[k]);
      if (st === 'missing') missing.push(k);
      else if (st === 'bad') unreadable.push(k);
    });
    var yw = input.yearWorkDays;
    if (yw === null || yw === undefined || yw === 0) codes.push('NO_CALENDAR');
    else mustWhole_(yw, 'yearWorkDays');
    var D = input.dailyMin;
    if (input.type === 'daily') {
      var sd = stateOf_(D);
      if (sd === 'missing' || D === 0) missing.push('dailyMin');
      else if (sd === 'bad') unreadable.push('dailyMin');
    }
    if (missing.length || unreadable.length || codes.length) return { cell: fail_(missing, unreadable, codes), u: null, ud: null };
    // 1 か月平均所定 = yw × MONTH_AVG_DAY_MIN ÷ MONTHS_PER_YEAR（分）→ 月額の項目 S の 1 分あたり = S × MONTHS_PER_YEAR ÷ (yw × MONTH_AVG_DAY_MIN)
    var monthDen = B(yw) * B(rules.MONTH_AVG_DAY_MIN);
    var S = 0;
    rules.HOURLY_BASE_ITEMS.forEach(function (k) {
      if (input.type === 'daily' && k === KEY.BASE) return;
      S += pay[k];
    });
    var monthly = frac_(B(S) * B(rules.MONTHS_PER_YEAR), monthDen);
    if (input.type === 'monthly') return { cell: null, u: monthly, ud: null };
    var ud = frac_(B(rules.HOURLY_BASE_ITEMS.indexOf(KEY.BASE) >= 0 ? pay[KEY.BASE] : 0), B(D));
    return { cell: null, u: add_(ud, monthly), ud: ud };
  }

  /** u × w ÷ 1000（w は 千分率 × 分） */
  function money_(u, w) { return frac_(u.n * w, u.d * B(1000)); }

  // ---------------------------------------------------------------------------
  // 1 人・1 期間の目安
  // ---------------------------------------------------------------------------

  function checkInput_(input) {
    if (!input || typeof input !== 'object') throw calcError_('BAD_INPUT', '入力がありません');
    if (!input.pay || typeof input.pay !== 'object') throw calcError_('BAD_INPUT', '給与の項目がありません');
    PAY_KEYS.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(input.pay, k)) throw calcError_('BAD_INPUT', '給与の項目が足りません: ' + k);
    });
    ['deepNight', 'nightCount', 'workDays'].forEach(function (k) { mustWhole_(input[k], k); });
    if (!Array.isArray(input.days) || !Array.isArray(input.settles)) throw calcError_('BAD_INPUT', 'days・settles は配列にしてください');
  }

  function estimate(input, rules, rates) {
    checkInput_(input);
    checkRates_(rates);
    var pay = input.pay;
    var orderOk = ratesInOrder(rates);
    var T = 0, H = 0;
    input.days.forEach(function (x) {
      mustWhole_(x.ordinary, 'ordinary');
      T += mustWhole_(x.overtime, 'overtime');
      H += mustWhole_(x.holiday, 'holiday');
    });
    input.settles.forEach(function (s) { T += mustWhole_(s.minutes, 'settle.minutes'); mustWhole_(s.unpaidOrdinary, 'settle.unpaidOrdinary'); });
    var N = input.deepNight;
    var unit = unitOf_(input, rules);
    var X = pay[KEY.FIXED_OT_MIN], F = pay[KEY.FIXED_OT_PAY];
    var sX = stateOf_(X), sF = stateOf_(F);
    var itemCell = function (k, st) { return st === 'missing' ? fail_([k]) : fail_([], [k]); };
    var needUnit = function () { return unit.cell ? unit.cell : null; };

    var ref = {};
    // 深夜（上乗せだけ。日給制も引かない）
    ref.deepNight = N === 0 ? okCell_(0) : (needUnit() || roundCell_(money_(unit.u, B(N) * B(rates.DEEP_NIGHT)), rules));
    var paid = null;
    if (input.type === 'daily') {
      // 日給制: 含み残業は当てない。日給で払った分（通常の賃金）を引く（13-3）
      if (!unit.cell) paid = dailyPaid(input.days, input.settles, input.dailyMin);
      ref.overtime = T === 0 ? okCell_(0) : (needUnit() ||
        roundCell_(max0_(sub_(money_(unit.u, tierWeight(0, T, rules, rates)), mulInt_(unit.ud, paid.co))), rules));
      ref.holiday = H === 0 ? okCell_(0) : (needUnit() ||
        roundCell_(max0_(sub_(money_(unit.u, B(H) * B(rates.LEGAL_HOLIDAY)), mulInt_(unit.ud, paid.ch))), rules));
      ref.sum = sumCells_([ref.overtime, ref.holiday, ref.deepNight]);
    } else {
      ref.holiday = H === 0 ? okCell_(0) : (needUnit() || roundCell_(money_(unit.u, B(H) * B(rates.LEGAL_HOLIDAY)), rules));
      // ① 時間で引いた額 tier(X, T]（13-2）
      if (sX !== 'ok') ref.byTime = unit.cell ? merge_([unit.cell, itemCell(KEY.FIXED_OT_MIN, sX)]) : itemCell(KEY.FIXED_OT_MIN, sX);
      else if (T <= X) ref.byTime = okCell_(0);
      else ref.byTime = needUnit() || roundCell_(money_(unit.u, tierWeight(X, T, rules, rates)), rules);
      // ② 金額で比べた額 max(0, tier(0, T] − F)
      if (sF !== 'ok') ref.byAmount = unit.cell ? merge_([unit.cell, itemCell(KEY.FIXED_OT_PAY, sF)]) : itemCell(KEY.FIXED_OT_PAY, sF);
      else if (T === 0) ref.byAmount = okCell_(0);
      else ref.byAmount = needUnit() || roundCell_(max0_(sub_(money_(unit.u, tierWeight(0, T, rules, rates)), frac_(B(F), B(1)))), rules);
      // 含み残業時間分の額 tier(0, X] と、見込み残業手当の不足 max(0, tier(0, X] − F)
      if (sX !== 'ok') ref.fixedOtValue = unit.cell ? merge_([unit.cell, itemCell(KEY.FIXED_OT_MIN, sX)]) : itemCell(KEY.FIXED_OT_MIN, sX);
      else if (X === 0) ref.fixedOtValue = okCell_(0);
      else ref.fixedOtValue = needUnit() || roundCell_(money_(unit.u, tierWeight(0, X, rules, rates)), rules);
      if (sX !== 'ok' || sF !== 'ok') {
        var parts = [];
        if (unit.cell) parts.push(unit.cell);
        if (sX !== 'ok') parts.push(itemCell(KEY.FIXED_OT_MIN, sX));
        if (sF !== 'ok') parts.push(itemCell(KEY.FIXED_OT_PAY, sF));
        ref.shortfall = merge_(parts);
      } else if (X === 0) ref.shortfall = okCell_(0);
      else ref.shortfall = needUnit() || roundCell_(max0_(sub_(money_(unit.u, tierWeight(0, X, rules, rates)), frac_(B(F), B(1)))), rules);
      ref.sumByTime = sumCells_([ref.byTime, ref.holiday, ref.deepNight]);
      ref.sumByAmount = sumCells_([ref.byAmount, ref.holiday, ref.deepNight]);
    }
    // 割増率の設定の順が正しくないときは、参考額を全部出さない（合計の目安は出す。13-5）
    if (!orderOk) Object.keys(ref).forEach(function (k) { ref[k] = fail_([], [], ['RATE_ORDER']); });

    // ---- 合計の目安（固定の 11 項目 ＋ 夜勤手当。参考額は足さない。13-0）----
    var night;
    var sN = stateOf_(pay[KEY.NIGHT_PAY]);
    if (input.nightCount === 0) night = okCell_(0);
    else if (sN === 'ok') night = okCell_(pay[KEY.NIGHT_PAY] * input.nightCount);
    else night = itemCell(KEY.NIGHT_PAY, sN);
    var fixed = {};
    rules.TOTAL_ITEMS.forEach(function (k) {
      var v = pay[k];
      var st = stateOf_(v);
      if (st !== 'ok') { fixed[k] = itemCell(k, st); return; }
      // 日給制の人の基本給は「日給 × 出勤日数」（2-4）
      fixed[k] = okCell_(input.type === 'daily' && k === KEY.BASE ? v * input.workDays : v);
    });
    var unreadableAll = PAY_KEYS.filter(function (k) { return stateOf_(pay[k]) === 'bad'; });
    var total;
    if (unreadableAll.length) {
      // 読めない値が 1 つでもある人は、合計の目安も「入っている項目だけの合計」も出さない（2-8・13-4）
      total = { status: 'unreadable', yen: null, partial: null, missing: [], unreadable: unreadableAll };
    } else {
      var cells = rules.TOTAL_ITEMS.map(function (k) { return fixed[k]; }).concat([night]);
      var missingItems = [];
      var partial = 0;
      rules.TOTAL_ITEMS.forEach(function (k) { if (isOk_(fixed[k])) partial += fixed[k].yen; else missingItems.push(k); });
      if (isOk_(night)) partial += night.yen; else missingItems.push(KEY.NIGHT_PAY);
      if (input.type !== 'monthly' && input.type !== 'daily') missingItems.push('employmentType');
      total = cells.every(isOk_) && missingItems.length === 0
        ? { status: 'ok', yen: partial, partial: null, missing: [], unreadable: [] }
        : { status: 'incomplete', yen: null, partial: partial, missing: missingItems, unreadable: [] };
    }
    var hourly = unit.cell ? null : roundYen(unit.u.n * B(60), unit.u.d, rules.ROUNDING);
    return {
      type: input.type,
      minutes: { overtime: T, fixedOvertime: sX === 'ok' ? X : null, legalHoliday: H, deepNight: N },
      nightCount: input.nightCount, workDays: input.workDays,
      unit: unit.cell ? unit.cell : { yen: hourly },
      fixed: fixed, nightAllowance: night, total: total,
      ref: ref, ratesInOrder: orderOk,
      shortfallNote: input.type === 'monthly' && orderOk && isOk_(ref.shortfall) && ref.shortfall.yen > 0,
    };
  }

  return {
    VERSION: VERSION,
    KEY: KEY,
    PAY_KEYS: PAY_KEYS,
    roundYen: roundYen,
    ratesInOrder: ratesInOrder,
    tierWeight: tierWeight,
    dailyPaid: dailyPaid,
    estimate: estimate,
  };
})();
