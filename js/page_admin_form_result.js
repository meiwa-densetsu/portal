/* 管理者: 受付の集計（form.result・form.admin.confirm。計画 stage4-board-plan.md 第6章・11-4・12-4）
 * 人別の回答・合計・未回答の一覧・対象外になった人の回答。Excel は画面で作る（MP.formExcel）。健康診断は確定日を入れる・外す。
 * 回答を直すときは form.html?id=…&emp=… を開く（締切の後も管理者は直せる。監査ログに残る）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    var save = MP.api.saver();
    var id = new URLSearchParams(window.location.search).get('id');
    if (id && !/^F\d{4}$/.test(id)) id = null;
    var data = null;

    function table(head, rows) {
      return el('table', { class: 'summary-table' }, [
        el('thead', {}, [el('tr', {}, head.map(function (h) { return el('th', { text: h }); }))]),
        el('tbody', {}, rows),
      ]);
    }

    function confirmCell(m) {
      if (!m.answered) return el('td', { text: '' });
      var input = el('input', { type: 'date', value: m.confirmedDate || '', 'aria-label': m.name + 'の確定日' });
      return el('td', {}, [el('div', { class: 'confirm-cell' }, [input, el('button', { type: 'button', class: 'btn', text: m.confirmedDate ? '変える・外す' : '確定する', on: { click: function () {
        ui.run(function () {
          return save('form.admin.confirm', { formId: id, employeeId: m.employeeId, baseVersion: m.recordVersion, date: input.value }).then(function (r) {
            if (!r.ok) { ui.pageMessage(r.message, 'error'); return load(); }
            ui.pageMessage(input.value ? m.name + 'さんの確定日を入れました' : m.name + 'さんの確定日を外しました', 'ok');
            return load();
          });
        });
      } } })])]);
    }

    function render() {
      var f = data.form, kind = f.kind;
      $('admin').hidden = false;
      $('r-title').textContent = '集計: ' + f.title;
      $('r-info').textContent = f.kindLabel + '・締切 ' + f.deadlineLabel + (f.show ? '' : '・ホームには出していません');
      var sheets = MP.formExcel.sheets(data);
      var tb = ui.clear($('r-totals'));
      sheets.slice(1).filter(function (s) { return s.name !== '対象外になった人'; }).forEach(function (s) {
        tb.appendChild(el('div', { class: 'result-scroll' }, [table(s.rows[0], s.rows.slice(1).map(function (r) { return el('tr', {}, r.map(function (c) { return el('td', { text: c }); })); }))]));
      });
      if (kind === 'health') tb.appendChild(el('p', { class: 'sub', text: '確定した人 ' + data.totals.confirmed + ' 人・未回答 ' + data.totals.unanswered + ' 人' }));
      var people = sheets[0];
      var head = people.rows[0].concat(['']);
      var rows = data.members.map(function (m, i) {
        var cells = people.rows[i + 1].map(function (c) { return el('td', { text: c }); });
        if (kind === 'health') cells[cells.length - 1] = confirmCell(m);
        cells.push(el('td', {}, [el('a', { class: 'btn', href: 'form.html?id=' + encodeURIComponent(id) + '&emp=' + encodeURIComponent(m.employeeId), text: '直す' })]));
        return el('tr', { 'data-emp': m.employeeId }, cells);
      });
      ui.clear($('r-members')).appendChild(table(head, rows));
      var un = ui.clear($('r-unanswered'));
      if (!data.unanswered.length) un.appendChild(el('li', { class: 'sub', text: '全員が答えました' }));
      data.unanswered.forEach(function (m) { un.appendChild(el('li', { text: m.name })); });
      var outSheet = sheets.filter(function (s) { return s.name === '対象外になった人'; })[0];
      $('r-outside-box').hidden = !outSheet;
      if (outSheet) ui.clear($('r-outside')).appendChild(table(outSheet.rows[0], outSheet.rows.slice(1).map(function (r) { return el('tr', {}, r.map(function (c) { return el('td', { text: c }); })); })));
    }

    function load() {
      return MP.api.call('form.result', { formId: id }).then(function (r) {
        if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
        data = r.data;
        render();
      });
    }

    $('excel').addEventListener('click', function () {
      if (!data) return;
      var snap = data;
      $('excel').disabled = true;
      Promise.resolve().then(function () { return MP.formExcel.build(window.ExcelJS, snap).xlsx.writeBuffer(); }).then(function (buf) {
        $('excel').disabled = false;
        var url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        var a = el('a', { href: url, download: MP.formExcel.fileName(snap), hidden: true });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        $('made').textContent = 'ファイルを作りました（' + MP.formExcel.fileName(snap) + '）';
        $('made').hidden = false;
      }).catch(function () {
        $('excel').disabled = false;
        ui.pageMessage('Excel のファイルを作れませんでした。もう一度お試しください', 'error');
      });
    });

    if (!id) return MP.guard.enter({ admin: true }).then(function () { ui.pageMessage('受付が見つかりません。受付の管理から開き直してください', 'error'); });
    return MP.guard.enter({ admin: true, load: { action: 'form.result', args: { formId: id } } }).then(function (entered) {
      data = entered.res.data;
      render();
    });
  });
})();
