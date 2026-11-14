/*
 * タスクリストの Excel の形（計画 docs/plans/stage2-tasklist-plan.md 2-8）。画面の部品も ExcelJS も使わない純粋な JS（Node のテストでも読み込む）
 *
 *   MP.taskExportLayout.sheet(d) … task.admin.export の答え → { name, columns, cells: [{ r, c, value, font }], merges, printArea, pageSetup }
 *   MP.taskExportLayout.fileName(month)
 * 値は文字だけ（式にしない）。文字の色は状態（完了 赤・先送りの印 緑・取りやめ 灰色に取り消し線）、急ぎは太字
 */
(function (root) {
  'use strict';
  var DOW = ['日', '月', '火', '水', '木', '金', '土'];
  var COLOR = { done: 'FFC00000', mark: 'FF00803C', cancel: 'FF808080', open: 'FF000000' };

  function dayNumber(d) { return Math.round(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86400000); }
  function dateOf(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function md(d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)); }
  function mark(u) { return u === '至急' ? '‼至急 ' : u === '急ぎ' ? '！急ぎ ' : ''; }

  function textOf(e) {
    var it = e.it;
    if (e.kind === 'mark') return '→' + md(it.to) + 'へ先送り ' + it.content;
    // v2: 締め切りは文字で付ける（〆11/14・〆11/14 15:00。完了・取りやめには付けない）
    var due = it.due && it.state === '未完了' ? ' 〆' + md(it.due) + (it.dueTime ? ' ' + Number(it.dueTime.slice(0, 2)) + ':' + it.dueTime.slice(3, 5) : '') : '';
    return mark(it.urgency) + it.content + (it.requester ? '（依頼: ' + it.requesterName + '）' : '') + (it.state === '完了' ? ' ✓' : '') + due;
  }
  /** その日の申し送り（新しい申し送り〔部署の名前つき〕 → 前のメモ）を1つの文字に */
  function memoOf(d, date) {
    var out = (d.handovers || []).filter(function (h) { return h.from <= date && date <= h.to; })
      .map(function (h) { return '【' + (h.deptName || '全員') + '】' + h.content; });
    var memo = d.memos.filter(function (m) { return m.date === date; })[0];
    if (memo && memo.content) out.push(memo.content);
    return out.join('\n');
  }
  function fontOf(e) {
    if (e.kind === 'mark') return { color: COLOR.mark };
    var it = e.it;
    var f = { color: it.state === '完了' ? COLOR.done : it.state === '取りやめ' ? COLOR.cancel : COLOR.open };
    if (it.state === '取りやめ') f.strike = true;
    if (it.urgency !== '通常') f.bold = true;
    return f;
  }

  function sheet(d) {
    var people = d.people;
    var cells = [], merges = [];
    var put = function (r, c, value, font) { cells.push({ r: r, c: c, value: value === null || value === undefined ? '' : String(value), font: font || null }); };
    put(1, 1, Number(d.month.slice(0, 4)) + '年' + Number(d.month.slice(5, 7)) + '月 タスクリスト', { bold: true, size: 14 });
    merges.push([1, 1, 1, people.length + 2]);
    put(2, 1, '日付', { bold: true });
    people.forEach(function (p, i) { put(2, i + 2, p.name, { bold: true }); });
    put(2, people.length + 2, '申し送り', { bold: true });
    var r = 3;
    for (var n = dayNumber(d.from); n <= dayNumber(d.to); n++) {
      var date = dateOf(n);
      var lists = people.map(function (p) {
        var items = d.items.filter(function (i) { return i.owner === p.employeeId && i.date === date; })
          .sort(function (a, b) { return a.order - b.order; }) // order はサーバーが並びの正本（CalcTask.sortDay）で付けた順位
          .map(function (i) { return { kind: 'task', it: i }; });
        d.marks.filter(function (m) { return m.owner === p.employeeId && m.date === date; }).forEach(function (m) { items.push({ kind: 'mark', it: m }); });
        return items;
      });
      var height = Math.max(1, lists.reduce(function (m, l) { return Math.max(m, l.length); }, 0));
      var w = new Date(n * 86400000).getUTCDay();
      put(r, 1, md(date) + '（' + DOW[w] + '）', { bold: true, color: w === 0 ? 'FFC00000' : w === 6 ? 'FF1F4E79' : 'FF000000' });
      if (height > 1) merges.push([r, 1, r + height - 1, 1]);
      lists.forEach(function (l, i) { l.forEach(function (e, k) { put(r + k, i + 2, textOf(e), fontOf(e)); }); });
      put(r, people.length + 2, memoOf(d, date));
      if (height > 1) merges.push([r, people.length + 2, r + height - 1, people.length + 2]);
      r += height;
    }
    var columns = [{ width: 9 }].concat(people.map(function () { return { width: 22 }; })).concat([{ width: 24 }]);
    return {
      name: d.month, columns: columns, cells: cells, merges: merges, lastRow: r - 1, lastCol: people.length + 2,
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '2:2',
        margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
    };
  }

  function fileName(month) { return 'タスクリスト_' + month + '.xlsx'; }

  /** ExcelJS のブックに書く（ブラウザだけ） */
  function build(ExcelJS, sh) {
    var wb = new ExcelJS.Workbook();
    wb.creator = '名和電設ポータル';
    wb.lastModifiedBy = '名和電設ポータル';
    var ws = wb.addWorksheet(sh.name, { pageSetup: Object.assign({}, sh.pageSetup), views: [{ state: 'frozen', ySplit: 2, xSplit: 1 }] });
    ws.columns = sh.columns;
    var thin = { style: 'thin', color: { argb: 'FFBFBFBF' } };
    sh.cells.forEach(function (c) {
      var cell = ws.getCell(c.r, c.c);
      cell.value = c.value; // 文字だけ（式にしない）
      cell.font = Object.assign({ name: '游ゴシック', size: 9 }, c.font ? { bold: !!c.font.bold, strike: !!c.font.strike, size: c.font.size || 9, color: c.font.color ? { argb: c.font.color } : undefined } : {});
      cell.alignment = { vertical: 'top', wrapText: true };
      if (c.r >= 2) cell.border = { top: thin, left: thin, bottom: thin, right: thin };
    });
    sh.merges.forEach(function (m) { ws.mergeCells(m[0], m[1], m[2], m[3]); });
    ws.pageSetup.printArea = 'A1:' + ws.getColumn(sh.lastCol).letter + sh.lastRow;
    return wb;
  }

  var api = { sheet: sheet, fileName: fileName, build: build, COLOR: COLOR };
  if (root) { root.MP = root.MP || {}; root.MP.taskExportLayout = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
