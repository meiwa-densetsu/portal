/*
 * 出勤簿の Excel の形（手順10の計画 docs/plans/stage1-step10-plan.md 2-2）。画面の部品も ExcelJS も使わない純粋な JS（Node のテストでも読み込む）
 *
 *   MP.exportLayout.sheet(o)       … 1人分の値 → シートの形 { name, columns, cells, merges, rowHeights, printArea, pageSetup }
 *   MP.exportLayout.sheetNames(ns) … 氏名の一覧 → Excel で使えるシート名の一覧（使えない文字の置き換え・31文字・重なり）
 *   MP.exportLayout.fileName(o)    … ファイル名
 *
 * セルの値は文字か数だけ（式は作らない）。色・罫線などは style の名前で持ち、ExcelJS への書き方は export_book.js が決める
 */
(function (root) {
  'use strict';

  var DOW = ['日', '月', '火', '水', '木', '金', '土'];
  var SLOT_COLS = ['出社', '開始', '終了', '退社', '直行直帰', '作業場所', '施工内容'];
  /** 列: A 日付・B 曜日・C〜I 日勤（施工内容まで）・J〜P 夜勤（同じ）・Q 対応部署（施工内容は勤務ごと: 手順10b 2-7） */
  var COL = { date: 1, dow: 2, day: 3, night: 10, dept: 17 };
  var SLOT_N = 7;
  var LAST_COL = 17;
  var TITLE = '名和電設(株) 出勤簿';
  var ALSOK = 'アルソックセキュリティ番号';
  var SHEET_NAME_MAX = 31;
  /** 文字の大きさと行の高さ（ポイント）。印刷の確かめで変えるときはここだけ（計画 2-2） */
  var SIZE = { font: 9, title: 14, titleRow: 22, row: 15, dayRow: 13.5, gap: 6 };

  function letter(c) { return String.fromCharCode(64 + c); }
  function addr(r, c) { return letter(c) + r; }
  function md(date) { return Number(date.slice(5, 7)) + '/' + Number(date.slice(8, 10)); }
  function jpDate(date) { return Number(date.slice(0, 4)) + '年' + Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日'; }
  function jpMd(date) { return Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日'; }
  function str(v) { return v === null || v === undefined ? '' : String(v); }

  /**
   * 1人分のシートの形。
   * o: { name, sheetName, period: { from, to }, days: [{ date, dow, day, night, note, department, inHistory }], counts: { day, night, total }, limits: { placeMax, contentMax } }
   * day・night は { 出社, 開始, 終了, 退社, 直行直帰, 作業場所, 施工内容 }
   */
  function sheet(o) {
    var cells = [], merges = [], rowHeights = {};
    function put(r, c, v, style) { cells.push({ addr: addr(r, c), value: v, style: style || 'cell' }); }
    function merge(r1, c1, r2, c2) { merges.push(addr(r1, c1) + ':' + addr(r2, c2)); }

    // 1〜2行: 見出し・期間・氏名・番号
    put(1, 1, o.period.to.slice(0, 4) + '年 ' + TITLE, 'title');
    merge(1, 1, 1, LAST_COL);
    rowHeights[1] = SIZE.titleRow;
    put(2, 1, '期間', 'label'); merge(2, 1, 2, 2);
    put(2, 3, jpDate(o.period.from) + '〜' + jpDate(o.period.to), 'text'); merge(2, 3, 2, 8);
    put(2, 10, '氏名', 'label');
    put(2, 11, str(o.name), 'text'); merge(2, 11, 2, 14);
    put(2, 15, ALSOK, 'label'); merge(2, 15, 2, 16);
    put(2, 17, '', 'text');

    // 3〜4行: 表の見出し
    put(3, COL.date, '日付', 'head'); merge(3, COL.date, 4, COL.date);
    put(3, COL.dow, '曜日', 'head'); merge(3, COL.dow, 4, COL.dow);
    put(3, COL.day, '日勤', 'head'); merge(3, COL.day, 3, COL.day + SLOT_N - 1);
    put(3, COL.night, '夜勤', 'head'); merge(3, COL.night, 3, COL.night + SLOT_N - 1);
    put(3, COL.dept, '対応部署', 'head'); merge(3, COL.dept, 4, COL.dept);
    SLOT_COLS.forEach(function (label, i) {
      put(4, COL.day + i, label, 'head');
      put(4, COL.night + i, label, 'head');
    });

    // 5行〜: 日ごと
    var r = 5;
    o.days.forEach(function (d) {
      var kind = !d.inHistory ? 'out' : d.dow === 6 ? 'sat' : d.dow === 0 ? 'sun' : '';
      var style = kind ? 'cell_' + kind : 'cell';
      var center = kind ? 'center_' + kind : 'center';
      put(r, COL.date, md(d.date), center);
      put(r, COL.dow, DOW[d.dow], center);
      [['day', COL.day], ['night', COL.night]].forEach(function (s) {
        var e = d.inHistory && d[s[0]] ? d[s[0]] : {};
        SLOT_COLS.forEach(function (k, i) { put(r, s[1] + i, d.inHistory ? str(e[k]) : '', i < 5 ? center : style); });
      });
      put(r, COL.dept, d.inHistory ? str(d.department) : '', center);
      r++;
    });
    var lastDayRow = r - 1;

    // 出勤日数
    r++;
    put(r, 1, '昼の出勤日数', 'label'); merge(r, 1, r, 3);
    put(r, 4, o.counts.day, 'count');
    put(r, 5, '日', 'text');
    put(r, 7, '夜の出勤日数', 'label'); merge(r, 7, r, 9);
    put(r, 10, o.counts.night, 'count');
    put(r, 11, '日', 'text');
    put(r, 13, '合計の出勤日数', 'label'); merge(r, 13, r, 15);
    put(r, 16, o.counts.total, 'count');
    put(r, 17, '日', 'text');
    var countRow = r;

    // 備考（備考のある日だけ「M月D日 内容」。左の列を上から埋め、次に右の列）
    r += 2;
    put(r, 1, '備考', 'head'); merge(r, 1, r, LAST_COL);
    var notes = o.days.filter(function (d) { return d.inHistory && str(d.note) !== ''; })
      .map(function (d) { return jpMd(d.date) + ' ' + str(d.note); });
    var lines = Math.max(1, Math.ceil(notes.length / 2));
    for (var i = 0; i < lines; i++) {
      var nr = r + 1 + i;
      put(nr, 1, notes[i] || '', 'note'); merge(nr, 1, nr, 9);
      put(nr, 10, notes[lines + i] || '', 'note'); merge(nr, 10, nr, LAST_COL);
    }
    var lastRow = r + lines;

    // 行の高さ（ポイント）。決めていない行は表の行の高さ
    for (var hr = 2; hr <= lastRow; hr++) if (!rowHeights[hr]) rowHeights[hr] = hr >= 5 && hr <= lastDayRow ? SIZE.dayRow : SIZE.row;
    rowHeights[lastDayRow + 1] = SIZE.gap;
    rowHeights[countRow + 1] = SIZE.gap;

    // 列の幅（字数の上限が1行で入る幅。Excel の幅の単位 → 画素 = 幅 × 7 + 5。全角1字は文字の大きさ（ポイント）× 4/3 画素）
    var lim = o.limits || {};
    var charPx = SIZE.font * 4 / 3;
    var widthFor = function (chars) { return Math.round(((chars * charPx + 6 - 5) / 7) * 10) / 10; };
    var columns = [];
    for (var c = 1; c <= LAST_COL; c++) {
      var w = 5;
      if (c === COL.dow) w = 3.5;
      else if (c === COL.day + 5 || c === COL.night + 5) w = widthFor(lim.placeMax || 10);
      else if (c === COL.day + 6 || c === COL.night + 6) w = widthFor(lim.contentMax || 20);
      else if (c === COL.dept) w = widthFor(5);
      columns.push({ width: w });
    }

    var out = {
      name: o.sheetName, columns: columns, cells: cells, merges: merges, rowHeights: rowHeights, font: SIZE.font,
      tableRows: { first: 3, lastDay: lastDayRow, count: countRow, last: lastRow },
      printArea: 'A1:' + addr(lastRow, LAST_COL),
      pageSetup: {
        paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1, horizontalCentered: true,
        margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
      },
    };
    out.estimate = estimate(out);
    return out;
  }

  /**
   * 印刷したときの縮み具合の見積もり（A4 横・余白 0.4 インチ。Excel は1ページに収めるため全体を縮める）。
   * 返す値: { widthPt, heightPt, scale（1 以下）, fontPt（縮めた後の表の文字の大きさ） }。本物の Excel の印刷とは少し違う（計画 2-2）
   */
  function estimate(sh) {
    var widthPt = sh.columns.reduce(function (s, c) { return s + Math.floor(c.width * 7 + 5) * 0.75; }, 0);
    var heightPt = 0;
    for (var r = 1; r <= sh.tableRows.last; r++) heightPt += sh.rowHeights[r] || SIZE.row;
    var m = sh.pageSetup.margins;
    var availW = 842 - (m.left + m.right) * 72, availH = 595 - (m.top + m.bottom) * 72;
    var scale = Math.min(1, availW / widthPt, availH / heightPt);
    scale = Math.floor(scale * 100) / 100; // Excel の倍率は 1% きざみ（切り捨て）
    return { widthPt: Math.round(widthPt), heightPt: Math.round(heightPt), scale: scale, fontPt: Math.round(sh.font * scale * 10) / 10 };
  }

  /** Excel のシート名の決まり（31文字まで・\ / ? * [ ] : は使えない・先頭と末尾の ' は使えない・大文字小文字を区別せず重ならない・History は使えない） */
  function sheetNames(names) {
    var used = Object.create(null); // constructor・__proto__ などの名前を「使用済み」と見ない（Codex 実装1回目 low）
    return names.map(function (n) {
      // 制御文字を先に消してから、先頭と末尾の ' を消す（逆だと「制御文字＋'」の ' が残る。内部レビュー low）
      var base = str(n).replace(/[\u0000-\u001f]/g, '').replace(/[\\\/?*\[\]:]/g, '_').replace(/^'+|'+$/g, '');
      if (base.replace(/\s/g, '') === '' || base.toLowerCase() === 'history') base = '社員' + (base ? '_' + base : '');
      var name = cut(base, SHEET_NAME_MAX);
      for (var k = 2; used[name.toLowerCase()]; k++) {
        var tail = '(' + k + ')';
        name = cut(base, SHEET_NAME_MAX - tail.length) + tail;
      }
      used[name.toLowerCase()] = true;
      return name;
    });
  }

  /** UTF-16 の長さで max 以下に切る（サロゲートペアを割らない） */
  function cut(s, max) {
    var out = '';
    var chars = Array.from(s);
    for (var i = 0; i < chars.length; i++) {
      if ((out + chars[i]).length > max) break;
      out += chars[i];
    }
    return out.replace(/'+$/, '');
  }

  /** ファイル名。1人だけのときは氏名を付ける（ファイル名に使えない文字は _） */
  function fileName(o) {
    var base = '出勤簿_' + o.period.from + '_' + o.period.to;
    if (o.single) base += '_' + cut(str(o.single).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_'), 40);
    return base + '.xlsx';
  }

  var api = { sheet: sheet, sheetNames: sheetNames, fileName: fileName, estimate: estimate, SLOT_COLS: SLOT_COLS, COL: COL, LAST_COL: LAST_COL, SIZE: SIZE };
  if (root) { root.MP = root.MP || {}; root.MP.exportLayout = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
