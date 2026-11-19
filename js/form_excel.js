/*
 * 受付の集計を Excel にする（計画 stage4-board-plan.md 第6章・11-9）。form.result の答えだけから作る（サーバーには聞かない）
 *
 *   MP.formExcel.sheets(result)       … [{ name, rows: [[文字, …], …] }]（どのセルも文字。数式の形の文字も文字のまま）
 *   MP.formExcel.build(ExcelJS, result) … ExcelJS の Workbook（セルの値はすべて文字列で入れる。式にしない）
 *   MP.formExcel.fileName(result)     … 「受付_制服の注文_F0001.xlsx」
 */
(function (root) {
  'use strict';
  var MP = root.MP = root.MP || {};

  function s(v) { return v === null || v === undefined ? '' : String(v); }

  function optName(map, id) {
    var o = map && map[id];
    return o ? o.name + (o.hidden ? '（今は出していない）' : '') : s(id);
  }

  function answerCells(kind, a, labels) {
    if (!a) return [];
    if (kind === 'attend') return [a.status, s(a.guests || 0), a.note];
    if (kind === 'order') {
      return [(a.lines || []).map(function (l) {
        var it = labels.items && labels.items[l.item];
        return optName(labels.items, l.item) + ' ' + (it ? optName(it.sizes, l.size) : s(l.size)) + ' × ' + l.qty;
      }).join('、')];
    }
    return [optName(labels.hospitals, a.hospital), a.category, (a.wishes || []).join('、'), a.note];
  }

  function head(kind) {
    if (kind === 'attend') return ['名前', '回答', '同伴の人数', '一言', '回答日時'];
    if (kind === 'order') return ['名前', '注文', '回答日時'];
    return ['名前', '病院', '区分', '希望日', '一言', '回答日時', '確定日'];
  }

  function personRows(r, list) {
    var kind = r.form.kind, labels = r.labels || {};
    return list.map(function (m) {
      var cells = [m.name].concat(m.answered ? answerCells(kind, m.answer, labels) : ['（未回答）']);
      while (cells.length < head(kind).length - (kind === 'health' ? 2 : 1)) cells.push('');
      cells.push(m.at || '');
      if (kind === 'health') cells.push(m.confirmedDate || '');
      return cells.map(s);
    });
  }

  function sheets(r) {
    var kind = r.form.kind;
    var out = [{ name: '人別', rows: [head(kind)].concat(personRows(r, r.members)) }];
    if (kind === 'order') {
      var labels = r.labels || {};
      out.push({ name: '品目とサイズ別', rows: [['品目', 'サイズ', '数量', '人数']].concat((r.totals.lines || []).map(function (l) {
        var it = labels.items && labels.items[l.item];
        return [optName(labels.items, l.item), it ? optName(it.sizes, l.size) : s(l.size), s(l.qty), s(l.people)];
      })) });
    }
    if (kind === 'attend') {
      var t = r.totals;
      out.push({ name: '人数', rows: [['出席', '欠席', '未定', '同伴', '合計（出席＋同伴）', '未回答'], [t['出席'], t['欠席'], t['未定'], t.guests, t.total, t.unanswered].map(s)] });
    }
    if (r.outside && r.outside.length) out.push({ name: '対象外になった人', rows: [head(kind)].concat(personRows(r, r.outside)) });
    return out;
  }

  function build(ExcelJS, r) {
    var wb = new ExcelJS.Workbook();
    sheets(r).forEach(function (sh) {
      var ws = wb.addWorksheet(sh.name);
      sh.rows.forEach(function (row, i) {
        row.forEach(function (v, c) {
          var cell = ws.getCell(i + 1, c + 1);
          cell.value = s(v); // 文字列のまま（先頭が = + - @ の文字も式にしない）
          cell.numFmt = '@';
        });
      });
      ws.columns.forEach(function (col) { col.width = 18; });
    });
    return wb;
  }

  function fileName(r) {
    return '受付_' + s(r.form.kindLabel) + '_' + s(r.form.formId) + '.xlsx';
  }

  MP.formExcel = { sheets: sheets, build: build, fileName: fileName };
})(typeof window !== 'undefined' ? window : this);
