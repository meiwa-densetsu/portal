/*
 * 依頼したタスク（計画 docs/plans/stage2-tasklist-plan.md 2-7）
 * まだ見ていない完了は、切り替えに関係なく上に出す（サーバーが知らせ済みにする）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var CT = window.CalcTask;
    function md(d) { return d ? Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)) : ''; }

    var now = null; // 締め切りの段階を決める「今」（サーバーの答え）と決まり

    /** 1件。v2: 締め切りの印・完了の一言・相談も出す（計画 stage2-tasklist-v2-plan.md 2-2・2-8） */
    function line(t) {
      var u = CT.urgencyMark(t.urgency);
      var parts = [t.ownerName + 'さん', '依頼した日 ' + md(t.firstDate), '予定日 ' + md(t.date)];
      if (t.deferCount) parts.push('先送り ' + t.deferCount + ' 回');
      if (t.state !== '未完了') parts.push(t.state + (t.doneAt ? '（' + t.doneAt + '）' : ''));
      // 締め切りの印は、タスクリストの行と同じ部品（task_item.js）で作る
      var badge = now ? MP.taskItem.due(t, now) : null;
      var title = [ui.el('span', { text: (u ? u + ' ' : '') + t.content + (t.hidden ? ' 🔒' : '') })];
      if (badge) title.push(badge);
      var kids = [ui.el('div', { class: 'item-title req-title' }, title), ui.el('div', { class: 'sub', text: parts.join('・') })];
      if (t.note) kids.push(ui.el('div', { class: 'req-note', text: '一言: ' + t.note }));
      if (t.consult) kids.push(ui.el('div', { class: 'req-note', text: '相談（' + ui.fmtDateTime(t.consult.at) + '）: ' + t.consult.text }));
      return ui.el('li', { class: 'task-item' + (t.state === '完了' ? ' tk-done' : t.state === '取りやめ' ? ' tk-cancel' : '') }, kids);
    }

    var justDone = []; // この画面を開いている間は、一度出した「完了しました」を残す（切り替えで読み直しても消えない）

    function render(d) {
      ui.$('view').hidden = false;
      now = d.nowDate ? { nowDate: d.nowDate, nowMin: d.nowMin, rules: d.rules || {} } : null;
      d.justDone.forEach(function (t) { if (!justDone.some(function (x) { return x.taskId === t.taskId; })) justDone.push(t); });
      ui.$('just-done-box').hidden = !justDone.length;
      var jd = ui.clear(ui.$('just-done'));
      justDone.forEach(function (t) { jd.appendChild(line(t)); });
      var shown = {};
      justDone.forEach(function (t) { shown[t.taskId] = true; });
      if (d.done) d.done = d.done.filter(function (t) { return !shown[t.taskId]; });
      var op = ui.clear(ui.$('open'));
      d.open.forEach(function (t) { op.appendChild(line(t)); });
      ui.$('open-empty').hidden = d.open.length > 0;
      ui.$('done-box').hidden = !d.done;
      var dn = ui.clear(ui.$('done'));
      (d.done || []).forEach(function (t) { dn.appendChild(line(t)); });
    }

    function load(first) {
      var args = { showDone: ui.$('show-done').checked };
      var p = first ? MP.guard.enter({ load: { action: 'task.requests', args: args } })
        : MP.api.call('task.requests', args).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        render(r.res.data);
      });
    }

    ui.$('show-done').addEventListener('change', function () { ui.run(function () { return load(false); }); });
    return load(true);
  });
})();
