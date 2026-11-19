// 自動生成（tools/build.js）。直接編集しない。正本: shared/calc_form.js
/**
 * 画面とサーバーで共有する各種受付の決まり（正本）。GAS のサービスは使わない純粋な JS。
 * tools/build.js が GAS 用（server/gen_calc_form.js）とブラウザ用（web/gen/calc_form.js）を生成する。生成物は直接編集しない。
 * 計画 docs/plans/stage4-board-plan.md 第2章・11-4・11-8。**年齢・生年月日・区分の判定はここに入れない**（サーバーの form_health.js だけ）
 *
 *   KIND                               … 受付の種類（attend 飲み会の出欠 / order 制服の注文 / health 健康診断の日程）
 *   jstMs(y, m, d, h, mi)              … 日本時間の日時 → ミリ秒（端末のタイムゾーンは使わない）
 *   parseDeadline(text)                … 締切の入力 → ミリ秒。'yyyy-MM-dd' はその次の日の 0:00、'yyyy-MM-ddTHH:mm' はその時刻。形が違えば null
 *   parseStart(text)                   … 受付の初めの入力 → ミリ秒。'yyyy-MM-dd' はその日の 0:00。空は null（作ったときから）
 *   isOpen(startMs, deadlineMs, nowMs) … 受け付けるか（受付の初め ≦ 今 ＜ 締切。締切ちょうどは受け付けない）
 *   deadlineLabel(ms)                  … 「10/31 まで」（0:00 は前の日の「まで」）・「10/31 18:00 まで」
 *   dateText(ms)・timeText(ms)         … 日本時間の 'yyyy-MM-dd'・'HH:mm'
 *   checkAnswer(kind, settings, answer, rules, extra) … 回答の形を確かめ、整えた形を返す（{ ok: true, value } / { ok: false, message }）。
 *       extra … { categories: [選べる区分]（健康診断だけ。サーバーが決めて渡す）, today: 'yyyy-MM-dd' }
 */
var CalcForm = (function () {
  'use strict';

  var KIND = { ATTEND: 'attend', ORDER: 'order', HEALTH: 'health' };
  var KINDS = [KIND.ATTEND, KIND.ORDER, KIND.HEALTH];
  var KIND_LABEL = { attend: '飲み会の出欠', order: '制服の注文', health: '健康診断の日程' };
  var ATTEND = ['出席', '欠席', '未定'];
  var HOUR = 3600000, DAY = 24 * HOUR;
  var TZ = 9 * HOUR; // 日本時間（夏時間なし）

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function jstMs(y, m, d, h, mi) {
    return Date.UTC(y, m - 1, d, h || 0, mi || 0) - TZ;
  }

  function validYmd(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  function isDate(text) {
    var m = typeof text === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) : null;
    return !!m && validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  /** 'yyyy-MM-dd' か 'yyyy-MM-ddTHH:mm' → { y, m, d, h, mi, timed } か null */
  function parts(text) {
    if (typeof text !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(text);
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (!validYmd(y, mo, d)) return null;
    var timed = m[4] !== undefined;
    var h = timed ? Number(m[4]) : 0, mi = timed ? Number(m[5]) : 0;
    if (h > 23 || mi > 59) return null;
    return { y: y, m: mo, d: d, h: h, mi: mi, timed: timed };
  }

  function parseDeadline(text) {
    var p = parts(text);
    if (!p) return null;
    var ms = jstMs(p.y, p.m, p.d, p.h, p.mi);
    return p.timed ? ms : ms + DAY; // 日付だけ → その日の終わり（次の日の 0:00）。その日の 23:59 までは受け付ける
  }

  function parseStart(text) {
    if (text === '' || text === null || text === undefined) return null;
    var p = parts(text);
    return p ? jstMs(p.y, p.m, p.d, p.h, p.mi) : null;
  }

  function isOpen(startMs, deadlineMs, nowMs) {
    if (typeof deadlineMs !== 'number' || !isFinite(deadlineMs) || typeof nowMs !== 'number') return false;
    if (typeof startMs === 'number' && isFinite(startMs) && nowMs < startMs) return false;
    return nowMs < deadlineMs;
  }

  function jst(ms) { var d = new Date(ms + TZ); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; }
  function dateText(ms) { var j = jst(ms); return j.y + '-' + pad(j.m) + '-' + pad(j.d); }
  function timeText(ms) { var j = jst(ms); return pad(j.h) + ':' + pad(j.mi); }

  function deadlineLabel(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var j = jst(ms);
    if (j.h === 0 && j.mi === 0) { var p = jst(ms - DAY); return p.m + '/' + p.d + ' まで'; }
    return j.m + '/' + j.d + ' ' + pad(j.h) + ':' + pad(j.mi) + ' まで';
  }

  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
  function onlyKeys(o, keys) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    return Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; });
  }
  function bad(message) { return { ok: false, message: message }; }

  /** 一言（0〜max 字・改行なし。前後の空白は消す。見えない文字は呼ぶ側で取り除いてから渡す） */
  function note(v, max, textLength) {
    if (v === undefined || v === null) return { ok: true, value: '' };
    if (typeof v !== 'string' || v.length > 2000) return bad('一言の形が正しくありません');
    var t = v.replace(/^[\s　]+|[\s　]+$/g, '');
    if (/[\r\n]/.test(t)) return bad('一言に改行は入れられません');
    if ((textLength ? textLength(t) : t.length) > max) return bad('一言は ' + max + ' 字までです');
    return { ok: true, value: t };
  }

  /** 選択肢のうち、出している（hidden でない）もの */
  function live(list) { return (Array.isArray(list) ? list : []).filter(function (o) { return o && o.hidden !== true; }); }
  function findLive(list, id) { return live(list).filter(function (o) { return o.id === id; })[0] || null; }

  function checkAttend(settings, a, rules, textLength) {
    if (!onlyKeys(a, ['status', 'note', 'guests'])) return bad('回答の形が正しくありません');
    if (ATTEND.indexOf(a.status) < 0) return bad('出席・欠席・未定のどれかを選んでください');
    var n = note(a.note, rules.NOTE_MAX, textLength);
    if (!n.ok) return n;
    var guests = 0;
    if (a.guests !== undefined && a.guests !== null && a.guests !== 0) {
      if (!settings || settings.guests !== true) return bad('この受付には同伴の人数は入れられません');
      if (!isInt(a.guests) || a.guests < 0 || a.guests > rules.ATTEND_GUEST_MAX) return bad('同伴の人数は 0〜' + rules.ATTEND_GUEST_MAX + ' 人です');
      guests = a.guests;
    }
    if (a.status !== '出席') guests = 0; // 出席でなければ同伴は数えない
    return { ok: true, value: { status: a.status, note: n.value, guests: guests } };
  }

  function checkOrder(settings, a, rules) {
    if (!onlyKeys(a, ['lines'])) return bad('回答の形が正しくありません');
    if (!Array.isArray(a.lines) || !a.lines.length) return bad('品目を 1 つ以上選んでください');
    if (a.lines.length > 200) return bad('回答の形が正しくありません');
    var seen = {}, perItem = {}, out = [];
    var items = settings && Array.isArray(settings.items) ? settings.items : [];
    for (var i = 0; i < a.lines.length; i++) {
      var l = a.lines[i];
      if (!onlyKeys(l, ['item', 'size', 'qty'])) return bad('回答の形が正しくありません');
      var item = findLive(items, l.item);
      if (!item) return bad('選べない品目があります。読み直してください');
      var size = findLive(item.sizes, l.size);
      if (!size) return bad('「' + item.name + '」で選べないサイズがあります。読み直してください');
      if (!isInt(l.qty) || l.qty < 1 || l.qty > rules.ORDER_QTY_MAX) return bad('数量は 1〜' + rules.ORDER_QTY_MAX + ' です');
      var key = l.item + '|' + l.size;
      if (seen[key]) return bad('同じ品目・サイズが 2 つあります');
      seen[key] = true;
      perItem[l.item] = (perItem[l.item] || 0) + l.qty;
      if (perItem[l.item] > rules.ORDER_QTY_MAX) return bad('「' + item.name + '」は合わせて ' + rules.ORDER_QTY_MAX + ' つまでです');
      out.push({ item: l.item, size: l.size, qty: l.qty });
    }
    return { ok: true, value: { lines: out } };
  }

  function addDays(date, n) {
    var p = parts(date);
    var t = new Date(Date.UTC(p.y, p.m - 1, p.d) + n * DAY);
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }

  function checkHealth(settings, a, rules, extra, textLength) {
    if (!onlyKeys(a, ['hospital', 'category', 'wishes', 'note'])) return bad('回答の形が正しくありません');
    var cats = extra && Array.isArray(extra.categories) ? extra.categories : [];
    if (!cats.length) return bad('生年月日が登録されていないため、区分を選べません。管理者に伝えてください');
    if (!findLive(settings && settings.hospitals, a.hospital)) return bad('病院を選んでください');
    if (cats.indexOf(a.category) < 0) return bad('区分を選んでください');
    if (!Array.isArray(a.wishes) || !a.wishes.length || a.wishes.length > rules.HEALTH_WISH_MAX) return bad('希望日は第 1 希望を必ず、第 ' + rules.HEALTH_WISH_MAX + ' 希望まで選べます');
    var today = extra && isDate(extra.today) ? extra.today : null;
    var seen = {};
    for (var i = 0; i < a.wishes.length; i++) {
      var w = a.wishes[i];
      if (!isDate(w)) return bad('第 ' + (i + 1) + ' 希望の日付の形が正しくありません');
      if (today && (w < today || w > addDays(today, rules.HEALTH_WISH_DAYS))) return bad('第 ' + (i + 1) + ' 希望は、今日から ' + rules.HEALTH_WISH_DAYS + ' 日先までの日にしてください');
      if (seen[w]) return bad('同じ日を 2 回は選べません');
      seen[w] = true;
    }
    var n = note(a.note, rules.NOTE_MAX, textLength);
    if (!n.ok) return n;
    return { ok: true, value: { hospital: a.hospital, category: a.category, wishes: a.wishes.slice(), note: n.value } };
  }

  function checkAnswer(kind, settings, answer, rules, extra, textLength) {
    if (kind === KIND.ATTEND) return checkAttend(settings, answer, rules, textLength);
    if (kind === KIND.ORDER) return checkOrder(settings, answer, rules);
    if (kind === KIND.HEALTH) return checkHealth(settings, answer, rules, extra, textLength);
    return bad('知らない種類の受付です');
  }

  return {
    KIND: KIND, KINDS: KINDS, KIND_LABEL: KIND_LABEL, ATTEND: ATTEND, DAY_MS: DAY,
    jstMs: jstMs, isDate: isDate, parseDeadline: parseDeadline, parseStart: parseStart, isOpen: isOpen, deadlineLabel: deadlineLabel,
    dateText: dateText, timeText: timeText, addDays: addDays, live: live, checkAnswer: checkAnswer,
  };
})();
