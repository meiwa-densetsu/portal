/*
 * 日報の修正履歴（管理者だけ）。手順8。計画 docs/plans/stage1-step8-plan.md 2-6
 *
 * 社員と締めの期間を選び、いつ・誰が・何を直したかを新しい順に出す。初めは反映済みだけ、「取りやめ・確認中の行も見る」で失敗・確認中も
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var CW = window.CalcWorktime;
    var data = null, rules = null;
    var employeeId = null, periodId = null;

    function periodOf(date) { return CW.payPeriodOf(date, rules); }

    function load(first) {
      var args = { employeeId: employeeId, periodId: periodId, showAll: ui.$('show-all').checked };
      var p = first ? MP.guard.enter({ admin: true, load: { action: 'report.admin.changes', args: args } })
        : MP.api.call('report.admin.changes', args).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        data = r.res.data;
        ui.$('view').hidden = false;
        render();
      });
    }

    function render() {
      var sel = ui.clear(ui.$('emp-select'));
      data.employees.forEach(function (e) { sel.appendChild(ui.el('option', { value: e.employeeId, text: e.name, selected: e.employeeId === employeeId })); });
      ui.$('period-label').textContent = data.period.label + '（' + data.period.from + '〜' + data.period.to + '）';
      ui.$('unreadable').hidden = !data.unreadable;
      ui.$('unreadable').textContent = data.unreadable ? '読めない行が ' + data.unreadable + ' 件あります。管理者に連絡してください' : '';
      ui.$('empty').hidden = data.items.length > 0;
      var ul = ui.clear(ui.$('list'));
      data.items.forEach(function (it) {
        var lines = it.changes === null ? [ui.el('div', { class: 'sub', text: '（読めない値）' })]
          : it.changes.map(function (c) { return ui.el('div', { class: 'sub', text: c.col + ': ' + (c.before === '' ? '（空）' : c.before) + ' → ' + (c.after === '' ? '（空）' : c.after) }); });
        ul.appendChild(ui.el('li', {}, [
          ui.el('div', { class: 'item-title', text: it.date + ' の' + it.item }),
          ui.el('div', {}, [it.state !== '反映済み' ? ui.el('span', { class: 'tag warn', text: it.state }) : null, ' ' + it.at + '・' + it.by]),
        ].concat(lines)));
      });
    }

    function shift(days) {
      var base = days < 0 ? data.period.from : data.period.to;
      var t = new Date(Date.UTC(Number(base.slice(0, 4)), Number(base.slice(5, 7)) - 1, Number(base.slice(8, 10)) + days));
      periodId = periodOf(t.toISOString().slice(0, 10)).id;
      ui.run(function () { return load(); });
    }

    ui.$('prev').addEventListener('click', function () { shift(-1); });
    ui.$('next').addEventListener('click', function () { shift(1); });
    ui.$('emp-select').addEventListener('change', function (ev) { employeeId = ev.target.value; ui.run(function () { return load(); }); });
    ui.$('show-all').addEventListener('change', function () { ui.run(function () { return load(); }); });

    // 初めは自分（管理者）と今の期間。社員は画面で選ぶ。?employee= で開くこともできる
    return MP.guard.enter({ admin: true }).then(function (me) {
      var q = new URLSearchParams(window.location.search);
      var e = q.get('employee');
      employeeId = e && /^E\d{4}$/.test(e) ? e : me.employeeId;
      var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      return MP.api.call('report.period', { employeeId: employeeId, date: today }).then(function (res) {
        if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
        rules = res.data.rules;
        periodId = periodOf(today).id;
        return load();
      });
    });
  });
})();
