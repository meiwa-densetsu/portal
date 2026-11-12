/*
 * 日報の締め（管理者だけ）。手順8。計画 docs/plans/stage1-step8-plan.md 2-5
 *
 * 1年（5/1〜4/30）の締めの期間を並べ、期間ごとに「締める」「解除する」。締める前に、未入力の出勤日のある社員を出す（report.admin.closingCheck）。
 * 締めは期間ごとに全員まとめて、解除はいつでも（2026-11-13 ユーザー決定）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var data = null;
    var save = MP.api.saver();

    function load(date, first) {
      var args = { date: date };
      var p = first ? MP.guard.enter({ admin: true, load: { action: 'report.admin.closingList', args: args } })
        : MP.api.call('report.admin.closingList', args).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        data = r.res.data;
        ui.$('view').hidden = false;
        render();
      });
    }

    function stateText(p) {
      if (p.state === '締め') return '締めました（' + p.closedAt + '・' + p.closedBy + '・版 ' + p.recordVersion + '）';
      if (p.state === '解除') return '解除しました（' + p.reopenedAt + '・' + p.reopenedBy + '・版 ' + p.recordVersion + '）';
      return p.closable ? 'まだ締めていません' : '期間の途中・これから（締められるのは ' + nextDay(p.to) + ' から）';
    }

    function nextDay(d) {
      var t = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)) + 1));
      return (t.getUTCMonth() + 1) + '月' + t.getUTCDate() + '日';
    }

    function render() {
      ui.$('year-label').textContent = Number(data.year.from.slice(0, 4)) + '年度（' + data.year.from + '〜' + data.year.to + '）';
      var ul = ui.clear(ui.$('list'));
      data.periods.forEach(function (p) {
        var closed = p.state === '締め';
        var actions = [];
        if (closed) actions.push(ui.el('button', { type: 'button', class: 'btn', text: '解除する', on: { click: function () { reopen(p); } } }));
        else if (p.closable) actions.push(ui.el('button', { type: 'button', class: 'btn primary', text: '締める', on: { click: function () { close(p); } } }));
        ul.appendChild(ui.el('li', {}, [
          ui.el('div', { class: 'item-title', text: p.label }),
          ui.el('div', {}, [ui.el('span', { class: 'tag' + (closed ? ' ok' : ''), text: closed ? '締め' : p.state === '解除' ? '解除' : '未' }), ' ', stateText(p)]),
          actions.length ? ui.el('div', { class: 'item-actions' }, actions) : null,
        ]));
      });
    }

    function close(p) {
      ui.run(function () {
        return MP.api.call('report.admin.closingCheck', { periodId: p.periodId }).then(function (res) {
          if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
          var people = res.data.people;
          var text = people.length
            ? '次の人に未入力の出勤日があります。締めると、社員は直せなくなります（管理者は直せます）。\n' + people.map(function (x) {
              return '・' + x.name + ' ' + x.missing + '日' + (x.unknownDays ? '（所定が分からない日 ' + x.unknownDays + '日）' : '');
            }).join('\n')
            : '未入力の出勤日はありません。締めると、社員は直せなくなります（管理者は直せます）。';
          return ui.confirm(p.label + 'を締める', text, '締める', 'primary').then(function (ok) {
            if (!ok) return;
            return send('report.admin.close', p, p.label + 'を締めました');
          });
        });
      });
    }

    function reopen(p) {
      ui.confirm(p.label + 'の締めを解除する', '解除すると、社員がまた自分の日報を直せるようになります。', '解除する', 'danger').then(function (ok) {
        if (!ok) return;
        ui.run(function () { return send('report.admin.reopen', p, p.label + 'の締めを解除しました'); });
      });
    }

    function send(action, p, done) {
      // 結果が分からない（通信の失敗など）ときに押し直すと、同じ requestId で送り直す（二重にしない。MP.api.saver）
      return save(action, { periodId: p.periodId, baseVersion: p.recordVersion }).then(function (res) {
        if (!res.ok) {
          ui.pageMessage(res.code === 'CONFLICT' ? '他の画面で締めが変わっています。読み込み直しました' : res.message, 'error');
          return load(data.periods[0].to);
        }
        return load(data.periods[0].to).then(function () { ui.pageMessage(done, 'ok'); });
      });
    }

    ui.$('prev').addEventListener('click', function () { ui.run(function () { return load(data.prevDate); }); });
    ui.$('next').addEventListener('click', function () { ui.run(function () { return load(data.nextDate); }); });

    var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // 開く年度を決めるだけ
    return load(today, true);
  });
})();
