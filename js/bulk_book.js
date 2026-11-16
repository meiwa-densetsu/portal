/*
 * まとめて登録の Excel のファイル（計画 docs/plans/stage1-bulk-excel-plan.md 第1章・2-1）
 *
 *   MP.bulkBook.BULK_BOOK            … 数字のまとめ（画面の柵。計算のルールではないので、サーバーの設定には置かない）
 *   MP.bulkBook.EMP_BOOK_HEADERS     … 「社員」のシートの見出し（入力の画面の項目の名前と同じ）
 *   MP.bulkBook.toInner(見出し)      … Excel の見出し → bulk.js の中の見出し（知らない見出しはそのまま）
 *   MP.bulkBook.sheetsOf(data)       … ファイルの形（シート・見出し・行・プルダウン・名前の付いた範囲・「書き方」の文）。ExcelJS を使わない
 *   MP.bulkBook.build(ExcelJS, data) … sheetsOf の形 → ExcelJS の Workbook
 *   MP.bulkBook.toBlob(workbook)     … .xlsx の Blob（ブラウザだけ。出勤簿の Excel〔export_book.js〕と同じ保存のしかた）
 *   MP.bulkBook.fileName(data)       … ポータル_社員と部署_YYYY-MM-DD.xlsx
 *   MP.bulkBook.cellText(値)         … セルの値 → { text } か { error }。式は結果があっても誤り
 *   MP.bulkBook.zipSummary(バイト列) … 開く前の下見（ZIP の目次だけを読む）→ { entries, unzippedBytes } か { error }
 *   MP.bulkBook.read(ExcelJS, バイト列) … Promise → { departments: 行, employees: 行 } か { error }。行は [{ line, cells, errors }]（失敗しても reject しない）
 *
 * data は master.admin.list の答え。値はすべて文字で書く（式にしない）。読むときも、式の結果は使わない
 */
(function (root) {
  'use strict';

  var bulk = root && root.MP && root.MP.bulk ? root.MP.bulk : (typeof require === 'function' ? require('./bulk.js') : null);

  var BULK_BOOK = {
    EDIT_ROWS: 500,                       // 見出しの下の、書式「文字列」とプルダウンを付けておく行の数
    DEPT_LIST_ROWS: 501,                  // 部署のプルダウンの元の終わりの行（「部署」のシートの B2〜B501）
    ROWS_MAX: 1000,                       // 読み込むシートの行の上限
    COLS_MAX: 30,                         // 読み込むシートの列の上限
    FILE_MAX_BYTES: 2 * 1024 * 1024,      // 読み込むファイルの大きさの上限
    CELL_MAX: 200,                        // 1つのセルの文字の数の上限
    ZIP_ENTRIES_MAX: 200,                 // ZIP の中の項目の数の上限
    UNZIPPED_MAX_BYTES: 20 * 1024 * 1024, // 開いた後の大きさの合計の上限（目次の数字と、実際に開いた大きさの両方で見る）
    ENTRY_MAX_BYTES: 10 * 1024 * 1024,    // 1つの項目の開いた後の大きさの上限
    // ExcelJS が開くときにマスごとに広げる範囲（セルの結合・入力規則。条件付き書式も念のため数える）の面積の合計の上限。
    // 書き出すファイルは 社員 3 列 × 500 行 ＋ 部署 3 列 × 500 行 = 3000 マス。1000 行 × 30 列 = 30000 マスまで認める
    RANGE_CELLS_MAX: 30000,
    RANGES_MAX: 2000,                     // その範囲の数の上限（ExcelJS は結合を 1 つ足すたびに、今までの結合すべてと重なりを比べる）
    CELL_TAGS_MAX: 60000,                 // シートの中のセル（<c>）の数の合計の上限（書き出すファイルは約 9200）
    // 列の指定（<col>）で ExcelJS が作る列の数の、全シートの合計の上限。Excel で「右の列を全部隠す」と 1 枚で 16384 列になるので、4 枚分まで認める
    COL_DEFS_MAX: 4 * 16384,
    // 名前の付いた範囲（<definedName>）で ExcelJS が作るマスの数の合計の上限（書き出すファイルのプルダウンの元は数千マス）
    NAME_CELLS_MAX: 30000,
    // シートの番号（sheetId）の上限。Excel はシートを足すたびに番号を 1 つずつ増やす（消しても戻らない）ので、ゆとりを持たせる
    SHEET_ID_MAX: 10000,
  };

  var SHEET = { DEPT: '部署', EMP: '社員', CHOICES: '選択肢', GUIDE: '書き方' };
  var TEXT_FORMAT = '@';

  /** 「社員」のシートの見出し（入力の画面と同じ名前・同じ順）と、bulk.js の中の見出し（計画 1-1 の表） */
  var EMP_BOOK_HEADERS = [
    { book: '社員ID', inner: '社員ID', width: 10 },
    { book: '名前', inner: '名前', width: 18 },
    { book: '表示順', inner: '表示順', width: 8 },
    { book: '入社日', inner: '入社日', width: 12 },
    { book: '生年月日', inner: '生年月日', width: 12 },
    { book: 'いつから（適用開始日）', inner: '適用開始日', width: 22 },
    { book: '権限', inner: '権限', width: 10, list: 'mp_roles' },
    { book: '部署', inner: '部署', width: 16, list: 'mp_depts' },
    { book: '閲覧できる部署（部長だけ）', inner: '閲覧部署', width: 28 },
    { book: '雇用区分', inner: '雇用区分', width: 14, list: 'mp_emp_types' },
    { book: '1日の所定労働時間', inner: '1日の所定労働時間', width: 18 },
    { book: '状態', inner: '状態', width: 12 },
  ];
  /**
   * 前の「社員」のシートにあった見出し → 中の名前（2026-11-16 から休憩方式・会社カレンダーは部署で決めるので、社員の表では読み飛ばす。
   * bulk.js の EMP_SKIPPED に当たる名前にする）
   */
  var EMP_BOOK_OLD = { '会社カレンダー': 'カレンダー' };
  /** 「部署」のシートの見出し（中の名前と同じ。bulk.js の DEPT_HEADERS） */
  var DEPT_BOOK_HEADERS = [
    { book: '部署ID', width: 10 },
    { book: '部署の名前', width: 22 },
    { book: '表示順', width: 8 },
    { book: '使っている', width: 12, list: 'mp_yes_no' },
    { book: '休憩方式', width: 14, list: 'mp_break_types' },
    { book: '会社カレンダー', width: 20, list: 'mp_calendars' },
  ];

  /**
   * 「空白を無視する」（allowBlank）を付けない一覧。元の範囲に空のマスがある一覧（部署: 「部署」のシートの B2〜B501）は、
   * 「空白を無視する」が付いていると、Excel が手で打った値を何でも通してしまう（ユーザーが本物の Excel で確かめた。2026-11-16）。
   * ほかの一覧は元に空のマスが無く、そのままで止まるので、付けたままにする（付けないと、マスを編集して空に戻すときにも止められる。会社カレンダーは空 = 未設定）
   */
  var STRICT_LISTS = ['mp_depts'];

  function toInner(header) {
    var h = String(header).trim();
    var hit = EMP_BOOK_HEADERS.filter(function (x) { return x.book === h; })[0];
    if (hit) return hit.inner;
    return Object.prototype.hasOwnProperty.call(EMP_BOOK_OLD, h) ? EMP_BOOK_OLD[h] : h;
  }

  /** 列の番号（1 から）→ A・B…Z・AA… */
  function colLetter(n) {
    var s = '';
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ---------------------------------------------------------------- ファイルの形（ExcelJS を使わない）

  /** 会社カレンダーの選択肢: 使っているもの ＋ 今どこかの部署に付いている、使っていないもの（部署の表で、前と同じ値なら選べるため） */
  function calendarChoices(data) {
    var attached = {};
    data.departments.forEach(function (d) { if (d.calendarId) attached[d.calendarId] = true; });
    return (data.calendars || []).filter(function (c) { return c.active || attached[c.calendarId]; }).map(function (c) { return String(c.name); });
  }

  function guideLines() {
    return [
      { text: '「いつから（適用開始日）」が空の行は、変えた内容が今日からになります。前からの内容そのものを直したいとき（入れ間違いの直しなど）は、その行の「いつから」に、直したい行の日付を入れてください（社員の管理の画面の「履歴」に出ている日付）。', bold: true },
      { text: '' },
      { text: '■ 使い方', bold: true },
      { text: '1. 「部署」と「社員」のシートを書き足す・書き直す → 保存する → ポータルの「Excel でまとめて登録」で、このファイルを読み込みます。' },
      { text: '2. 読み込むと、何が変わるかの一覧が出ます。確かめてから「登録する」を押すまで、何も保存されません。' },
      { text: '3. 見出し（1行目）の名前と、シートの名前（部署・社員）は変えないでください。' },
      { text: '' },
      { text: '■ 「部署」のシート', bold: true },
      { text: '・新しい部署は、いちばん下に書き足します。部署ID は空のままにします（登録すると自動で付きます）。' },
      { text: '・表示順は 1〜9999 の整数。「使っている」は「はい」か「いいえ」。' },
      { text: '・休憩方式: マスの右の▼から選びます。新しい部署には必ず入れます。その部署の社員の休憩の引き方が、これで決まります。' },
      { text: '・会社カレンダー: マスの右の▼から選びます。空にすると「未設定」になります。その部署の社員の出勤日・休みが、これで決まります。' },
      { text: '・休憩方式・会社カレンダーを変えると、その部署にいた期間の、今までの日報にも効きます。途中の日から変えたいときは、新しい部署を作って、社員の「いつから」で移してください。' },
      { text: '・行を消しても、部署は消えません（使わなくするときは「使っている」を「いいえ」に）。' },
      { text: '' },
      { text: '■ 「社員」のシート', bold: true },
      { text: '・新しい人は、いちばん下に書き足します。社員ID は空のままにします（登録すると自動で付きます）。' },
      { text: '・行を消しても、社員は消えません。利用停止・招待は、社員の管理の画面で1人ずつ行います。' },
      { text: '・名前: 30文字まで。同じ名前の人がいるときは「佐藤（工事）」のように区別します。' },
      { text: '・表示順: 1〜9999 の整数（小さいほうが上）。' },
      { text: '・入社日・生年月日: 2026/4/1 の形。分からなければ空のまま。' },
      { text: '・権限・部署・雇用区分: マスの右の▼から選びます。「部署」のシートに書き足した部署も選べます（使っていない部署は選んでも登録できません）。' },
      { text: '・閲覧できる部署（部長だけ）: 権限が部長の人だけ入れます。部署の名前を「、」で区切って書きます（例: 鉄道部、電気通信部）。' },
      { text: '・1日の所定労働時間: 8:00 の形（7時間30分なら 7:30）。' },
      { text: '・休憩方式・会社カレンダーは、その人の部署で決まります（「部署」のシートで選びます）。' },
      { text: '・状態: 見るだけの列です。書き換えても何も変わりません。' },
      { text: '・権限〜1日の所定労働時間は、新しい人には全部入れます。今いる人は、変えない所はそのままにしておきます。' },
      { text: '' },
      { text: '■ 気を付けること', bold: true },
      { text: '・このファイルには個人情報（名前・生年月日・入社日）が入っています。取り扱いに注意し、要らなくなったら消してください。' },
      { text: '・式（= で始まるもの）は読み込めません。値として入れてください。' },
      { text: '・「選択肢」のシートは、▼の一覧の元です。書き換えないでください。「選択肢」と、この「書き方」のシートは、読み込みでは使いません。' },
      { text: '・確かめているのは、Excel（Windows）で保存したファイルだけです。ほかのソフトで保存し直したファイルは、読めないことがあります。' },
    ];
  }

  /**
   * ファイルの形。返り値:
   *   { sheets: [ { name, kind: 'table', headers, widths, rows, editRows, lists: [{ col, name, allowBlank }] },   … 部署・社員
   *               { name, kind: 'choices', headers, widths, columns: [[値…]…] },                      … 選択肢
   *               { name, kind: 'guide', width, lines: [{ text, bold }] } ],                          … 書き方
   *     names: [{ name, ref }] }                                                                      … 名前の付いた範囲
   */
  function sheetsOf(data) {
    var o = data.options;
    function table(name, heads, rows) {
      var lists = [];
      heads.forEach(function (h, i) { if (h.list) lists.push({ col: i + 1, name: h.list, allowBlank: STRICT_LISTS.indexOf(h.list) < 0 }); });
      return { name: name, kind: 'table', headers: heads.map(function (h) { return h.book; }), widths: heads.map(function (h) { return h.width; }),
        rows: rows, editRows: BULK_BOOK.EDIT_ROWS, lists: lists };
    }
    var choices = [
      { head: '権限', name: 'mp_roles', values: o.roles.map(String) },
      { head: '雇用区分', name: 'mp_emp_types', values: o.employmentTypes.map(String) },
      { head: '休憩方式', name: 'mp_break_types', values: o.breakTypes.map(String) },
      { head: '会社カレンダー', name: 'mp_calendars', values: calendarChoices(data) },
      { head: '使っている', name: 'mp_yes_no', values: ['はい', 'いいえ'] },
    ];
    var names = choices.map(function (c, i) {
      var L = colLetter(i + 1);
      // 中身が無い一覧（カレンダーが1つも無い）も、1マスの範囲にする（空の範囲は作れない）
      return { name: c.name, ref: "'" + SHEET.CHOICES + "'!$" + L + '$2:$' + L + '$' + (1 + Math.max(1, c.values.length)) };
    });
    // 部署だけは「部署」のシートの名前の列を指す（書き足した部署も選べる）
    names.push({ name: 'mp_depts', ref: "'" + SHEET.DEPT + "'!$B$2:$B$" + BULK_BOOK.DEPT_LIST_ROWS });
    return {
      sheets: [
        table(SHEET.DEPT, DEPT_BOOK_HEADERS, bulk.departmentRows(data)),
        table(SHEET.EMP, EMP_BOOK_HEADERS, bulk.employeeRows(data)),
        { name: SHEET.CHOICES, kind: 'choices', headers: choices.map(function (c) { return c.head; }), widths: choices.map(function () { return 18; }),
          columns: choices.map(function (c) { return c.values; }) },
        { name: SHEET.GUIDE, kind: 'guide', width: 110, lines: guideLines() },
      ],
      names: names,
    };
  }

  function fileName(data) {
    return 'ポータル_社員と部署_' + data.today + '.xlsx';
  }

  // ---------------------------------------------------------------- 書く（ExcelJS）

  var FONT = '游ゴシック';

  /**
   * 一覧に無い値は入れられない入力規則（元は名前の付いた範囲）。
   * errorStyle は書かない: Excel のファイルの決まりで使える値は stop・warning・information で、書かなければ stop（入れさせない）。
   * ExcelJS の説明にある 'error' はそのままファイルに書かれ、決まりに無い値になる（openpyxl は読めなかった。Excel が「修復」を出すおそれ）
   */
  function listRule(name, allowBlank) {
    return { type: 'list', allowBlank: allowBlank, formulae: [name], showErrorMessage: true,
      errorTitle: '一覧から選んでください', error: 'マスの右の▼から選んでください（一覧に無い値は入れられません）' };
  }

  /** 書く順は 書式（文字列）→ 値。値はすべて文字（「=」で始まっても式にしない） */
  function putText(cell, value, bold) {
    cell.numFmt = TEXT_FORMAT;
    cell.font = bold ? { name: FONT, size: 11, bold: true } : { name: FONT, size: 11 };
    if (value !== undefined) cell.value = String(value);
  }

  function build(ExcelJS, data) {
    var shape = sheetsOf(data);
    var wb = new ExcelJS.Workbook();
    wb.creator = '名和電設ポータル';
    wb.lastModifiedBy = '名和電設ポータル';
    shape.sheets.forEach(function (sh) {
      if (sh.kind === 'guide') {
        var g = wb.addWorksheet(sh.name);
        g.columns = [{ width: sh.width }];
        sh.lines.forEach(function (ln, i) {
          var c = g.getCell(i + 1, 1);
          putText(c, ln.text, !!ln.bold);
          c.alignment = { vertical: 'top', wrapText: true };
        });
        return;
      }
      // 見出しの行を固定する（スクロールしても見える）
      var ws = wb.addWorksheet(sh.name, { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = sh.widths.map(function (w) { return { width: w }; });
      sh.headers.forEach(function (h, i) { putText(ws.getCell(1, i + 1), h, true); });
      if (sh.kind === 'choices') {
        sh.columns.forEach(function (values, ci) {
          values.forEach(function (v, ri) { putText(ws.getCell(ri + 2, ci + 1), v, false); });
        });
        return;
      }
      // 部署・社員: 見出しの下の editRows 行（今の行がそれより多ければ、その行まで）に、先に書式とプルダウンを付ける
      var last = 1 + Math.max(sh.editRows, sh.rows.length);
      for (var r = 2; r <= last; r++) {
        for (var c = 1; c <= sh.headers.length; c++) putText(ws.getCell(r, c), undefined, false);
      }
      // プルダウンは、列ごとに 1 つの範囲（G2:G501）として付ける。
      // セルごとに付ける（cell.dataValidation = …）と、ExcelJS 4.4.0 がファイルに書くときに「G10:G501」と「G2:G501」の
      // 重なった 2 つの範囲にまとめてしまう（番地を文字の順に並べるため）。重なった入力規則は、Excel が開くときに「修復」を出すおそれがある
      sh.lists.forEach(function (l) {
        var L = colLetter(l.col);
        ws.dataValidations.add(L + '2:' + L + last, listRule(l.name, l.allowBlank));
      });
      // その後で値を入れる
      sh.rows.forEach(function (row, ri) {
        row.forEach(function (v, ci) { ws.getCell(ri + 2, ci + 1).value = String(v); });
      });
    });
    // 名前の付いた範囲（プルダウンの元。ブック全体の名前）
    shape.names.forEach(function (n) { wb.definedNames.add(n.ref, n.name); });
    return wb;
  }

  function toBlob(wb) {
    return wb.xlsx.writeBuffer().then(function (buf) {
      return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    });
  }

  // ---------------------------------------------------------------- セルの値 → 文字

  var ERR_FORMULA = '式が入っています。値に置き換えてください';
  var ERR_VALUE = 'Excel の誤りの値（#N/A など）が入っています';
  var ERR_UNKNOWN = '読めない形の値です';
  var ERR_LONG = '文字が長すぎます';
  var ERR_DATE = '正しい日付ではありません';
  var ERR_TIME = '時刻が 24 時間以上か、日付として読めない値です（所定労働時間は 8:00 の形で入れてください）';

  function textOut(s) {
    return s.length > BULK_BOOK.CELL_MAX ? { error: ERR_LONG } : { text: s };
  }

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /**
   * 日付の値（Excel が日付として保存したセル）→ 文字。
   * 1899/12/30 の値は時刻だけ（8:00。Excel の時刻だけのセルは、通し番号 0 の日 = 1899/12/30 の時刻として届く）。
   * ほかの 1899・1900 年の値は誤り（24 時間以上の時刻〔25:30 = 1899/12/31 1:30〕の日の部分を捨てて 1:30 と読まないため）。
   * それ以外は yyyy/m/d（0:00 でなければ時刻も付ける → 日付の列では誤りになる）
   */
  function dateText(d) {
    var ms = d.getTime();
    if (typeof ms !== 'number' || !isFinite(ms)) return { error: ERR_DATE };
    var t = new Date(Math.round(ms / 1000) * 1000); // 小数の誤差（7:59:59.999 など）を秒に丸める
    var time = t.getUTCHours() + ':' + pad2(t.getUTCMinutes()) + (t.getUTCSeconds() ? ':' + pad2(t.getUTCSeconds()) : '');
    var y = t.getUTCFullYear();
    if (y === 1899 && t.getUTCMonth() === 11 && t.getUTCDate() === 30) return { text: time };
    if (y === 1899 || y === 1900) return { error: ERR_TIME };
    var day = y + '/' + (t.getUTCMonth() + 1) + '/' + t.getUTCDate();
    return { text: t.getUTCHours() || t.getUTCMinutes() || t.getUTCSeconds() ? day + ' ' + time : day };
  }

  /**
   * セルの値（ExcelJS の cell.value）→ { text: '文字' } か { error: '理由' }
   * 式は、保存された結果（result）があっても使わない（古い・空・誤りのことがあるため）。数は、ただの数の文字（日付に読み替えない）
   */
  function cellText(value) {
    if (value === null || value === undefined || value === '') return { text: '' };
    if (typeof value === 'string') return textOut(value);
    if (typeof value === 'number') return isFinite(value) ? textOut(String(value)) : { error: ERR_UNKNOWN };
    if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE' };
    if (typeof value !== 'object') return { error: ERR_UNKNOWN };
    if (Object.prototype.toString.call(value) === '[object Date]') return dateText(value);
    if (has(value, 'formula') || has(value, 'sharedFormula')) return { error: ERR_FORMULA };
    if (has(value, 'error')) return { error: ERR_VALUE };
    if (Array.isArray(value.richText)) {
      var s = '';
      for (var i = 0; i < value.richText.length; i++) {
        var part = value.richText[i];
        if (!part || typeof part.text !== 'string') return { error: ERR_UNKNOWN };
        s += part.text;
      }
      return textOut(s);
    }
    if (has(value, 'hyperlink') && has(value, 'text')) {
      // リンク: 表示の文字だけを使う（文字か、書式つきの文字）
      var t = value.text;
      if (typeof t === 'string' || (t && typeof t === 'object' && Array.isArray(t.richText))) return cellText(t);
      return { error: ERR_UNKNOWN };
    }
    return { error: ERR_UNKNOWN };
  }

  // ---------------------------------------------------------------- 開く前の下見（ZIP の目次）

  var ERR_NOT_XLSX = 'Excel のファイルとして読めませんでした';
  var ERR_TOO_BIG = 'ファイルが大きすぎます';

  function bytesOf(buf) {
    if (buf && typeof buf.byteLength === 'number') {
      if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      try { return new Uint8Array(buf); } catch (e) { return null; }
    }
    return null;
  }

  /**
   * .xlsx は ZIP。ExcelJS に渡す前に、ZIP の目次（終わりの印 → 目次の各項目）だけを読む。
   * 返り値: { entries: 項目の数, unzippedBytes: 目次に書かれた開いた後の大きさの合計 } か { error: '文' }
   * 目次の数字は偽れるので、これだけでは守りにならない。中身を開いて確かめるのは scanParts
   */
  function zipSummary(buf) {
    var d = zipDirectory(buf);
    return d.error ? { error: d.error } : { entries: d.items.length, unzippedBytes: d.unzippedBytes };
  }

  /** zipSummary の中身。目次の各項目 { name, flags, method, comp, size, local } も返す */
  function zipDirectory(buf) {
    var b = bytesOf(buf);
    if (!b || b.length < 22) return { error: ERR_NOT_XLSX };
    var v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    // 終わりの印（0x06054b50）を後ろから探す（後ろに付けられるコメントは 65535 バイトまで）
    var eocd = -1;
    for (var i = b.length - 22, stop = Math.max(0, b.length - 22 - 65535); i >= stop; i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { error: ERR_NOT_XLSX };
    // ZIP64（大きなファイル用の形）は受け付けない
    if (eocd >= 20 && v.getUint32(eocd - 20, true) === 0x07064b50) return { error: ERR_NOT_XLSX };
    var disk = v.getUint16(eocd + 4, true), cdDisk = v.getUint16(eocd + 6, true);
    var onDisk = v.getUint16(eocd + 8, true), total = v.getUint16(eocd + 10, true);
    var cdSize = v.getUint32(eocd + 12, true), cdOffset = v.getUint32(eocd + 16, true);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { error: ERR_NOT_XLSX };
    if (disk !== 0 || cdDisk !== 0 || onDisk !== total || total === 0) return { error: ERR_NOT_XLSX };
    // 目次は終わりの印のすぐ前に、隙間なく置かれていること（隙間があると、ExcelJS の中の JSZip は隙間の分ずらして別の目次を読む。
    // そうなると、ここで確かめた目次と ExcelJS が読む目次が違ってしまう）
    if (cdOffset + cdSize !== eocd) return { error: ERR_NOT_XLSX };
    if (total > BULK_BOOK.ZIP_ENTRIES_MAX) return { error: ERR_TOO_BIG };
    var p = cdOffset, end = cdOffset + cdSize, sum = 0, items = [];
    for (var n = 0; n < total; n++) {
      if (p + 46 > end || v.getUint32(p, true) !== 0x02014b50) return { error: ERR_NOT_XLSX };
      var comp = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true), local = v.getUint32(p + 42, true);
      if (comp === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return { error: ERR_NOT_XLSX };
      if (size > BULK_BOOK.ENTRY_MAX_BYTES) return { error: ERR_TOO_BIG };
      sum += size;
      if (sum > BULK_BOOK.UNZIPPED_MAX_BYTES) return { error: ERR_TOO_BIG };
      var nameLen = v.getUint16(p + 28, true);
      if (p + 46 + nameLen > end) return { error: ERR_NOT_XLSX };
      var extraLen = v.getUint16(p + 30, true);
      if (p + 46 + nameLen + extraLen + v.getUint16(p + 32, true) > end) return { error: ERR_NOT_XLSX };
      // 名前を置き換える欄（Unicode Path 0x7075）。JSZip はこの欄の名前で読むので、下見の名前と食い違う（Codex 5 回目 medium）。Excel は書かないので断る
      if (hasExtra(v, p + 46 + nameLen, extraLen, 0x7075) !== false) return { error: ERR_NOT_XLSX };
      var nameBytes = b.subarray(p + 46, p + 46 + nameLen);
      var name = latin1(nameBytes);
      // JSZip は名前の中の「.」「..」を解いて読むので、「sub/../sheet1.xml」のような名前ではシートの下見をすり抜けられる（Codex 4 回目 medium）。
      // Excel はこういう名前を書かないので、「.」「..」の区切り・\・頭の /・空の区切りを含む名前は断る
      if (/\\/.test(name) || name.split('/').some(function (s, k, all) { return s === '.' || s === '..' || (s === '' && k !== all.length - 1); })) return { error: ERR_NOT_XLSX };
      items.push({ name: name, nameBytes: nameBytes, flags: v.getUint16(p + 8, true), method: v.getUint16(p + 10, true), comp: comp, size: size, local: local });
      p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    }
    if (p !== end) return { error: ERR_NOT_XLSX };
    return { items: items, unzippedBytes: sum, cdOffset: cdOffset, bytes: b, view: v };
  }

  /** ZIP の追加の欄（start から len バイト）に、番号 id の欄があるか。返り値: true / false、欄の並びが壊れていれば null */
  function hasExtra(v, start, len, id) {
    var q = start, stop = start + len;
    while (q < stop) {
      if (q + 4 > stop) return null;
      var size = v.getUint16(q + 2, true);
      if (q + 4 + size > stop) return null;
      if (v.getUint16(q, true) === id) return true;
      q += 4 + size;
    }
    return false;
  }

  /** 2 つのバイト列が同じか */
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** 名前のバイト列を、1 バイト 1 文字で読む（ExcelJS がシートとして読む名前は英数字だけなので、それで足りる） */
  function latin1(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  // ---------------------------------------------------------------- 開く前の下見（中身を開いて数える）

  var ERR_BROWSER = 'このブラウザでは Excel のファイルを読めません。パソコンの新しい Chrome か Edge で開いてください';
  var ERR_RANGES = 'ファイルの中に、広い範囲のセルの結合・入力規則・条件付き書式があります。列全体などに付けたものを外して保存し直してください（書き出したファイルを使うのがおすすめです）';
  var MAX_ROW = 1048576, MAX_COL = 16384;

  function noop() { /* 何もしない */ }

  function concat(chunks, total) {
    var out = new Uint8Array(total), at = 0;
    chunks.forEach(function (c) { out.set(c, at); at += c.length; });
    return out;
  }

  /**
   * deflate の中身を、数えながら開く。limit を超えたら止める。返り値（Promise）: { data } か { error }。
   * ブラウザの DecompressionStream を使う（無いブラウザでは読まない）
   */
  function inflate(data, limit) {
    var ds;
    try { ds = new DecompressionStream('deflate-raw'); } catch (e) { return Promise.resolve({ error: ERR_BROWSER }); }
    var writer = ds.writable.getWriter();
    writer.write(data).then(noop, noop);
    writer.close().then(noop, noop);
    var reader = ds.readable.getReader();
    var chunks = [], total = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return { data: concat(chunks, total) };
        total += r.value.length;
        if (total > limit) { reader.cancel().then(noop, noop); return { error: ERR_TOO_BIG }; }
        chunks.push(r.value);
        return pump();
      });
    }
    return pump().then(null, function () { return { error: ERR_NOT_XLSX }; });
  }

  /** 列の文字（A〜XFD）→ 番号。読めなければ null */
  function colNumber(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.toUpperCase().charCodeAt(i) - 64);
    return n >= 1 && n <= MAX_COL ? n : null;
  }

  /** 範囲の文字（A1・A1:C3・G:G・2:5。空白で区切って複数）→ マスの数。読めない形は null */
  function rangeArea(text) {
    var tokens = String(text).trim().split(/\s+/).filter(function (s) { return s !== ''; });
    if (!tokens.length) return { area: 0, count: 0 };
    var area = 0;
    for (var i = 0; i < tokens.length; i++) {
      var parts = tokens[i].split(':');
      if (parts.length > 2) return null;
      var ends = [];
      for (var j = 0; j < parts.length; j++) {
        var m = /^\$?([A-Za-z]{1,3})?\$?(\d{1,7})?$/.exec(parts[j]);
        if (!m || (!m[1] && !m[2])) return null;
        var c = m[1] ? colNumber(m[1]) : 0, r = m[2] ? Number(m[2]) : 0;
        if (c === null || r > MAX_ROW || (m[2] && r < 1)) return null;
        ends.push({ c: c, r: r });
      }
      if (ends.length === 1) {
        if (!ends[0].c || !ends[0].r) return null; // 「G」「5」だけは範囲ではない
        area += 1;
        continue;
      }
      // 列が無い（2:5）→ 全部の列、行が無い（G:G）→ 全部の行
      var cols = ends[0].c && ends[1].c ? Math.abs(ends[1].c - ends[0].c) + 1 : MAX_COL;
      var rows = ends[0].r && ends[1].r ? Math.abs(ends[1].r - ends[0].r) + 1 : MAX_ROW;
      area += cols * rows;
    }
    return { area: area, count: tokens.length };
  }

  /**
   * シートの XML の中の、ExcelJS が開くときにマスごとに広げる範囲（セルの結合の ref・入力規則と条件付き書式の sqref・xm:sqref）と、セル（<c>）を数える。
   * 前置き（x: など）が付いた名前・' で囲んだ値も数える（多めに数える）。範囲が読めない形（&#58; などの書き方を含む）は誤り
   */
  function countSheet(xml, acc) {
    var r;
    // 結合・入力規則・条件付き書式の範囲（ref・sqref。前置き付きの属性も数える）
    var ok = eachTag(xml, 'mergeCell|dataValidation|conditionalFormatting', function (attrs) {
      for (var i = 0; i < attrs.length; i++) {
        if (!/^s?q?ref$/.test(attrs[i].local)) continue;
        r = rangeArea(attrs[i].value);
        if (!r) return false;
        acc.area += r.area; acc.ranges += r.count;
      }
      return true;
    });
    if (!ok) return false;
    // <xm:sqref> の中身。中身のすぐ後が閉じるタグでなければ（コメントなどを挟んだもの）断る（Codex 3 回目）
    var ext = /<(?:[\w.-]+:)?sqref(?=[\s>])[^>]*>/g, body = /([^<]*)<\//y;
    while (ext.exec(xml)) {
      body.lastIndex = ext.lastIndex;
      var b = body.exec(xml);
      if (!b) return false;
      r = rangeArea(b[1]);
      if (!r) return false;
      acc.area += r.area; acc.ranges += r.count;
    }
    var cells = xml.match(/<(?:[\w.-]+:)?c(?=[\s\/>])/g);
    acc.cells += cells ? cells.length : 0;
    // 行とセルの番号（<row r>・<c r>）。ExcelJS は行の番号を添字にした配列を作り、数えるときに番号の大きさに比例して時間がかかる（1 億で約 3 秒。Codex 3 回目 medium）。
    // Excel の上限（行 1048576・列 XFD）までの、決まった形だけを認める
    ok = eachTag(xml, 'row|c', function (attrs) {
      for (var i = 0; i < attrs.length; i++) {
        if (attrs[i].local !== 'r') continue;
        var p = /^(?:([A-Z]{1,3}))?(\d{1,7})$/.exec(attrs[i].value);
        if (!p || Number(p[2]) < 1 || Number(p[2]) > MAX_ROW || (p[1] && colNumber(p[1]) === null)) return false;
      }
      return true;
    });
    if (!ok) return false;
    // 列の幅などの指定（<col min max>）。ExcelJS 4.4.0 は開くときに、1 列目から一番右の max まで列を 1 つずつ作る（10 万と書けば 10 万列。Codex medium）。
    // min・max は 1〜XFD の整数で min ≦ max だけ認め（Excel はいつもこの形で書く）、シートごとの一番右の列を合計して数える
    // 前置きの付いた <xdr:col>（絵の位置）などは ExcelJS が列として読まないので、前置きの無い <col> だけを見る（すべての項目にかけるため）
    var widest = 0;
    ok = eachTag(xml, 'col', function (attrs) {
      var v = {};
      for (var i = 0; i < attrs.length; i++) {
        var k = attrs[i].local;
        if (k !== 'min' && k !== 'max') continue;
        if (v[k] !== undefined || !/^\d{1,5}$/.test(attrs[i].value)) return false; // 2 つある・数字だけでない
        v[k] = Number(attrs[i].value);
      }
      if (v.min === undefined || v.max === undefined || v.min < 1 || v.max > MAX_COL || v.min > v.max) return false;
      if (v.max > widest) widest = v.max;
      return true;
    }, true);
    if (!ok) return false;
    acc.cols += widest;
    return true;
  }

  /**
   * xml の中の、名前が names（| で区切る。前置き x: なども当たる）のタグを 1 つずつ読み、属性の一覧 [{ local, value }] を fn に渡す。
   * 値の中の > や偽の属性に惑わされないよう、属性を「名前="値"」の並びとして頭から読む（Codex 2 回目 medium）。
   * 並びとして読めないタグ（値に < がある・引用符が閉じない・知らない書き方）は、XML として読めないものとして false。fn が false を返しても false。
   * plain が真なら、前置きの無いタグだけを読む
   */
  function eachTag(xml, names, fn, plain) {
    var start = new RegExp('<' + (plain ? '' : '(?:[\\w.-]+:)?') + '(?:' + names + ')(?=[\\s/>])', 'g');
    var whole = /((?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*\/?>/y;
    var one = /\s+([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var m, w, a;
    while ((m = start.exec(xml))) {
      whole.lastIndex = start.lastIndex;
      if (!(w = whole.exec(xml))) return false;
      var attrs = [];
      one.lastIndex = 0;
      while ((a = one.exec(w[1]))) attrs.push({ local: a[1].split(':').pop(), value: a[2] !== undefined ? a[2] : a[3] });
      if (fn(attrs) === false) return false;
      start.lastIndex = whole.lastIndex;
    }
    return true;
  }

  /** XML の文字の書き方（&amp; &#36; など）を元の文字に戻す。知らない書き方は null */
  function xmlText(s) {
    var bad = false;
    var out = s.replace(/&(#x[0-9A-Fa-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);|&/g, function (all, k) {
      if (!k) { bad = true; return ''; }
      if (k.charAt(0) !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k];
      var n = k.charAt(1) === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      if (n > 0x10FFFF) { bad = true; return ''; }
      return String.fromCodePoint(n);
    });
    return bad ? null : out;
  }

  /**
   * ブックの名前の付いた範囲（<definedName>）の面積を数える。ExcelJS 4.4.0 は開くときに、「$A$1」の形を含む範囲をマスごとに広げる（Codex 2 回目 medium）。
   * ExcelJS の番号の読み方は甘い（小文字や記号を飛ばす・行の番号に上限が無い）ので、中身に $ があれば、Excel が書く決まった形だけを認める:
   *   「シート名!範囲」をカンマでつないだもの。シート名は ' で囲んだもの（中の ' は ''、! は不可）か、記号を含まない名前で、省いてもよい。
   *   範囲は A1・$A$1:$J$100（大文字・列 XFD・行 1048576 まで。マスの数を数える）と、$A:$C・$1:$1（列だけ・行だけ。ExcelJS は広げないので 0）
   * $ が無ければ、ExcelJS は広げないので数えない（式などの名前）。返り値: 面積（決まった形でないものがあれば null）
   */
  function countNames(xml) {
    var open = /<(?:[\w.-]+:)?definedName(?=[\s/>])(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/g;
    var close = /<\/(?:[\w.-]+:)?definedName\s*>/g;
    var token = /^(?:(?:'(?:[^'!]|'')+'|[^\s!'",:$()]+)!)?(?:(\$?[A-Z]{1,3}\$?\d{1,7}(?::\$?[A-Z]{1,3}\$?\d{1,7})?)|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d{1,7}:\$?\d{1,7})$/;
    var m, c, total = 0;
    while ((m = open.exec(xml))) {
      if (m[0].charAt(m[0].length - 2) === '/') continue; // <definedName .../>（中身が無い）
      close.lastIndex = open.lastIndex;
      if (!(c = close.exec(xml))) return null;
      var inner = xml.slice(open.lastIndex, c.index);
      open.lastIndex = c.index + c[0].length;
      // 中身に < があれば（コメント・処理命令・CDATA・別のタグ）断る。中の </definedName> で数えるのを打ち切られないため（Codex 3 回目 medium）。Excel は中身に < を書かない
      if (inner.indexOf('<') >= 0) return null;
      var text = xmlText(inner);
      if (text === null) return null;
      if (text.indexOf('$') < 0) continue;
      var parts = splitNameText(text);
      for (var i = 0; i < parts.length; i++) {
        var t = token.exec(parts[i]);
        if (!t) return null;
        if (!t[1]) continue;
        var r = rangeArea(t[1]);
        if (!r || r.area < 1) return null;
        total += r.area;
      }
      if (total > BULK_BOOK.NAME_CELLS_MAX) return total;
    }
    return total;
  }

  /** 名前の中身を、' の外のカンマで分ける（ExcelJS と同じ分け方） */
  function splitNameText(text) {
    var out = [], cur = '', quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === "'") quoted = !quoted;
      if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  /**
   * ZIP の中身を、ExcelJS（の中の JSZip）と同じ場所から、数えながら全部開いて確かめる。返り値（Promise）: { ok: true } か { error }
   *   ・実際に開いた大きさで、1 項目 ENTRY_MAX_BYTES・合計 UNZIPPED_MAX_BYTES まで（目次の数字と違えば、嘘の目次として断る）
   *   ・シートの XML の結合・入力規則・条件付き書式の範囲の面積の合計が RANGE_CELLS_MAX まで、その数が RANGES_MAX まで、セルの数が CELL_TAGS_MAX まで、
   *     列の指定（<col>）で作られる列の数の合計が COL_DEFS_MAX まで、名前の付いた範囲のマスの数の合計が NAME_CELLS_MAX まで
   * ExcelJS 4.4.0 は開くときに、結合と入力規則の範囲をマスごとに広げる（列全体なら 100 万マス）ので、開く前に断る
   */
  function scanParts(dir) {
    if (typeof DecompressionStream !== 'function' || typeof TextDecoder !== 'function') return Promise.resolve({ error: ERR_BROWSER });
    var b = dir.bytes, v = dir.view;
    var acc = { area: 0, ranges: 0, cells: 0, cols: 0, names: 0 }, total = 0;
    var i = 0;
    function next() {
      if (i >= dir.items.length) return Promise.resolve({ ok: true });
      var it = dir.items[i++];
      // 暗号化した項目・知らない縮め方は読まない
      if (it.flags & 1) return Promise.resolve({ error: ERR_NOT_XLSX });
      if (it.method !== 0 && it.method !== 8) return Promise.resolve({ error: ERR_NOT_XLSX });
      var h = it.local;
      if (h + 30 > dir.cdOffset || v.getUint32(h, true) !== 0x04034b50) return Promise.resolve({ error: ERR_NOT_XLSX });
      var localNameLen = v.getUint16(h + 26, true), localExtraLen = v.getUint16(h + 28, true);
      var start = h + 30 + localNameLen + localExtraLen;
      if (start > dir.cdOffset) return Promise.resolve({ error: ERR_NOT_XLSX });
      // JSZip は中の見出し（ローカルヘッダー）の名前で読み直すので、目次の名前と 1 バイトでも違えば断る。見出しの名前を置き換える欄も断る（Codex 5 回目 medium）
      if (!sameBytes(b.subarray(h + 30, h + 30 + localNameLen), it.nameBytes)) return Promise.resolve({ error: ERR_NOT_XLSX });
      if (hasExtra(v, h + 30 + localNameLen, localExtraLen, 0x7075) !== false) return Promise.resolve({ error: ERR_NOT_XLSX });
      if (start + it.comp > dir.cdOffset) return Promise.resolve({ error: ERR_NOT_XLSX });
      var raw = b.subarray(start, start + it.comp);
      var limit = Math.min(BULK_BOOK.ENTRY_MAX_BYTES, BULK_BOOK.UNZIPPED_MAX_BYTES - total);
      var opened = it.method === 0 ? Promise.resolve(raw.length > limit ? { error: ERR_TOO_BIG } : { data: raw }) : inflate(raw, limit);
      return opened.then(function (o) {
        if (o.error) return { error: o.error };
        if (o.data.length !== it.size) return { error: ERR_NOT_XLSX }; // 目次の大きさが中身と違う（嘘の目次）
        total += o.data.length;
        var xml;
        try { xml = new TextDecoder('utf-8').decode(o.data); } catch (e) { return { error: ERR_NOT_XLSX }; }
        // シートの番号（<sheet sheetId>）。ExcelJS はこの番号を配列の添字にし、名前でシートを探すたびに番号の大きさに比例して時間がかかる（1 億で約 6 秒。Codex 4 回目 medium）。
        // 1〜SHEET_ID_MAX の数字だけを認める。どの項目にあっても見る
        if (xml.indexOf('<') >= 0 && !eachTag(xml, 'sheet', function (attrs) {
          for (var k = 0; k < attrs.length; k++) {
            if (attrs[k].local !== 'sheetId') continue;
            if (!/^\d{1,5}$/.test(attrs[k].value) || Number(attrs[k].value) < 1 || Number(attrs[k].value) > BULK_BOOK.SHEET_ID_MAX) return false;
          }
          return true;
        })) return { error: ERR_NOT_XLSX };
        // 名前の付いた範囲は、ExcelJS が読む xl/workbook.xml だけでなく、どの項目にあっても数える（多めに数える）
        if (xml.indexOf('definedName') >= 0) {
          var named = countNames(xml);
          if (named === null) return { error: ERR_NOT_XLSX };
          acc.names += named;
          if (acc.names > BULK_BOOK.NAME_CELLS_MAX) return { error: ERR_TOO_BIG };
        }
        // シートの中身の数え方は、名前に関係なくすべての項目にかける（名前のずれで下見をすり抜けられないため。Codex 4・5 回目。多めに数える）
        if (!countSheet(xml, acc)) return { error: ERR_NOT_XLSX };
        if (acc.area > BULK_BOOK.RANGE_CELLS_MAX || acc.ranges > BULK_BOOK.RANGES_MAX) return { error: ERR_RANGES };
        if (acc.cells > BULK_BOOK.CELL_TAGS_MAX || acc.cols > BULK_BOOK.COL_DEFS_MAX) return { error: ERR_TOO_BIG };
        return next();
      });
    }
    return next();
  }

  /** 開く前の下見の全部（目次 → 中身）。返り値（Promise）: { ok: true } か { error } */
  function precheck(buf) {
    var dir = zipDirectory(buf);
    if (dir.error) return Promise.resolve({ error: dir.error });
    return scanParts(dir);
  }

  // ---------------------------------------------------------------- 読む（ExcelJS）

  /** 1枚のシート → { rows: [{ line, cells, errors }] } か { error }。すべてのセルが空の行は飛ばす */
  function readSheet(ws, name) {
    // 行の数を先に見る（列の数は全部の行を回って数えるので、行の番号が大きいと時間がかかる。Codex 3 回目 medium）
    var rowCount = ws.rowCount;
    if (rowCount > BULK_BOOK.ROWS_MAX) return { error: '「' + name + '」のシートの行が多すぎます（' + BULK_BOOK.ROWS_MAX + ' 行まで）' };
    var colCount = ws.columnCount;
    if (colCount > BULK_BOOK.COLS_MAX) return { error: '「' + name + '」のシートの列が多すぎます（' + BULK_BOOK.COLS_MAX + ' 列まで）' };
    var out = [];
    var heads = null; // 見出しの行の文字（誤りの文に列の名前を添える）
    for (var r = 1; r <= rowCount; r++) {
      var row = ws.getRow(r);
      var cells = [], errors = [], any = false;
      for (var c = 1; c <= colCount; c++) {
        var cell = row.getCell(c);
        // 結合したセルは、先頭だけに値があるものとして読む（ほかは空）
        var merged = cell.master && cell.master !== cell && cell.master.address !== cell.address;
        var t = merged ? { text: '' } : cellText(cell.value);
        if (t.error) {
          var head = heads && heads[c - 1] ? '（' + heads[c - 1] + '）' : '';
          errors.push(colLetter(c) + ' 列' + head + ': ' + t.error);
          cells.push('');
        } else {
          cells.push(t.text);
          if (t.text.trim() !== '') any = true;
        }
      }
      if (!any && !errors.length) continue;
      if (!heads) heads = cells.map(function (x) { return x.trim(); });
      out.push({ line: r, cells: cells, errors: errors });
    }
    return { rows: out };
  }

  /**
   * ファイルを読む。下見 → ExcelJS で開く → 「部署」「社員」の2枚だけを行の配列にする（「社員」は見出しを中の名前に直す）。
   * 失敗はすべて { error } で返す（reject しない）
   */
  function read(ExcelJS, buf) {
    return Promise.resolve().then(function () {
      var b = bytesOf(buf);
      if (!b) return { error: ERR_NOT_XLSX };
      if (b.length > BULK_BOOK.FILE_MAX_BYTES) return { error: ERR_TOO_BIG + '（2MB まで）' };
      // ExcelJS には、渡されたバイト列ちょうどの写しを渡す（下見も同じ写しで行う）
      var copy = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return precheck(copy).then(function (z) {
        if (z.error) return { error: z.error };
        return loadBook(ExcelJS, copy);
      });
    }).then(null, function () { return { error: ERR_NOT_XLSX }; });
  }

  /** 下見を通ったファイルを ExcelJS で開き、「部署」「社員」の2枚だけを行の配列にする */
  function loadBook(ExcelJS, copy) {
    var wb = new ExcelJS.Workbook();
    return wb.xlsx.load(copy).then(function () {
      var out = {};
      var want = [[SHEET.DEPT, 'departments'], [SHEET.EMP, 'employees']];
      for (var i = 0; i < want.length; i++) {
        var ws = wb.getWorksheet(want[i][0]);
        if (!ws) return { error: '「' + want[i][0] + '」のシートがありません（書き出したファイルを使ってください）' };
        var s = readSheet(ws, want[i][0]);
        if (s.error) return { error: s.error };
        out[want[i][1]] = s.rows;
      }
      if (out.employees.length) out.employees[0].cells = out.employees[0].cells.map(toInner);
      return out;
    });
  }

  var api = {
    BULK_BOOK: BULK_BOOK, SHEET: SHEET, EMP_BOOK_HEADERS: EMP_BOOK_HEADERS, DEPT_BOOK_HEADERS: DEPT_BOOK_HEADERS,
    STRICT_LISTS: STRICT_LISTS, toInner: toInner, colLetter: colLetter, sheetsOf: sheetsOf, fileName: fileName, build: build, toBlob: toBlob,
    cellText: cellText, zipSummary: zipSummary, precheck: precheck, rangeArea: rangeArea, countNames: countNames, read: read,
  };
  if (root) { root.MP = root.MP || {}; root.MP.bulkBook = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
