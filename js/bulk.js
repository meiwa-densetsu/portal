/*
 * まとめて登録の計算（計画 docs/plans/stage1-bulk-plan.md 第2章・第3章）。画面の部品を使わない純粋な JS（Node のテストでも読み込む）
 *
 *   MP.bulk.exportDepartments(data) / exportEmployees(data) → Excel に貼れるタブ区切りの文字
 *   MP.bulk.planDepartments(text, data) / planEmployees(text, data)
 *     → { fatal: '文' }（表全体の誤り）または { rows: [{ line, label, errors: [], notes: [], ops: [] }], ops: [...], unchanged, errorCount }
 *     ops の1件: { action, args, label, line, group }（group … 同じ社員の「基本」と「履歴」をまとめる印）
 *   data は master.admin.list の答え（employees・departments・today・options）
 *
 * 最終の判断はサーバー（ここでの確かめは、保存の前に早めに知らせるため）
 */
(function (root) {
  'use strict';

  var DEPT_HEADERS = ['部署ID', '部署の名前', '表示順', '使っている'];
  var EMP_HEADERS = ['社員ID', '名前', '表示順', '入社日', '生年月日', '適用開始日', '権限', '部署', '閲覧部署', '雇用区分', '1日の所定労働時間', '休憩方式', '状態'];
  var EMP_EXPORT_ONLY = ['状態'];
  var HIST_COLS = ['権限', '部署', '閲覧部署', '雇用区分', '1日の所定労働時間', '休憩方式'];
  var NAME_MAX = 30;
  var ORDER_MAX = 9999;
  var MINUTES_MAX = 1440;
  var BAD_CHARS = /[\u0000-\u001f\u007f\p{Cf}]/u;

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
   * 見出しの名前で列を見つける。返り値: { rows: [{ line, get(見出し) }] } か { fatal }
   * 足りない見出し・知らない見出し・同じ見出し2回 → fatal。空の行は飛ばす
   */
  function readTable(text, headers, optional) {
    var lines = splitTsv(text).filter(function (r) { return r.cells.some(function (c) { return String(c).trim() !== ''; }); });
    if (!lines.length) return { fatal: '貼り付けた表が空です。Excel で見出しの行から選んでコピーしてください' };
    var head = lines[0].cells.map(function (c) { return String(c).trim(); });
    var index = {};
    var unknown = [];
    for (var i = 0; i < head.length; i++) {
      var h = head[i];
      if (h === '') continue;
      if (Object.prototype.hasOwnProperty.call(index, h)) return { fatal: '見出し「' + h + '」が2つあります' };
      if (headers.indexOf(h) < 0) unknown.push(h);
      index[h] = i;
    }
    if (unknown.length) return { fatal: '知らない列があります: ' + unknown.join('、') + '（使わない列は消してから貼ってください。見出しの名前は書き出したものから変えないでください）' };
    var missing = headers.filter(function (h) { return (optional || []).indexOf(h) < 0 && !Object.prototype.hasOwnProperty.call(index, h); });
    if (missing.length) return { fatal: '列がありません: ' + missing.join('、') + '（見出しの行から選んでコピーしてください）' };
    return {
      rows: lines.slice(1).map(function (r) {
        return {
          line: r.line,
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

  function exportDepartments(data) {
    return toTsv(DEPT_HEADERS, data.departments.map(function (d) {
      return [d.deptId, d.name, d.order === null ? '' : d.order, d.active ? 'はい' : 'いいえ'];
    }));
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
      var row = { line: r.line, label: '', errors: [], notes: [], ops: [] };
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
      row._name = name; row._cur = cur; row._changedName = changedName;
      if (row.errors.length) return row;
      var next = { name: name, order: order, active: active };
      if (!cur) {
        row.ops.push({ action: 'master.admin.saveDepartment', args: { deptId: null, base: null, next: next }, label: '部署を足す: ' + name, line: r.line, group: 'L' + r.line });
      } else if (cur.name !== name || str(cur.order) !== str(order) || cur.active !== active) {
        if (order === null) { row.errors.push('部署を直すときは、表示順も 1〜' + ORDER_MAX + ' の整数で入れてください'); return row; }
        var what = [];
        if (cur.name !== name) what.push('名前 ' + cur.name + ' → ' + name);
        if (str(cur.order) !== str(order)) what.push('表示順 ' + str(cur.order) + ' → ' + order);
        if (cur.active !== active) what.push(active ? '使う' : '使わない');
        row.ops.push({ action: 'master.admin.saveDepartment', args: { deptId: cur.deptId, base: { name: cur.name, order: cur.order, active: cur.active }, next: next },
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

  /** 履歴の行を、表の6つの列（権限〜休憩方式）の文字にする（書き出しと「変えない」の判定で同じものを使う） */
  function histCells(data, h) {
    return [h.role || '', deptNameOf(data, h.deptId), (h.viewDeptIds || []).map(function (id) { return deptNameOf(data, id); }).join('、'),
      h.employmentType || '', fmtMinutes(h.dailyMinutes), h.breakType || ''];
  }

  function exportEmployees(data) {
    return toTsv(EMP_HEADERS, data.employees.map(function (e) {
      var ef = effective(e.history, data.today, data.options.roles);
      var cells = ef.row ? histCells(data, ef.row) : ['', '', '', '', '', ''];
      return [e.employeeId, e.name, e.order === null ? '' : e.order, fmtDateOut(e.joinDate), fmtDateOut(e.birthDate), ''].concat(cells).concat([statusText(e)]);
    }));
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
    if (!hits.length) return { error: '「' + name + '」という部署がありません（部署の表で登録してから、社員の表を書き出し直してください）' };
    if ((allowIds || []).indexOf(hits[0].deptId) >= 0) return { id: hits[0].deptId };
    return { error: '「' + name + '」は使っていない部署です' };
  }

  function planEmployees(text, data) {
    var t = readTable(text, EMP_HEADERS, EMP_EXPORT_ONLY);
    if (t.fatal) return { fatal: t.fatal };
    var o = data.options;
    var byId = {};
    data.employees.forEach(function (e) { byId[e.employeeId] = e; });
    var seenId = {};
    var rows = t.rows.map(function (r) {
      var row = { line: r.line, label: '', errors: [], notes: [], ops: [] };
      var id = r.get('社員ID');
      var name = r.get('名前');
      row.label = (id || '新しい人') + ' ' + name;
      var cur = null;
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
      if (join === null) row.errors.push('入社日は 2026/4/1 の形で入れてください（Excel では列の書式を「日付」にしてからコピーしてください）');
      var birth = parseDate(r.get('生年月日'));
      if (birth === null) row.errors.push('生年月日は 2026/4/1 の形で入れてください（Excel では列の書式を「日付」にしてからコピーしてください）');
      var sinceText = r.get('適用開始日');
      var since = sinceText === '' ? data.today : parseDate(sinceText);
      if (since === null) row.errors.push('適用開始日は 2026/4/1 の形で入れてください（空なら今日からです）');

      // 履歴（権限〜休憩方式）: 全部空なら変えない（今の人だけ）。一部だけ空は誤り。
      // ただし今の人で、その日の時点の今の値を書き出したときと同じ文字なら「変えない」（雇用区分などが空の古い行がある人も、往復で誤りにしない）
      var filled = HIST_COLS.filter(function (c) { return r.get(c) !== ''; });
      var wantHist = filled.length > 0;
      if (cur && since) {
        var efNow = effective(cur.history, since, o.roles);
        var curCells = efNow.row ? histCells(data, efNow.row) : ['', '', '', '', '', ''];
        if (HIST_COLS.map(function (c) { return r.get(c); }).join('\t') === curCells.join('\t')) wantHist = false;
      }
      if (wantHist && filled.length < HIST_COLS.length && !(filled.length === HIST_COLS.length - 1 && r.get('閲覧部署') === '')) {
        row.errors.push('権限・部署・閲覧部署・雇用区分・1日の所定労働時間・休憩方式は、全部入れるか全部空にしてください（閲覧部署は部長だけ）');
      }
      if (!cur && !wantHist) row.errors.push('新しい人には、権限・部署・雇用区分・1日の所定労働時間・休憩方式を入れてください');

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
        var bt = r.get('休憩方式');
        if (o.breakTypes.indexOf(bt) < 0) row.errors.push('休憩方式は ' + o.breakTypes.join('・') + ' のどれかにしてください');
        if (row.errors.length === before) next = { since: since, role: role, deptId: dept.id, viewDeptIds: viewIds, employmentType: et, dailyMinutes: minutes, breakType: bt };
      }
      if (row.errors.length) return row;

      var group = 'L' + r.line;
      var basicNext = { name: name, order: order, joinDate: join, birthDate: birth };
      if (!cur) {
        row.ops.push({ action: 'master.admin.addEmployee', args: { name: name, order: order, joinDate: join, birthDate: birth, history: next },
          label: '新しく足す: ' + name + '（' + fmtDateJa(since) + 'から ' + next.role + '・' + deptNameOf(data, next.deptId) + '）', line: r.line, group: group });
        return row;
      }
      if (!cur.active) row.notes.push('この人は' + (cur.suspendedOn ? '利用停止中' : '作成中（追加の途中で止まった人）') + 'です。保存しても使えるようにはなりません。社員の管理の画面で利用の再開をしてください');
      var diffs = [];
      if (cur.name !== name) diffs.push('名前 ' + cur.name + ' → ' + name);
      if (str(cur.order) !== str(order)) diffs.push('表示順 ' + str(cur.order) + ' → ' + order);
      if (str(cur.joinDate) !== join) diffs.push('入社日 ' + (str(cur.joinDate) || '空') + ' → ' + (join || '空'));
      if (str(cur.birthDate) !== birth) diffs.push('生年月日 ' + (str(cur.birthDate) || '空') + ' → ' + (birth || '空'));
      if (diffs.length && order === null) {
        row.errors.push('名前などを変えるときは、表示順も 1〜' + ORDER_MAX + ' の整数で入れてください');
        row.ops = [];
        return row;
      }
      if (diffs.length) {
        row.ops.push({ action: 'master.admin.updateEmployee',
          args: { employeeId: cur.employeeId, base: { name: cur.name, order: cur.order, joinDate: cur.joinDate, birthDate: cur.birthDate }, next: basicNext },
          label: '基本（' + cur.employeeId + '）: ' + diffs.join('・'), line: r.line, group: group, part: 'basic' });
      }
      if (next) {
        var same = effRow && effRow.role === next.role && effRow.deptId === next.deptId && str(effRow.viewDeptIds) === str(next.viewDeptIds) &&
          effRow.employmentType === next.employmentType && effRow.dailyMinutes === next.dailyMinutes && effRow.breakType === next.breakType;
        if (!same) {
          var sameDay = cur.history.filter(function (h) { return h.since === since; });
          var base = sameDay.length === 1 ? sameDay[0] : null;
          var hd = [];
          if (!effRow || effRow.role !== next.role) hd.push('権限 ' + (effRow ? effRow.role : '—') + ' → ' + next.role);
          if (!effRow || effRow.deptId !== next.deptId) hd.push('部署 ' + (effRow ? deptNameOf(data, effRow.deptId) : '—') + ' → ' + deptNameOf(data, next.deptId));
          if (!effRow || str(effRow.viewDeptIds) !== str(next.viewDeptIds)) hd.push('閲覧部署');
          if (!effRow || effRow.employmentType !== next.employmentType) hd.push('雇用区分 → ' + next.employmentType);
          if (!effRow || effRow.dailyMinutes !== next.dailyMinutes) hd.push('所定 → ' + fmtMinutes(next.dailyMinutes));
          if (!effRow || effRow.breakType !== next.breakType) hd.push('休憩方式 → ' + next.breakType);
          row.ops.push({ action: 'master.admin.saveHistory',
            args: base
              ? { employeeId: cur.employeeId, baseSince: since, base: { since: base.since, role: base.role, deptId: base.deptId, viewDeptIds: base.viewDeptIds, employmentType: base.employmentType, dailyMinutes: base.dailyMinutes, breakType: base.breakType }, next: next }
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
    return summarize(rows);
  }

  var api = {
    DEPT_HEADERS: DEPT_HEADERS, EMP_HEADERS: EMP_HEADERS,
    nameKey: nameKey, parseDate: parseDate, parseMinutes: parseMinutes, effective: effective, splitTsv: splitTsv,
    exportDepartments: exportDepartments, exportEmployees: exportEmployees, planDepartments: planDepartments, planEmployees: planEmployees,
    fmtDateJa: fmtDateJa,
  };
  if (root) { root.MP = root.MP || {}; root.MP.bulk = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
