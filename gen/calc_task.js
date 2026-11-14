// 自動生成（tools/build.js）。直接編集しない。正本: shared/calc_task.js
/**
 * 画面とサーバーで共有するタスクリストの決まり（正本）。GAS のサービスは使わない純粋な JS。
 * tools/build.js が GAS 用（server/gen_calc_task.js）とブラウザ用（web/gen/calc_task.js）を生成する。生成物は直接編集しない。
 * 計画 docs/plans/stage2-tasklist-plan.md 第2章。
 *
 *   can(user, task, op)                 … その人がそのタスクにその操作をしてよいか（2-2 の表。サーバーで必ず確かめる。画面はボタンの出し分けだけ）
 *   addKind(user, ownerId)              … だれの欄に足せるか: 'own'（自分の欄）・'request'（依頼）・'admin'（管理者が他の人の欄に。依頼ではない）
 *   nextState(state, op)                … 状態の移り方（2-3）。できなければ null
 *   nextBusinessDay(date, isHoliday)    … 次の営業日（isHoliday(date) → true / false。分からない日は呼ぶ側が土日で答える）
 *   autoDeferTarget(date, today, isHoliday) … 自動の先送りの先と、飛ばした営業日の数（2-4）
 *   recurringDates(rule, from, to, isHoliday) … 定型タスクの「入れる日」（2-5。v3 計画 2-1〜2-3: 毎年・月末・第n曜日・第n週の初営業日・第n営業日・休みは前の営業日へ／次の営業日へ）
 *   isLongCycle(rule)                   … 毎月・毎年か（さかのぼりの限りを長くする。v3 計画 2-4）
 *   can(…, 'remind')・remindAt・remindDue・remindKey … リマインダー（v3 計画 第3章）
 *   sortDay(list)                       … 表示の並びの正本（v2 計画 2-3: 状態の組 → 急ぎ → 締め切り → 並び → タスクID）
 *   groupKey(task)                      … 並べ替えの「群」の鍵（同じ群の中でだけ 上へ・下へ ができる）
 *   dueLevel(task, nowDate, nowMin, soonDays) … 締め切りの段階（v2 計画 2-2）: ''・normal・soon・over
 *   dueLabel(task, nowDate, nowMin, soonDays) … 締め切りの印の文字（〆11/20・〆明日・〆過ぎ 11/13）
 *   taskToday(date, minutes, startMin)  … タスクの今日（v2 計画 2-6。startMin より前の時刻は前の日）
 * v2 の計画: docs/plans/stage2-tasklist-v2-plan.md。v3 の計画: docs/plans/stage2-tasklist-v3-plan.md
 */
var CalcTask = (function () {
  'use strict';

  var STATE = { OPEN: '未完了', DONE: '完了', DEFERRED: '先送り', CANCELLED: '取りやめ' };
  var STATES = [STATE.OPEN, STATE.DONE, STATE.DEFERRED, STATE.CANCELLED];
  var URGENCY = ['至急', '急ぎ', '通常'];
  var REPEAT = { DAILY: '毎日', WEEKLY: '曜日', MONTHLY: '毎月', YEARLY: '毎年' };
  /** 毎月・毎年の「日の決め方」（v3 計画 2-1）。空は DAY と同じ */
  var DAY_KIND = { DAY: '日', LAST: '月末', NTH_WEEKDAY: '第n曜日', WEEK_FIRST_BIZ: '第n週の初営業日', NTH_BIZ: '第n営業日' };
  var DAY_KINDS = [DAY_KIND.DAY, DAY_KIND.LAST, DAY_KIND.NTH_WEEKDAY, DAY_KIND.WEEK_FIRST_BIZ, DAY_KIND.NTH_BIZ];
  /** 休みの日に当たったとき（v3 計画 2-2。「次の営業日」はユーザーの依頼 2026-11-15） */
  var HOLIDAY = { PREV: '前の営業日', NEXT: '次の営業日', SKIP: '飛ばす', KEEP: 'そのまま' };
  var HOLIDAYS = [HOLIDAY.PREV, HOLIDAY.NEXT, HOLIDAY.SKIP, HOLIDAY.KEEP];
  /** 第n の特別な値: 最後の◯曜日・最後の営業日。ふつうの値の範囲は NTH_RANGE */
  var NTH_LAST_WEEKDAY = 9, NTH_LAST_BIZ = 99;
  var NTH_RANGE = { WEEKDAY: [1, 5], WEEK: [1, 6], BIZ: [1, 23] };
  /** リマインダーの種類（知らせ済みの印の鍵に入る） */
  var REMIND_KIND = { EARLY: 'early', MAIN: 'main' };
  var ADMIN = '管理者';
  var DAY_MS = 86400000;

  function str_(v) { return v === null || v === undefined ? '' : String(v); }
  function isAdmin_(user) { return !!user && user.role === ADMIN; }
  function isDate(text) {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    var t = Date.UTC(Number(text.slice(0, 4)), Number(text.slice(5, 7)) - 1, Number(text.slice(8, 10)));
    return new Date(t).toISOString().slice(0, 10) === text;
  }
  function dayNumber(date) { return Math.round(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS); }
  function dateOf(n) { return new Date(n * DAY_MS).toISOString().slice(0, 10); }
  function addDays(date, k) { return dateOf(dayNumber(date) + k); }
  /** 曜日（日曜 = 0 … 土曜 = 6） */
  function dowOf(date) { return new Date(dayNumber(date) * DAY_MS).getUTCDay(); }

  /**
   * その人がそのタスクにその操作をしてよいか（計画 2-2）。
   * user: { employeeId, role }。task: { owner（担当）, requester（依頼者・空なら依頼でない）, hidden, state }。
   * op: view・edit・complete（完了・未完了に戻す）・defer・cancel（取りやめ・取りやめから戻す）・delete・move
   */
  function can(user, task, op) {
    if (!user || !task) return false;
    var me = str_(user.employeeId);
    var owner = str_(task.owner), requester = str_(task.requester);
    var admin = isAdmin_(user);
    var isOwner = me !== '' && me === owner;
    var isRequester = requester !== '' && me === requester;
    var requested = requester !== '';
    // 直す・消すのは未完了の今の行だけ（完了・取りやめは未完了に戻してから。先送りの記録は直せない。計画 2-3）
    var open = task.state === STATE.OPEN;
    switch (op) {
      case 'view': return admin || isOwner || isRequester || !task.hidden;
      case 'edit': return open && (admin || (isOwner && !requested) || isRequester);
      case 'complete': return admin || isOwner;
      case 'defer': return admin || isOwner || isRequester;
      case 'cancel': return admin || isRequester || (isOwner && !requested); // 依頼されたタスクは、依頼された人が取りやめにできない（仕様書 第12章）
      case 'delete': return open && (admin || isRequester || (isOwner && !requested));
      case 'move': return admin || isOwner;
      case 'remind': return open && (admin || isOwner); // リマインダーは担当の持ち物（v3 計画 3-2）
      default: return false;
    }
  }

  /** だれの欄に足せるか（計画 2-2）。ownerActive が false（利用停止）の欄には足せない */
  function addKind(user, ownerId, ownerActive) {
    if (!user || !ownerId || ownerActive === false) return null;
    if (str_(user.employeeId) === str_(ownerId)) return 'own';
    return isAdmin_(user) ? 'admin' : 'request';
  }

  /** 状態の移り方（計画 2-3）。op: complete・reopen・defer・cancel・uncancel */
  function nextState(state, op) {
    if (op === 'complete') return state === STATE.OPEN ? STATE.DONE : null;
    if (op === 'reopen') return state === STATE.DONE ? STATE.OPEN : null;
    if (op === 'defer') return state === STATE.OPEN ? STATE.DEFERRED : null;
    if (op === 'cancel') return state === STATE.OPEN ? STATE.CANCELLED : null;
    if (op === 'uncancel') return state === STATE.CANCELLED ? STATE.OPEN : null;
    return null;
  }

  /** 状態の操作に要る権限（can の op） */
  var OP_PERMISSION = { complete: 'complete', reopen: 'complete', defer: 'defer', cancel: 'cancel', uncancel: 'cancel' };

  /** 分からない日の休み（土日） */
  function weekendHoliday(date) { var w = dowOf(date); return w === 0 || w === 6; }

  /** 次の営業日（370日先まで探す。見つからなければ翌日） */
  function nextBusinessDay(date, isHoliday) {
    var hol = isHoliday || weekendHoliday;
    for (var k = 1; k <= 370; k++) {
      var d = addDays(date, k);
      if (!hol(d)) return d;
    }
    return addDays(date, 1);
  }

  /**
   * 自動の先送りの先（計画 2-4）。その日の次の営業日をくり返し、今日以降になった最初の営業日。
   * 返す値: { to, hops（飛ばした営業日の数＝先送り回数に足す数） }。date が今日以降なら null
   */
  function autoDeferTarget(date, today, isHoliday) {
    if (!(date < today)) return null;
    var d = date, hops = 0;
    do {
      d = nextBusinessDay(d, isHoliday);
      hops++;
    } while (d < today && hops < 1000);
    return { to: d, hops: hops };
  }

  /** 休みの扱い（v3 計画 2-2）。新しい値が無い行は、今までの「営業日だけ」から読む。営業日で決める日の決め方は、そのまま */
  function holidayOf(rule) {
    if (!rule) return HOLIDAY.KEEP;
    var long = rule.repeat === REPEAT.MONTHLY || rule.repeat === REPEAT.YEARLY;
    if (long && (rule.dayKind === DAY_KIND.WEEK_FIRST_BIZ || rule.dayKind === DAY_KIND.NTH_BIZ)) return HOLIDAY.KEEP;
    if (HOLIDAYS.indexOf(rule.holiday) >= 0) return rule.holiday;
    return rule.businessOnly ? HOLIDAY.SKIP : HOLIDAY.KEEP;
  }

  /** 毎月・毎年か（さかのぼりの限りを長くする定型。v3 計画 2-4）。日の決め方・休みの扱いには依らない */
  function isLongCycle(rule) {
    return !!rule && (rule.repeat === REPEAT.MONTHLY || rule.repeat === REPEAT.YEARLY);
  }

  function dayOfMonth(d) { return Number(d.slice(8, 10)); }
  function sameMonth(a, b) { return a.slice(0, 7) === b.slice(0, 7); }

  /** 毎月・毎年の「日の決め方」に、その日が当てはまるか（名目の日） */
  function matchDayKind(rule, d, hol) {
    var kind = rule.dayKind || DAY_KIND.DAY;
    var day = dayOfMonth(d), nth = Number(rule.nth), k;
    if (kind === DAY_KIND.DAY) return day === Number(rule.day);
    if (kind === DAY_KIND.LAST) return !sameMonth(addDays(d, 1), d);
    if (kind === DAY_KIND.NTH_WEEKDAY) {
      if (dowOf(d) !== Number(rule.weekday)) return false;
      return nth === NTH_LAST_WEEKDAY ? !sameMonth(addDays(d, 7), d) : Math.ceil(day / 7) === nth;
    }
    if (kind === DAY_KIND.WEEK_FIRST_BIZ) {
      // 週は日曜始まり（壁のカレンダーの段と同じ）。第 1 週は 1 日を含む週（v3 計画 2-1。ユーザー決定 2026-11-14）
      var pos = dowOf(d); // 日曜 = 0 … 土曜 = 6
      var firstPos = dowOf(addDays(d, 1 - day));
      if (Math.floor((day - 1 + firstPos) / 7) + 1 !== nth || hol(d)) return false;
      for (k = 1; k <= pos && day - k >= 1; k++) if (!hol(addDays(d, -k))) return false; // 同じ週・同じ月に、もっと前の営業日がある
      return true;
    }
    if (kind === DAY_KIND.NTH_BIZ) {
      if (hol(d)) return false;
      if (nth === NTH_LAST_BIZ) {
        for (k = 1; sameMonth(addDays(d, k), d); k++) if (!hol(addDays(d, k))) return false;
        return true;
      }
      var count = 1;
      for (k = 1; day - k >= 1; k++) if (!hol(addDays(d, -k))) count++;
      return count === nth;
    }
    return false;
  }

  /** その日が、決まり（繰り返し・月・日の決め方）に当てはまるか（名目の日。休みの扱いは見ない） */
  function matchRule(rule, d, hol) {
    if (rule.repeat === REPEAT.DAILY) return true;
    if (rule.repeat === REPEAT.WEEKLY) return (rule.weekdays || []).indexOf(dowOf(d)) >= 0;
    if (rule.repeat === REPEAT.MONTHLY) return matchDayKind(rule, d, hol);
    if (rule.repeat === REPEAT.YEARLY) return Number(d.slice(5, 7)) === Number(rule.month) && matchDayKind(rule, d, hol);
    return false;
  }

  /**
   * 定型タスクの「入れる日」（計画 2-5・v3 計画 2-3）。from〜to（両端を含む）に入るものを、昇順・重なり無しで返す。
   * rule: { repeat: 毎日・曜日・毎月・毎年, weekdays: [0..6]（曜日のとき）, month: 1〜12（毎年）,
   *         dayKind（毎月・毎年。空は「日」）, day: 1〜31, nth, weekday: 0〜6,
   *         holiday: 前の営業日・次の営業日・飛ばす・そのまま（無ければ businessOnly から）, shiftMax（前・次へずらす日数の限り。呼ぶ側が設定から入れる）,
   *         start, end（空なら無期限。名目の日に当てる） }
   * 手順: 名目の日を from〜to + shiftMax（前へずらすとき）・from − shiftMax〜to（次へずらすとき）で調べる → start・end → 決まり → 休みの扱い → 入れる日が from〜to のものだけ
   */
  function recurringDates(rule, from, to, isHoliday) {
    var out = [];
    if (!rule || !isDate(from) || !isDate(to) || from > to) return out;
    var hol = isHoliday || weekendHoliday;
    var mode = holidayOf(rule);
    var dir = mode === HOLIDAY.PREV ? -1 : mode === HOLIDAY.NEXT ? 1 : 0; // ずらす向き（前へ・次へ・ずらさない）
    var shiftMax = dir !== 0 ? Math.max(0, Math.floor(Number(rule.shiftMax) || 0)) : 0;
    var seen = {};
    var first = dayNumber(from) - (dir > 0 ? shiftMax : 0); // 次へずらす: from より前の名目の日が、from 以降に入る
    var last = dayNumber(to) + (dir < 0 ? shiftMax : 0); // 前へずらす: to より先の名目の日が、to 以前に入る
    for (var n = first; n <= last; n++) {
      var d = dateOf(n);
      if (rule.start && d < rule.start) continue;
      if (rule.end && d > rule.end) continue;
      if (!matchRule(rule, d, hol)) continue;
      var put = d;
      if (hol(d)) {
        if (mode === HOLIDAY.SKIP) continue;
        if (dir !== 0) {
          put = null;
          for (var k = 1; k <= shiftMax; k++) {
            var e = addDays(d, dir * k);
            if (!hol(e)) { put = e; break; }
          }
          if (!put) continue;
        }
      }
      if (put < from || put > to || seen[put]) continue;
      seen[put] = true;
      out.push(put);
    }
    return out.sort();
  }

  function isTime(text) { return typeof text === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(text); }
  function minutesOf(time) { return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)); }

  /**
   * 並べ替えの「群」の鍵（v2 計画 2-3）: 状態の組（未完了／完了・取りやめ）・急ぎの度合い・締め切り日・締め切りの時刻。
   * 文字として比べた順が、そのまま表示の順になる（締め切り無しは後・時刻無しはその日の終わり）
   */
  function groupKey(task) {
    var open = task.state === STATE.OPEN ? '0' : '1';
    var u = URGENCY.indexOf(task.urgency);
    var due = isDate(task.due) ? task.due : '9999-99-99';
    var time = isDate(task.due) && isTime(task.dueTime) ? task.dueTime : '99:99';
    return open + '|' + (u < 0 ? URGENCY.length - 1 : u) + '|' + due + '|' + time;
  }

  /** 表示の並びの正本: 群の鍵 → 並び（数。画面では rank）→ タスクID */
  function sortDay(list) {
    return list.map(function (t) { return { t: t, k: groupKey(t) }; }).sort(function (a, b) {
      if (a.k !== b.k) return a.k < b.k ? -1 : 1;
      return (Number(a.t.order) || 0) - (Number(b.t.order) || 0) || (str_(a.t.taskId) < str_(b.t.taskId) ? -1 : str_(a.t.taskId) > str_(b.t.taskId) ? 1 : 0);
    }).map(function (x) { return x.t; });
  }

  /**
   * 締め切りの段階（v2 計画 2-2）。nowDate・nowMin は本当の今（日本時間の日付と、0時からの分）。
   * 完了・取りやめ・締め切り無し → ''。過ぎた → over（時刻があればその時刻を過ぎたら。無ければその日が終わったら）。
   * 締め切り日が今日から soonDays 日以内 → soon。それ以外 → normal
   */
  function dueLevel(task, nowDate, nowMin, soonDays) {
    if (!task || task.state !== STATE.OPEN || !isDate(task.due) || !isDate(nowDate)) return '';
    if (nowDate > task.due) return 'over';
    if (nowDate === task.due && isTime(task.dueTime) && Number(nowMin) > minutesOf(task.dueTime)) return 'over';
    return dayNumber(task.due) - dayNumber(nowDate) <= Number(soonDays) ? 'soon' : 'normal';
  }

  function md_(date) { return Number(date.slice(5, 7)) + '/' + Number(date.slice(8, 10)); }

  /** 締め切りの印の文字。段階が '' なら '' */
  function dueLabel(task, nowDate, nowMin, soonDays) {
    var lv = dueLevel(task, nowDate, nowMin, soonDays);
    if (!lv) return '';
    var time = isTime(task.dueTime) ? ' ' + Number(task.dueTime.slice(0, 2)) + ':' + task.dueTime.slice(3, 5) : '';
    if (lv === 'over') return '〆過ぎ ' + md_(task.due) + time;
    var diff = dayNumber(task.due) - dayNumber(nowDate);
    return '〆' + (diff === 0 ? '今日' : diff === 1 ? '明日' : md_(task.due)) + time;
  }

  /** タスクの今日（v2 計画 2-6）。date・minutes は日本時間の今。startMin（例 360 = 6:00）より前は前の日 */
  function taskToday(date, minutes, startMin) {
    return Number(minutes) < Number(startMin) ? addDays(date, -1) : date;
  }

  /** 日本時間の「その日のその時刻」のミリ秒（端末のタイムゾーンに依らない） */
  function jstMs(date, time) {
    return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(time.slice(0, 2)) - 9, Number(time.slice(3, 5)));
  }

  /** リマインダーの時刻（v3 計画 3-1）: { main, early（早めの知らせ。無ければ null） }。形が違えば null */
  function remindAt(item) {
    if (!item || !isDate(item.date) || !isTime(item.time)) return null;
    var main = jstMs(item.date, item.time);
    var e = Number(item.early);
    return { main: main, early: e > 0 ? main - e * 60000 : null };
  }

  /** 知らせ済みの印の鍵（タスクの日付と時刻で作る。出した日では作らない。v3 計画 3-4） */
  function remindKey(item, kind) { return str_(item.taskId) + '|' + item.date + '|' + item.time + '|' + kind; }

  /**
   * 今、知らせるもの（v3 計画 3-4）。items: [{ taskId, date, time, early, … }]、nowMs: サーバーの今、done: { 鍵: 真 }、lateMaxMin: 過ぎてから出す限り。
   * 返す値: { fire: [{ key, kind, item, late（時刻からの遅れの分）, left（早めの知らせ: 本番までの分） }], expire: [もう出さない鍵] }
   *   早めの知らせ … 早めの時刻 〜 本番の時刻の前。本番の時刻を過ぎたら出さない（expire）
   *   時刻の知らせ … 本番の時刻 〜 lateMaxMin 分後。それより後は出さない（expire）
   */
  function remindDue(items, nowMs, done, lateMaxMin) {
    var fire = [], expire = [];
    var seen = done || {};
    (items || []).forEach(function (it) {
      var at = remindAt(it);
      if (!at) return;
      var kM = remindKey(it, REMIND_KIND.MAIN), kE = remindKey(it, REMIND_KIND.EARLY);
      if (at.early !== null && !seen[kE]) {
        if (nowMs >= at.main) expire.push(kE);
        else if (nowMs >= at.early) fire.push({ key: kE, kind: REMIND_KIND.EARLY, item: it, late: Math.floor((nowMs - at.early) / 60000), left: Math.ceil((at.main - nowMs) / 60000) });
      }
      if (!seen[kM] && nowMs >= at.main) {
        var late = Math.floor((nowMs - at.main) / 60000);
        if (late > Number(lateMaxMin)) expire.push(kM);
        else fire.push({ key: kM, kind: REMIND_KIND.MAIN, item: it, late: late, left: 0 });
      }
    });
    return { fire: fire, expire: expire };
  }

  /** 急ぎの印（色だけに頼らない文字。計画 2-7） */
  function urgencyMark(u) { return u === '至急' ? '‼至急' : u === '急ぎ' ? '！急ぎ' : ''; }

  /** 完了したタスクの内容を、日報の施工内容の形に（「、」でつなぐ。計画 2-8） */
  function reportText(contents) {
    return (contents || []).map(str_).filter(function (s) { return s !== ''; }).join('、');
  }

  return {
    STATE: STATE, STATES: STATES, URGENCY: URGENCY, REPEAT: REPEAT, OP_PERMISSION: OP_PERMISSION,
    DAY_KIND: DAY_KIND, DAY_KINDS: DAY_KINDS, HOLIDAY: HOLIDAY, HOLIDAYS: HOLIDAYS, NTH_LAST_WEEKDAY: NTH_LAST_WEEKDAY, NTH_LAST_BIZ: NTH_LAST_BIZ, NTH_RANGE: NTH_RANGE,
    REMIND_KIND: REMIND_KIND, holidayOf: holidayOf, isLongCycle: isLongCycle, remindAt: remindAt, remindKey: remindKey, remindDue: remindDue,
    isDate: isDate, addDays: addDays, dowOf: dowOf, dayNumber: dayNumber, dateOf: dateOf,
    can: can, addKind: addKind, nextState: nextState, weekendHoliday: weekendHoliday,
    nextBusinessDay: nextBusinessDay, autoDeferTarget: autoDeferTarget, recurringDates: recurringDates,
    sortDay: sortDay, groupKey: groupKey, dueLevel: dueLevel, dueLabel: dueLabel, taskToday: taskToday, isTime: isTime,
    urgencyMark: urgencyMark, reportText: reportText,
  };
})();
