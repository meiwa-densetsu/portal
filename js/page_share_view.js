/*
 * 見せてもらった日報（手順9。計画 docs/plans/stage1-step9-plan.md 2-3・2-4・2-6）
 *
 * 見るだけ（share.view）。見せる人が写すのを許していれば、日にちに印を付けるか「初め〜終わり」を選んで、自分の日報へ写す（share.copy）。
 * 写すのは時刻・作業場所・施工内容（備考は写さない）。自分の日報に入力がある日は写さない（サーバーが決める）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, el = ui.el, CW = window.CalcWorktime;
    var DOW = ['日', '月', '火', '水', '木', '金', '土'];
    var q = new URLSearchParams(window.location.search);
    var args = { codeRef: q.get('code') || '', from: q.get('from') || '', to: q.get('to') || '' };
    var data = null;
    var copySave = MP.api.saver();
    var dayIds = {}; // 日付 → requestId（結果が分からないときの押し直しで同じものを使う）

    function fmt(min) { return min === null || min === undefined ? '—' : CW.formatHm(min); }
    function dateLabel(d) { return Number(d.date.slice(5, 7)) + '月' + Number(d.date.slice(8, 10)) + '日（' + DOW[d.dow] + '）'; }
    function copyable(d) { return d.state === 'work'; }

    function load(first) {
      var p = first ? MP.guard.enter({ load: { action: 'share.view', args: args } })
        : MP.api.call('share.view', args).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); ui.$('view').hidden = true; return; }
        data = r.res.data;
        ui.$('view').hidden = false;
        render();
      });
    }

    function timesOf(row, slot) {
      var a = row[slot + '_出社'], b = row[slot + '_退社'];
      return a ? (slot === '昼' ? '' : '夜 ') + a + '〜' + b + (row[slot + '_作業場所'] ? '・' + row[slot + '_作業場所'] : '') : '';
    }

    function render() {
      ui.$('title').textContent = data.ownerName + 'さんの日報（見るだけ）';
      ui.$('range').textContent = ui.fmtDate(data.from) + '〜' + ui.fmtDate(data.to) + '・' + ui.fmtDateTime(data.expiresAt) + ' まで見られます';
      ui.$('copy-bar').hidden = !data.allowCopy;
      var ul = ui.clear(ui.$('days'));
      var fromSel = ui.clear(ui.$('copy-from')), toSel = ui.clear(ui.$('copy-to'));
      data.days.forEach(function (d) {
        fromSel.appendChild(el('option', { value: d.date, text: dateLabel(d) }));
        toSel.appendChild(el('option', { value: d.date, text: dateLabel(d) }));
        var lines = [];
        if (d.row) {
          [timesOf(d.row, '昼'), timesOf(d.row, '夜')].forEach(function (t) { if (t) lines.push(t); });
          // 施工内容は勤務ごと（手順10b）
          if (d.row['昼_施工内容']) lines.push('施工内容（昼）: ' + d.row['昼_施工内容']);
          if (d.row['夜_施工内容']) lines.push('施工内容（夜）: ' + d.row['夜_施工内容']);
          if (d.row['備考']) lines.push('備考: ' + d.row['備考']);
        }
        var head = [el('span', { class: 'day-date', text: dateLabel(d) }), el('span', { class: 'day-state', text: d.state === 'work' ? '実働 ' + fmt(d.row['実働']) : d.state === 'workless' ? '勤務なし' : '未入力' })];
        var box = data.allowCopy && copyable(d)
          ? el('label', { class: 'check' }, [el('input', { type: 'checkbox', class: 'pick', value: d.date })].concat(head))
          : el('div', { class: 'item-title' }, head);
        ul.appendChild(el('li', {}, [box].concat(lines.map(function (t) { return el('div', { class: 'sub', text: t }); }))));
      });
      if (data.days.length) toSel.value = data.days[data.days.length - 1].date;
    }

    function picked() {
      return Array.prototype.filter.call(document.querySelectorAll('input.pick'), function (c) { return c.checked; }).map(function (c) { return c.value; });
    }

    function pickRange() {
      var a = ui.$('copy-from').value, b = ui.$('copy-to').value;
      if (a > b) { var t = a; a = b; b = t; }
      Array.prototype.forEach.call(document.querySelectorAll('input.pick'), function (c) { c.checked = c.value >= a && c.value <= b; });
    }

    function copy() {
      var dates = picked();
      if (!dates.length) { ui.pageMessage('写す日に印を付けてください（勤務のある日だけ選べます）', 'warn'); return; }
      var text = data.ownerName + 'さんの ' + dates.length + ' 日分を自分の日報に写します。写すのは時刻・作業場所・施工内容です（備考は写しません）。自分の日報に入力がある日は写しません。';
      ui.confirm('自分の日報に写す', text, '写す', 'primary').then(function (ok) {
        if (!ok) return;
        var byDate = {};
        data.days.forEach(function (d) { byDate[d.date] = d; });
        var days = dates.map(function (date) {
          if (!dayIds[date]) dayIds[date] = MP.api.newRequestId();
          return { date: date, requestId: dayIds[date], baseVersion: 0, sourceVersion: byDate[date].recordVersion };
        });
        ui.run(function () {
          return copySave('share.copy', { codeRef: data.codeRef, days: days }).then(function (res) {
            if (!res.ok) {
              if (res.code !== 'NETWORK' && res.code !== 'BUSY' && res.code !== 'INTERNAL') dayIds = {};
              ui.pageMessage(res.message, 'error');
              return;
            }
            dayIds = {};
            renderResults(res.data.results);
          });
        });
      });
    }

    function renderResults(results) {
      var ul = ui.clear(ui.$('results'));
      ui.$('results-box').hidden = false;
      results.forEach(function (x) {
        var text = x.status === 'saved' ? '写しました' : x.status === 'unchanged' ? '写してあります' :
          x.code === 'SKIP_HAS_INPUT' ? '入力があるので写しませんでした' : x.code === 'SKIP_EMPTY' ? '勤務がないので写しませんでした' :
          x.code === 'SKIP_INVALID' ? '今の決まりに合わない（施工内容が長いなど）ので写しませんでした' :
          x.code === 'SOURCE_CHANGED' ? '見せる人が直したので写しませんでした（開き直してください）' : '写せませんでした（' + x.message + '）';
        ul.appendChild(el('li', {}, [el('span', { text: ui.fmtDate(x.date) + ': ' + text }), x.status === 'error' ? el('span', { class: 'tag warn', text: '未' }) : null]));
      });
      ui.pageMessage('写した日は、自分の日報の画面で確かめて、必要なら直してください', 'ok');
    }

    ui.$('pick-range').addEventListener('click', pickRange);
    ui.$('copy').addEventListener('click', copy);
    ui.$('reload').addEventListener('click', function () { ui.run(function () { return load(false); }); });
    return load(true);
  });
})();
