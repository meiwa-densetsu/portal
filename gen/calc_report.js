// 自動生成（tools/build.js）。直接編集しない。正本: shared/calc_report.js
/**
 * 画面とサーバーで共有する日報の計算（正本）。GAS のサービスは使わない純粋な JS。
 * tools/build.js が GAS 用（server/gen_calc_report.js）とブラウザ用（web/gen/calc_report.js）を生成する。生成物は直接編集しない。
 *
 * 手順6（計画 docs/plans/stage1-step6-plan.md 2-1・2-2）: 1日分の入力の確かめ、日勤・夜勤の判断と振り分け、
 * 勤務ごとの計算、前後の日との時間の重なり、月次集計に写す値。
 * 手順4の CalcWorktime は、GAS でファイルの読み込みの順番が決まらないため、読み込むときではなく、
 * 関数を呼ぶときに引数 CW で受け取る。数字はすべて引数 rules（サーバーの RULES.WORK）から読む。
 *
 * つながり:
 *   normalizeDay(画面の入力, rules) → { entries, note }（そろえた入力。施工内容は勤務ごと）
 *   effective(日報の行) → 施工内容を読み替えた行の写し（古い列「施工内容」との関係。手順10b 2-2）
 *   toSlots(そろえた入力, CW, rules) → 日報の行の入力の列（昼の欄・夜の欄に振り分け）
 *   calcDay(行, { date, breakType }, CW, rules) → 計算の結果（計算の列）
 *   checkOverlap(前の日の行, その日の行, 次の日の行, CW, rules) → 時間の重なり
 *   balance(実働, 会社用の所定, 夜勤があるか, CW, rules) → 所定を超えた時間・足りない時間
 */
var CalcReport = (function () {
  'use strict';

  /** このファイルの計算の版。中身を変えたら上げる（日報の「計算の版」に CalcWorktime の版と並べて残す） */
  var VERSION = 1;

  var TIMES = ['arrive', 'start', 'end', 'leave'];
  var TIME_LABEL = { arrive: '出社', start: '開始', end: '終了', leave: '退社' };
  var SLOT_PREFIX = { day: '昼_', night: '夜_' };
  var DIRECT_VALUES = ['', '直行', '直帰', '両方'];

  /**
   * 日報の行の入力の列（計画 2-5。照合・修正履歴の JSON・空にする列はこの一覧で決める）。
   * 施工内容は勤務ごと（手順10b。計画 docs/plans/stage1-step10b-plan.md 2-1）。シートの見出しの並びはこの一覧では決めない（server の rep_headers_）
   */
  var INPUT_COLS = ['昼_出社', '昼_開始', '昼_終了', '昼_退社', '昼_直行直帰', '昼_作業場所', '昼_施工内容',
    '夜_出社', '夜_開始', '夜_終了', '夜_退社', '夜_直行直帰', '夜_作業場所', '夜_施工内容', '備考'];
  /** 日報の行の計算の列 */
  var CALC_COLS = ['休憩方式', '昼_休憩', '昼_実働', '夜_休憩', '夜_実働', '実働', '深夜', '法定休日',
    '暦日の内訳', '警告', '計算の版', '計算の決まり'];
  var SLOT_COLS = { arrive: '出社', start: '開始', end: '終了', leave: '退社', direct: '直行直帰', place: '作業場所', content: '施工内容' };
  /** 1日に1つだった頃の施工内容の列（古い版の画面・戻したときのため、昼と夜をつないだ値を書き続ける。計画 2-2） */
  var LEGACY_CONTENT = '施工内容';
  var CONTENT_SEP = '／';

  function str_(v) { return v === null || v === undefined ? '' : String(v); }

  /** 古い列に書く値: 昼と夜の施工内容を「／」でつなぐ（片方だけならそれだけ） */
  function joinContent(day, night) {
    return [str_(day), str_(night)].filter(function (s) { return s !== ''; }).join(CONTENT_SEP);
  }

  /**
   * 施工内容を読み替えた行の写し（計画 2-2。日報の行を使う所はすべてこれを通す。行そのものは書き換えない）。
   * 古い列 === join(昼, 夜) なら新しい2列が正しい。違えば古い列が正しく、日勤があれば昼・夜勤だけなら夜・時刻が無ければ昼に読み替える
   */
  function effective(row) {
    if (!row) return row;
    var dayC = str_(row['昼_施工内容']), nightC = str_(row['夜_施工内容']);
    var legacy = str_(row[LEGACY_CONTENT]);
    var out = {};
    for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
    // 古い列を持たない行（読み替え済み・画面の入力・toSlots の行）は、新しい2列をそのまま使う（何度通しても同じ。Codex 計画2回目 high）
    // 古い列を持つ行（シートの行）だけ新旧を比べる。古い列が「あって空」なら、古い版で消したものとして両方空
    if (!Object.prototype.hasOwnProperty.call(row, LEGACY_CONTENT) || legacy === joinContent(dayC, nightC)) {
      out['昼_施工内容'] = dayC;
      out['夜_施工内容'] = nightC;
      return out;
    }
    var toNight = !timesPresent_(row, 'day') && timesPresent_(row, 'night');
    out['昼_施工内容'] = toNight ? '' : legacy;
    out['夜_施工内容'] = toNight ? legacy : '';
    return out;
  }

  /** その勤務の4つの時刻のどれかが入っているか（行を直接見る。effective の中でも使う） */
  function timesPresent_(row, slot) {
    var p = SLOT_PREFIX[slot];
    return str_(row[p + '出社']) !== '' || str_(row[p + '開始']) !== '' || str_(row[p + '終了']) !== '' || str_(row[p + '退社']) !== '';
  }

  function calcError_(code, message) {
    var e = new Error(message);
    e.calcCode = code;
    return e;
  }

  function isWhole_(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
  }

  /** 計算の決まりの値の形を確かめる（計画 第3章の表）。形が違えば BAD_RULES（黙って初期値に戻さない） */
  function checkRules(rules) {
    var na = rules && rules.NIGHT_AUTO;
    var step = rules && rules.TIME_STEP_MIN;
    if (!na || !isWhole_(na.ARRIVE_MAX) || na.ARRIVE_MAX < 0 || na.ARRIVE_MAX > 1440 - step || !isWhole_(step) || na.ARRIVE_MAX % step !== 0) {
      throw calcError_('BAD_RULES', 'NIGHT_AUTO.ARRIVE_MAX が正しくありません');
    }
    var r = rules.REPORT;
    var keys = ['PLACE_MAX', 'CONTENT_MAX', 'NOTE_MAX', 'PATTERN_MAX', 'PATTERN_NAME_MAX', 'ENTRY_MAX', 'BATCH_MAX'];
    if (!r) throw calcError_('BAD_RULES', 'REPORT がありません');
    for (var i = 0; i < keys.length; i++) {
      if (!isWhole_(r[keys[i]]) || r[keys[i]] < 1) throw calcError_('BAD_RULES', 'REPORT.' + keys[i] + ' が正しくありません');
    }
    if (r.ENTRY_MAX !== 2) throw calcError_('BAD_RULES', 'REPORT.ENTRY_MAX は 2（日勤1つと夜勤1つ）だけ使えます');
    var w = rules.AGREEMENT_36_WARN_RATIO;
    if (typeof w !== 'number' || !isFinite(w) || w <= 0 || w > 1) throw calcError_('BAD_RULES', 'AGREEMENT_36_WARN_RATIO が正しくありません');
  }

  /** 見た目の1文字で数えた長さ（絵文字なども1字） */
  function textLength(text) {
    return Array.from(String(text)).length;
  }

  /** 全角の数字・コロンを半角にし、前後の空白を消す（時刻の欄） */
  function normTime_(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[：]/g, ':').trim();
  }

  /** 前後の空白（全角を含む）を消す（文字の欄） */
  function normText_(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/^[\s　]+|[\s　]+$/g, '');
  }

  function isEmptyEntry_(e) {
    return e.arrive === '' && e.start === '' && e.end === '' && e.leave === '' && e.direct === '' && e.place === '' && str_(e.content) === '';
  }

  /** 内容だけの勤務（4つの時刻・直行直帰・作業場所が空で、施工内容だけがある。計画 2-1） */
  function isContentOnly_(e) {
    return e.arrive === '' && e.start === '' && e.end === '' && e.leave === '' && e.direct === '' && e.place === '' && str_(e.content) !== '';
  }

  /**
   * 画面の入力 { entries: [{ arrive, start, end, leave, direct, place, content }], note } をそろえる。
   * 全部が空の勤務は捨てる（「勤務なし」）。返す値: { entries, note }（入力は書き換えない）
   */
  function normalizeDay(input, rules) {
    var src = input || {};
    var list = Array.isArray(src.entries) ? src.entries : [];
    var entries = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      var n = {
        arrive: normTime_(e.arrive), start: normTime_(e.start), end: normTime_(e.end), leave: normTime_(e.leave),
        direct: normText_(e.direct), place: normText_(e.place), content: normText_(e.content),
      };
      if (!isEmptyEntry_(n)) entries.push(n);
    }
    return { entries: entries, note: normText_(src.note) };
  }

  /**
   * 日勤か夜勤か（計画 2-2）。返す値: { kind: 'day' | 'night' | null, errors: [{ field, code }] }
   * ① 4つの時刻がそろっているか・形・30分単位 ② 前の時刻より小さくなる所が2つ以上 → ORDER
   * ③ 1つ（0時をまたぐ）か、出社が NIGHT_AUTO.ARRIVE_MAX 以下 → 夜勤の候補、それ以外は日勤の候補
   * ④ 候補の印で validateShift をし直し、誤りがあれば kind は null。正しい勤務にだけ kind を付ける
   */
  function classifyShift(entry, CW, rules) {
    var e = entry || {};
    var errors = [];
    var raw = [];
    for (var i = 0; i < TIMES.length; i++) {
      var f = TIMES[i];
      var text = normTime_(e[f]);
      if (text === '') { errors.push({ field: f, code: 'EMPTY' }); continue; }
      var v = CW.parseHm(text, 1439);
      if (v === null) { errors.push({ field: f, code: 'FORMAT' }); continue; }
      if (v % rules.TIME_STEP_MIN !== 0) { errors.push({ field: f, code: 'STEP' }); continue; }
      raw.push(v);
    }
    if (errors.length) return { kind: null, errors: errors };
    var back = 0;
    for (var k = 1; k < raw.length; k++) {
      if (raw[k] < raw[k - 1]) {
        back++;
        if (back >= 2) return { kind: null, errors: [{ field: TIMES[k], code: 'ORDER' }] };
      }
    }
    var night = back === 1 || raw[0] <= rules.NIGHT_AUTO.ARRIVE_MAX;
    var v2 = CW.validateShift({ arrive: normTime_(e.arrive), start: normTime_(e.start), end: normTime_(e.end), leave: normTime_(e.leave), night: night }, rules);
    if (!v2.ok) return { kind: null, errors: v2.errors };
    return { kind: night ? 'night' : 'day', errors: [] };
  }

  function textErrors_(n, rules) {
    var R = rules.REPORT;
    var errors = [];
    if (/[\r\n]/.test(n.note)) errors.push({ entry: null, field: 'note', code: 'NEWLINE' });
    else if (textLength(n.note) > R.NOTE_MAX) errors.push({ entry: null, field: 'note', code: 'TOO_LONG_TEXT' });
    for (var i = 0; i < n.entries.length; i++) {
      var e = n.entries[i];
      if (/[\r\n]/.test(e.place)) errors.push({ entry: i, field: 'place', code: 'NEWLINE' });
      else if (textLength(e.place) > R.PLACE_MAX) errors.push({ entry: i, field: 'place', code: 'TOO_LONG_TEXT' });
      var c = str_(e.content);
      if (/[\r\n]/.test(c)) errors.push({ entry: i, field: 'content', code: 'NEWLINE' });
      else if (textLength(c) > R.CONTENT_MAX) errors.push({ entry: i, field: 'content', code: 'TOO_LONG_TEXT' });
      if (DIRECT_VALUES.indexOf(e.direct) < 0) errors.push({ entry: i, field: 'direct', code: 'FORMAT' });
    }
    return errors;
  }

  function emptyRow_() {
    var row = {};
    for (var i = 0; i < INPUT_COLS.length; i++) row[INPUT_COLS[i]] = '';
    return row;
  }

  /**
   * そろえた入力を、日報の行の入力の列（昼の欄・夜の欄）に振り分ける。
   * 返す値: { ok, errors: [{ entry, field, code }], row: 入力の列14列 | null, slotOf: { day: 勤務の番号, night: 勤務の番号 } }
   */
  function toSlots(norm, CW, rules) {
    checkRules(rules);
    var n = norm || { entries: [], note: '' };
    var errors = [];
    if (n.entries.length > rules.REPORT.ENTRY_MAX) {
      errors.push({ entry: rules.REPORT.ENTRY_MAX, field: null, code: 'TOO_MANY' });
      return { ok: false, errors: errors, row: null, slotOf: {} };
    }
    errors = errors.concat(textErrors_(n, rules));
    var slotOf = {};
    // 内容だけの勤務（計画 2-1 の④⑥）: ほかに勤務が無い日に1つだけ。昼の欄に入れる
    var contentOnly = -1;
    for (var q = 0; q < n.entries.length; q++) {
      if (!isContentOnly_(n.entries[q])) continue;
      if (n.entries.length > 1) errors.push({ entry: q, field: 'content', code: 'CONTENT_ONLY' });
      else contentOnly = q;
    }
    for (var i = 0; i < n.entries.length; i++) {
      if (isContentOnly_(n.entries[i])) continue;
      var c = classifyShift(n.entries[i], CW, rules);
      if (!c.kind) {
        for (var j = 0; j < c.errors.length; j++) errors.push({ entry: i, field: c.errors[j].field, code: c.errors[j].code });
        continue;
      }
      if (slotOf[c.kind] !== undefined) {
        errors.push({ entry: i, field: null, code: c.kind === 'day' ? 'TWO_DAY' : 'TWO_NIGHT' });
        continue;
      }
      slotOf[c.kind] = i;
    }
    if (errors.length) return { ok: false, errors: errors, row: null, slotOf: slotOf };
    var row = emptyRow_();
    ['day', 'night'].forEach(function (slot) {
      if (slotOf[slot] === undefined) return;
      var e = n.entries[slotOf[slot]];
      for (var key in SLOT_COLS) row[SLOT_PREFIX[slot] + SLOT_COLS[key]] = str_(e[key]);
    });
    if (contentOnly >= 0) {
      slotOf.day = contentOnly;
      row['昼_施工内容'] = n.entries[contentOnly].content;
    }
    row['備考'] = n.note;
    return { ok: true, errors: [], row: row, slotOf: slotOf };
  }

  function slotEntry_(row, slot) {
    var e = {};
    for (var key in SLOT_COLS) {
      var v = row[SLOT_PREFIX[slot] + SLOT_COLS[key]];
      e[key] = v === null || v === undefined ? '' : String(v);
    }
    return e;
  }

  function slotPresent_(row, slot) {
    var e = slotEntry_(row, slot);
    return e.arrive !== '' || e.start !== '' || e.end !== '' || e.leave !== '';
  }

  /**
   * 日報の行から画面の入力に戻す（日勤 → 夜勤の順。施工内容は effective で読み替えてから）。返す値: { entries, note }。
   * 時刻の無い行で昼の施工内容だけがあれば、内容だけの勤務1つになる
   */
  function fromSlots(row) {
    var r = effective(row || {});
    var entries = [];
    ['day', 'night'].forEach(function (slot) {
      var e = slotEntry_(r, slot);
      if (!isEmptyEntry_(e)) entries.push(e);
    });
    return { entries: entries, note: r['備考'] ? String(r['備考']) : '' };
  }

  /** 日の状態: 'missing'（空）/ 'workless'（時刻なし・文字あり）/ 'work'（勤務が1つ以上） */
  function dayState(row0) {
    if (!row0) return 'missing';
    var row = effective(row0); // 古い列だけの「有給」も workless（計画 2-2）
    if (slotPresent_(row, 'day') || slotPresent_(row, 'night')) return 'work';
    for (var i = 0; i < INPUT_COLS.length; i++) {
      var v = row[INPUT_COLS[i]];
      if (v !== null && v !== undefined && String(v) !== '') return 'workless';
    }
    return 'missing';
  }

  /** 欄の勤務を、欄の印（昼 = 日勤・夜 = 夜勤）で確かめて分に直す。欄と判断が食い違えば SLOT_MISMATCH */
  function slotShift_(row, slot, CW, rules) {
    var e = slotEntry_(row, slot);
    var c = classifyShift(e, CW, rules);
    if (!c.kind) return { ok: false, errors: c.errors };
    if (c.kind !== slot) return { ok: false, errors: [{ field: null, code: 'SLOT_MISMATCH' }] };
    var v = CW.validateShift({ arrive: e.arrive, start: e.start, end: e.end, leave: e.leave, night: slot === 'night' }, rules);
    return v.ok ? { ok: true, shift: v.shift } : { ok: false, errors: v.errors };
  }

  function sortedJson_(obj) {
    var keys = Object.keys(obj).sort();
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      var o = obj[keys[i]];
      out[keys[i]] = { work: o.work, deepNight: o.deepNight, legalHoliday: o.legalHoliday };
    }
    return JSON.stringify(out);
  }

  /**
   * 1日分の計算（計画 2-2）。row は日報の行（入力の列）、ctx は { date: 帰属日, breakType: 休憩方式 }。
   * 返す値: { ok, errors: [{ slot, field, code }], warnings, slots: { day: { calc, shift }, night: {...} },
   *          work, deepNight, legalHoliday, byDate, cols: 計算の列（ok のときだけ） }
   */
  function calcDay(row, ctx, CW, rules) {
    checkRules(rules);
    var r = row || {};
    var errors = [];
    var warnings = [];
    var slots = {};
    var work = 0, deep = 0, holiday = 0;
    var byDate = {};
    var state = dayState(r);
    ['day', 'night'].forEach(function (slot) {
      if (!slotPresent_(r, slot)) {
        var e = slotEntry_(r, slot);
        if (e.direct !== '' || e.place !== '') errors.push({ slot: slot, field: 'arrive', code: 'EMPTY' });
        return;
      }
      var s = slotShift_(r, slot, CW, rules);
      if (!s.ok) {
        for (var i = 0; i < s.errors.length; i++) errors.push({ slot: slot, field: s.errors[i].field, code: s.errors[i].code });
        return;
      }
      var calc = CW.calcShift(s.shift, ctx.breakType, rules);
      var split = CW.splitShift(s.shift, calc, ctx.date, rules);
      slots[slot] = { shift: s.shift, calc: calc, split: split };
      work += calc.work;
      deep += split.deepNight;
      holiday += split.legalHoliday;
      for (var d in split.byDate) {
        if (!byDate[d]) byDate[d] = { work: 0, deepNight: 0, legalHoliday: 0 };
        byDate[d].work += split.byDate[d].work;
        byDate[d].deepNight += split.byDate[d].deepNight;
        byDate[d].legalHoliday += split.byDate[d].legalHoliday;
      }
      for (var w = 0; w < calc.warnings.length; w++) if (warnings.indexOf(calc.warnings[w]) < 0) warnings.push(calc.warnings[w]);
    });
    if (errors.length) return { ok: false, errors: errors, warnings: [], slots: {}, work: 0, deepNight: 0, legalHoliday: 0, byDate: {}, cols: null };

    var cols = {};
    if (state === 'missing') {
      for (var c = 0; c < CALC_COLS.length; c++) cols[CALC_COLS[c]] = '';
    } else {
      cols['休憩方式'] = String(ctx.breakType);
      ['day', 'night'].forEach(function (slot) {
        var p = SLOT_PREFIX[slot];
        var s = slots[slot];
        cols[p + '休憩'] = s ? s.calc.baseBreak + s.calc.extraBreak : '';
        cols[p + '実働'] = s ? s.calc.work : '';
      });
      cols['実働'] = work;
      cols['深夜'] = deep;
      cols['法定休日'] = holiday;
      cols['暦日の内訳'] = Object.keys(byDate).length ? sortedJson_(byDate) : '';
      cols['警告'] = warnings.slice().sort().join(',');
      cols['計算の版'] = CW.VERSION + '/' + VERSION;
      cols['計算の決まり'] = CW.rulesKey(rules);
    }
    return { ok: true, errors: [], warnings: warnings, slots: slots, work: work, deepNight: deep, legalHoliday: holiday, byDate: byDate, cols: cols };
  }

  /** 行の勤務を、その日の 0:00 からの区間 [出社, 退社] にする（offset は前の日 -1440・次の日 +1440）。通らなければ null */
  function interval_(row, slot, offset, CW, rules) {
    if (!row || !slotPresent_(row, slot)) return { none: true };
    var s = slotShift_(row, slot, CW, rules);
    if (!s.ok) return { bad: true };
    return { from: s.shift.arrive + offset, to: s.shift.leave + offset };
  }

  function overlaps_(a, b) {
    return a.from < b.to && b.from < a.to;
  }

  /**
   * 時間の重なり（計画 2-2）。prev・next は前の日・次の日の行（無ければ null）。today はその日の行（calcDay が通ったもの）。
   * 返す値: { errors: [{ slot, field, code: 'OVERLAP', with }], warnings: [{ code: 'NEIGHBOR_UNCHECKED', with }] }
   */
  function checkOverlap(prev, today, next, CW, rules) {
    var DAY = 1440;
    var errors = [];
    var warnings = [];
    var mine = { day: interval_(today, 'day', 0, CW, rules), night: interval_(today, 'night', 0, CW, rules) };
    var others = [
      { with: 'prevNight', iv: interval_(prev, 'night', -DAY, CW, rules) },
      { with: 'nextDay', iv: interval_(next, 'day', DAY, CW, rules) },
      { with: 'nextNight', iv: interval_(next, 'night', DAY, CW, rules) },
    ];
    for (var o = 0; o < others.length; o++) {
      if (others[o].iv.bad) warnings.push({ code: 'NEIGHBOR_UNCHECKED', with: others[o].with });
    }
    if (mine.day.from !== undefined && mine.night.from !== undefined && overlaps_(mine.day, mine.night)) {
      errors.push({ slot: 'night', field: 'arrive', code: 'OVERLAP', with: 'day' });
    }
    ['day', 'night'].forEach(function (slot) {
      var m = mine[slot];
      if (m.from === undefined) return;
      for (var i = 0; i < others.length; i++) {
        var iv = others[i].iv;
        if (iv.from === undefined) continue;
        if (overlaps_(m, iv)) {
          errors.push({ slot: slot, field: others[i].with === 'prevNight' ? 'arrive' : 'leave', code: 'OVERLAP', with: others[i].with });
        }
      }
    });
    return { errors: errors, warnings: warnings };
  }

  /** 所定を超えた時間・足りない時間。所定が分からない（null）なら両方 null */
  function balance(work, companyScheduled, hasNight, CW, rules) {
    if (companyScheduled === null || companyScheduled === undefined) return { furikae: null, shortage: null };
    var b = CW.dayBalance([{ calc: { work: work }, night: hasNight === true }], companyScheduled, rules);
    return { furikae: b.furikae, shortage: b.shortage };
  }

  /**
   * 月次集計に写すその日の値（計画 2-10）。row は日報の行（入力の列・計算の列・recordVersion）。
   * 返す値: { v, s, w, h, n, k }
   */
  function summaryOf(row) {
    var st = dayState(row);
    var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : 0; };
    return {
      v: num(row && row['recordVersion']),
      s: st,
      w: st === 'work' ? num(row['実働']) : 0,
      h: st === 'work' ? num(row['法定休日']) : 0,
      n: st === 'work' ? num(row['深夜']) : 0,
      k: st === 'work' && slotPresent_(row, 'night') ? 1 : 0,
    };
  }

  return {
    VERSION: VERSION,
    INPUT_COLS: INPUT_COLS,
    CALC_COLS: CALC_COLS,
    LEGACY_CONTENT: LEGACY_CONTENT,
    joinContent: joinContent,
    effective: effective,
    DIRECT_VALUES: DIRECT_VALUES,
    TIME_LABEL: TIME_LABEL,
    checkRules: checkRules,
    textLength: textLength,
    normalizeDay: normalizeDay,
    classifyShift: classifyShift,
    toSlots: toSlots,
    fromSlots: fromSlots,
    dayState: dayState,
    /** その勤務（'day'・'night'）の4つの時刻のどれかが入っているか（出勤簿の出勤日数。手順10 2-3） */
    hasSlot: function (row, slot) { return !!row && slotPresent_(row, slot); },
    calcDay: calcDay,
    checkOverlap: checkOverlap,
    balance: balance,
    summaryOf: summaryOf,
  };
})();
