/*
 * 定型タスク（計画 docs/plans/stage2-tasklist-plan.md 2-6）。自分の分（管理者は人を選べる）の一覧・足す・直す・止める
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var DOW = ['日', '月', '火', '水', '木', '金', '土'];
    var data = null, ownerId = null, editing = null;
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

    function ruleText(it) {
      var t = it.repeat === '毎日' ? '毎日' : it.repeat === '曜日' ? '毎週 ' + it.weekdays.map(function (w) { return DOW[w]; }).join('・') : '毎月 ' + it.day + '日';
      return t + (it.businessOnly ? '（会社の休みの日は除く）' : '') + '・' + it.start + '〜' + (it.end || '') + (it.active ? '' : '・止めています');
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
      R.repeat.forEach(function (x) { rep.appendChild(ui.el('option', { value: x, text: x, selected: (it ? it.repeat : '毎日') === x })); });
      var wd = ui.clear(ui.$('f-weekdays'));
      [1, 2, 3, 4, 5, 6, 0].forEach(function (w) {
        wd.appendChild(ui.el('label', { class: 'check' }, [ui.el('input', { type: 'checkbox', class: 'wd', value: String(w), checked: it ? it.weekdays.indexOf(w) >= 0 : false }), DOW[w]]));
      });
      ui.$('f-content').value = it ? it.content : '';
      ui.$('f-day').value = it && it.day ? String(it.day) : '';
      ui.$('f-business').checked = it ? it.businessOnly : true;
      ui.$('f-hidden').checked = it ? it.hidden : false;
      ui.$('f-start').value = it ? it.start : data.today;
      ui.$('f-end').value = it ? it.end : '';
      ui.$('f-active').checked = it ? it.active : true;
      ui.$('form-title').textContent = it ? '定型タスクを直す' : '定型タスクを足す';
      showRepeat();
      ui.$('form').hidden = false;
      ui.$('form').scrollIntoView({ block: 'start' });
    }

    function showRepeat() {
      var r = ui.$('f-repeat').value;
      ui.$('f-weekdays-box').hidden = r !== '曜日';
      ui.$('f-day-box').hidden = r !== '毎月';
    }

    function save() {
      var repeat = ui.$('f-repeat').value;
      var args = {
        baseVersion: editing ? editing.recordVersion : 0, ownerId: ownerId, content: ui.$('f-content').value, urgency: ui.$('f-urgency').value, hidden: ui.$('f-hidden').checked,
        repeat: repeat, weekdays: repeat === '曜日' ? Array.prototype.map.call(document.querySelectorAll('input.wd:checked'), function (c) { return Number(c.value); }) : [],
        day: repeat === '毎月' ? Number(ui.$('f-day').value) || 0 : null, businessOnly: ui.$('f-business').checked,
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
    ui.$('f-save').addEventListener('click', save);
    ui.$('f-cancel').addEventListener('click', function () { ui.$('form').hidden = true; });
    ui.$('owner').addEventListener('change', function (ev) { ownerId = ev.target.value; ui.$('form').hidden = true; ui.run(function () { return load(false); }); });
    return load(true);
  });
})();
