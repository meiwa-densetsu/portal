/*
 * 法律上の時間外の目安（管理者だけ）。手順6。計画 docs/plans/stage1-step6-plan.md 2-10・第4章
 *
 * 1年の期間（5/1〜4/30）の、法律上の時間外の推計と36協定の上限（1か月42時間・1年320時間・1日3時間・法定休日の勤務は月4回）。
 * 言い方の決まり（手順4 第0章）: 推計が上限の内側でも「内側」「守れています」とは言わない。数字だけを出す。
 * 未入力などで未確定なら「少なくとも」。集計がずれているときは「作り直すまで正しくありません」
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var CW = window.CalcWorktime;
    var data = null;
    var REASONS = {
      MISSING: '未入力の日があります', NOT_YET: '年度の途中です', BOUNDARY_WEEK: '境目の週の数え方を確認中です',
      SCHEDULE_UNKNOWN: 'カレンダーが未設定・下書きの期間があります', SUMMARY_STALE: '集計がずれています（作り直してください）',
    };

    function hm(min) { return min === null || min === undefined ? '—' : CW.formatHm(min); }
    function monthLabel(ym) { return Number(ym.slice(0, 4)) + '年' + Number(ym.slice(5, 7)) + '月'; }

    /** 数字の前に付ける言葉（集計がずれている → 作り直すまで正しくない、未確定 → 少なくとも） */
    function prefix(e) {
      if (e.provisionalReasons.indexOf('SUMMARY_STALE') >= 0) return '（集計を作り直すまで正しくありません）推計 ';
      return e.provisionalReasons.length ? '推計で少なくとも ' : '推計では ';
    }

    function levelTag(level) {
      if (level === 'over') return ui.el('span', { class: 'tag off', text: '上限を超えています' });
      if (level === 'near') return ui.el('span', { class: 'tag warn', text: '上限に近づいています' });
      return null;
    }

    function load(date, first) {
      var args = { date: date, employeeId: null };
      var p = first ? MP.guard.enter({ admin: true, load: { action: 'report.admin.legal', args: args } })
        : MP.api.call('report.admin.legal', args).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        data = r.res.data;
        ui.$('view').hidden = false;
        renderList();
      });
    }

    function rebuild(e) {
      var months = e.staleMonths.map(function (s) { return s.month; });
      return ui.run(function () {
        var n = 0;
        var step = function (i) {
          if (i >= months.length) return Promise.resolve();
          ui.pageMessage('集計を作り直しています… ' + (i + 1) + '/' + months.length + ' か月', 'info');
          return MP.api.call('report.admin.rebuildMonth', { employeeId: e.employeeId, month: months[i] }, { requestId: MP.api.newRequestId() }).then(function (res) {
            if (res.ok) n++;
            return step(i + 1);
          });
        };
        return step(0).then(function () {
          return load(data.period.from).then(function () {
            ui.pageMessage(e.name + 'さんの集計を ' + n + ' か月作り直しました' + (n < months.length ? '（' + (months.length - n) + ' か月はできませんでした）' : ''), n < months.length ? 'warn' : 'ok');
          });
        });
      });
    }

    function renderList() {
      ui.$('period-label').textContent = Number(data.period.from.slice(0, 4)) + '年度（' + data.period.from.slice(5).replace('-', '/') + '〜' + data.period.to.slice(5).replace('-', '/') + '）';
      ui.$('next').disabled = !data.nextDate;
      ui.$('list-view').hidden = false;
      ui.$('detail-view').hidden = true;
      var ul = ui.clear(ui.$('list'));
      if (!data.employees.length) { ul.appendChild(ui.el('li', { text: 'この年度に在籍した社員がいません' })); return; }
      data.employees.forEach(function (e) {
        var nowM = e.nowMonth;
        var lines = [
          ui.el('div', { class: 'item-title', text: e.name + (e.active ? '' : '（利用停止）') }),
          nowM ? ui.el('p', {}, ['今月（' + monthLabel(nowM.month) + '）: ' + prefix(e) + hm(nowM.overtime) + '（上限 ' + hm(data.limits.MONTH_MIN) + '） ', levelTag(nowM.level)]) : null,
          ui.el('p', {}, ['年度の合計: ' + prefix(e) + hm(e.yearOvertime) + '（上限 ' + hm(data.limits.YEAR_MIN) + '） ', levelTag(e.yearLevel)]),
          e.provisionalReasons.length ? ui.el('p', { class: 'sub', text: e.provisionalReasons.map(function (k) { return REASONS[k] || k; }).join('・') }) : null,
          ui.el('div', { class: 'item-actions' }, [
            ui.el('button', { type: 'button', class: 'btn', text: '詳しく見る', on: { click: function () { openDetail(e); } } }),
            e.staleMonths.length ? ui.el('button', { type: 'button', class: 'btn primary', text: '集計を作り直す（' + e.staleMonths.length + 'か月）', on: { click: function () { rebuild(e); } } }) : null,
          ]),
        ];
        ul.appendChild(ui.el('li', {}, lines));
      });
    }

    function openDetail(e) {
      ui.run(function () {
        return MP.api.call('report.admin.legal', { date: data.period.from, employeeId: e.employeeId }).then(function (res) {
          if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
          renderDetail(res.data.employees[0]);
        });
      });
    }

    function renderDetail(e) {
      ui.$('list-view').hidden = true;
      ui.$('detail-view').hidden = false;
      ui.$('detail-title').textContent = e.name + 'さん';
      var box = ui.clear(ui.$('detail'));
      if (e.provisionalReasons.length) box.appendChild(ui.el('p', { class: 'msg warn', text: '未確定: ' + e.provisionalReasons.map(function (k) { return REASONS[k] || k; }).join('・') }));
      var kv = ui.el('dl', { class: 'kv' });
      [['年度の時間外', prefix(e) + hm(e.yearOvertime) + '（上限 ' + hm(e.yearLimit) + '）'],
        ['年の総枠まで残り', hm(e.remainingToFrame)], ['実働の合計', hm(e.work)], ['深夜', hm(e.deepNight)], ['法定休日', hm(e.legalHoliday)]]
        .forEach(function (x) { kv.appendChild(ui.el('dt', { text: x[0] })); kv.appendChild(ui.el('dd', { text: x[1] })); });
      box.appendChild(kv);
      e.settlements.forEach(function (s) {
        box.appendChild(ui.el('p', { class: 'sub', text: '清算 ' + s.from.slice(5).replace('-', '/') + '〜' + s.to.slice(5).replace('-', '/') + ': ' +
          (s.settlementOT !== null ? hm(s.settlementOT) : '少なくとも ' + hm(s.soFar)) }));
      });
      box.appendChild(ui.el('h3', { text: '月ごと（協定の1か月は暦の月）' }));
      var ul = ui.el('ul', { class: 'list' });
      e.months.forEach(function (m) {
        ul.appendChild(ui.el('li', {}, [
          ui.el('div', { class: 'item-title', text: monthLabel(m.month) }),
          ui.el('p', {}, ['時間外: ' + prefix(e) + hm(m.overtime) + '（上限 ' + hm(m.monthLimit) + '） ', levelTag(m.level)]),
          ui.el('p', {}, ['法定休日の勤務: ' + m.holidayDays + '回（上限 ' + m.holidayLimit + '回） ', levelTag(m.holidayLevel)]),
        ]));
      });
      box.appendChild(ul);
      box.appendChild(ui.el('h3', { text: '1日の時間外が ' + hm(e.dayLimit) + ' を超えた日' }));
      box.appendChild(e.dayOver.length ? ui.el('ul', {}, e.dayOver.map(function (d) { return ui.el('li', { text: d.date + ': ' + hm(d.minutes) }); }))
        : ui.el('p', { class: 'sub', text: '推計では、ありません' }));
      box.appendChild(ui.el('h3', { text: '時間外が付いた日' }));
      box.appendChild(e.perDay.length ? ui.el('ul', {}, e.perDay.map(function (d) { return ui.el('li', { text: d.date + ': ' + hm(d.minutes) }); }))
        : ui.el('p', { class: 'sub', text: '推計では、ありません' }));
      ui.$('detail-view').scrollIntoView({ block: 'start' });
    }

    ui.$('prev').addEventListener('click', function () { ui.run(function () { return load(data.prevDate); }); });
    ui.$('next').addEventListener('click', function () { if (data.nextDate) ui.run(function () { return load(data.nextDate); }); });
    ui.$('back').addEventListener('click', function () { ui.$('detail-view').hidden = true; ui.$('list-view').hidden = false; });

    var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // 開く年度を決めるだけ
    return load(today, true);
  });
})();
