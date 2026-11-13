/*
 * 日報（表形式・Excel 風）。手順7。計画 docs/plans/stage1-step7-plan.md 第2章・3-7
 *
 * 締めの期間1回分を表で直し、「保存」で直した日をまとめて送る（report.saveMany）。正しい日だけ保存され、誤りの日は状態の列に理由が出る。
 * 昼・夜の欄のどちらに入れても、保存のときに共有の計算（CalcReport.toSlots）が時刻から振り分け直す。
 * 行ごとの requestId: 中身を変えたら作り直す。結果が分からない（NETWORK・INTERNAL・BUSY）ときは同じものを送り直す（3-7）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var CR = window.CalcReport;
    var CW = window.CalcWorktime;
    var GC = MP.gridCore;
    var T = MP.reportText;
    var DOW = ['日', '月', '火', '水', '木', '金', '土'];
    var COLS = CR.INPUT_COLS;                     // 入力の15列（昼7・夜7・備考。施工内容は勤務ごと: 手順10b）
    var SLOT = { day: '昼_', night: '夜_' };
    var KEYS = { arrive: '出社', start: '開始', end: '終了', leave: '退社', direct: '直行直帰', place: '作業場所', content: '施工内容' };
    var TIME_KEYS = ['arrive', 'start', 'end', 'leave'];
    var CALC = ['実働', '振替・不足', '状態'];
    var VIEW_KEY = 'mp_report_view';

    var me = null, data = null, target = null, grid = null, saving = false;
    var rows = [];   // [{ day, base（サーバーの入力14列）, cur（今の入力）, baseVersion, rid, status, err, server, info }]

    function fmt(min) { return min === null || min === undefined ? '' : CW.formatHm(min); }
    function dateLabel(d) { return Number(d.date.slice(5, 7)) + '/' + Number(d.date.slice(8, 10)) + '（' + DOW[d.dow] + '）'; }
    function emptyInput() { var o = {}; COLS.forEach(function (c) { o[c] = ''; }); return o; }
    function inputOf(row) { var o = emptyInput(); if (row) COLS.forEach(function (c) { o[c] = row[c] === null || row[c] === undefined ? '' : String(row[c]); }); return o; }
    function same(a, b) { return COLS.every(function (c) { return a[c] === b[c]; }); }
    function isDirty(x) { return !same(x.cur, x.base); }
    function anyDirty() { return rows.some(isDirty); }
    function hasInput(inp) { return COLS.some(function (c) { return inp[c] !== ''; }); }
    function remember(v) { try { window.localStorage.setItem(VIEW_KEY, v); } catch (e) { /* 覚えられなくても動く */ } }

    // ------------------------------------------------------------------ 1行の確かめと計算（画面で。最終はサーバー）

    function groupEntry(inp, slot) {
      var e = {};
      Object.keys(KEYS).forEach(function (k) { e[k] = inp[SLOT[slot] + KEYS[k]]; });
      return e;
    }
    function entryEmpty(e) { return Object.keys(KEYS).every(function (k) { return String(e[k]).trim() === ''; }); }

    /** 送る形 { entries, note } と、勤務の番号 → 欄（day・night）の対応 */
    function toSend(inp) {
      var entries = [], from = [];
      ['day', 'night'].forEach(function (s) { var e = groupEntry(inp, s); if (!entryEmpty(e)) { entries.push(e); from.push(s); } });
      return { input: { entries: entries, note: inp['備考'] }, from: from };
    }

    function finalRow(i) {
      if (i < 0) return data.neighbors ? data.neighbors.before.input : null; // 部長が見るだけのときは隣の日は無い
      if (i >= rows.length) return data.neighbors ? data.neighbors.after.input : null;
      var s = CR.toSlots(CR.normalizeDay(toSend(rows[i].cur).input, data.rules), CW, data.rules);
      return s.ok ? s.row : rows[i].base;
    }

    /** その行の誤り（セルごと）・計算・知らせ */
    function analyze(i) {
      var x = rows[i], R = data.rules, out = { cell: {}, first: '', work: null, bal: null, info: '' };
      if (!hasInput(x.cur)) return out;
      var send = toSend(x.cur);
      var put = function (col, msg) { if (!out.cell[col]) out.cell[col] = msg; if (!out.first) out.first = msg; };
      var slots = CR.toSlots(CR.normalizeDay(send.input, R), CW, R);
      if (!slots.ok) {
        slots.errors.forEach(function (e) {
          var msg = T.MESSAGES[e.code] || '入力が正しくありません';
          if (e.entry === null || e.entry === undefined) put('備考', msg);
          else put(SLOT[send.from[Math.min(e.entry, send.from.length - 1)] || 'day'] + KEYS[e.field || 'arrive'], msg);
        });
        return out;
      }
      ['day', 'night'].forEach(function (k) {
        var idx = slots.slotOf[k];
        if (idx === undefined || send.from[idx] === k) return;
        var only = !slots.row['昼_出社'] && !slots.row['夜_出社']; // 時刻の無い施工内容（有給など）は昼の欄に入る（手順10b 2-1）
        out.info = only ? '時刻の無い施工内容は、昼の欄に移ります' : k === 'night' ? '夜勤として保存します（夜の欄に移ります）' : '日勤として保存します（昼の欄に移ります）';
      });
      if (!x.day.canCalc) return out;
      var calc = CR.calcDay(slots.row, { date: x.day.date, breakType: x.day.breakType }, CW, R);
      if (!calc.ok) { out.first = T.MESSAGES[calc.errors[0].code] || '計算できません'; return out; }
      var ov = CR.checkOverlap(finalRow(i - 1), slots.row, finalRow(i + 1), CW, R);
      if (ov.errors.length) {
        var o = ov.errors[0];
        var shown = send.from[slots.slotOf[o.slot]] || o.slot;
        put(SLOT[shown] + KEYS[o.field], T.MESSAGES.OVERLAP + '（' + (T.WITH[o.with] || '') + '）');
        return out;
      }
      out.work = calc.work;
      out.bal = CR.balance(calc.work, x.day.companyScheduled, !!calc.slots.night, CW, R);
      return out;
    }

    // ------------------------------------------------------------------ 表

    var columns = [];
    function buildColumns() {
      columns = [];
      ['day', 'night'].forEach(function (s) {
        Object.keys(KEYS).forEach(function (k) {
          var col = { key: SLOT[s] + KEYS[k], label: KEYS[k], group: s === 'day' ? '昼の勤務' : '夜の勤務', kind: TIME_KEYS.indexOf(k) >= 0 ? 'time' : k === 'direct' ? 'select' : 'text' };
          if (k === 'direct') col.options = CR.DIRECT_VALUES.map(function (v) { return { value: v, text: v === '' ? 'なし' : v }; });
          columns.push(col);
        });
      });
      columns.push({ key: '備考', label: '備考', kind: 'text' });
      CALC.forEach(function (k) { columns.push({ key: k, label: k, kind: 'calc' }); });
    }

    function editable(i, c) {
      var d = rows[i].day;
      return !saving && c < COLS.length && data.editable && d.canCalc && d.date <= data.today &&
        data.firstDate !== null && d.date >= data.firstDate && rows[i].status !== 'conflict';
    }

    function statusText(i, a) {
      var x = rows[i], d = x.day;
      if (x.status === 'conflict') return '他の画面で更新されています（下で選んでください）';
      if (d.date > data.today) return '';
      if (!d.canCalc) return '社員の履歴がありません（管理者へ）';
      if (x.status === 'error' && x.err) return '保存できません: ' + x.err.message;
      if (a.first) return '誤り: ' + a.first;
      if (x.status === 'unknown') return '保存できたか分かりません（もう一度「保存」）';
      if (isDirty(x)) return '保存していない' + (a.info ? '・' + a.info : '');
      if (x.status === 'saved') return '保存しました';
      if (d.needsRecalc) return '計算し直しが要る（管理者）';
      return '';
    }

    var cache = [];
    function analyzeAll() { cache = rows.map(function (x, i) { return analyze(i); }); }

    function display(i, c) {
      var col = columns[c], a = cache[i] || {};
      if (col.key === '実働') return a.work === null || a.work === undefined ? '' : fmt(a.work);
      if (col.key === '振替・不足') {
        if (!a.bal) return '';
        if (a.bal.furikae) return '+' + fmt(a.bal.furikae);
        if (a.bal.shortage) return '−' + fmt(a.bal.shortage);
        return '';
      }
      if (col.key === '状態') return statusText(i, a);
      var v = rows[i].cur[col.key];
      return col.kind === 'select' && v === '' ? '' : v;
    }

    function cellState(i, c) {
      var col = columns[c], x = rows[i], a = cache[i] || {};
      if (col.key === '状態') {
        var t = statusText(i, a);
        var cls = x.status === 'conflict' || (x.status === 'error' && x.err) || a.first ? 'st-err' : x.status === 'unknown' || isDirty(x) ? 'st-dirty' : x.status === 'saved' ? 'st-ok' : '';
        return { cls: cls, title: t };
      }
      if (col.kind === 'calc') return {};
      var msg = a.cell && a.cell[col.key];
      var dirty = x.cur[col.key] !== x.base[col.key];
      return { cls: (msg ? 'err' : '') + (dirty ? ' dirty' : ''), title: msg || '' };
    }

    function change(list) {
      var touched = {};
      list.forEach(function (ch) {
        var col = columns[ch.c];
        if (!col || col.kind === 'calc') return;
        var v = ch.value === null || ch.value === undefined ? '' : String(ch.value);
        if (col.kind === 'time') v = GC.parseLooseTime(v).value;
        if (col.kind === 'select') { var t = v.trim(); v = t === 'なし' ? '' : t; }
        rows[ch.r].cur[col.key] = v;
        touched[ch.r] = true;
      });
      Object.keys(touched).forEach(function (r) {
        var x = rows[r];
        x.rid = null; // 中身を変えたら requestId を作り直す（3-7）
        if (x.status !== 'conflict') { x.status = ''; x.err = null; }
      });
      after();
    }

    function after() {
      analyzeAll();
      if (grid) grid.refresh();
      renderSummary();
    }

    function renderSummary() {
      var work = 0, dirty = 0, errs = 0;
      cache.forEach(function (a, i) { if (a.work) work += a.work; if (isDirty(rows[i])) dirty++; if (a.first || rows[i].status === 'error' || rows[i].status === 'conflict') errs++; });
      var dl = ui.clear(ui.$('totals'));
      [['実働の合計', fmt(work) || '0:00'], ['保存していない日', dirty + '日'], ['誤りのある日', errs + '日']]
        .forEach(function (kv) { dl.appendChild(ui.el('dt', { text: kv[0] })); dl.appendChild(ui.el('dd', { text: kv[1] })); });
      ui.$('save').disabled = saving || !data.editable || MP.guard.viewing(); // 社員の画面を見ている間は保存しない
      renderConflicts();
    }

    function renderConflicts() {
      var list = rows.filter(function (x) { return x.status === 'conflict'; });
      var box = ui.$('conflicts');
      box.hidden = !list.length;
      var ul = ui.clear(ui.$('conflict-list'));
      list.forEach(function (x) {
        ul.appendChild(ui.el('li', {}, [
          ui.el('div', { class: 'item-title', text: dateLabel(x.day) + ' は他の画面で更新されています' }),
          ui.el('div', { class: 'item-actions' }, [
            ui.el('button', { type: 'button', class: 'btn', text: '最新の内容にする', on: { click: function () { resolveConflict(x, false); } } }),
            ui.el('button', { type: 'button', class: 'btn', text: '自分の入力で保存し直す', on: { click: function () { resolveConflict(x, true); } } }),
          ]),
        ]));
      });
    }

    function resolveConflict(x, keepMine) {
      var latest = inputOf(x.server);
      x.base = latest;
      x.baseVersion = x.serverVersion;
      if (!keepMine) x.cur = inputOf(x.server);
      x.day.row = x.server;
      x.status = '';
      x.err = null;
      x.rid = null;
      after();
      ui.pageMessage(keepMine ? dateLabel(x.day) + ' は、次の「保存」であなたの入力を保存します' : dateLabel(x.day) + ' を最新の内容にしました', 'ok');
    }

    // ------------------------------------------------------------------ 読み込み

    function load(date, employee, first) {
      var args = { employeeId: employee, date: date };
      var p = first ? MP.guard.enter({ load: { action: 'report.period', args: args } })
        : MP.api.call('report.period', args).then(function (res) { return { me: me, res: res }; });
      return p.then(function (r) {
        me = r.me;
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        data = r.res.data;
        target = data.employee.employeeId === me.employeeId ? null : data.employee.employeeId;
        rows = data.days.map(function (d) {
          var inp = inputOf(d.row);
          return { day: d, base: inp, cur: inputOf(d.row), baseVersion: d.recordVersion, rid: null, status: '', err: null, server: null, serverVersion: null };
        });
        ui.$('view').hidden = false;
        renderHead();
        buildColumns();
        analyzeAll();
        grid = MP.grid.create(ui.$('grid'), {
          columns: columns, rowCount: rows.length,
          rowHead: function (i) {
            var d = rows[i].day, out = d.state === 'out'; // 部長の範囲外の日
            return { text: dateLabel(d) + (out ? '（範囲外）' : ''), label: dateLabel(d) + (out ? ' 範囲外' : ''), cls: (d.dow === 0 ? 'sun' : d.dow === 6 ? 'sat' : '') + (d.companyType === 'H' ? ' off' : '') };
          },
          value: function (i, c) { var col = columns[c]; return col.kind === 'calc' ? display(i, c) : rows[i].cur[col.key]; },
          display: display, editable: editable, cellState: cellState, change: change,
          notify: function (t, k) { ui.pageMessage(t, k === 'ok' ? 'ok' : 'warn'); },
        });
        var todayRow = 0;
        rows.forEach(function (x, i) { if (x.day.date <= data.today) todayRow = i; });
        grid.select(todayRow, 0);
        renderSummary();
      });
    }

    function renderHead() {
      var admin = MP.guard.isAdmin(me);
      ui.$('title').textContent = target ? data.employee.name + 'さんの日報（表' + (data.viewOnly ? '・見るだけ' : '') + '）' : '日報（表）';
      ui.$('period-label').textContent = data.period.label;
      ui.$('next').disabled = !data.nextDate;
      ui.$('admin-bar').hidden = !admin;
      if (admin) {
        var sel = ui.clear(ui.$('emp-select'));
        (data.employees || []).forEach(function (e) {
          sel.appendChild(ui.el('option', { value: e.employeeId, text: e.name + (e.active ? '' : '（利用停止）'), selected: e.employeeId === data.employee.employeeId }));
        });
        ui.$('other-note').hidden = !target;
        ui.$('other-note').textContent = target ? data.employee.name + 'さんの日報を見ています。直すと修正履歴に残ります。' : '';
      }
      ui.$('use-pattern').hidden = !data.patterns;
      // 締めた期間の知らせ（手順8 2-4。直せるかはサーバーが editable で決める）
      var closed = !!(data.closing && data.closing.closed);
      var note = !closed ? '' : data.editable ? '締めた期間です。直すと修正履歴に残ります。' : 'この期間は締めました。直すときは管理者に頼んでください。';
      ui.$('closed-note').hidden = !note;
      ui.$('closed-note').textContent = note;
      ui.$('to-day').href = 'report.html?view=day&date=' + encodeURIComponent(data.days[0].date) + (target ? '&employee=' + encodeURIComponent(target) : '');
    }

    function confirmLeave() {
      if (!anyDirty()) return Promise.resolve(true);
      return ui.confirm('保存していない入力があります', '入れた内容を捨てて移りますか？', '捨てて移る', 'danger');
    }

    // ------------------------------------------------------------------ 保存（まとめて）

    function doSave() {
      if (grid) grid.commitEdit();
      analyzeAll();
      var send = [], skipped = 0, waiting = 0;
      rows.forEach(function (x, i) {
        if (!isDirty(x) && x.status !== 'unknown') return;
        if (x.status === 'conflict') { waiting++; return; }
        if (!isDirty(x)) return;
        if (cache[i].first) { skipped++; return; }
        if (!x.rid) x.rid = MP.api.newRequestId();
        var s = toSend(x.cur).input;
        send.push({ x: x, day: { date: x.day.date, baseVersion: x.baseVersion, requestId: x.rid, entries: s.entries, note: s.note } });
      });
      if (!send.length) {
        ui.pageMessage(skipped || waiting ? '保存できる日がありません（誤りのある日 ' + skipped + ' 日・他の画面で更新された日 ' + waiting + ' 日）' : '保存していない日はありません', 'warn');
        after();
        return;
      }
      saving = true;
      grid.setLocked(true);
      ui.$('emp-select').disabled = true; // ui.run が止めるのはボタンだけなので、社員の選択も止める
      after();
      ui.run(function () {
        return MP.api.call('report.saveMany', { employeeId: target, days: send.map(function (s) { return s.day; }) }).then(function (res) {
          saving = false;
          grid.setLocked(false);
          ui.$('emp-select').disabled = false;
          if (!res.ok) {
            var unknown = res.code === 'NETWORK' || res.code === 'INTERNAL' || res.code === 'BUSY';
            if (unknown) send.forEach(function (s) { s.x.status = 'unknown'; }); // 同じ requestId のまま次の「保存」で送り直す
            ui.pageMessage(unknown ? '保存できたか分かりません。もう一度「保存」を押してください（同じ内容は二重になりません）' : res.message, 'error');
            after();
            return;
          }
          var byDate = {};
          res.data.results.forEach(function (r) { byDate[r.date] = r; });
          send.forEach(function (s) {
            var x = s.x, r = byDate[x.day.date];
            if (!r) return;
            if (r.status === 'saved' || r.status === 'unchanged') {
              if (r.row) { x.day.row = r.row; x.day.state = r.state; x.base = inputOf(r.row); x.cur = inputOf(r.row); }
              else x.base = Object.assign({}, x.cur);
              if (typeof r.recordVersion === 'number') x.baseVersion = r.recordVersion;
              x.rid = null; x.status = 'saved'; x.err = null;
            } else if (r.code === 'CONFLICT') {
              x.status = 'conflict'; x.server = r.row; x.serverVersion = r.recordVersion; x.err = null; x.rid = null;
            } else {
              x.status = 'error'; x.err = { code: r.code, message: r.message };
            }
          });
          var d = res.data;
          ui.pageMessage(d.saved + ' 日を保存しました' + (d.failed ? '。' + d.failed + ' 日は保存できませんでした（状態の列を見てください）' : '') +
            (skipped ? '。誤りのある ' + skipped + ' 日は送っていません' : ''), d.failed || skipped ? 'warn' : 'ok');
          after();
        });
      });
    }

    // ------------------------------------------------------------------ 元に戻す・前日と同じ・定型パターン・まとめて適用

    function setRows(list, make, what) {
      var n = 0, skip = 0;
      list.forEach(function (i) {
        if (!editable(i, 0)) { skip++; return; }
        var v = make(i);
        if (!v) { skip++; return; }
        rows[i].cur = v;
        rows[i].rid = null;
        if (rows[i].status !== 'conflict') { rows[i].status = ''; rows[i].err = null; }
        n++;
      });
      after();
      ui.pageMessage(what + ': ' + n + ' 日に入れました' + (skip ? '（' + skip + ' 日は飛ばしました）' : ''), n ? 'ok' : 'warn');
    }

    function revertSelected() {
      var list = grid.selectedRows();
      list.forEach(function (i) { var x = rows[i]; if (x.status === 'conflict') return; x.cur = Object.assign({}, x.base); x.rid = null; x.status = ''; x.err = null; });
      after();
      ui.pageMessage('選んだ行を元に戻しました', 'ok');
    }

    function revertAll() {
      if (!anyDirty()) { ui.pageMessage('保存していない変更はありません', 'warn'); return; }
      ui.confirm('保存していない変更をすべて取り消す', '保存していない入力をすべて元に戻しますか？', '取り消す', 'danger').then(function (ok) {
        if (!ok) return;
        rows.forEach(function (x) { if (x.status === 'conflict') return; x.cur = Object.assign({}, x.base); x.rid = null; x.status = ''; x.err = null; });
        after();
        ui.pageMessage('保存していない変更を取り消しました', 'ok');
      });
    }

    function copyPrev() {
      setRows(grid.selectedRows(), function (i) {
        var prev = i > 0 ? rows[i - 1].cur : inputOf(data.neighbors ? data.neighbors.before.input : null);
        return hasInput(prev) ? Object.assign({}, prev) : null;
      }, '前日と同じ');
    }

    /** 定型パターンを、入力の15列（備考は今のまま）にする */
    function patternInput(p, keepNote) {
      var R = data.rules;
      var s = CR.toSlots(CR.normalizeDay({ entries: p.entries, note: '' }, R), CW, R);
      var out = emptyInput();
      if (s.ok) COLS.forEach(function (c) { out[c] = s.row[c]; });
      else {
        ['day', 'night'].forEach(function (slot, k) {
          var e = p.entries[k];
          if (e) Object.keys(KEYS).forEach(function (key) { out[SLOT[slot] + KEYS[key]] = e[key] || ''; });
        });
      }
      out['備考'] = keepNote;
      return out;
    }

    function choosePattern() {
      var list = data.patterns || [];
      if (!list.length) return ui.notice('定型パターン', 'まだ定型パターンがありません。1日ずつの画面で「定型パターンにする」から登録できます').then(function () { return null; });
      var buttons = list.map(function (p, k) { return { label: p.name, value: k }; });
      buttons.push({ label: 'やめる', value: null });
      return ui.dialog({ title: '定型パターンを選ぶ', text: '選んだ行に入れます（備考は変えません）', buttons: buttons }).then(function (k) { return k === null || k === undefined ? null : list[k]; });
    }

    function usePattern() {
      var rowsSel = grid.selectedRows();
      choosePattern().then(function (p) {
        if (!p) return;
        setRows(rowsSel, function (i) { return patternInput(p, rows[i].cur['備考']); }, '定型パターン「' + p.name + '」');
      });
    }

    function bulkApply() {
      var src = grid.selectedRows()[0];
      var dates = rows.filter(function (x, i) { return editable(i, 0); }).map(function (x) { return x.day.date; });
      if (!dates.length) { ui.notice('まとめて適用', '直せる日がありません'); return; }
      var opts = function (id, sel) {
        return ui.el('select', { id: id }, dates.map(function (d) { return ui.el('option', { value: d, text: dateLabel(rows.filter(function (x) { return x.day.date === d; })[0].day), selected: d === sel }); }));
      };
      var dows = [1, 2, 3, 4, 5, 6, 0];
      var source = ui.el('select', { id: 'bulk-source' }, [ui.el('option', { value: 'row', text: '選んでいる行（' + dateLabel(rows[src].day) + '）の中身' })]
        .concat((data.patterns || []).map(function (p, k) { return ui.el('option', { value: 'p' + k, text: '定型パターン「' + p.name + '」' }); })));
      // ダイアログは閉じると消えるので、値は作った要素から読む
      var fromSel = opts('bulk-from', dates[0]), toSel = opts('bulk-to', dates[dates.length - 1]);
      var dowBox = {};
      dows.forEach(function (w) { dowBox[w] = ui.el('input', { type: 'checkbox', id: 'bulk-dow-' + w, checked: w >= 1 && w <= 5 }); });
      var overBox = ui.el('input', { type: 'checkbox', id: 'bulk-over' });
      var skipBox = ui.el('input', { type: 'checkbox', id: 'bulk-skip-off', checked: true });
      var body = ui.el('div', {}, [
        ui.el('div', { class: 'field' }, [ui.el('label', { for: 'bulk-from', text: 'いつから' }), fromSel]),
        ui.el('div', { class: 'field' }, [ui.el('label', { for: 'bulk-to', text: 'いつまで' }), toSel]),
        ui.el('fieldset', { class: 'field' }, [ui.el('legend', { text: '曜日' })].concat(dows.map(function (w) {
          return ui.el('label', { class: 'check' }, [dowBox[w], DOW[w]]);
        }))),
        ui.el('div', { class: 'field' }, [ui.el('label', { for: 'bulk-source', text: '入れる中身' }), source]),
        ui.el('label', { class: 'check' }, [overBox, 'もう入っている日も上書きする']),
        ui.el('label', { class: 'check' }, [skipBox, '会社の休みの日（所定が無い・分からない日）を除く']),
      ]);
      ui.dialog({ title: 'まとめて適用', text: '表の上に入れます。保存は「保存」ボタンで。', body: body, buttons: [{ label: '入れる', value: true, kind: 'primary' }, { label: 'やめる', value: false }] }).then(function (ok) {
        if (!ok) return;
        var from = fromSel.value, to = toSel.value;
        var on = {};
        dows.forEach(function (w) { on[w] = dowBox[w].checked; });
        var over = overBox.checked, skipOff = skipBox.checked;
        var sv = source.value;
        var base = sv === 'row' ? Object.assign({}, rows[src].cur) : null;
        var pat = sv === 'row' ? null : data.patterns[Number(sv.slice(1))];
        if (base && !hasInput(base)) { ui.notice('まとめて適用', '選んでいる行が空です。中身の入った行を選んでから使ってください'); return; }
        var list = [];
        rows.forEach(function (x, i) {
          var d = x.day;
          if (d.date < from || d.date > to || !on[d.dow]) return;
          if (!over && hasInput(x.cur)) return;
          if (skipOff && !(d.companyScheduled > 0)) return;
          list.push(i);
        });
        setRows(list, function (i) { return pat ? patternInput(pat, rows[i].cur['備考']) : Object.assign({}, base); }, 'まとめて適用');

      });
    }

    // ------------------------------------------------------------------ つなぐ

    function go(date, employee) {
      if (saving) return;
      confirmLeave().then(function (ok) {
        if (!ok) return;
        ui.run(function () { return load(date, employee); });
      });
    }
    ui.$('prev').addEventListener('click', function () { go(data.prevDate, target); });
    ui.$('next').addEventListener('click', function () { if (data.nextDate) go(data.nextDate, target); });
    ui.$('emp-select').addEventListener('change', function (ev) {
      var v = ev.target.value;
      if (saving) { ev.target.value = data.employee.employeeId; return; }
      confirmLeave().then(function (ok) {
        if (!ok) { ev.target.value = data.employee.employeeId; return; }
        ui.run(function () { return load(data.days[0].date, v === me.employeeId ? null : v); });
      });
    });
    ui.$('save').addEventListener('click', doSave);
    ui.$('copy-prev').addEventListener('click', copyPrev);
    ui.$('use-pattern').addEventListener('click', usePattern);
    ui.$('bulk').addEventListener('click', bulkApply);
    ui.$('revert-row').addEventListener('click', revertSelected);
    ui.$('revert-all').addEventListener('click', revertAll);
    ui.$('to-day').addEventListener('click', function (ev) {
      ev.preventDefault();
      if (saving) return;
      var href = ui.$('to-day').href;
      confirmLeave().then(function (ok) { if (ok) { rows.forEach(function (x) { x.cur = x.base; }); remember('day'); window.location.href = href; } });
    });
    window.addEventListener('beforeunload', function (ev) { if (anyDirty() || saving) { ev.preventDefault(); ev.returnValue = ''; } });

    remember('grid');
    var q = new URLSearchParams(window.location.search);
    var date = q.get('date');
    var employee = q.get('employee');
    var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // 開く期間を決めるだけ（日付の確かめはサーバー）
    return load(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today, employee && /^E\d{4}$/.test(employee) ? employee : null, true);
  });
})();
