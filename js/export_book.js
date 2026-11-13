/*
 * 出勤簿の形（export_layout.js）を ExcelJS のブックに書く（手順10の計画 docs/plans/stage1-step10-plan.md 2-2）
 *
 *   MP.exportBook.build(ExcelJS, sheets) … シートの形の一覧 → ExcelJS の Workbook
 *   MP.exportBook.toBlob(workbook)       … .xlsx の Blob（ブラウザだけ）
 *
 * 値は文字か数だけを書く（式にしない。ExcelJS は文字の値を文字のセルとして書く）
 */
(function (root) {
  'use strict';

  var FONT = '游ゴシック';
  var FILL = { sat: 'FFDDEBF7', sun: 'FFFCE4E4', out: 'FFE7E6E6', head: 'FFF2F2F2' };
  var THIN = { style: 'thin', color: { argb: 'FF808080' } };
  var BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

  function fill(argb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb } }; }

  /** style の名前 → ExcelJS のセルの書式 */
  function styleOf(name, size) {
    var parts = name.split('_');
    var kind = parts[0], color = parts[1] || null;
    var s = { font: { name: FONT, size: size || 9 }, alignment: { vertical: 'middle', shrinkToFit: true } };
    if (kind === 'title') { s.font = { name: FONT, size: 14, bold: true }; s.alignment = { vertical: 'middle', horizontal: 'center' }; return s; }
    if (kind === 'label') { s.font.bold = true; s.alignment.horizontal = 'center'; return s; }
    if (kind === 'text') return s;
    if (kind === 'count') { s.alignment.horizontal = 'center'; s.border = BORDER; return s; }
    if (kind === 'note') { s.border = BORDER; return s; }
    if (kind === 'head') { s.font.bold = true; s.alignment.horizontal = 'center'; s.border = BORDER; s.fill = fill(FILL.head); return s; }
    // cell / center（表の中）
    s.border = BORDER;
    if (kind === 'center') s.alignment.horizontal = 'center';
    if (color) s.fill = fill(FILL[color]);
    return s;
  }

  function build(ExcelJS, sheets) {
    var wb = new ExcelJS.Workbook();
    wb.creator = '名和電設ポータル';
    wb.lastModifiedBy = '名和電設ポータル';
    sheets.forEach(function (sh) {
      var ws = wb.addWorksheet(sh.name, { pageSetup: Object.assign({}, sh.pageSetup), views: [{ showGridLines: false }] });
      ws.columns = sh.columns.map(function (c) { return { width: c.width }; });
      sh.cells.forEach(function (c) {
        var cell = ws.getCell(c.addr);
        cell.value = typeof c.value === 'number' ? c.value : (c.value === null || c.value === undefined ? '' : String(c.value));
        var st = styleOf(c.style, sh.font);
        Object.keys(st).forEach(function (k) { cell[k] = st[k]; });
      });
      sh.merges.forEach(function (m) { ws.mergeCells(m); });
      Object.keys(sh.rowHeights).forEach(function (r) { ws.getRow(Number(r)).height = sh.rowHeights[r]; });
      ws.pageSetup.printArea = sh.printArea;
    });
    return wb;
  }

  function toBlob(wb) {
    return wb.xlsx.writeBuffer().then(function (buf) {
      return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    });
  }

  var api = { build: build, toBlob: toBlob, styleOf: styleOf };
  if (root) { root.MP = root.MP || {}; root.MP.exportBook = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
