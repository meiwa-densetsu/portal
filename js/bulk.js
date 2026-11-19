/*
 * まとめて登録の計算（計画 docs/plans/stage1-bulk-plan.md 第2章・第3章）。画面の部品を使わない純粋な JS（Node のテストでも読み込む）
 *
 *   MP.bulk.exportDepartments(data) / exportEmployees(data) → タブ区切りの文字（前の「貼り付け」のやり方の形。今は画面では使わず、試験が計画の入力に使う）
 *   MP.bulk.planDepartments(text, data) / planEmployees(text, data)
 *     → { fatal: '文' }（表全体の誤り）または { rows: [{ line, label, errors: [], notes: [], ops: [] }], ops: [...], unchanged, errorCount }
 *     ops の1件: { action, args, label, line, group }（group … 同じ社員の「基本」と「履歴」をまとめる印）
 *   data は master.admin.list の答え（employees・departments・today・options）
 *
 * Excel のファイルのやり方（計画 docs/plans/stage1-bulk-excel-plan.md 2-2）で足した分:
 *   planDepartments / planEmployees の1つ目の引数は、行の配列 [{ line, cells, errors }] でもよい（bulk_book.js の read の答え）
 *   MP.bulk.departmentRows(data) / employeeRows(data) → 書き出す行（文字の配列の配列。見出しは含まない）
 *   MP.bulk.afterDepartments(data, 部署の計画) → 部署の計画を当てはめた後の data の写し（新しい部署は仮の ID「NEW-L<行>」）
 *   MP.bulk.planKey(計画, data) → 計画の中身の目印（action と args の全部。部署ID は名前の鍵に置き換える）
 *   MP.bulk.hasTempId(ops) → 仮の ID が残っているか
 *
 * 保険の番号・給与の固定の項目（計画 docs/plans/stage2-employee-fields-plan.md 第4章・10-5・10-8）で足した分:
 *   data.options.payItems がある答え（サーバーの API 9）のときだけ、社員の表に 16 列（PAY_EXTRA_HEADERS）を足す。無ければ今の 12 列のまま
 *   employeeRows(data, { omitPay: true }) … 16 列を入れない（「入れない」で書き出す）
 *   planEmployees(行, data, { knownIds: { 名前の鍵: 社員ID } }) … 前の取り込みで足せていた人（画面を開いている間だけ覚える対応）を、その社員ID の行として扱う
 *
 * 最終の判断はサーバー（ここでの確かめは、保存の前に早めに知らせるため）
 */
(function (root) {
  'use strict';

  /**
   * 列の定義（2026-11-16 から、休憩方式・会社カレンダーは部署で決める。計画 stage1-break-types-plan.md 6-4）。
   * 部署の表: 休憩方式（options.breakTypes のどれか）・会社カレンダー（名前。空は未設定）を足した 6 列
   */
  var DEPT_HEADERS = ['部署ID', '部署の名前', '表示順', '使っている', '休憩方式', '会社カレンダー'];
  var DEPT_BREAK_COL = '休憩方式';
  var DEPT_CAL_COL = '会社カレンダー';
  /** 社員の表: 休憩方式・カレンダーを外した 12 列 */
  var EMP_HEADERS = ['社員ID', '名前', '表示順', '入社日', '生年月日', '適用開始日', '権限', '部署', '閲覧部署', '雇用区分', '1日の所定労働時間', '状態'];
  /** 社員の表で無くてもよい列 */
  var EMP_OPTIONAL = ['状態'];
  /** 16 列を足した社員の表の見出し（28 列。PAY_EXTRA_HEADERS は下で決める） */
  function empPayHeaders() { return EMP_HEADERS.slice(0, EMP_HEADERS.length - 1).concat(PAY_EXTRA_HEADERS, [EMP_HEADERS[EMP_HEADERS.length - 1]]); }
  /**
   * 社員の表で読み飛ばす列（前に書き出した表に残っている 2 列。部署で決まるので使わない）。
   * 知らない列にも足りない列にも数えず、値は読まない。部署の表には渡さない（部署の表では要る列）
   */
  var EMP_SKIPPED = ['休憩方式', 'カレンダー'];
  var SKIPPED_NOTE = '休憩方式・カレンダーの列は、部署で決まるので使いません';
  var HIST_COLS = ['権限', '部署', '閲覧部署', '雇用区分', '1日の所定労働時間'];
  var NAME_MAX = 30;
  var ORDER_MAX = 9999;
  var MINUTES_MAX = 1440;
  var BAD_CHARS = /[\u0000-\u001f\u007f\p{Cf}]/u;

  /**
   * 保険の番号の 3 列と、給与の固定の項目の 13 列（計画 stage2-employee-fields-plan.md 4-1。列の並びは表の順）。
   * 見出しの名前は、サーバーの INSURANCE_ITEMS・PAY_ITEMS の画面での名前（label）と同じ（試験で確かめる）
   */
  var INS_COLS = [
    { col: '健康保険の番号', key: 'healthInsuranceNo' },
    { col: '基礎年金番号', key: 'pensionNo' },
    { col: '雇用保険の番号', key: 'employmentInsuranceNo' },
  ];
  var PAY_COLS = [
    { col: '基本給', key: 'basePay', unit: 'yen' },
    { col: '査定給', key: 'evalPay', unit: 'yen' },
    { col: '奨励金', key: 'incentive', unit: 'yen' },
    { col: '生涯設計前払金', key: 'lifePlanPrepay', unit: 'yen' },
    { col: '役員手当', key: 'officerAllowance', unit: 'yen' },
    { col: '役職手当', key: 'positionAllowance', unit: 'yen' },
    { col: '免許手当', key: 'licenseAllowance', unit: 'yen' },
    { col: '住宅食事手当', key: 'housingMealAllowance', unit: 'yen' },
    { col: '見込み残業手当', key: 'fixedOvertimePay', unit: 'yen' },
    { col: '家族手当', key: 'familyAllowance', unit: 'yen' },
    { col: '交通費', key: 'commute', unit: 'yen' },
    { col: '含み残業時間', key: 'fixedOvertimeMinutes', unit: 'minutes' },
    { col: '夜勤1日あたりの金額', key: 'nightShiftPay', unit: 'yen' },
  ];
  /** 足す 16 列の見出し（「1日の所定労働時間」の後ろ・「状態」の前） */
  var PAY_EXTRA_HEADERS = INS_COLS.map(function (c) { return c.col; }).concat(PAY_COLS.map(function (c) { return c.col; }));
  /** 早めに知らせるための柵（サーバーの RULES.PAY・RULES.INSURANCE と同じ数。答えには入っていないので、ここに置く。最終の判断はサーバー） */
  var PAY_LIMITS = { YEN_MAX: 9999999, MINUTES_MAX: 6000 };
  var INS_LIMITS = { PENSION_DIGITS: 10, EMPLOYMENT_DIGITS: 11, HEALTH_MAX: 30, HEALTH_MIN_DIGITS: 5 };
  var PAY_NEEDS_HIST = '給与の項目を変えるときは、権限〜1日の所定労働時間も入れてください';
  var PAY_DC_KEY = 'lifePlanPrepay';

  // ---------------------------------------------------------------- 名前・日付・時間

  /** サーバーの mst_nameKey_ と同じ比べ方（NFKC → 空白と書式文字を除く → 小文字） */
  function nameKey(name) {
    return String(name).normalize('NFKC').replace(/[\s\p{Cf}]/gu, '').toLowerCase();
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function isRealDate(y, m, d) {
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
    var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return d <= last;
  }

  /** サーバーの dt_isDate_ と同じ: 'yyyy-MM-dd' で実在する日付 */
  function isDateText(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
    return !!m && isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  /**
   * 表の日付を 'yyyy-MM-dd' にする。空 → ''。読めない → null。
   * 受け付ける: 2026/4/1・2026-04-01・2026年4月1日（年は4桁で先頭）。時刻付きは 0:00 のときだけ。
   * 数だけ（Excel の通し番号）・月日が先・2桁の年は変換しない（誤り）
   */
  function parseDate(s) {
    var t = String(s).trim();
    if (t === '') return '';
    var m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:\s+0{1,2}:00(?::00)?)?$/.exec(t) || /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(t);
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (!isRealDate(y, mo, d)) return null;
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }

  /** 1日の所定労働時間を分にする。8:00・7:30・8:00:00・8（時間だけ）。小数・範囲外は null */
  function parseMinutes(s) {
    var t = String(s).trim();
    var m = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(t);
    var n = null;
    if (m && Number(m[2]) < 60) n = Number(m[1]) * 60 + Number(m[2]);
    else if (/^\d{1,2}$/.test(t)) n = Number(t) * 60;
    if (n === null || n < 1 || n > MINUTES_MAX) return null;
    return n;
  }

  function fmtDateOut(s) {
    if (!isDateText(s)) return '';
    var p = s.split('-');
    return Number(p[0]) + '/' + Number(p[1]) + '/' + Number(p[2]);
  }

  function fmtMinutes(n) {
    if (typeof n !== 'number') return '';
    return Math.floor(n / 60) + ':' + pad2(n % 60);
  }

  function fmtDateJa(s) {
    var p = String(s).split('-');
    return Number(p[0]) + '年' + Number(p[1]) + '月' + Number(p[2]) + '日';
  }

  // ---------------------------------------------------------------- 保険の番号・給与の固定の項目（計画 stage2-employee-fields-plan.md 4-2）

  /** サーバーの答えが給与・保険の番号の欄を持つか（1 つ前のサーバーの答え・今の試験の見本 data では偽 → 今の 12 列のまま） */
  function hasPay(data) {
    return !!(data && data.options && Array.isArray(data.options.payItems) && data.options.payItems.length);
  }

  /** 3 けたごとのカンマ（250000 → 250,000） */
  function commas(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /** 給与の値 → 表の文字（書き出しと「変えない」の判定で同じものを使う）。null → 空。読めない値（文字）は、そのままの文字 */
  function payCell(v, unit) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return unit === 'minutes' ? fmtMinutes(v) : String(v);
    return String(v);
  }

  /** 確かめの一覧に出す給与の値 */
  function payLabel(v, unit) {
    if (v === null || v === undefined) return '空';
    if (typeof v === 'number') return unit === 'minutes' ? fmtMinutes(v) : commas(v);
    return '読めない値';
  }

  /** 金額のマスの文字 → { value: 数 | null } か { error }。NFKC → 前後の空白 → 3 けたごとのカンマと末尾の「円」は受け付ける → 0〜上限の整数 */
  function parseYen(s, label) {
    var t = String(s).normalize('NFKC').trim();
    if (t === '') return { value: null };
    t = t.replace(/\s*円$/, '');
    if (!/^(\d+|\d{1,3}(,\d{3})+)$/.test(t)) return { error: label + 'は 0 以上の整数（円）で入れてください' };
    var n = Number(t.replace(/,/g, ''));
    if (!isFinite(n) || n > PAY_LIMITS.YEN_MAX) return { error: label + 'は ' + commas(PAY_LIMITS.YEN_MAX) + ' 円までで入れてください' };
    return { value: n };
  }

  /** 含み残業時間のマスの文字 → { value: 分 | null } か { error }。30:00・30（時間だけ）・7:30。0〜100:00 */
  function parseOtMinutes(s, label) {
    var t = String(s).normalize('NFKC').trim();
    if (t === '') return { value: null };
    var m = /^(\d{1,3}):(\d{2})(?::00)?$/.exec(t);
    var n = null;
    if (m && Number(m[2]) < 60) n = Number(m[1]) * 60 + Number(m[2]);
    else if (/^\d{1,3}$/.test(t)) n = Number(t) * 60;
    if (n === null || n > PAY_LIMITS.MINUTES_MAX) return { error: label + 'は 30:00 の形で、0:00〜' + fmtMinutes(PAY_LIMITS.MINUTES_MAX) + ' で入れてください' };
    return { value: n };
  }

  var INS_HYPHENS = /[-‐‑‒–—―−ー－﹣]/g;

  /**
   * 保険の番号をそろえる（サーバーの ins_normalize_ と同じ決まり）。返り値: { value: そろえた文字（空 = 未登録） } か { error }。
   * 誤りの文に、入れた値を書かない
   */
  function normIns(key, v) {
    var s = String(v).normalize('NFKC').trim();
    if (s === '') return { value: '' };
    if (key === 'pensionNo' || key === 'employmentInsuranceNo') {
      var d = s.replace(INS_HYPHENS, '').replace(/\s/g, '');
      var n = key === 'pensionNo' ? INS_LIMITS.PENSION_DIGITS : INS_LIMITS.EMPLOYMENT_DIGITS;
      if (!new RegExp('^\\d{' + n + '}$').test(d)) return { error: (key === 'pensionNo' ? '基礎年金番号' : '雇用保険の番号') + 'は ' + n + ' けたの数字で入れてください' };
      return { value: key === 'pensionNo' ? d.slice(0, 4) + '-' + d.slice(4) : d.slice(0, 4) + '-' + d.slice(4, 10) + '-' + d.slice(10) };
    }
    if (BAD_CHARS.test(s)) return { error: '健康保険の番号に使えない文字が入っています' };
    var t = s.replace(/[‐‑‒–—―−－﹣]/g, '-').replace(/\s+/g, ' ');
    if (!/^[0-9A-Za-zぁ-ゖァ-ヺー一-鿿々\- ]+$/.test(t) || t.length > INS_LIMITS.HEALTH_MAX) {
      return { error: '健康保険の番号は、数字・英字・かな・漢字・ハイフンで ' + INS_LIMITS.HEALTH_MAX + ' 文字まで入れてください' };
    }
    if (t.replace(/\D/g, '').length < INS_LIMITS.HEALTH_MIN_DIGITS) return { error: '健康保険の番号は、数字を ' + INS_LIMITS.HEALTH_MIN_DIGITS + ' けた以上ふくめて入れてください' };
    return { value: t };
  }

  /** 履歴の行の給与の値（一覧の答えの h.pay。無ければ null） */
  function payOf(h, key) {
    var p = h && h.pay && typeof h.pay === 'object' ? h.pay : null;
    return p && Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined ? p[key] : null;
  }

  function isKeep(v) { return !!v && typeof v === 'object' && v.keep === true; }

  /** 給与の値どうしが同じか（数・null・読めない値の文字） */
  function samePay(a, b) { return (a === undefined ? null : a) === (b === undefined ? null : b); }

  // ---------------------------------------------------------------- 履歴

  /**
   * サーバーの mst_effective_ と同じ決まり。返り値:
   *   { row } … その日に効いている行 / { none: true } … その日以前の行が無い /
   *   { broken: '理由' } … 同じ適用開始日の行が2つ以上・日付の形でない行・権限の値が正しくない（勝手に選ばない）
   */
  function effective(history, date, roles) {
    var best = null, dup = false;
    for (var i = 0; i < history.length; i++) {
      var h = history[i];
      if (typeof h.since !== 'string' || !isDateText(h.since)) return { broken: '適用開始日が日付でない行があります' };
      if (h.since > date) continue;
      if (!best || h.since > best.since) { best = h; dup = false; }
      else if (h.since === best.since) dup = true;
    }
    if (!best) return { none: true };
    if (dup) return { broken: '同じ適用開始日の行が2つあります' };
    if (roles.indexOf(best.role) < 0) return { broken: '権限の値が正しくない行があります' };
    return { row: best };
  }

  // ---------------------------------------------------------------- 表の読み書き

  function cellOut(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toTsv(header, rows) {
    return [header].concat(rows).map(function (r) { return r.map(cellOut).join('\t'); }).join('\r\n') + '\r\n';
  }

  /** タブ区切りの文字を行の配列にする（Excel の「"」で囲んだセル〔中にタブ・改行〕も読む）。返り値: [{ line, cells: [...] }] */
  function splitTsv(text) {
    var s = String(text).replace(/\r\n?/g, '\n');
    var out = [], row = [], cell = '', i = 0, line = 1, rowLine = 1, quoted = false, atStart = true;
    while (i < s.length) {
      var c = s[i];
      if (quoted) {
        if (c === '"' && s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        if (c === '"') { quoted = false; i++; continue; }
        if (c === '\n') line++;
        cell += c; i++; continue;
      }
      if (c === '"' && atStart) { quoted = true; atStart = false; i++; continue; }
      if (c === '\t') { row.push(cell); cell = ''; atStart = true; i++; continue; }
      if (c === '\n') { row.push(cell); out.push({ line: rowLine, cells: row }); row = []; cell = ''; atStart = true; line++; rowLine = line; i++; continue; }
      cell += c; atStart = false; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push({ line: rowLine, cells: row }); }
    return out;
  }

  /**
   * 見出しの名前で列を見つける。返り値: { rows: [{ line, get(見出し) }], skipped: [読み飛ばした見出し] } か { fatal }
   * 足りない見出し・知らない見出し・同じ見出し2回 → fatal。空の行は飛ばす。
   * skip … 読み飛ばす見出し（知らない列にも足りない列にも数えず、値は読まない。同じ見出しが 2 回なら、今までどおり止める）
   */
  function readTable(text, headers, optional, skip) {
    // 行の配列（Excel のファイルを読んだもの。計画 stage1-bulk-excel-plan.md 2-2）は、そのまま使う。セルの誤り（errors）のある行は、空でも飛ばさない
    var lines = (Array.isArray(text) ? text : splitTsv(text)).filter(function (r) {
      return r.cells.some(function (c) { return String(c).trim() !== ''; }) || (!!r.errors && r.errors.length > 0);
    });
    if (lines.length && lines[0].errors && lines[0].errors.length) return { fatal: '見出しの行に読めないセルがあります（' + lines[0].errors.join('／') + '）' };
    if (!lines.length) return { fatal: '表が空です。見出しの行（1行目）は消さないでください（書き出したファイルを使ってください）' };
    var head = lines[0].cells.map(function (c) { return String(c).trim(); });
    var index = {};
    var unknown = [], skipped = [];
    for (var i = 0; i < head.length; i++) {
      var h = head[i];
      if (h === '') continue;
      if (Object.prototype.hasOwnProperty.call(index, h) || skipped.indexOf(h) >= 0) return { fatal: '見出し「' + h + '」が2つあります' };
      if ((skip || []).indexOf(h) >= 0) { skipped.push(h); continue; }
      if (headers.indexOf(h) < 0) unknown.push(h);
      index[h] = i;
    }
    if (unknown.length) return { fatal: '知らない列があります: ' + unknown.join('、') + '（使わない列は消してください。見出しの名前は、書き出したファイルから変えないでください）' };
    var missing = headers.filter(function (h) { return (optional || []).indexOf(h) < 0 && !Object.prototype.hasOwnProperty.call(index, h); });
    if (missing.length) return { fatal: '列がありません: ' + missing.join('、') + '（見出しの名前は、書き出したファイルから変えないでください）' };
    return {
      has: function (h) { return Object.prototype.hasOwnProperty.call(index, h); },
      skipped: skipped,
      rows: lines.slice(1).map(function (r) {
        return {
          line: r.line,
          errors: r.errors ? r.errors.slice() : [],
          get: function (h) { return Object.prototype.hasOwnProperty.call(index, h) ? String(r.cells[index[h]] === undefined ? '' : r.cells[index[h]]).trim() : ''; },
        };
      }),
    };
  }

  function nameError(name, what) {
    if (!name || name.length > NAME_MAX) return what + 'は1〜' + NAME_MAX + '文字で入れてください';
    if (BAD_CHARS.test(name)) return what + 'に使えない文字が入っています';
    return '';
  }

  function parseOrder(s) {
    return /^\d{1,4}$/.test(s) && Number(s) >= 1 && Number(s) <= ORDER_MAX ? Number(s) : null;
  }

  function str(v) { return v === null || v === undefined ? '' : Array.isArray(v) ? v.join(',') : String(v); }

  function summarize(rows) {
    var ops = [], unchanged = 0, errorCount = 0;
    rows.forEach(function (r) {
      if (r.errors.length) errorCount += r.errors.length;
      else if (!r.ops.length) unchanged++;
      else ops = ops.concat(r.ops);
    });
    return { rows: rows, ops: errorCount ? [] : ops, unchanged: unchanged, errorCount: errorCount };
  }

  // ---------------------------------------------------------------- 部署

  /** 書き出す行（見出しは含まない。値はすべて文字）。タブ区切りの書き出しと Excel のファイル（bulk_book.js）で同じものを使う */
  function departmentRows(data) {
    return data.departments.map(function (d) {
      return [d.deptId, d.name, d.order === null ? '' : d.order, d.active ? 'はい' : 'いいえ', d.breakType || '', d.calendarId ? calNameOf(data, d.calendarId) : ''].map(str);
    });
  }

  function exportDepartments(data) {
    return toTsv(DEPT_HEADERS, departmentRows(data));
  }

  function parseActive(s) {
    var t = s.trim().toUpperCase();
    if (['はい', '○', '〇', 'TRUE'].indexOf(t) >= 0) return true;
    if (['いいえ', '×', 'FALSE'].indexOf(t) >= 0) return false;
    return null;
  }

  function planDepartments(text, data) {
    var t = readTable(text, DEPT_HEADERS);
    if (t.fatal) return { fatal: t.fatal };
    var byId = {};
    data.departments.forEach(function (d) { byId[d.deptId] = d; });
    var seenId = {};
    var rows = t.rows.map(function (r) {
      var row = { line: r.line, label: '', errors: r.errors.slice(), notes: [], ops: [] };
      var id = r.get('部署ID');
      var name = r.get('部署の名前');
      row.label = (id || '新しい部署') + ' ' + name;
      var cur = null;
      if (id) {
        if (seenId[id]) row.errors.push('同じ部署ID が2回あります');
        seenId[id] = true;
        cur = Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null;
        if (!cur) row.errors.push('部署ID「' + id + '」の部署はありません（新しい部署なら部署ID を空にしてください）');
      }
      var changedName = !cur || cur.name !== name;
      var ne = changedName ? nameError(name, '部署の名前') : '';
      if (ne) row.errors.push(ne);
      // 表示順が空の古い行は、空のまま（変えない）なら誤りにしない
      var orderText = r.get('表示順');
      var keepNullOrder = !!cur && cur.order === null && orderText === '';
      var order = keepNullOrder ? null : parseOrder(orderText);
      if (order === null && !keepNullOrder) row.errors.push('表示順は 1〜' + ORDER_MAX + ' の整数で入れてください');
      var activeText = r.get('使っている');
      var active = activeText === '' && !cur ? true : parseActive(activeText);
      if (active === null) row.errors.push('「使っている」は「はい」か「いいえ」で入れてください');
      else if (!cur && active === false) row.errors.push('新しい部署は「使っている」を「はい」にしてください');
      // 休憩方式・会社カレンダー（計画 stage1-break-types-plan.md 6-4）。
      // 送るときは 2 つそろえて送る（片方だけはサーバーが断る）。今ある部署で、休憩方式が空のまま・カレンダーも同じなら、2 つとも送らない（触らない。未設定の部署を往復で誤りにしない）
      var curBreak = cur ? str(cur.breakType) : '', curCal = cur ? str(cur.calendarId) : '';
      var breakText = r.get(DEPT_BREAK_COL);
      var calId = null;
      var calText = r.get(DEPT_CAL_COL);
      if (calText === '') calId = '';
      else {
        var rc = resolveCalendar(data, calText, cur ? [curCal] : []);
        if (rc.error) row.errors.push('会社カレンダー: ' + rc.error);
        else calId = rc.id;
      }
      var withRules = !cur || breakText !== curBreak || (calId !== null && calId !== curCal);
      if (withRules && data.options.breakTypes.indexOf(breakText) < 0) {
        row.errors.push('休憩方式は ' + data.options.breakTypes.join('・') + ' のどれかにしてください' + (breakText === '' ? '（部署には必ず入れます）' : ''));
      }
      row._name = name; row._cur = cur; row._changedName = changedName;
      if (row.errors.length) return row;
      var next = { name: name, order: order, active: active };
      if (withRules) { next.breakType = breakText; next.calendarId = calId; }
      var calLabel = function (id) { return id ? calNameOf(data, id) : '未設定'; };
      if (!cur) {
        row.ops.push({ action: 'master.admin.saveDepartment', args: { deptId: null, base: null, next: next },
          label: '部署を足す: ' + name + '（' + breakText + '・カレンダー ' + calLabel(calId) + '）', line: r.line, group: 'L' + r.line });
      } else if (cur.name !== name || str(cur.order) !== str(order) || cur.active !== active || withRules) {
        if (order === null) { row.errors.push('部署を直すときは、表示順も 1〜' + ORDER_MAX + ' の整数で入れてください'); return row; }
        var what = [];
        if (cur.name !== name) what.push('名前 ' + cur.name + ' → ' + name);
        if (str(cur.order) !== str(order)) what.push('表示順 ' + str(cur.order) + ' → ' + order);
        if (cur.active !== active) what.push(active ? '使う' : '使わない');
        if (withRules && breakText !== curBreak) what.push('休憩方式 ' + (curBreak || '未設定') + ' → ' + breakText);
        if (withRules && calId !== curCal) what.push('カレンダー ' + calLabel(curCal) + ' → ' + calLabel(calId));
        var base = { name: cur.name, order: cur.order, active: cur.active };
        if (withRules) { base.breakType = curBreak; base.calendarId = curCal; }
        row.ops.push({ action: 'master.admin.saveDepartment', args: { deptId: cur.deptId, base: base, next: next },
          label: '部署を直す（' + cur.deptId + '）: ' + what.join('・'), line: r.line, group: 'L' + r.line });
      }
      return row;
    });
    // 名前の重なり: 名前を変える・足す行の名前が、他の部署の今の名前・表の他の行の名前と見た目が同じ → 誤り
    rows.forEach(function (row) {
      if (row.errors.length || !row._changedName) return;
      var key = nameKey(row._name);
      var clash = data.departments.some(function (d) { return d !== row._cur && nameKey(d.name) === key; }) ||
        rows.some(function (o) { return o !== row && o._name !== undefined && nameKey(o._name) === key; });
      if (clash) { row.errors.push('同じ名前の部署があります（使っていない部署も含みます）。別の名前にしてください'); row.ops = []; }
    });
    return summarize(rows);
  }

  // ---------------------------------------------------------------- 社員

  function deptNameOf(data, id) {
    var d = data.departments.filter(function (x) { return x.deptId === id; })[0];
    return d ? d.name : '';
  }

  function statusText(e) {
    if (!e.active) return e.suspendedOn ? '利用停止中' : '作成中';
    if (!e.history.length) return '履歴なし';
    if (e.tempPassword) return '招待待ち';
    return '利用中';
  }

  /** 履歴の行を、表の 5 つの列（権限〜1日の所定労働時間。HIST_COLS の順）の文字にする（書き出しと「変えない」の判定で同じものを使う） */
  function histCells(data, h) {
    return [h.role || '', deptNameOf(data, h.deptId), (h.viewDeptIds || []).map(function (id) { return deptNameOf(data, id); }).join('、'),
      h.employmentType || '', fmtMinutes(h.dailyMinutes)];
  }
  var EMPTY_HIST = HIST_COLS.map(function () { return ''; });

  function calNameOf(data, id) {
    var c = (data.calendars || []).filter(function (x) { return x.calendarId === id; })[0];
    return c ? c.name : '';
  }

  /** 給与の 13 列の文字（PAY_COLS の順）。行が無ければ全部空 */
  function payCells(h) {
    return PAY_COLS.map(function (c) { return h ? payCell(payOf(h, c.key), c.unit) : ''; });
  }

  /** 保険の番号の 3 列の文字（INS_COLS の順。一覧の答えの e.insurance。全部の桁） */
  function insCells(e) {
    var ins = e && e.insurance && typeof e.insurance === 'object' ? e.insurance : {};
    return INS_COLS.map(function (c) { return str(ins[c.key]); });
  }

  /** 社員の表の見出し（中の名前）。給与・保険の番号の列は、サーバーの答えが持っていて、入れない（omitPay）を選んでいないときだけ */
  function employeeHeaders(data, opt) {
    return hasPay(data) && !(opt && opt.omitPay) ? empPayHeaders() : EMP_HEADERS.slice();
  }

  /**
   * 書き出す行（見出しは含まない。値はすべて文字。列の順は employeeHeaders）。
   * 給与は今日に効く行の値（読めない値はそのままの文字。計画 10-5）、保険の番号は全部の桁
   */
  function employeeRows(data, opt) {
    var withPay = hasPay(data) && !(opt && opt.omitPay);
    return data.employees.map(function (e) {
      var ef = effective(e.history, data.today, data.options.roles);
      var cells = ef.row ? histCells(data, ef.row) : EMPTY_HIST;
      var extra = withPay ? insCells(e).concat(payCells(ef.row || null)) : [];
      return [e.employeeId, e.name, e.order === null ? '' : e.order, fmtDateOut(e.joinDate), fmtDateOut(e.birthDate), ''].concat(cells)
        .concat(extra, [statusText(e)]).map(str);
    });
  }

  function exportEmployees(data) {
    return toTsv(employeeHeaders(data), employeeRows(data));
  }

  /**
   * カレンダーの名前から ID を決める（部署と同じ決まり）。使っていないカレンダーは、今の値と同じ（allowIds）ときだけ。
   * 名前を変えた後の前の名前は「ありません」の誤り
   */
  function resolveCalendar(data, name, allowIds) {
    var key = nameKey(name);
    var hits = (data.calendars || []).filter(function (c) { return nameKey(c.name) === key; });
    if (hits.length > 1) return { error: '「' + name + '」という名前のカレンダーが2つあります（カレンダーの名前を直してください）' };
    if (!hits.length) return { error: '「' + name + '」というカレンダーがありません（名前を変えたときは、ファイルを書き出し直してください）' };
    if (hits[0].active || (allowIds || []).indexOf(hits[0].calendarId) >= 0) return { id: hits[0].calendarId };
    return { error: '「' + name + '」は使っていないカレンダーです' };
  }

  /**
   * 部署の名前から部署ID を決める。使っている部署で見た目が同じものがちょうど1つ → その ID。
   * 使っていない部署は、今の値と同じ（allowIds に入っている）ときだけ認める（往復で変わらない行を誤りにしない）
   */
  function resolveDept(data, name, allowIds) {
    var key = nameKey(name);
    var hits = data.departments.filter(function (d) { return nameKey(d.name) === key; });
    var active = hits.filter(function (d) { return d.active; });
    if (active.length === 1 && hits.length === 1) return { id: active[0].deptId };
    if (hits.length > 1) return { error: '「' + name + '」という名前の部署が2つあります（部署の名前を直してください）' };
    if (!hits.length) return { error: '「' + name + '」という部署がありません（「部署」のシートに書き足してください）' };
    if ((allowIds || []).indexOf(hits[0].deptId) >= 0) return { id: hits[0].deptId };
    return { error: '「' + name + '」は使っていない部署です' };
  }

  /**
   * 1 行の保険の番号を読む。列が無い → 今の値（今の人）・空（新しい人）。返り値: { values: { key: そろえた文字 }, changed: [列の名前] }（誤りは errors に足す）
   */
  function readIns(r, t, cur, errors) {
    var values = {}, changed = [];
    var now = cur ? insCells(cur) : INS_COLS.map(function () { return ''; });
    INS_COLS.forEach(function (c, i) {
      if (!t.has(c.col)) { values[c.key] = now[i]; return; }
      var text = r.get(c.col);
      // 今の値と同じ文字なら変えない（シートを手で直した、今の決まりに合わない値も、往復で誤りにしない）
      if (cur && text === now[i].trim()) { values[c.key] = now[i]; return; }
      var n = normIns(c.key, text);
      if (n.error) { errors.push(n.error); values[c.key] = now[i]; return; }
      values[c.key] = n.value;
      if (n.value !== now[i]) changed.push(c.col);
    });
    return { values: values, changed: changed };
  }

  /**
   * 1 行の給与の 13 個を読む。effRow … その日に効いている今の行（無ければ null）。
   * 列が無い → 「今のまま」（{ keep: true }。新しい人は null）。マスの文字が今の読めない値と同じ → 「今のまま」（計画 10-5）。
   * 返り値: { values: { key: 数 | null | { keep: true } }, changed: [{ c, from, to }] }（誤りは errors に足す）
   */
  function readPay(r, t, cur, effRow, errors) {
    var values = {}, changed = [];
    PAY_COLS.forEach(function (c) {
      var now = effRow ? payOf(effRow, c.key) : null;
      if (!t.has(c.col)) { values[c.key] = cur ? { keep: true } : null; return; }
      var text = r.get(c.col);
      if (cur && typeof now === 'string' && text === now.trim()) { values[c.key] = { keep: true }; return; }
      var p = c.unit === 'minutes' ? parseOtMinutes(text, c.col) : parseYen(text, c.col);
      if (p.error) { errors.push(p.error); values[c.key] = cur ? { keep: true } : null; return; }
      values[c.key] = p.value;
      if (!samePay(p.value, now)) changed.push({ c: c, from: now, to: p.value });
    });
    return { values: values, changed: changed };
  }

  /** 給与の変わる所の文（確かめの一覧）: 給与の項目（基本給 250,000 → 260,000 ほか 2 項目） */
  function payDiffText(changed) {
    var f = changed[0];
    return '給与の項目（' + f.c.col + ' ' + payLabel(f.from, f.c.unit) + ' → ' + payLabel(f.to, f.c.unit) +
      (changed.length > 1 ? ' ほか ' + (changed.length - 1) + ' 項目' : '') + '）';
  }

  /** 生涯設計前払金が確定拠出年金の上限（設定）を超えるときの注意（保存は止めない。計画 4-2） */
  function dcNote(data, values) {
    var limit = data.options.dcLimitYen;
    var v = values[PAY_DC_KEY];
    if (typeof limit !== 'number' || typeof v !== 'number' || v <= limit) return '';
    return '生涯設計前払金（' + commas(v) + ' 円）が、確定拠出年金の上限（' + commas(limit) + ' 円）を超えています（保存はできます）';
  }

  function planEmployees(text, data, opt) {
    var withPay = hasPay(data);
    var t = readTable(text, withPay ? empPayHeaders() : EMP_HEADERS, withPay ? EMP_OPTIONAL.concat(PAY_EXTRA_HEADERS) : EMP_OPTIONAL, EMP_SKIPPED);
    if (t.fatal) return { fatal: t.fatal };
    var o = data.options;
    var byId = {};
    data.employees.forEach(function (e) { byId[e.employeeId] = e; });
    // 前の取り込みで足せていた人（名前の鍵 → 社員ID。画面を開いている間だけの対応。計画 10-8・10-9）
    var known = opt && opt.knownIds && typeof opt.knownIds === 'object' ? opt.knownIds : {};
    var seenId = {};
    var rows = t.rows.map(function (r) {
      var row = { line: r.line, label: '', errors: r.errors.slice(), notes: [], ops: [] };
      var id = r.get('社員ID');
      var name = r.get('名前');
      row.label = (id || '新しい人') + ' ' + name;
      var cur = null;
      if (!id && name && Object.prototype.hasOwnProperty.call(known, nameKey(name))) {
        // 社員ID が空でも、前の取り込みで足せていた人（今の名前も同じ）なら、その人の行として扱う（新しく足さない）
        var kid = known[nameKey(name)];
        var ke = Object.prototype.hasOwnProperty.call(byId, kid) ? byId[kid] : null;
        // 有効でない人（利用停止中・作成中）には補わない。同じ名前の別の人を新しく足せるため、名前だけでは元の行の人か確かめられない
        // （補わないと、下の名前の重なりの確かめで「社員ID を書き足して」と止まる。Codex 実装 1 回目 medium 2）
        if (ke && !ke.active && nameKey(ke.name) === nameKey(name)) {
          row.notes.push('前の取り込みで登録できていた社員ID ' + kid + ' の人は、今は' + (ke.suspendedOn ? '利用停止中' : '作成中') + 'のため、社員ID を自動では補いません。同じ人なら社員ID 欄に ' + kid + ' を入れてください');
        } else if (ke && nameKey(ke.name) === nameKey(name) && !seenId[kid]) {
          id = kid;
          row.label = kid + ' ' + name;
          row.notes.push('この人は前の取り込みで登録できていました（社員ID ' + kid + '）。この行は、その人の行として確かめます');
        }
      }
      if (id) {
        if (seenId[id]) row.errors.push('同じ社員ID が2回あります');
        seenId[id] = true;
        cur = Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null;
        if (!cur) row.errors.push('社員ID「' + id + '」の人はいません（新しい人なら社員ID を空にしてください）');
      }
      row._name = name; row._cur = cur; row._changedName = !cur || cur.name !== name;
      if (row._changedName) { var ne = nameError(name, '名前'); if (ne) row.errors.push(ne); }
      // 表示順が空の古い行は、空のまま（変えない）なら誤りにしない
      var orderText = r.get('表示順');
      var keepNullOrder = !!cur && cur.order === null && orderText === '';
      var order = keepNullOrder ? null : parseOrder(orderText);
      if (order === null && !keepNullOrder) row.errors.push('表示順は 1〜' + ORDER_MAX + ' の整数で入れてください');
      var join = parseDate(r.get('入社日'));
      if (join === null) row.errors.push('入社日は 2026/4/1 の形で入れてください');
      var birth = parseDate(r.get('生年月日'));
      if (birth === null) row.errors.push('生年月日は 2026/4/1 の形で入れてください');
      var sinceText = r.get('適用開始日');
      var since = sinceText === '' ? data.today : parseDate(sinceText);
      if (since === null) row.errors.push('適用開始日は 2026/4/1 の形で入れてください（空なら今日からです）');

      // 履歴（権限〜1日の所定労働時間）: 全部空なら変えない（今の人だけ）。一部だけ空は誤り。
      // ただし今の人で、その日の時点の今の値を書き出したときと同じ文字なら「変えない」（雇用区分などが空の古い行がある人も、往復で誤りにしない）
      var filled = HIST_COLS.filter(function (c) { return r.get(c) !== ''; });
      var wantHist = filled.length > 0;
      // 給与の 13 個（計画 4-2）: 今の値は、その日に効いている行の値。保険の番号は社員の今の値
      var efPay = cur && since ? effective(cur.history, since, o.roles) : { none: true };
      var pay = withPay ? readPay(r, t, cur, efPay.row || null, row.errors) : null;
      var ins = withPay ? readIns(r, t, cur, row.errors) : null;
      var payChanged = !!pay && pay.changed.length > 0;
      if (cur && since) {
        var efNow = effective(cur.history, since, o.roles);
        var curCells = efNow.row ? histCells(data, efNow.row) : EMPTY_HIST;
        // 権限〜所定が今と同じ文字で、給与も変わらなければ「変えない」（給与だけが違えば、履歴を変える）
        if (HIST_COLS.map(function (c) { return r.get(c); }).join('\t') === curCells.join('\t') && !payChanged) wantHist = false;
      }
      if (cur && !filled.length && payChanged) row.errors.push(PAY_NEEDS_HIST);
      if (wantHist && filled.length < HIST_COLS.length && !(filled.length === HIST_COLS.length - 1 && r.get('閲覧部署') === '')) {
        row.errors.push('権限・部署・閲覧部署・雇用区分・1日の所定労働時間は、全部入れるか全部空にしてください（閲覧部署は部長だけ）');
      }
      if (!cur && !wantHist) row.errors.push('新しい人には、権限・部署・雇用区分・1日の所定労働時間を入れてください');

      var ef = cur && since ? effective(cur.history, since, o.roles) : { none: true };
      var broken = !!(cur && wantHist && ef.broken);
      if (broken) row.errors.push('この人の履歴に正しくない行があります（' + ef.broken + '）。社員の管理の画面で直してください');
      var effRow = ef.row || null;
      var next = null;
      var partial = wantHist && filled.length < HIST_COLS.length && !(filled.length === HIST_COLS.length - 1 && r.get('閲覧部署') === '');
      // 履歴の各列の誤りも、他の列の誤りと一緒に全部出す（壊れた履歴・一部だけ空のときは、列ごとの確かめはしない）
      if (wantHist && !broken && !partial && since) {
        var before = row.errors.length;
        var role = r.get('権限');
        if (o.roles.indexOf(role) < 0) row.errors.push('権限は ' + o.roles.join('・') + ' のどれかにしてください');
        var allow = effRow ? [effRow.deptId] : [];
        var dept = resolveDept(data, r.get('部署'), allow);
        if (dept.error) row.errors.push('部署: ' + dept.error);
        var viewNames = r.get('閲覧部署').split(/[、,，]/).map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
        var viewIds = [];
        viewNames.forEach(function (vn) {
          var v = resolveDept(data, vn, effRow ? effRow.viewDeptIds : []);
          if (v.error) row.errors.push('閲覧部署: ' + v.error);
          else if (viewIds.indexOf(v.id) >= 0) row.errors.push('閲覧部署に同じ部署が2回入っています');
          else viewIds.push(v.id);
        });
        if (role === '部長' && !viewNames.length) row.errors.push('部長には、閲覧部署を1つ以上入れてください');
        if (role !== '部長' && viewNames.length) row.errors.push('閲覧部署は、権限が部長のときだけ入れます');
        var et = r.get('雇用区分');
        if (o.employmentTypes.indexOf(et) < 0) row.errors.push('雇用区分は ' + o.employmentTypes.join('・') + ' のどれかにしてください');
        var minutes = parseMinutes(r.get('1日の所定労働時間'));
        if (minutes === null) row.errors.push('1日の所定労働時間は 8:00 の形で入れてください（0:01〜24:00）');
        // 休憩方式・会社カレンダーは送らない（部署で決まる。計画 stage1-break-types-plan.md 6-4）
        if (row.errors.length === before) {
          next = { since: since, role: role, deptId: dept.id, viewDeptIds: viewIds, employmentType: et, dailyMinutes: minutes };
          // 給与の 13 個は、そろえて送る（列が無い・今の読めない値と同じ → 「今のまま」。サーバーが直前の行から写す。計画 10-5）
          if (pay) PAY_COLS.forEach(function (c) { next[c.key] = pay.values[c.key]; });
        }
      }
      if (row.errors.length) return row;

      var group = 'L' + r.line;
      var basicNext = { name: name, order: order, joinDate: join, birthDate: birth };
      if (!cur) {
        var addArgs = { name: name, order: order, joinDate: join, birthDate: birth };
        if (ins) INS_COLS.forEach(function (c) { addArgs[c.key] = ins.values[c.key]; });
        addArgs.history = next;
        var dcA = pay ? dcNote(data, pay.values) : '';
        if (dcA) row.notes.push(dcA);
        row.ops.push({ action: 'master.admin.addEmployee', args: addArgs,
          label: '新しく足す: ' + name + '（' + fmtDateJa(since) + 'から ' + next.role + '・' + deptNameOf(data, next.deptId) + '）', line: r.line, group: group });
        return row;
      }
      if (!cur.active) row.notes.push('この人は' + (cur.suspendedOn ? '利用停止中' : '作成中（追加の途中で止まった人）') + 'です。保存しても使えるようにはなりません。社員の管理の画面で利用の再開をしてください');
      var diffs = [];
      if (cur.name !== name) diffs.push('名前 ' + cur.name + ' → ' + name);
      if (str(cur.order) !== str(order)) diffs.push('表示順 ' + str(cur.order) + ' → ' + order);
      if (str(cur.joinDate) !== join) diffs.push('入社日 ' + (str(cur.joinDate) || '空') + ' → ' + (join || '空'));
      if (str(cur.birthDate) !== birth) diffs.push('生年月日 ' + (str(cur.birthDate) || '空') + ' → ' + (birth || '空'));
      // 保険の番号は、今の値と比べて変わったものだけを送る（どの番号かだけを出し、番号そのものは一覧に出さない）
      var insChanged = !!ins && ins.changed.length > 0;
      if (insChanged) diffs.push('保険の番号（' + ins.changed.join('・') + '）');
      if (diffs.length && order === null) {
        row.errors.push('名前などを変えるときは、表示順も 1〜' + ORDER_MAX + ' の整数で入れてください');
        row.ops = [];
        return row;
      }
      if (diffs.length) {
        var ubase = { name: cur.name, order: cur.order, joinDate: cur.joinDate, birthDate: cur.birthDate };
        if (insChanged) {
          // 番号は 3 つそろえて送る（base は今の値、next は読んだ値。変えない番号は今の値のまま）
          var nowIns = insCells(cur);
          INS_COLS.forEach(function (c, i) { ubase[c.key] = nowIns[i]; basicNext[c.key] = ins.values[c.key]; });
        }
        row.ops.push({ action: 'master.admin.updateEmployee',
          args: { employeeId: cur.employeeId, base: ubase, next: basicNext },
          label: '基本（' + cur.employeeId + '）: ' + diffs.join('・'), line: r.line, group: group, part: 'basic' });
      }
      if (next) {
        var same = effRow && effRow.role === next.role && effRow.deptId === next.deptId && str(effRow.viewDeptIds) === str(next.viewDeptIds) &&
          effRow.employmentType === next.employmentType && effRow.dailyMinutes === next.dailyMinutes && !payChanged;
        if (!same) {
          var sameDay = cur.history.filter(function (h) { return h.since === since; });
          var base = sameDay.length === 1 ? sameDay[0] : null;
          var baseArgs = base ? { since: base.since, role: base.role, deptId: base.deptId, viewDeptIds: base.viewDeptIds, employmentType: base.employmentType, dailyMinutes: base.dailyMinutes } : null;
          // 今ある行を直すときは、給与の base も 13 個そろえて送る（画面が見ていた値。読めない値は文字のまま）
          if (baseArgs && pay) PAY_COLS.forEach(function (c) { baseArgs[c.key] = payOf(base, c.key); });
          var hd = [];
          if (!effRow || effRow.role !== next.role) hd.push('権限 ' + (effRow ? effRow.role : '—') + ' → ' + next.role);
          if (!effRow || effRow.deptId !== next.deptId) hd.push('部署 ' + (effRow ? deptNameOf(data, effRow.deptId) : '—') + ' → ' + deptNameOf(data, next.deptId));
          if (!effRow || str(effRow.viewDeptIds) !== str(next.viewDeptIds)) hd.push('閲覧部署');
          if (!effRow || effRow.employmentType !== next.employmentType) hd.push('雇用区分 → ' + next.employmentType);
          if (!effRow || effRow.dailyMinutes !== next.dailyMinutes) hd.push('所定 → ' + fmtMinutes(next.dailyMinutes));
          var onlyPay = !hd.length && payChanged;
          if (payChanged) hd.push(payDiffText(pay.changed));
          // 金額だけが変わり「いつから」が空 → 今日からになる、と知らせる（給与の締めに合わせるときは日付を入れる。計画 4-2・Q2）
          if (onlyPay && sinceText === '') {
            var tp = data.today.split('-');
            row.notes.push('金額は今日（' + Number(tp[1]) + ' 月 ' + Number(tp[2]) + ' 日）から変わります。給与の締め（21 日）に合わせるときは「いつから」に日付を入れてください');
          }
          var dcH = pay ? dcNote(data, pay.values) : '';
          if (dcH && pay.changed.some(function (x) { return x.c.key === PAY_DC_KEY; })) row.notes.push(dcH);
          row.ops.push({ action: 'master.admin.saveHistory',
            args: base
              ? { employeeId: cur.employeeId, baseSince: since, base: baseArgs, next: next }
              : { employeeId: cur.employeeId, baseSince: null, base: null, next: next },
            label: '履歴（' + cur.employeeId + '）: ' + fmtDateJa(since) + 'から ' + hd.join('・') + (base ? '（その日の行を直す）' : '（行を足す）'),
            line: r.line, group: group, part: 'history' });
        }
      }
      return row;
    });
    // 名前の重なり（見た目が同じ）: 表の行どうし／新しい人と今の全員（利用停止中・作成中も）／名前を変える人と今の有効な人
    rows.forEach(function (row) {
      if (row.errors.length || !row._changedName) return;
      var key = nameKey(row._name);
      var inTable = rows.some(function (x) { return x !== row && x._name !== undefined && nameKey(x._name) === key; });
      var inCur = data.employees.some(function (e) { return e !== row._cur && (row._cur ? e.active : true) && nameKey(e.name) === key; });
      if (inTable || inCur) {
        row.errors.push(row._cur ? '同じ名前の人がいます。「佐藤（工事）」のように区別してください'
          : '同じ名前の人がいます。もう登録済みなら社員ID を書き足してください。別の人なら「佐藤（工事）」のように区別してください');
        row.ops = [];
      }
    });
    var out = summarize(rows);
    // 読み飛ばした列（前に書き出した表の 休憩方式・カレンダー）があれば、画面に 1 行知らせる
    out.skipped = t.skipped.slice();
    if (t.skipped.length) out.note = SKIPPED_NOTE;
    // 無い列（前の版のファイル・列を消したファイル・「入れない」で書き出したファイル）は、その項目を今のまま変えない。そのことを 1 行知らせる（計画 4-2）
    out.missing = withPay ? PAY_EXTRA_HEADERS.filter(function (h) { return !t.has(h); }) : [];
    if (out.missing.length) out.missingNote = 'このファイルには ' + out.missing[0] + (out.missing.length > 1 ? ' など ' + out.missing.length + ' 列' : ' の列') + 'がありません。その項目は今のまま変えません';
    return out;
  }

  // ---------------------------------------------------------------- Excel のファイルのやり方で足した分（計画 stage1-bulk-excel-plan.md 2-2）

  var TEMP_ID = 'NEW-L'; // まだ保存していない新しい部署の仮の ID（本物の部署ID の形「D + 数字」とは重ならない）
  var SAVE_DEPT = 'master.admin.saveDepartment';

  /**
   * 部署の計画を当てはめた後の data の写し（社員の計画を、まだ保存していない新しい部署・名前を変えた部署で確かめるため）。
   * 呼んでよいのは、部署の計画が fatal でなく、誤りの行が1つも無いときだけ（そうでなければ例外 = 呼ぶ側の誤り）。元の data は変えない
   */
  function afterDepartments(data, deptPlan) {
    if (!deptPlan || deptPlan.fatal || deptPlan.errorCount || !Array.isArray(deptPlan.ops)) throw new Error('部署の計画に誤りがあるときは、当てはめられません');
    var depts = data.departments.map(function (d) { return Object.assign({}, d); });
    deptPlan.ops.forEach(function (op) {
      if (op.action !== SAVE_DEPT) throw new Error('部署の計画ではありません');
      var n = op.args.next;
      if (op.args.deptId === null) {
        depts.push({ deptId: TEMP_ID + op.line, name: n.name, order: n.order, active: true, breakType: str(n.breakType), calendarId: str(n.calendarId) });
        return;
      }
      var cur = depts.filter(function (d) { return d.deptId === op.args.deptId; })[0];
      if (!cur) throw new Error('計画の部署が見つかりません');
      cur.name = n.name; cur.order = n.order; cur.active = n.active;
      if (Object.prototype.hasOwnProperty.call(n, 'breakType')) { cur.breakType = n.breakType; cur.calendarId = n.calendarId; }
    });
    return Object.assign({}, data, { departments: depts });
  }

  /** args の中の値を、決まった順の文字にできる形へ写す（鍵は名前の順。部署ID は名前の鍵に。閲覧部署は鍵の順に並べる） */
  function keyValue(v, key, deptKey) {
    if (deptKey && key === 'deptId' && typeof v === 'string') return deptKey(v);
    if (deptKey && key === 'viewDeptIds' && Array.isArray(v)) return v.map(function (x) { return typeof x === 'string' ? deptKey(x) : keyValue(x, '', deptKey); }).sort();
    if (Array.isArray(v)) return v.map(function (x) { return keyValue(x, '', deptKey); });
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).sort().forEach(function (k) { out[k] = keyValue(v[k], k, deptKey); });
      return out;
    }
    return v === undefined ? null : v;
  }

  /**
   * 計画の「中身の目印」。各 op の action と args の全部を、決まった順の文字にしたもの（label は使わない）。
   * 社員の op の中の部署ID（deptId・viewDeptIds）は、その計画に使った data での部署の名前の鍵に置き換える
   * → 仮の ID で立てた計画と、保存の後に本物の ID で立てた計画が、送る中身が同じなら同じ目印になる。data に無い ID は、ID のまま
   */
  function planKey(plan, data) {
    var names = {};
    data.departments.forEach(function (d) { names[d.deptId] = nameKey(d.name); });
    function deptKey(id) { return Object.prototype.hasOwnProperty.call(names, id) ? 'name:' + names[id] : 'id:' + id; }
    var ops = plan && Array.isArray(plan.ops) ? plan.ops : [];
    return JSON.stringify(ops.map(function (op) {
      // 部署の op は仮の ID を持たない（足すときは deptId: null）ので、そのまま
      return { action: op.action, args: keyValue(op.args, '', op.action === SAVE_DEPT ? null : deptKey) };
    }));
  }

  function hasTempIn(v, key) {
    if (typeof v === 'string') return (key === 'deptId' || key === 'viewDeptIds') && v.indexOf(TEMP_ID) === 0;
    if (Array.isArray(v)) return v.some(function (x) { return hasTempIn(x, key); });
    if (v && typeof v === 'object') return Object.keys(v).some(function (k) { return hasTempIn(v[k], k); });
    return false;
  }

  /** op の args のどこか（next・base・history の中も）に、仮の部署ID が残っているか（送る直前の最後の確かめ） */
  function hasTempId(ops) {
    return (ops || []).some(function (op) { return hasTempIn(op.args, ''); });
  }

  var api = {
    DEPT_HEADERS: DEPT_HEADERS, EMP_HEADERS: EMP_HEADERS, EMP_SKIPPED: EMP_SKIPPED, SKIPPED_NOTE: SKIPPED_NOTE, TEMP_ID: TEMP_ID,
    INS_COLS: INS_COLS, PAY_COLS: PAY_COLS, PAY_EXTRA_HEADERS: PAY_EXTRA_HEADERS, PAY_NEEDS_HIST: PAY_NEEDS_HIST, PAY_LIMITS: PAY_LIMITS, INS_LIMITS: INS_LIMITS,
    hasPay: hasPay, employeeHeaders: employeeHeaders, normIns: normIns, parseYen: parseYen, parseOtMinutes: parseOtMinutes,
    departmentRows: departmentRows, employeeRows: employeeRows, afterDepartments: afterDepartments, planKey: planKey, hasTempId: hasTempId,
    nameKey: nameKey, parseDate: parseDate, parseMinutes: parseMinutes, effective: effective, splitTsv: splitTsv, cellOut: cellOut,
    exportDepartments: exportDepartments, exportEmployees: exportEmployees, planDepartments: planDepartments, planEmployees: planEmployees,
    fmtDateJa: fmtDateJa,
  };
  if (root) { root.MP = root.MP || {}; root.MP.bulk = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
