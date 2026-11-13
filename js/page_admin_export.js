/*
 * 出勤簿の Excel（管理者だけ）。手順10。計画 docs/plans/stage1-step10-plan.md 2-4
 *
 * 締めの期間を選び、出す人を選んで「Excel を作る」。ファイルはブラウザの中で作る（サーバーには送らない）。
 * 競合: 読み込みの番号（loadSeq）と作成の番号（makeSeq）で、古い答え・古い期間のファイルを捨てる
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var data = null;        // 今の期間の答え（読み込みが成功したときだけ入る）
    var loadSeq = 0, makeSeq = 0;
    var loading = false, making = false;
    var entered = false;    // 入口の確認（MP.guard.enter）が済んだか
    var checked = {};       // 社員ID → 選んでいるか（期間を変えても覚えておく）

    function controls() {
      return [ui.$('prev'), ui.$('next'), ui.$('all-on'), ui.$('all-off'), ui.$('make'), ui.$('retry')]
        .concat(Array.prototype.slice.call(document.querySelectorAll('#people input')));
    }

    /** ボタンの押せる・押せないを今の状態から決め直す */
    function refresh() {
      var busy = loading || making;
      controls().forEach(function (c) { c.disabled = busy; });
      if (!busy) {
        ui.$('prev').disabled = !data;
        ui.$('next').disabled = !data || !data.nextDate;
        ui.$('all-on').disabled = ui.$('all-off').disabled = !data || data.people.length === 0;
        ui.$('make').disabled = !data || selected().length === 0;
      }
      ui.$('make').textContent = making ? '作っています…' : 'Excel を作る';
    }

    function selected() {
      return data ? data.people.filter(function (p) { return checked[p.employeeId] !== false; }) : [];
    }

    function load(date, first) {
      var seq = ++loadSeq;
      data = null; // 読み込みを始めたら、前の期間のデータでは作れない
      loading = true;
      ui.$('retry').hidden = true;
      ui.$('made').hidden = true;
      // 前の期間の一覧・注意を消す（読み込み中に前の期間のものが残らないように。内部レビュー low）
      ui.clear(ui.$('people'));
      ui.$('period-label').textContent = '読み込んでいます…';
      ['not-closed', 'skipped', 'empty'].forEach(function (id) { ui.$(id).hidden = true; });
      refresh();
      // 入口の確認（管理者か・上の帯）がまだ済んでいなければ、入口の処理を通す。通信の失敗・混み合いは「もう一度読み込む」を出す
      var viaGuard = first || !entered;
      var p = viaGuard ? MP.guard.enter({ admin: true, retryable: true, load: { action: 'report.admin.export', args: { date: date } } })
        : MP.api.call('report.admin.export', { date: date }).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (seq !== loadSeq) return; // 古い答え
        loading = false;
        if (!r || !r.res) { refresh(); return; }
        if (viaGuard && r.me) entered = true;
        ui.$('view').hidden = false;
        if (!r.res.ok) {
          ui.pageMessage(r.res.message, 'error');
          ui.$('retry').hidden = false;
          ui.$('retry').onclick = function () { ui.pageMessage(''); load(date); };
          refresh();
          return;
        }
        ui.pageMessage('');
        data = r.res.data;
        render();
        refresh();
      }, function (e) {
        if (seq !== loadSeq) return;
        loading = false;
        ui.pageMessage('読み込めませんでした。もう一度お試しください', 'error');
        ui.$('retry').hidden = false;
        ui.$('retry').onclick = function () { ui.pageMessage(''); load(date); };
        refresh();
        if (first) throw e;
      });
    }

    function render() {
      ui.$('period-label').textContent = data.period.label;
      ui.$('not-closed').hidden = data.closed;
      ui.$('skipped').hidden = !data.skippedDays;
      ui.$('skipped').textContent = data.skippedDays ? '出していない日報が ' + data.skippedDays + ' 日分あります（社員履歴の無い日・退職した人の分）' : '';
      ui.$('empty').hidden = data.people.length > 0;
      var box = ui.clear(ui.$('people'));
      data.people.forEach(function (p) {
        var id = 'p-' + p.employeeId;
        var input = ui.el('input', { type: 'checkbox', id: id, checked: checked[p.employeeId] !== false, on: {
          change: function (ev) { checked[p.employeeId] = ev.target.checked; refresh(); },
        } });
        box.appendChild(ui.el('label', { class: 'check', for: id }, [input, p.name + (p.active ? '' : '（利用停止）') + '・出勤 ' + p.counts.total + '日']));
      });
    }

    function setAll(on) {
      if (!data) return;
      data.people.forEach(function (p) { checked[p.employeeId] = on; });
      render();
      refresh();
    }

    function make() {
      if (!data || loading || making) return;
      var people = selected();
      if (!people.length) return;
      var mySeq = ++makeSeq, atLoad = loadSeq, snap = data;
      making = true;
      ui.$('made').hidden = true;
      refresh();
      var L = MP.exportLayout;
      var finish = function () { making = false; refresh(); };
      Promise.resolve().then(function () {
        var names = L.sheetNames(people.map(function (p) { return p.name; }));
        var sheets = people.map(function (p, i) {
          return L.sheet({ name: p.name, sheetName: names[i], period: snap.period, days: p.days, counts: p.counts, limits: snap.limits });
        });
        return MP.exportBook.toBlob(MP.exportBook.build(window.ExcelJS, sheets));
      }).then(function (blob) {
        finish();
        if (mySeq !== makeSeq || atLoad !== loadSeq) return; // 作っている間に期間が変わった
        var name = L.fileName({ period: snap.period, single: people.length === 1 ? people[0].name : null });
        var url = URL.createObjectURL(blob);
        var a = ui.el('a', { href: url, download: name, hidden: true });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        ui.$('made').textContent = people.length + '人分のファイルを作りました（' + name + '）';
        ui.$('made').hidden = false;
      }).catch(function () { // 作る途中の失敗も、ダウンロードの途中の失敗も拾う（内部レビュー low）
        if (making) finish();
        if (mySeq !== makeSeq) return;
        ui.pageMessage('Excel のファイルを作れませんでした。もう一度お試しください', 'error');
      });
    }

    ui.$('prev').addEventListener('click', function () { if (data) load(data.prevDate); });
    ui.$('next').addEventListener('click', function () { if (data && data.nextDate) load(data.nextDate); });
    ui.$('all-on').addEventListener('click', function () { setAll(true); });
    ui.$('all-off').addEventListener('click', function () { setAll(false); });
    ui.$('make').addEventListener('click', make);

    var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    return load(today, true);
  });
})();
