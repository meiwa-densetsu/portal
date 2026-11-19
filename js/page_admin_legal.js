/*
 * 法律上の時間外の目安（管理者だけ）。手順6。計画 docs/plans/stage1-step6-plan.md 2-10・第4章
 *
 * 1年の期間（5/1〜4/30）の、法律上の時間外の推計と36協定の上限（1か月42時間・1年320時間・1日3時間・法定休日の勤務は月4回）。
 * 言い方の決まり（手順4 第0章）: 推計が上限の内側でも「内側」「守れています」とは言わない。数字だけを出す。
 * 未入力などで未確定なら「少なくとも」。集計がずれているときは「作り直すまで正しくありません」
 * 年の総枠を超えた分（清算）の推計は、多くも少なくも出るので「少なくとも」と言わない（計画 stage3-pay-estimate-plan.md 14-1）
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
      // 協定の無いカレンダーの人（計画 stage2-standard-hours-plan.md 第4章）
      NO_SCHEDULE: 'カレンダーが確定していない日があり、日報の無い日を見つけられません',
      MIXED_WEEK: '変形と、ふつうの決まりが切り替わる週があります',
      VARIANT_UNKNOWN: 'カレンダーの協定の印が読めません。会社カレンダーで選び直してください',
    };
    var MODES = { standard: 'ふつうの決まり（1 日 8 時間・週 40 時間）', mixed: '年度の途中で数え方が変わります' };

    /** 数え方の一言（1 年単位の変形の人は出さない） */
    function modeLine(e) {
      return MODES[e.mode] ? ui.el('p', { class: 'sub', text: '数え方: ' + MODES[e.mode] }) : null;
    }

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
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return false; } // サーバーの断り・通信の失敗は、ほかの画面と同じく返事の文を出す
        data = r.res.data;
        ui.$('view').hidden = false;
        renderList();
        return true;
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

    var OFFICER_MIXED = '社員と役員の履歴があります。この人は一覧の対象です';

    function renderList() {
      ui.$('period-label').textContent = Number(data.period.from.slice(0, 4)) + '年度（' + data.period.from.slice(5).replace('-', '/') + '〜' + data.period.to.slice(5).replace('-', '/') + '）';
      ui.$('next').disabled = !data.nextDate;
      ui.$('list-view').hidden = false;
      ui.$('detail-view').hidden = true;
      var ul = ui.clear(ui.$('list'));
      // 役員（ずっと役員の人）は 36 協定の対象外（サーバーが一覧から外し、人数だけ返す）
      var officers = data.officerCount || 0;
      if (!data.employees.length) {
        ul.appendChild(ui.el('li', { 'data-officers': '', text: officers ? '対象の社員がいません（役員は対象外です ' + officers + ' 人）' : 'この年度に在籍した社員がいません' }));
        return;
      }
      data.employees.forEach(function (e) {
        var nowM = e.nowMonth;
        var lines = [
          ui.el('div', { class: 'item-title', text: e.name + (e.active ? '' : '（利用停止）') }),
          modeLine(e),
          // 上限は社員・月ごと（その時の数え方で決まる。計画 第3・4章）
          nowM ? ui.el('p', {}, ['今月（' + monthLabel(nowM.month) + '）: ' + prefix(e) + hm(nowM.overtime) + '（上限 ' + hm(nowM.monthLimit) + '） ', levelTag(nowM.level)]) : null,
          ui.el('p', {}, ['年度の合計: ' + prefix(e) + hm(e.yearOvertime) + '（上限 ' + hm(e.yearLimit) + '） ', levelTag(e.yearLevel)]),
          e.provisionalReasons.length ? ui.el('p', { class: 'sub', text: e.provisionalReasons.map(function (k) { return REASONS[k] || k; }).join('・') }) : null,
          e.officerMixed ? ui.el('p', { class: 'sub', text: OFFICER_MIXED }) : null,
          ui.el('div', { class: 'item-actions' }, [
            ui.el('button', { type: 'button', class: 'btn', text: '詳しく見る', on: { click: function () { openDetail(e); } } }),
            e.staleMonths.length ? ui.el('button', { type: 'button', class: 'btn primary', text: '集計を作り直す（' + e.staleMonths.length + 'か月）', on: { click: function () { rebuild(e); } } }) : null,
          ]),
        ];
        ul.appendChild(ui.el('li', {}, lines));
      });
      if (officers) ul.appendChild(ui.el('li', { class: 'sub', 'data-officers': '', text: '役員は対象外です（' + officers + ' 人）' }));
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
      if (e.officerMixed) box.appendChild(ui.el('p', { class: 'sub', text: OFFICER_MIXED }));
      if (e.provisionalReasons.length) box.appendChild(ui.el('p', { class: 'msg warn', text: '未確定: ' + e.provisionalReasons.map(function (k) { return REASONS[k] || k; }).join('・') }));
      var ml = modeLine(e);
      if (ml) box.appendChild(ml);
      var kv = ui.el('dl', { class: 'kv' });
      // 年の総枠の残りは、値があるときだけ（ふつうの決まりの人・今日の区間が無い人は出さない。計画 第4章）
      [['年度の時間外', prefix(e) + hm(e.yearOvertime) + '（上限 ' + hm(e.yearLimit) + '）'],
        e.remainingToFrame === null ? null : ['年の総枠まで残り', hm(e.remainingToFrame)], ['実働の合計', hm(e.work)], ['深夜', hm(e.deepNight)], ['法定休日', hm(e.legalHoliday)]]
        .filter(Boolean).forEach(function (x) { kv.appendChild(ui.el('dt', { text: x[0] })); kv.appendChild(ui.el('dd', { text: x[1] })); });
      box.appendChild(kv);
      e.settlements.forEach(function (s) {
        box.appendChild(ui.el('p', { class: 'sub', text: '清算 ' + s.from.slice(5).replace('-', '/') + '〜' + s.to.slice(5).replace('-', '/') + ': ' +
          // 推計（soFar）は、境目の週は多めに、日報の抜けは少なめに出る（計画 stage3-pay-estimate-plan.md 14-1。給与の目安の画面と同じ言い方）
          (s.settlementOT !== null ? hm(s.settlementOT) : '推計 ' + hm(s.soFar) + '（境目の週・日報の抜けがあると、多くも少なくも出ます）') }));
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

    /** 年度を移る。ui.run は終わるとボタンを押せる形に戻すので、「次の年度」は終わった後に決め直す（給与の目安の画面と同じ） */
    function move(date) {
      var before = data;
      var wasDetail = !ui.$('detail-view').hidden; // 社員の詳しい表示を開いていたか（失敗したら、そのまま戻す）
      var p = ui.run(function () { return load(date); });
      // 移れたら前の知らせを消す。返事が断り・通信の失敗なら load が返事の文を出し、表示は移る前のまま。
      // 表示の途中の問題（例外）は飲み込まず、ほかの画面と同じ一言で知らせる。ボタンは ui.run が押せる形に戻す。
      // 表示は移る前のもの（開いていた詳しい表示も）に戻し、前後のボタンも移る前の期間から決める（途中まで描いた表示を残さない）
      if (p) p.then(function (moved) {
        ui.$('next').disabled = !data.nextDate;
        if (moved) ui.pageMessage('');
      }, function () {
        data = before;
        try {
          renderList();
          if (wasDetail) { ui.$('list-view').hidden = true; ui.$('detail-view').hidden = false; } // 詳しい表示の中身は描き直していない
        } catch (e) { /* 戻せなくても、知らせは出す */ }
        ui.$('next').disabled = !data.nextDate;
        ui.pageMessage('読み込めませんでした。もう一度お試しください', 'error');
      });
    }
    ui.$('prev').addEventListener('click', function () { move(data.prevDate); });
    ui.$('next').addEventListener('click', function () { if (data.nextDate) move(data.nextDate); });
    ui.$('back').addEventListener('click', function () { ui.$('detail-view').hidden = true; ui.$('list-view').hidden = false; });

    var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // 開く年度を決めるだけ
    return load(today, true);
  });
})();
