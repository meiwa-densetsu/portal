/*
 * 定型タスク（計画 docs/plans/stage2-tasklist-plan.md 2-6）。自分の分（管理者は人を選べる）の一覧・足す・直す・止める
 * v3（計画 docs/plans/stage2-tasklist-v3-plan.md 2-7）: 毎年・月末・第n曜日・第n週の初営業日・第n営業日・休みの日の扱い・リマインダー・次に入る日
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var DOW = ['日', '月', '火', '水', '木', '金', '土'];
    var data = null, ownerId = null, editing = null, remF = null;
    var CT = window.CalcTask;
    var K = CT.DAY_KIND, H = CT.HOLIDAY;
    var REPEAT_LABEL = { '毎日': '毎日', '曜日': '毎週（曜日を選ぶ）', '毎月': '毎月', '毎年': '毎年' };
    var KIND_LABEL = {};
    KIND_LABEL[K.DAY] = '◯日'; KIND_LABEL[K.LAST] = '月末'; KIND_LABEL[K.NTH_WEEKDAY] = '第◯ ◯曜日'; KIND_LABEL[K.WEEK_FIRST_BIZ] = '第◯週の最初の営業日'; KIND_LABEL[K.NTH_BIZ] = '◯番目の営業日';
    var HOLIDAY_LABEL = {};
    HOLIDAY_LABEL[H.PREV] = '前の営業日に入れる'; HOLIDAY_LABEL[H.NEXT] = '次の営業日に入れる'; HOLIDAY_LABEL[H.SKIP] = '入れない（飛ばす）'; HOLIDAY_LABEL[H.KEEP] = 'そのまま入れる';
    var save_ = MP.api.saver(); // 結果が分からない後の同じ中身の送り直しは同じ requestId（二重に作らない。Codex 実装1回目 medium）

    function load(first) {
      var args = ownerId ? { ownerId: ownerId } : {};
      var p = first ? MP.guard.enter({ load: { action: 'task.recurring.list', args: args } })
        : MP.api.call('task.recurring.list', args).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        data = r.res.data;
        ownerId = data.ownerId;
        ui.$('view').hidden = false;
        render();
      });
    }

    function long(repeat) { return repeat === '毎月' || repeat === '毎年'; }
    function bizKind(kind) { return kind === K.WEEK_FIRST_BIZ || kind === K.NTH_BIZ; }

    /** 日の決め方の言い方（15日・月末・第2 火曜日・最後の 金曜日・第2週の最初の営業日・3番目の営業日・最後の営業日） */
    function dayText(it) {
      var k = it.dayKind || K.DAY;
      if (k === K.LAST) return '月末';
      if (k === K.NTH_WEEKDAY) return (it.nth === data.rules.nthLastWeekday ? '最後の ' : '第' + it.nth + ' ') + DOW[it.weekday] + '曜日';
      if (k === K.WEEK_FIRST_BIZ) return '第' + it.nth + '週の最初の営業日';
      if (k === K.NTH_BIZ) return it.nth === data.rules.nthLastBiz ? '最後の営業日' : it.nth + '番目の営業日';
      return it.day + '日';
    }

    function ruleText(it) {
      var t = it.repeat === '毎日' ? '毎日' : it.repeat === '曜日' ? '毎週 ' + it.weekdays.map(function (w) { return DOW[w]; }).join('・')
        : it.repeat === '毎年' ? '毎年 ' + it.month + '月 ' + dayText(it) : '毎月 ' + dayText(it);
      var hol = long(it.repeat) && bizKind(it.dayKind) ? '' : it.holiday === H.PREV ? '（休みなら前の営業日）' : it.holiday === H.NEXT ? '（休みなら次の営業日）' : it.holiday === H.SKIP ? '（会社の休みの日は除く）' : '';
      var rem = it.remindTime ? '・⏰' + MP.taskView.remindClock(it.remindTime) + (it.remindEarly ? '（' + MP.taskView.earlyText(it.remindEarly) + '前にも）' : '') : '';
      return t + hol + rem + '・' + it.start + '〜' + (it.end || '') + (it.active ? '' : '・止めています');
    }

    function nextText(it) {
      if (!it.active) return '';
      return it.next ? '次に入る日: ' + it.next + '（' + DOW[CT.dowOf(it.next)] + '）' : '次に入る日: 1 年先までにありません';
    }

    function render() {
      var box = ui.$('owner-box');
      box.hidden = !data.people;
      if (data.people) {
        var sel = ui.clear(ui.$('owner'));
        data.people.forEach(function (p) { sel.appendChild(ui.el('option', { value: p.employeeId, text: p.name, selected: p.employeeId === ownerId })); });
      }
      var ul = ui.clear(ui.$('list'));
      data.items.forEach(function (it) {
        ul.appendChild(ui.el('li', { class: 'task-item' + (it.active ? '' : ' tk-cancel') }, [
          ui.el('div', { class: 'item-title', text: (it.urgency !== '通常' ? it.urgency + '・' : '') + it.content + (it.hidden ? ' 🔒' : '') }),
          ui.el('div', { class: 'sub', text: ruleText(it) }),
          it.active ? ui.el('div', { class: 'sub recur-next', text: nextText(it) }) : null,
          MP.guard.viewing() ? null : ui.el('div', { class: 'item-actions' }, [ui.el('button', { type: 'button', class: 'btn', text: '直す', on: { click: function () { openForm(it); } } })]),
        ]));
      });
      ui.$('empty').hidden = data.items.length > 0;
      ui.$('new').hidden = MP.guard.viewing();
    }

    function openForm(it) {
      editing = it || null;
      var R = data.rules;
      var urg = ui.clear(ui.$('f-urgency'));
      R.urgency.forEach(function (u) { urg.appendChild(ui.el('option', { value: u, text: u, selected: (it ? it.urgency : '通常') === u })); });
      var rep = ui.clear(ui.$('f-repeat'));
      R.repeat.forEach(function (x) { rep.appendChild(ui.el('option', { value: x, text: REPEAT_LABEL[x] || x, selected: (it ? it.repeat : '毎日') === x })); });
      var mon = ui.clear(ui.$('f-month'));
      for (var mi = 1; mi <= 12; mi++) mon.appendChild(ui.el('option', { value: String(mi), text: mi + ' 月', selected: (it && it.month ? it.month : Number(data.today.slice(5, 7))) === mi }));
      var kind = ui.clear(ui.$('f-kind'));
      R.dayKinds.forEach(function (x) { kind.appendChild(ui.el('option', { value: x, text: KIND_LABEL[x] || x, selected: (it && it.dayKind ? it.dayKind : K.DAY) === x })); });
      var wsel = ui.clear(ui.$('f-wd'));
      [1, 2, 3, 4, 5, 6, 0].forEach(function (w) { wsel.appendChild(ui.el('option', { value: String(w), text: DOW[w] + '曜日', selected: (it && typeof it.weekday === 'number' ? it.weekday : 1) === w })); });
      var hol = ui.clear(ui.$('f-holiday'));
      R.holidays.forEach(function (x) { hol.appendChild(ui.el('option', { value: x, text: HOLIDAY_LABEL[x] || x, selected: (it ? it.holiday : H.PREV) === x })); });
      remF = MP.taskDialogs.remindFields(ui, 'f', it ? it.remindTime : '', it ? it.remindEarly : null, R.remindEarly);
      ui.clear(ui.$('f-remind')).appendChild(remF.box);
      fillNth(it && typeof it.nth === 'number' ? it.nth : null);
      var wd = ui.clear(ui.$('f-weekdays'));
      [1, 2, 3, 4, 5, 6, 0].forEach(function (w) {
        wd.appendChild(ui.el('label', { class: 'check' }, [ui.el('input', { type: 'checkbox', class: 'wd', value: String(w), checked: it ? it.weekdays.indexOf(w) >= 0 : false }), DOW[w]]));
      });
      ui.$('f-content').value = it ? it.content : '';
      ui.$('f-day').value = it && it.day ? String(it.day) : '';
      ui.$('f-hidden').checked = it ? it.hidden : false;
      ui.$('f-start').value = it ? it.start : data.today;
      ui.$('f-end').value = it ? it.end : '';
      ui.$('f-active').checked = it ? it.active : true;
      ui.$('form-title').textContent = it ? '定型タスクを直す' : '定型タスクを足す';
      showRepeat();
      ui.$('form').hidden = false;
      ui.$('form').scrollIntoView({ block: 'start' });
    }

    /** 「何番目」の選択肢を、日の決め方に合わせて入れ直す（keep: 選んでおく値。無ければ 1 か、今の値が選べればそのまま） */
    function fillNth(keep) {
      var R = data.rules, kind = ui.$('f-kind').value;
      var sel = ui.$('f-nth');
      var cur = keep === null || keep === undefined ? Number(sel.value) || 1 : keep;
      ui.clear(sel);
      var opts = [];
      var range = kind === K.NTH_WEEKDAY ? R.nthRange.WEEKDAY : kind === K.WEEK_FIRST_BIZ ? R.nthRange.WEEK : R.nthRange.BIZ;
      for (var n = range[0]; n <= range[1]; n++) opts.push({ value: n, text: kind === K.NTH_WEEKDAY ? '第' + n : kind === K.WEEK_FIRST_BIZ ? '第' + n + '週' : n + '番目' });
      if (kind === K.NTH_WEEKDAY) opts.push({ value: R.nthLastWeekday, text: '最後' });
      if (kind === K.NTH_BIZ) opts.push({ value: R.nthLastBiz, text: '最後' });
      if (!opts.some(function (x) { return x.value === cur; })) cur = opts[0].value;
      opts.forEach(function (x) { sel.appendChild(ui.el('option', { value: String(x.value), text: x.text, selected: x.value === cur })); });
      ui.$('f-nth-label').textContent = kind === K.NTH_WEEKDAY ? '第何' : kind === K.WEEK_FIRST_BIZ ? '第何週（週は日曜から。カレンダーの上から何段目か）' : '何番目の営業日';
    }

    function showRepeat() {
      var r = ui.$('f-repeat').value, kind = ui.$('f-kind').value;
      var lg = long(r);
      ui.$('f-weekdays-box').hidden = r !== '曜日';
      ui.$('f-month-box').hidden = r !== '毎年';
      ui.$('f-kind-box').hidden = !lg;
      ui.$('f-day-box').hidden = !lg || kind !== K.DAY;
      ui.$('f-nth-box').hidden = !lg || kind === K.DAY || kind === K.LAST;
      ui.$('f-wd-box').hidden = !lg || kind !== K.NTH_WEEKDAY;
      ui.$('f-holiday-box').hidden = lg && bizKind(kind);
      var hint = '';
      if (lg && bizKind(kind)) hint = '営業日は、担当の会社カレンダーで決まります（休みの日には入りません）。';
      else if (r === '毎年' && kind === K.DAY) hint = '2 月 29 日は、うるう年だけ入ります。毎年入れたいときは「月末」を選んでください。';
      else if (lg && kind === K.NTH_WEEKDAY) hint = '第 5 は、その月に無ければ入りません。';
      ui.$('f-kind-hint').textContent = hint;
      ui.$('f-kind-hint').hidden = hint === '';
    }

    function save() {
      var repeat = ui.$('f-repeat').value;
      var lg = long(repeat), kind = lg ? ui.$('f-kind').value : K.DAY;
      var holiday = lg && bizKind(kind) ? H.KEEP : ui.$('f-holiday').value;
      var rm = remF.read();
      if (typeof rm === 'string') { ui.pageMessage(rm, 'error'); return; }
      var args = {
        baseVersion: editing ? editing.recordVersion : 0, ownerId: ownerId, content: ui.$('f-content').value, urgency: ui.$('f-urgency').value, hidden: ui.$('f-hidden').checked,
        repeat: repeat, weekdays: repeat === '曜日' ? Array.prototype.map.call(document.querySelectorAll('input.wd:checked'), function (c) { return Number(c.value); }) : [],
        day: lg && kind === K.DAY ? Number(ui.$('f-day').value) || 0 : null, businessOnly: holiday === H.SKIP,
        month: repeat === '毎年' ? Number(ui.$('f-month').value) : null, dayKind: lg ? kind : null,
        nth: lg && kind !== K.DAY && kind !== K.LAST ? Number(ui.$('f-nth').value) : null, weekday: lg && kind === K.NTH_WEEKDAY ? Number(ui.$('f-wd').value) : null,
        holiday: holiday, remindTime: rm.remindTime, remindEarly: rm.remindEarly,
        start: ui.$('f-start').value, end: ui.$('f-end').value, active: ui.$('f-active').checked,
      };
      if (editing) args.recurringId = editing.recurringId;
      return ui.run(function () {
        return save_('task.recurring.save', args).then(function (res) {
          if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
          ui.$('form').hidden = true;
          ui.pageMessage('保存しました。その日にタスクリストを開くと入ります', 'ok');
          return load(false);
        });
      });
    }

    ui.$('new').addEventListener('click', function () { openForm(null); });
    ui.$('f-repeat').addEventListener('change', showRepeat);
    ui.$('f-kind').addEventListener('change', function () { fillNth(null); showRepeat(); });
    ui.$('f-save').addEventListener('click', save);
    ui.$('f-cancel').addEventListener('click', function () { ui.$('form').hidden = true; });
    ui.$('owner').addEventListener('change', function (ev) { ownerId = ev.target.value; ui.$('form').hidden = true; ui.run(function () { return load(false); }); });
    return load(true);
  });
})();
