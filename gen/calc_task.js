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
 *   recurringDates(rule, from, to, isHoliday) … 定型タスクの当てはまる日（2-5）
 *   sortDay(list)                       … 表示の並びの正本（v2 計画 2-3: 状態の組 → 急ぎ → 締め切り → 並び → タスクID）
 *   groupKey(task)                      … 並べ替えの「群」の鍵（同じ群の中でだけ 上へ・下へ ができる）
 *   dueLevel(task, nowDate, nowMin, soonDays) … 締め切りの段階（v2 計画 2-2）: ''・normal・soon・over
 *   dueLabel(task, nowDate, nowMin, soonDays) … 締め切りの印の文字（〆11/20・〆明日・〆過ぎ 11/13）
 *   taskToday(date, minutes, startMin)  … タスクの今日（v2 計画 2-6。startMin より前の時刻は前の日）
 * v2 の計画: docs/plans/stage2-tasklist-v2-plan.md
 */
var CalcTask = (function () {
  'use strict';

  var STATE = { OPEN: '未完了', DONE: '完了', DEFERRED: '先送り', CANCELLED: '取りやめ' };
  var STATES = [STATE.OPEN, STATE.DONE, STATE.DEFERRED, STATE.CANCELLED];
  var URGENCY = ['至急', '急ぎ', '通常'];
  var REPEAT = { DAILY: '毎日', WEEKLY: '曜日', MONTHLY: '毎月' };
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

  /**
   * 定型タスクの当てはまる日（計画 2-5）。from〜to（両端を含む）の中で。
   * rule: { repeat: 毎日・曜日・毎月, weekdays: [0..6]（曜日のとき）, day: 1〜31（毎月のとき）, businessOnly, start, end（空なら無期限） }
   */
  function recurringDates(rule, from, to, isHoliday) {
    var out = [];
    if (!rule || !isDate(from) || !isDate(to) || from > to) return out;
    var lo = rule.start && rule.start > from ? rule.start : from;
    var hi = rule.end && rule.end < to ? rule.end : to;
    var hol = isHoliday || weekendHoliday;
    for (var n = dayNumber(lo); n <= dayNumber(hi); n++) {
      var d = dateOf(n);
      var ok = false;
      if (rule.repeat === REPEAT.DAILY) ok = true;
      else if (rule.repeat === REPEAT.WEEKLY) ok = (rule.weekdays || []).indexOf(dowOf(d)) >= 0;
      else if (rule.repeat === REPEAT.MONTHLY) ok = Number(d.slice(8, 10)) === Number(rule.day);
      if (ok && rule.businessOnly && hol(d)) ok = false;
      if (ok) out.push(d);
    }
    return out;
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

  /** 急ぎの印（色だけに頼らない文字。計画 2-7） */
  function urgencyMark(u) { return u === '至急' ? '‼至急' : u === '急ぎ' ? '！急ぎ' : ''; }

  /** 完了したタスクの内容を、日報の施工内容の形に（「、」でつなぐ。計画 2-8） */
  function reportText(contents) {
    return (contents || []).map(str_).filter(function (s) { return s !== ''; }).join('、');
  }

  return {
    STATE: STATE, STATES: STATES, URGENCY: URGENCY, REPEAT: REPEAT, OP_PERMISSION: OP_PERMISSION,
    isDate: isDate, addDays: addDays, dowOf: dowOf, dayNumber: dayNumber, dateOf: dateOf,
    can: can, addKind: addKind, nextState: nextState, weekendHoliday: weekendHoliday,
    nextBusinessDay: nextBusinessDay, autoDeferTarget: autoDeferTarget, recurringDates: recurringDates,
    sortDay: sortDay, groupKey: groupKey, dueLevel: dueLevel, dueLabel: dueLabel, taskToday: taskToday, isTime: isTime,
    urgencyMark: urgencyMark, reportText: reportText,
  };
})();
