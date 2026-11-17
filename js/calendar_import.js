/*
 * 会社カレンダーのファイル（CSV / xlsx）の取り込み（計画 docs/plans/stage2-calendar-import-sw-plan.md 第1章）
 * 画面とは別の純粋な関数（Node の試験でも同じものを動かす）。ファイルの中身はサーバーに送らない
 *
 *   MP.calImport.LIMITS                  … 数字のまとめ（行 400・列 30・誤りの表示 20 件・ファイル 2MB〔まとめて登録と同じ〕）
 *   MP.calImport.kindOf(ファイル名)       … 'csv' | 'xlsx' | null
 *   MP.calImport.readCsv(バイト列)        → { rows } か { error }（UTF-8。BOM 付き・無しどちらも）
 *   MP.calImport.readXlsx(ExcelJS, バイト列) → Promise { rows } か { error }（1 枚目のシートだけ。開く前の下見はまとめて登録と同じ）
 *   MP.calImport.read(ExcelJS, 種類, バイト列) → Promise（上の 2 つのどちらか。失敗しても reject しない）
 *   MP.calImport.check(rows, o)           → { ok: false, errors: [{ line, text }] } か
 *                                           { ok: true, days（取り込んだ後の 1 年分の配列）, changed, missing, unsaved, summary }
 *       o: { C（CalcCalendar）, period, rules, today, confirmed, base（保存済みの文字列）, days（今の画面の配列） }
 *   MP.calImport.errorText(errors)        … 誤りの一覧の文（最初の 20 件・行の番号つき）
 *
 * rows は [{ line: 行の番号, cells: [文字], errors: [セルの誤り] }]（すべてのセルが空の行は入れない）
 */
(function (root) {
  'use strict';

  var BB = root && root.MP && root.MP.bulkBook ? root.MP.bulkBook : (typeof require === 'function' ? require('./bulk_book.js') : null);

  var LIMITS = {
    ROWS_MAX: 400,                            // 読む行の上限（1 年 366 日 ＋ 見出し に、ゆとり）
    COLS_MAX: 30,                             // 読む列の上限（まとめて登録と同じ）
    ERRORS_MAX: 20,                           // 一覧に出す誤りの数
    FILE_MAX_BYTES: BB.BULK_BOOK.FILE_MAX_BYTES, // 2MB（まとめて登録と同じ）
  };
  var HEADERS = ['日付', '区分'];
  var TYPE_WORDS = { '出勤': 'W', '出': 'W', '休み': 'H', '休': 'H', '有給推奨': 'P', '推': 'P' };
  var TYPE_TEXT = { W: '出勤', H: '休み', P: '有給推奨' };
  var EDGE_SPACE = /^[ \t\u3000\u00A0]+|[ \t\u3000\u00A0]+$/g; // 前後の空白（半角・全角・タブ）だけを外す
  // 見えない文字（制御文字・ゼロ幅・文字の向き・BOM・行や段落の区切り）。取り除いて通さず、誤りにする
  var INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB]/;

  var ERR_TOO_BIG = 'ファイルが大きすぎます（2MB まで）';
  var ERR_ROWS = '行が多すぎます（' + LIMITS.ROWS_MAX + ' 行まで）';
  var ERR_COLS = '列が多すぎます（' + LIMITS.COLS_MAX + ' 列まで）';
  var ERR_NOT_XLSX = 'Excel のファイルとして読めませんでした';

  function kindOf(name) {
    var n = String(name || '');
    if (/\.csv$/i.test(n)) return 'csv';
    if (/\.xlsx$/i.test(n)) return 'xlsx';
    return null;
  }

  function bytesOf(buf) {
    if (!buf || typeof buf.byteLength !== 'number') return null;
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    try { return new Uint8Array(buf); } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- CSV

  /** CSV の文字 → { rows } か { error }。「"」で囲んだ値（中の「""」・改行）も読む。行の番号は、その行が始まる行 */
  function parseCsv(text) {
    var rows = [], cells = [], cell = '', quoted = false, closed = false, line = 1, start = 1, count = 0;
    function endCell() { cells.push(cell); cell = ''; closed = false; if (cells.length > LIMITS.COLS_MAX) return false; return true; }
    function endRow() {
      count++;
      if (count > LIMITS.ROWS_MAX) return false;
      if (cells.some(function (c) { return c.replace(EDGE_SPACE, '') !== ''; })) rows.push({ line: start, cells: cells, errors: [] });
      cells = [];
      return true;
    }
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (quoted) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { cell += '"'; i++; } else { quoted = false; closed = true; }
        } else {
          if (ch === '\n' || (ch === '\r' && text.charAt(i + 1) !== '\n')) line++;
          cell += ch;
        }
        continue;
      }
      if (ch === ',') { if (!endCell()) return { error: ERR_COLS }; continue; }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
        if (!endCell()) return { error: ERR_COLS };
        if (!endRow()) return { error: ERR_ROWS };
        line++;
        start = line;
        continue;
      }
      if (closed) return { error: start + ' 行目: 「"」で囲んだ値の後ろに文字があります' };
      if (ch === '"') {
        if (cell.replace(EDGE_SPACE, '') !== '') return { error: start + ' 行目: 値の途中に「"」があります' };
        cell = '';
        quoted = true;
        continue;
      }
      cell += ch;
    }
    if (quoted) return { error: start + ' 行目: 「"」が閉じていません' };
    if (cell !== '' || cells.length || closed) {
      if (!endCell()) return { error: ERR_COLS };
      if (!endRow()) return { error: ERR_ROWS };
    }
    return { rows: rows };
  }

  /** CSV のバイト列 → { rows } か { error } */
  function readCsv(buf) {
    var b = bytesOf(buf);
    if (!b) return { error: 'CSV のファイルとして読めませんでした' };
    if (b.length > LIMITS.FILE_MAX_BYTES) return { error: ERR_TOO_BIG };
    var text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
    } catch (e) {
      return { error: 'UTF-8 の CSV として読めませんでした（Excel では「CSV UTF-8（コンマ区切り）」で保存してください）' };
    }
    if (text.charAt(0) === '\uFEFF') text = text.slice(1); // 先頭の BOM だけ外す（ほかの場所の BOM は見えない文字として誤り）
    return parseCsv(text);
  }

  // ---------------------------------------------------------------- xlsx

  /** 1 枚目のシート → { rows } か { error }。行・列の数は、まとめて登録の readSheet と同じ数え方（行を先に見る） */
  function sheetRows(ws) {
    var rowCount = ws.rowCount;
    if (rowCount > LIMITS.ROWS_MAX) return { error: ERR_ROWS };
    var colCount = ws.columnCount;
    if (colCount > LIMITS.COLS_MAX) return { error: ERR_COLS };
    var out = [];
    for (var r = 1; r <= rowCount; r++) {
      var row = ws.getRow(r);
      var cells = [], errors = [], any = false;
      for (var c = 1; c <= colCount; c++) {
        var cell = row.getCell(c);
        var merged = cell.master && cell.master !== cell && cell.master.address !== cell.address;
        var t = merged ? { text: '' } : BB.cellText(cell.value);
        if (t.error) {
          errors.push(BB.colLetter(c) + ' 列（' + (HEADERS[c - 1] || (c + ' 列目')) + '）: ' + t.error);
          cells.push('');
        } else {
          cells.push(t.text);
          if (t.text.replace(EDGE_SPACE, '') !== '') any = true;
        }
      }
      if (!any && !errors.length) continue;
      out.push({ line: r, cells: cells, errors: errors });
    }
    return { rows: out };
  }

  /** xlsx のバイト列 → Promise { rows } か { error }。大きさ → 開く前の下見（MP.bulkBook.precheck）→ ExcelJS → 1 枚目のシート */
  function readXlsx(ExcelJS, buf) {
    return Promise.resolve().then(function () {
      var b = bytesOf(buf);
      if (!b) return { error: ERR_NOT_XLSX };
      if (b.length > LIMITS.FILE_MAX_BYTES) return { error: ERR_TOO_BIG };
      var copy = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); // 下見と ExcelJS に、同じ写しを渡す
      return BB.precheck(copy).then(function (z) {
        if (z.error) return { error: z.error };
        var wb = new ExcelJS.Workbook();
        return wb.xlsx.load(copy).then(function () {
          var ws = wb.worksheets[0];
          if (!ws) return { error: 'シートがありません' };
          return sheetRows(ws);
        });
      });
    }).then(null, function () { return { error: ERR_NOT_XLSX }; });
  }

  function read(ExcelJS, kind, buf) {
    if (kind === 'csv') return Promise.resolve().then(function () { return readCsv(buf); }).then(null, function () { return { error: 'CSV のファイルとして読めませんでした' }; });
    if (kind === 'xlsx') return readXlsx(ExcelJS, buf);
    return Promise.resolve({ error: '.csv か .xlsx のファイルを選んでください' });
  }

  // ---------------------------------------------------------------- 確かめ

  /** セルの文字 → { text }（前後の空白を外した文字）か { error }（見えない文字） */
  function field(s) {
    var t = String(s === undefined || s === null ? '' : s).replace(EDGE_SPACE, '');
    if (INVISIBLE.test(t)) return { error: '見えない文字が入っています' };
    return { text: t };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 'YYYY-MM-DD' か 'YYYY/M/D' → { date: 'YYYY-MM-DD' } か { error } */
  function parseDate(C, t) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t) || /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(t);
    if (!m) {
      if (/^\d{4}\/\d{1,2}\/\d{1,2} \d/.test(t)) return { error: '時刻が付いた日付です（日付だけにしてください）' };
      return { error: t === '' ? '日付がありません' : '日付の形が違います（2026-05-01 か 2026/5/1 の形）' };
    }
    var date = m[1] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3]));
    if (C.dayNumber(date) === null) return { error: '存在しない日付です（' + t + '）' };
    return { date: date };
  }

  function quote(t) { return t.length > 20 ? t.slice(0, 20) + '…' : t; }

  function check(rows, o) {
    var C = o.C, period = o.period, rules = o.rules;
    var errors = [];
    function err(line, text) { errors.push({ line: line, text: text }); }
    if (!rows.length) return { ok: false, errors: [{ line: null, text: '中身がありません（1 行目に「日付,区分」、2 行目から 1 日 1 行）' }] };
    var head = rows[0];
    var h0 = field(head.cells[0]), h1 = field(head.cells[1]);
    var headOk = !head.errors.length && h0.text === HEADERS[0] && h1.text === HEADERS[1] &&
      head.cells.slice(2).every(function (c) { return field(c).text === ''; });
    if (head.line !== 1 || !headOk) return { ok: false, errors: [{ line: head.line, text: '1 行目の見出しを「日付,区分」にしてください（日付・区分の 2 列）' }] };
    var start = C.dayNumber(period.from);
    var seen = {}, set = {};
    rows.slice(1).forEach(function (row) {
      if (row.errors.length) { row.errors.forEach(function (e) { err(row.line, e); }); return; }
      if (row.cells.slice(2).some(function (c) { return field(c).text !== ''; })) { err(row.line, '3 列目より右には何も入れないでください'); return; }
      var d = field(row.cells[0]), t = field(row.cells[1]);
      if (d.error) { err(row.line, '日付: ' + d.error); return; }
      if (t.error) { err(row.line, '区分: ' + t.error); return; }
      var pd = parseDate(C, d.text);
      var type = Object.prototype.hasOwnProperty.call(TYPE_WORDS, t.text) ? TYPE_WORDS[t.text] : null;
      if (pd.error) err(row.line, pd.error);
      if (!type) err(row.line, t.text === '' ? '区分がありません' : '区分「' + quote(t.text) + '」は使えません（出勤・休み・有給推奨、または 出・休・推）');
      if (pd.error || !type) return;
      var n = C.dayNumber(pd.date) - start;
      if (n < 0 || n >= period.days) { err(row.line, pd.date + ' は、この年度（' + period.from + '〜' + period.to + '）の外です'); return; }
      if (seen[n]) { err(row.line, pd.date + ' が 2 回あります（' + seen[n] + ' 行目にも）'); return; }
      seen[n] = row.line;
      if (C.dowOf(start + n) === rules.LEGAL_HOLIDAY_DOW && type !== 'H') { err(row.line, pd.date + ' は日曜（法定休日）なので「休み」にしてください'); return; }
      if (o.confirmed && pd.date <= o.today && type !== o.days[n]) {
        err(row.line, pd.date + ' は確定後の今日以前なので変えられません（今は「' + TYPE_TEXT[o.days[n]] + '」）');
        return;
      }
      set[n] = type;
    });
    if (rows.length === 1) err(null, '日付の行がありません（2 行目から 1 日 1 行）');
    if (errors.length) return { ok: false, errors: errors };
    var next = o.days.slice();
    var changed = 0, missing = 0, unsaved = 0;
    for (var i = 0; i < period.days; i++) {
      if (Object.prototype.hasOwnProperty.call(set, i)) next[i] = set[i]; else missing++;
      if (next[i] !== o.days[i]) changed++;
      if (o.days[i] !== o.base.charAt(i)) unsaved++;
    }
    var text = next.join('');
    // 窓の数は、保存のときのサーバーの確かめと同じ物差し（validateDays が誤りなし → summarize）で出す
    if (!C.validateDays(text, period, rules).ok) return { ok: false, errors: [{ line: null, text: '取り込んだ後の区分が正しくありません' }] };
    return { ok: true, days: next, changed: changed, missing: missing, unsaved: unsaved, summary: C.summarize(text, period, rules) };
  }

  /** 誤りの一覧の文（最初の 20 件。行の番号つき。残りは件数だけ） */
  function errorText(errors) {
    var lines = errors.slice(0, LIMITS.ERRORS_MAX).map(function (e) { return (e.line ? e.line + ' 行目: ' : '') + e.text; });
    if (errors.length > LIMITS.ERRORS_MAX) lines.push('ほか ' + (errors.length - LIMITS.ERRORS_MAX) + ' 件');
    return lines.join('\n');
  }

  var api = { LIMITS: LIMITS, kindOf: kindOf, readCsv: readCsv, readXlsx: readXlsx, read: read, check: check, errorText: errorText };
  if (root) { root.MP = root.MP || {}; root.MP.calImport = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
