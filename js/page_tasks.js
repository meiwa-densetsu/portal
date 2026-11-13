/*
 * タスクリスト（計画 docs/plans/stage2-tasklist-plan.md 2-8）
 *
 * パソコン: 月の表（列 = 担当・行 = 日付ごとのタスク＋新しいタスクの空きの行・右にメモ）。日報の表と同じ部品（grid.js）
 * スマホ: 日付を選んで自分のタスク（全員の分に切り替えられる）
 * 送り方: すべての操作を1つの順番待ちの列で送る（前の答えが返ってから次。答えの版を使う）。通信の結果が分からないときは同じ requestId で送り直す。
 *         CONFLICT（ほかの人が直した）のときは自分の入力を残し、「最新を読む」「自分の入力をもう一度送る」を選べる
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var CT = window.CalcTask;
    var DOW = ['日', '月', '火', '水', '木', '金', '土'];
    var VIEW_KEY = 'mp_tasks_view';
    var me = null, data = null, ym = null, grid = null, mode = null, day = null;
    var rows = [];         // 表の行: [{ date, idx, first }]
    var queue = [];        // 送る操作の列
    var sending = false;
    var failed = null;     // CONFLICT などで止まった操作 { op, message }

    function viewing() { return MP.guard.viewing(); }
    function todayJst() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
    function md(d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)); }
    function dayLabel(d) { return Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日（' + DOW[CT.dowOf(d)] + '）'; }
    function remember(v) { try { window.localStorage.setItem(VIEW_KEY, v); } catch (e) { /* 覚えられなくても動く */ } }
    function remembered() { try { return window.localStorage.getItem(VIEW_KEY); } catch (e) { return null; } }
    function peopleById() { var o = {}; data.people.forEach(function (p) { o[p.employeeId] = p; }); return o; }

    // ------------------------------------------------------------------ 読み込み

    var loadSeq = 0, loading = false, shownDay = null; // shownDay: 今出している月の中で、最後に出した日

    /** 読み込みの間は、月の移動・新しくする・表の編集を止める */
    function setLoading(v) {
      loading = v;
      ['prev', 'next', 'reload', 'day-prev', 'day-next', 'add-btn'].forEach(function (id) { ui.$(id).disabled = v; });
      if (grid) grid.setLocked(v);
      if (mode === 'table' && grid) updateTools(); // 操作のボタンも止める（Codex 実装3回目 medium）
      Array.prototype.forEach.call(document.querySelectorAll('#day-list button'), function (b) { b.disabled = v || sending; });
    }

    /** 月を読む。番号で見分け、最後に頼んだ読み込み以外の答えは捨てる（月を続けて切り替えたとき。Codex 実装2回目 medium） */
    function load(first) {
      var my = ++loadSeq;
      var args = { month: ym };
      setLoading(true);
      var p = first ? MP.guard.enter({ load: { action: 'task.month', args: args } })
        : MP.api.call('task.month', args).then(function (res) { return { me: me, res: res }; });
      return p.then(function (r) {
        if (my !== loadSeq) return; // 古い答え
        me = r.me;
        setLoading(false);
        if (!r.res.ok) { // 読めなければ、今出している月と日に戻す（月の移動で day を空にしていても。Codex 実装5回目 medium）
          if (data) { ym = data.month; day = shownDay; render(); }
          ui.pageMessage(r.res.message, 'error'); return;
        }
        if (r.res.data.month !== ym) return; // 念のため: 頼んだ月と違う答えは使わない
        data = r.res.data;
        ui.$('view').hidden = false;
        ui.$('to-export').hidden = !MP.guard.isAdmin(me) || viewing();
        if (!day || day.slice(0, 7) !== ym) day = data.today.slice(0, 7) === ym ? data.today : data.from;
        shownDay = day;
        render();
      });
    }

    /** その担当・その日のタスク（並びの順）と先送りの印 */
    function entriesOf(owner, date) {
      var list = CT.sortTasks(data.items.filter(function (i) { return i.owner === owner && i.date === date; }))
        .map(function (i) { return { kind: 'task', it: i }; });
      data.marks.filter(function (m) { return m.owner === owner && m.date === date; })
        .forEach(function (m) { list.push({ kind: 'mark', it: m }); });
      return list;
    }

    function itemText(e) {
      var it = e.it;
      if (e.kind === 'mark') return '→' + md(it.to) + 'へ先送り ' + it.content + (it.hidden ? ' 🔒' : '');
      var u = CT.urgencyMark(it.urgency);
      return (u ? u + ' ' : '') + it.content + (it.requester ? '（依頼: ' + it.requesterName + '）' : '') + (it.hidden ? ' 🔒' : '') +
        (it.state === '完了' ? ' ✓完了' : it.state === '取りやめ' ? '（取りやめ）' : '');
    }
    function itemCls(e) {
      if (e.kind === 'mark') return 'tk-mark';
      return (e.it.state === '完了' ? 'tk-done' : e.it.state === '取りやめ' ? 'tk-cancel' : '') + (e.it.urgency !== '通常' ? ' tk-urgent' : '');
    }

    function render() {
      ui.$('month-label').textContent = Number(data.month.slice(0, 4)) + '年' + Number(data.month.slice(5, 7)) + '月';
      if (mode === 'table') renderTable(); else renderList();
      ui.$('table-pane').hidden = mode !== 'table';
      ui.$('list-pane').hidden = mode === 'table';
      renderQueue();
    }

    // ------------------------------------------------------------------ 月の表

    function buildRows() {
      rows = [];
      for (var n = CT.dayNumber(data.from); n <= CT.dayNumber(data.to); n++) {
        var d = CT.dateOf(n);
        var max = 0;
        data.people.forEach(function (p) { max = Math.max(max, entriesOf(p.employeeId, d).length); });
        for (var k = 0; k <= max; k++) rows.push({ date: d, idx: k, first: k === 0 });
      }
    }

    function cellOf(r, c) {
      var row = rows[r];
      if (c === data.people.length) return { kind: 'memo', date: row.date, first: row.first };
      var owner = data.people[c];
      var list = entriesOf(owner.employeeId, row.date);
      if (row.idx < list.length) return list[row.idx];
      if (row.idx === list.length) return { kind: 'empty', owner: owner, date: row.date };
      return { kind: 'none' };
    }

    function memoOf(date) { return data.memos.filter(function (m) { return m.date === date; })[0] || null; }

    function renderTable() {
      buildRows();
      var columns = data.people.map(function (p) { return { key: p.employeeId, label: p.name + (p.active ? '' : '（利用停止）'), kind: 'text' }; });
      columns.push({ key: 'memo', label: 'メモ（申し送り）', kind: 'text' });
      grid = MP.grid.create(ui.$('grid'), {
        columns: columns,
        rowCount: rows.length,
        rowHead: function (r) {
          var row = rows[r], w = CT.dowOf(row.date);
          return { text: row.first ? md(row.date) + '（' + DOW[w] + '）' : '', label: dayLabel(row.date), cls: w === 0 ? 'sun' : w === 6 ? 'sat' : '' };
        },
        value: function (r, c) {
          var x = cellOf(r, c);
          if (x.kind === 'task') return x.it.content;
          if (x.kind === 'memo') { var m = memoOf(x.date); return x.first && m ? m.content : ''; }
          return '';
        },
        display: function (r, c) {
          var x = cellOf(r, c);
          if (x.kind === 'task' || x.kind === 'mark') return itemText(x);
          if (x.kind === 'memo') { var m = memoOf(x.date); return x.first && m ? m.content.replace(/\n/g, ' ／ ') : ''; }
          return '';
        },
        editable: function (r, c) {
          if (viewing() || sending || loading) return false;
          var x = cellOf(r, c);
          if (x.kind === 'task') return x.it.can.edit;
          if (x.kind === 'empty') return x.owner.active;
          if (x.kind === 'memo') return x.first;
          return false;
        },
        cellState: function (r, c) {
          var x = cellOf(r, c);
          if (x.kind === 'task' || x.kind === 'mark') return { cls: itemCls(x), title: itemText(x) + '（' + (x.kind === 'mark' ? '先送りの印' : x.it.state) + '）' };
          return {};
        },
        change: onGridChange,
        notify: function (text, kind) { ui.pageMessage(text, kind || 'warn'); },
      });
      ui.$('grid').addEventListener('click', updateTools);
      ui.$('grid').addEventListener('keyup', updateTools);
      updateTools();
    }

    /** 打った・貼り付けた内容（まとめて） */
    function onGridChange(list) {
      var adds = [];
      list.forEach(function (ch) {
        var x = cellOf(ch.r, ch.c);
        var v = String(ch.value || '').replace(/^[\s　]+|[\s　]+$/g, '');
        if (x.kind === 'memo' && x.first) {
          var m = memoOf(x.date);
          enqueue({ action: 'task.memo.save', args: function () { var cur = memoOf(x.date); return { date: x.date, baseVersion: cur ? cur.recordVersion : 0, content: String(ch.value || '') }; }, label: md(x.date) + ' のメモ' });
          void m;
        } else if (x.kind === 'empty' && v !== '') {
          adds.push({ ownerId: x.owner.employeeId, date: x.date, content: v });
        } else if (x.kind === 'task' && v !== '' && v !== x.it.content) {
          var id = x.it.taskId;
          enqueue({ action: 'task.update', args: function () { var cur = findItem(id); return { taskId: id, baseVersion: cur ? cur.recordVersion : 0, content: v }; }, label: '「' + v + '」' });
        }
      });
      if (adds.length === 1) enqueue({ action: 'task.add', args: function () { return Object.assign({ urgency: '通常', hidden: false }, adds[0]); }, label: '「' + adds[0].content + '」' });
      else if (adds.length > 1) {
        for (var i = 0; i < adds.length; i += 50) {
          (function (part) { enqueue({ action: 'task.addMany', args: function () { return { items: part }; }, label: part.length + ' 件のタスク' }); })(adds.slice(i, i + 50));
        }
      }
      if (grid) grid.refresh();
    }

    function findItem(taskId) { return data.items.filter(function (i) { return i.taskId === taskId; })[0] || null; }

    /** 選んでいるセルのタスク（無ければ null） */
    function selectedTask() {
      if (mode !== 'table' || !grid) return null;
      var s = grid.selection();
      var x = cellOf(s.r2, s.c2);
      return x.kind === 'task' ? x.it : null;
    }

    function updateTools() {
      var it = selectedTask();
      var busy = sending || loading || !!failed || viewing();
      var set = function (id, ok) { ui.$(id).disabled = busy || !ok; };
      set('t-complete', it && it.can.complete && it.state === '未完了');
      set('t-reopen', it && it.can.complete && it.state === '完了');
      set('t-defer', it && it.can.defer && it.state === '未完了');
      set('t-cancel', it && it.can.cancel && it.state === '未完了');
      set('t-uncancel', it && it.can.cancel && it.state === '取りやめ');
      set('t-urgency', it && it.can.edit);
      set('t-hide', it && it.can.edit);
      set('t-up', it && it.can.move);
      set('t-down', it && it.can.move);
      set('t-delete', it && it.can.del);
      ui.$('sel-info').textContent = it ? '選んでいるタスク: ' + it.content + '（' + it.state + (it.requester ? '・依頼: ' + it.requesterName : '') + '）' : '';
    }

    // ------------------------------------------------------------------ 日付ごとの一覧（スマホ）

    function renderList() {
      ui.$('day-label').textContent = dayLabel(day);
      ui.$('day-prev').disabled = day <= data.from && false;
      var all = ui.$('show-all').checked;
      var owners = all ? data.people.map(function (p) { return p.employeeId; }) : [me.employeeId];
      var ul = ui.clear(ui.$('day-list'));
      owners.forEach(function (id) {
        var list = entriesOf(id, day);
        if (all && !list.length) return;
        if (all) ul.appendChild(ui.el('li', { class: 'item-title', text: (peopleById()[id] || {}).name || id }));
        // 急ぎを上に（至急 → 急ぎ → 通常）。印は下
        list.sort(function (a, b) {
          var ua = a.kind === 'mark' ? 9 : CT.URGENCY.indexOf(a.it.urgency), ub = b.kind === 'mark' ? 9 : CT.URGENCY.indexOf(b.it.urgency);
          return ua - ub;
        });
        list.forEach(function (e) {
          var it = e.it;
          var btns = [];
          if (e.kind === 'task' && !viewing()) {
            if (it.can.complete && it.state === '未完了') btns.push(button('完了', function () { stateOp(it, 'complete'); }, 'primary'));
            if (it.can.complete && it.state === '完了') btns.push(button('未完了に戻す', function () { stateOp(it, 'reopen'); }));
            if (it.can.defer && it.state === '未完了') btns.push(button('先送り', function () { deferOp(it); }));
            if (it.can.cancel && it.state === '未完了') btns.push(button('取りやめ', function () { stateOp(it, 'cancel'); }));
          }
          ul.appendChild(ui.el('li', { class: 'task-item ' + itemCls(e) }, [ui.el('div', { text: itemText(e) }), btns.length ? ui.el('div', { class: 'item-actions' }, btns) : null]));
        });
      });
      if (!ul.firstChild) ul.appendChild(ui.el('li', { class: 'sub', text: 'この日のタスクはありません' }));
      var m = memoOf(day);
      ui.clear(ui.$('day-memo')).appendChild(ui.el('p', { class: 'sub', text: m && m.content ? 'メモ: ' + m.content : 'メモはありません' }));
      ui.$('add-box').hidden = viewing();
    }

    function button(label, fn, kind) { return ui.el('button', { type: 'button', class: 'btn' + (kind ? ' ' + kind : ''), text: label, disabled: sending || loading, on: { click: fn } }); }

    // ------------------------------------------------------------------ 操作

    function stateOp(it, op, extra) {
      var id = it.taskId;
      enqueue({ action: 'task.state', args: function () { var cur = findItem(id); return Object.assign({ taskId: id, baseVersion: cur ? cur.recordVersion : 0, op: op }, extra || {}); },
        label: '「' + it.content + '」', reload: op === 'defer' });
    }

    function deferOp(it) {
      var today = data.today;
      var input = ui.el('input', { type: 'date', id: 'defer-date', min: today, max: CT.addDays(today, data.rules.deferMaxDays), value: CT.nextBusinessDay(it.date < today ? today : it.date, null) });
      var body = ui.el('div', { class: 'field' }, [ui.el('label', { for: 'defer-date', text: '先送り先の日' }), input]);
      return ui.dialog({ title: '先送り', body: body, buttons: [{ label: '先送りする', value: true, kind: 'primary' }, { label: 'やめる', value: false }] }).then(function (ok) {
        if (!ok) return;
        if (!CT.isDate(input.value)) { ui.pageMessage('日付を選んでください', 'error'); return; }
        stateOp(it, 'defer', { to: input.value });
      });
    }

    function urgencyOp(it) {
      var buttons = data.rules.urgency.map(function (u) { return { label: u, value: u, kind: u === it.urgency ? 'primary' : '' }; });
      buttons.push({ label: 'やめる', value: null });
      return ui.dialog({ title: '急ぎの度合い', text: '「' + it.content + '」', buttons: buttons }).then(function (u) {
        if (!u || u === it.urgency) return;
        var id = it.taskId;
        enqueue({ action: 'task.update', args: function () { var cur = findItem(id); return { taskId: id, baseVersion: cur ? cur.recordVersion : 0, urgency: u }; }, label: '「' + it.content + '」' });
      });
    }

    function hideOp(it) {
      var id = it.taskId, v = !it.hidden;
      enqueue({ action: 'task.update', args: function () { var cur = findItem(id); return { taskId: id, baseVersion: cur ? cur.recordVersion : 0, hidden: v }; }, label: '「' + it.content + '」', reload: true });
    }

    function deleteOp(it) {
      return ui.confirm('タスクを消す', '「' + it.content + '」を消しますか？', '消す', 'danger').then(function (ok) {
        if (!ok) return;
        var id = it.taskId;
        enqueue({ action: 'task.delete', args: function () { var cur = findItem(id); return { taskId: id, baseVersion: cur ? cur.recordVersion : 0 }; }, label: '「' + it.content + '」', reload: true });
      });
    }

    /** 並べ替え（送る直前に、今の姿から並びと版を作る。競合したら読み直して並べ直してもらう。Codex 実装1回目 medium） */
    function moveOp(it, dir) {
      var id = it.taskId, owner = it.owner, date = it.date;
      enqueue({ action: 'task.move', label: '並べ替え', reload: true, noRetry: true, args: function () {
        var list = CT.sortTasks(data.items.filter(function (i) { return i.owner === owner && i.date === date; }));
        var order = list.map(function (i) { return i.taskId; });
        var k = order.indexOf(id), j = k + dir;
        if (k < 0 || j < 0 || j >= order.length) return null; // 動かせない（端・もう無い）→ 送らない
        order[k] = order[j]; order[j] = id;
        var versions = {};
        list.forEach(function (i) { versions[i.taskId] = i.recordVersion; });
        return { ownerId: owner, date: date, order: order, versions: versions };
      } });
    }

    // ------------------------------------------------------------------ 順番待ちの列

    function enqueue(op) {
      if (loading) { ui.pageMessage('読み込み中です。終わってからもう一度操作してください', 'error'); return; } // 古い姿のまま送らない
      op.rid = MP.api.newRequestId();
      queue.push(op);
      pump();
    }

    /**
     * 止まった操作の知らせ。
     *   unknown（通信の結果が分からない）… 「もう一度送る」は同じ中身・同じ requestId（二重にしない）
     *   conflict（ほかの人が直した）     … 「最新を読む」か「自分の入力をもう一度送る」（読み直した版で中身を作り直し、新しい requestId）
     *   それ以外（断られた）             … 理由を出して捨てる
     */
    function renderQueue() {
      ui.$('sending').hidden = !sending;
      var f = ui.$('failed');
      ui.clear(f);
      f.hidden = !failed;
      if (failed) {
        var op = failed.op;
        f.appendChild(ui.el('p', { text: op.label + ' を送れませんでした: ' + failed.message }));
        var btns = [];
        if (failed.kind === 'unknown') {
          btns.push(button('もう一度送る', function () { failed = null; queue.unshift(op); pump(); }));
          btns.push(button('やめて最新を読む', function () { failed = null; queue = []; reloadNow(); }));
        } else if (failed.kind === 'conflict') {
          btns.push(button('最新を読む（自分の入力は捨てる）', function () { failed = null; queue = []; reloadNow(); }));
          if (!op.noRetry) btns.push(button('自分の入力をもう一度送る', function () { failed = null; reloadNow().then(function () { op.rid = MP.api.newRequestId(); op.sent = null; queue.unshift(op); pump(); }); }));
        } else {
          btns.push(button('閉じる', function () { failed = null; reloadNow(); }));
        }
        f.appendChild(ui.el('div', { class: 'item-actions' }, btns));
      }
      if (mode === 'table' && grid) updateTools(); // 送っている間・止まっている間は、操作のボタンを止める
    }

    function reloadNow() { return ui.run(function () { return load(false); }); }

    function pump() {
      if (sending || failed || !queue.length) { renderQueue(); return; }
      var op = queue.shift();
      if (!op.sent) op.sent = op.args(); // 中身は最初に送るときに固める（送り直しでは同じ中身）
      if (!op.sent) { pump(); return; }   // 送るものが無い（並べ替えで端など）
      sending = true;
      renderQueue();
      if (grid) grid.refresh();
      var attempt = function (tries) {
        return MP.api.call(op.action, op.sent, { requestId: op.rid }).then(function (res) {
          // 通信の結果が分からない（NETWORK・BUSY）ときは、同じ中身・同じ requestId で送り直す（3回まで）
          if (!res.ok && (res.code === 'NETWORK' || res.code === 'BUSY') && tries < 3) return attempt(tries + 1);
          return res;
        });
      };
      attempt(1).then(function (res) {
        sending = false;
        if (!res.ok) {
          var unknown = res.code === 'NETWORK' || res.code === 'BUSY' || res.code === 'INTERNAL';
          failed = { op: op, kind: unknown ? 'unknown' : res.code === 'CONFLICT' ? 'conflict' : 'refused', message: res.message || '送れませんでした' };
          renderQueue();
          if (grid) grid.refresh();
          return;
        }
        applyResult(op, res.data);
        if (op.reload) return load(false).then(function () { pump(); }); // 先送り・隠す・消す・並べ替えは印や並びが変わるので読み直す
        render();
        pump();
      }, function () {
        sending = false;
        failed = { op: op, kind: 'unknown', message: '送れたか分かりません' };
        renderQueue();
      });
    }

    /** 答えの姿を手元に入れる（版を次の操作に使う） */
    function applyResult(op, d) {
      var put = function (it) {
        if (!it) return;
        var k = data.items.map(function (i) { return i.taskId; }).indexOf(it.taskId);
        if (k >= 0) data.items[k] = it; else data.items.push(it);
      };
      if (d.item) put(d.item);
      if (d.results) d.results.forEach(function (x) { put(x.item); });
      if (d.results && d.results.some(function (x) { return x.status === 'error'; })) {
        ui.pageMessage(d.results.filter(function (x) { return x.status === 'error'; }).map(function (x) { return (x.index + 1) + '件目: ' + x.message; }).join('\n'), 'warn');
      }
      if (op.action === 'task.memo.save') {
        var m = memoOf(d.date);
        if (m) { m.content = d.content; m.recordVersion = d.recordVersion; } else data.memos.push({ date: d.date, content: d.content, recordVersion: d.recordVersion });
      }
    }

    // ------------------------------------------------------------------ ボタン

    function withSel(fn) { return function () { if (loading) return; var it = selectedTask(); if (it) fn(it); }; }
    ui.$('t-complete').addEventListener('click', withSel(function (it) { stateOp(it, 'complete'); }));
    ui.$('t-reopen').addEventListener('click', withSel(function (it) { stateOp(it, 'reopen'); }));
    ui.$('t-defer').addEventListener('click', withSel(deferOp));
    ui.$('t-cancel').addEventListener('click', withSel(function (it) { stateOp(it, 'cancel'); }));
    ui.$('t-uncancel').addEventListener('click', withSel(function (it) { stateOp(it, 'uncancel'); }));
    ui.$('t-urgency').addEventListener('click', withSel(urgencyOp));
    ui.$('t-hide').addEventListener('click', withSel(hideOp));
    ui.$('t-delete').addEventListener('click', withSel(deleteOp));
    ui.$('t-up').addEventListener('click', withSel(function (it) { moveOp(it, -1); }));
    ui.$('t-down').addEventListener('click', withSel(function (it) { moveOp(it, 1); }));

    function shiftMonth(k) {
      if (sending || queue.length || loading) return;
      var n = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + k;
      ym = Math.floor(n / 12) + '-' + ('0' + (n % 12 + 1)).slice(-2);
      day = null;
      reloadNow();
    }
    ui.$('prev').addEventListener('click', function () { shiftMonth(-1); });
    ui.$('next').addEventListener('click', function () { shiftMonth(1); });
    ui.$('reload').addEventListener('click', function () { if (!sending) reloadNow(); });
    ui.$('to-list').addEventListener('click', function () { mode = 'list'; remember('list'); render(); });
    ui.$('to-table').addEventListener('click', function () { mode = 'table'; remember('table'); render(); });
    ui.$('show-all').addEventListener('change', renderList);
    /** 日を動かす。月をまたぐときは、その日のまま月を読み直す（月初の「前日」で前月末へ。Codex 実装4回目 medium） */
    function goDay(k) {
      if (loading) return;
      var d = CT.addDays(day, k);
      if (d >= data.from && d <= data.to) { day = shownDay = d; renderList(); return; }
      if (sending || queue.length) return; // 送り終わるまで月は動かさない（shiftMonth と同じ）
      day = d; ym = d.slice(0, 7);
      reloadNow();
    }
    ui.$('day-prev').addEventListener('click', function () { goDay(-1); });
    ui.$('day-next').addEventListener('click', function () { goDay(1); });
    ui.$('add-btn').addEventListener('click', function () {
      var v = ui.$('add-content').value.replace(/^[\s　]+|[\s　]+$/g, '');
      if (!v) { ui.pageMessage('内容を入れてください', 'error'); return; }
      if (CT && v.length > data.rules.contentMax * 2) { ui.pageMessage('内容は ' + data.rules.contentMax + ' 字までです', 'error'); return; }
      ui.$('add-content').value = '';
      var d = day; // 足す日は押したときの日（送る前に日を動かしても変わらない）
      enqueue({ action: 'task.add', args: function () { return { ownerId: me.employeeId, date: d, content: v, urgency: '通常', hidden: false }; }, label: '「' + v + '」', reload: true });
    });

    // 初め: 今日の月。見る形は端末で最後に使った方（初めはパソコンの幅なら表、スマホは一覧）
    var q = new URLSearchParams(window.location.search);
    ym = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : todayJst().slice(0, 7);
    mode = remembered() === 'table' || remembered() === 'list' ? remembered() : window.innerWidth >= 600 ? 'table' : 'list';
    return load(true);
  });
})();
