/*
 * タスクリストの Excel（管理者だけ。計画 docs/plans/stage2-tasklist-plan.md 2-8）。月を選んで、ブラウザの中で .xlsx を作る
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var L = MP.taskExportLayout;
    var data = null, ym = null, seq = 0;

    function load(first) {
      var my = ++seq;
      data = null;
      ui.$('make').disabled = true;
      ui.$('made').hidden = true;
      var p = first ? MP.guard.enter({ admin: true, retryable: true, load: { action: 'task.admin.export', args: { month: ym } } })
        : MP.api.call('task.admin.export', { month: ym }).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (my !== seq || !r || !r.res) return;
        ui.$('view').hidden = false;
        ui.$('month-label').textContent = Number(ym.slice(0, 4)) + '年' + Number(ym.slice(5, 7)) + '月';
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        ui.pageMessage('');
        data = r.res.data;
        ui.$('make').disabled = false;
      });
    }

    function shift(k) {
      var n = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + k;
      ym = Math.floor(n / 12) + '-' + ('0' + (n % 12 + 1)).slice(-2);
      load(false);
    }

    function make() {
      if (!data) return;
      var snap = data, my = seq;
      ui.$('make').disabled = true;
      Promise.resolve().then(function () {
        return L.build(window.ExcelJS, L.sheet(snap)).xlsx.writeBuffer();
      }).then(function (buf) {
        ui.$('make').disabled = false;
        if (my !== seq) return; // 作る途中に月を変えた
        var url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        var a = ui.el('a', { href: url, download: L.fileName(snap.month), hidden: true });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        ui.$('made').textContent = 'ファイルを作りました（' + L.fileName(snap.month) + '）';
        ui.$('made').hidden = false;
      }).catch(function () {
        ui.$('make').disabled = false;
        ui.pageMessage('Excel のファイルを作れませんでした。もう一度お試しください', 'error');
      });
    }

    ui.$('prev').addEventListener('click', function () { shift(-1); });
    ui.$('next').addEventListener('click', function () { shift(1); });
    ui.$('make').addEventListener('click', make);
    ym = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
    return load(true);
  });
})();
