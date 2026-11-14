/*
 * タスクリスト（計画 docs/plans/stage2-tasklist-plan.md 2-8・改善の計画 docs/plans/stage2-tasklist-v2-plan.md）
 *
 * パソコン: 月の表（列 = 番号・担当〔選んだ部署の人〕・申し送り。行 = 日付ごとのタスク＋新しいタスクの空きの行。1マス = 1件）。日報の表と同じ部品（grid.js）
 * スマホ: 日付を選んで、人ごとの欄（自分を先に）。1件を1行に（□ で完了・行を押すとメニュー）。終わったものはたたむ
 * 上に 申し送り・依頼したタスクの知らせ（完了・相談。✕ で消す）・部署のまとめ（部長と管理者）
 * 送り方: すべての操作を1つの順番待ちの列で送る（前の答えが返ってから次。答えの版を使う）。通信の結果が分からないときは同じ requestId で送り直す。
 *         CONFLICT（ほかの人が直した）のときは自分の入力を残し、「最新を読む」「自分の入力をもう一度送る」を選べる
 *         「見た」「✕」は版を上げない印なので、列を通さずに送る
 * 表示の計算（並び・締め切りの印・部署の人・まとめ）は task_view.js、入力のダイアログは task_dialogs.js
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var CT = window.CalcTask;
    var TV = MP.taskView;
    var TD = MP.taskDialogs;
    var DOW = ['日', '月', '火', '水', '木', '金', '土'];
    var VIEW_KEY = 'mp_tasks_view', DEPT_KEY = 'mp_tasks_dept', TEXT_KEY = 'mp_tasks_text';
    var UNDO_MS = 5000;
    var me = null, data = null, ym = null, grid = null, mode = null, day = null;
    var deptId = null;     // 見ている部署（'' = 全員。null = まだ決めていない）
    var textMode = 'clip'; // 長い内容: clip（1行で切る）・wrap（全部出す）
    var openCards = {};    // スマホ: 開いている人の欄（社員ID → 真）
    var openDone = {};     // スマホ: 終わったものを開いている人の欄
    var rows = [];         // 表の行: [{ date, idx, first, count }]
    var cols = [];         // 表に出している人
    var queue = [];        // 送る操作の列
    var sending = false;
    var failed = null;     // CONFLICT などで止まった操作 { op, message }
    var seenSent = {};     // 「見た」を送ったタスク（タスクID:版）
    var undo = null;       // 完了にした直後の帯 { taskId, timer }
    var explicitMonth = false, firstLoad = true;

    function viewing() { return MP.guard.viewing(); }
    /** 開く月の初めの見当（端末の時計で、朝 6 時より前は前の日。本当の「タスクの今日」はサーバーの答えで決め直す） */
    function guessToday() { return new Date(Date.now() + 9 * 3600000 - 6 * 3600000).toISOString().slice(0, 10); }
    function md(d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)); }
    function dayLabel(d) { return Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日（' + DOW[CT.dowOf(d)] + '）' + (data && d === data.taskToday ? ' 今日' : ''); }
    function put(key, v) { try { window.localStorage.setItem(key, v); } catch (e) { /* 覚えられなくても動く */ } }
    function got(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
    function isBoss() { return !!me && (me.role === '管理者' || me.role === '部長'); }
    function deptName(id) { var d = data.departments.filter(function (x) { return x.deptId === id; })[0]; return d ? d.name : '全員'; }

    // ------------------------------------------------------------------ 読み込み

    var loadSeq = 0, loading = false, shownDay = null; // shownDay: 今出している月の中で、最後に出した日
    var jumpToday = true; // 月の表を描いたときに、今日の段へ動くか（月を読んだ直後だけ）

    /** 読み込みの間は、月の移動・新しくする・表の編集を止める */
    function setLoading(v) {
      loading = v;
      ['prev', 'next', 'reload', 'day-prev', 'day-next', 'add-btn', 'day-today', 'add-detail', 'request-btn', 'handover-add'].forEach(function (id) { ui.$(id).disabled = v; });
      if (grid) grid.setLocked(v);
      if (mode === 'table' && grid) updateTools(); // 操作のボタンも止める（Codex 実装3回目 medium）
      Array.prototype.forEach.call(document.querySelectorAll('#day-list button, #handovers button, #notices button'), function (b) { b.disabled = v || sending; });
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
        // 初めに開いたとき: 端末の時計で見当を付けた月が、サーバーの「タスクの今日」の月と違えば、その月を読み直す（月の変わり目の夜中）
        if (firstLoad && !explicitMonth && r.res.data.taskToday.slice(0, 7) !== ym) {
          firstLoad = false;
          ym = r.res.data.taskToday.slice(0, 7);
          return load(false);
        }
        firstLoad = false;
        data = r.res.data;
        ui.$('view').hidden = false;
        ui.$('to-export').hidden = !MP.guard.isAdmin(me) || viewing();
        if (!day || day.slice(0, 7) !== ym) day = data.taskToday.slice(0, 7) === ym ? data.taskToday : data.from;
        shownDay = day;
        if (deptId === null) { // 初めは端末に覚えた部署。無ければ自分の部署（部署が無い人は全員）
          var saved = got(DEPT_KEY);
          deptId = saved !== null && (saved === '' || data.departments.some(function (d) { return d.deptId === saved; })) ? saved : (data.myDeptId || '');
        } else if (deptId !== '' && !data.departments.some(function (d) { return d.deptId === deptId; })) deptId = '';
        jumpToday = true;
        render();
      });
    }

    function findItem(taskId) { return data.items.filter(function (i) { return i.taskId === taskId; })[0] || null; }
    function shownPeople() { return TV.people(data, deptId, me.employeeId); }

    function render() {
      ui.$('month-label').textContent = Number(data.month.slice(0, 4)) + '年' + Number(data.month.slice(5, 7)) + '月';
      renderDeptBar();
      if (mode === 'table') renderTable(); else renderList();
      ui.$('table-pane').hidden = mode !== 'table';
      ui.$('list-pane').hidden = mode === 'table';
      ui.$('add-tools').hidden = viewing();
      renderSide();
      renderQueue();
      sendSeen();
    }

    // ------------------------------------------------------------------ 部署の切り替え・申し送り・知らせ・まとめ

    function renderDeptBar() {
      var bar = ui.clear(ui.$('dept-bar'));
      bar.hidden = !data.departments.length;
      var chip = function (id, name) {
        return ui.el('button', { type: 'button', class: 'btn chip' + (deptId === id ? ' primary' : ''), text: name, 'aria-pressed': deptId === id ? 'true' : 'false',
          on: { click: function () { deptId = id; put(DEPT_KEY, id); jumpToday = false; render(); } } });
      };
      data.departments.forEach(function (d) { bar.appendChild(chip(d.deptId, d.name)); });
      bar.appendChild(chip('', '全員'));
    }

    /** 申し送り・知らせ・部署のまとめ（選んでいる日・部署のもの） */
    function renderSide() {
      // 申し送り
      ui.$('handover-title').textContent = '申し送り（' + (deptId ? deptName(deptId) : '全員') + '・' + md(day) + '）';
      var ul = ui.clear(ui.$('handovers'));
      var list = TV.handovers(data, deptId, day);
      list.forEach(function (x) {
        var h = x.h;
        var who = x.kind === 'memo' ? '前のメモ' + (h.authorName ? '・' + h.authorName : '')
          : h.deptName + '・' + (h.from === h.to ? md(h.from) : md(h.from) + '〜' + md(h.to)) + '・' + h.authorName + ' ' + ui.fmtDateTime(h.at);
        var kids = [ui.el('div', { class: 'handover-text', text: h.content }), ui.el('div', { class: 'sub', text: who })];
        if (x.kind === 'handover' && h.canEdit && !viewing()) {
          kids.push(ui.el('div', { class: 'item-actions' }, [button('直す', function () { handoverOp(h); })]));
        }
        ul.appendChild(ui.el('li', { class: 'handover-item' }, kids));
      });
      if (!list.length) ul.appendChild(ui.el('li', { class: 'sub', text: 'この日の申し送りはありません' }));
      ui.$('handover-add').hidden = viewing();
      renderNotices();
      // 部署のまとめ（部長・管理者だけ。その人に見えるタスクから数える）
      var box = ui.$('summary-box');
      box.hidden = !isBoss();
      if (isBoss()) {
        ui.$('summary-title').textContent = '部署のまとめ（' + (deptId ? deptName(deptId) : '全員') + '・' + md(day) + '）';
        var t = ui.clear(ui.$('summary'));
        t.appendChild(ui.el('thead', {}, [ui.el('tr', {}, ['名前', '残り', '締め切り過ぎ', '先送り ' + data.rules.deferWarn + ' 回以上'].map(function (h) { return ui.el('th', { scope: 'col', text: h }); }))]));
        var body = ui.el('tbody');
        TV.summary(data, deptId, day).forEach(function (s) {
          body.appendChild(ui.el('tr', {}, [
            ui.el('th', { scope: 'row', class: 'name' }, [ui.el('button', { type: 'button', class: 'btn link-btn', text: s.name, on: { click: function () { jumpTo(s.employeeId); } } })]),
            ui.el('td', { text: s.open + ' 件' }),
            ui.el('td', { class: s.over ? 'missing' : '', text: s.over + ' 件' }),
            ui.el('td', { class: s.deferred ? 'missing' : '', text: s.deferred + ' 件' }),
          ]));
        });
        t.appendChild(body);
      }
    }

    function renderNotices() {
      var box = ui.$('notice-box');
      var ul = ui.clear(ui.$('notices'));
      box.hidden = !data.notices.length;
      data.notices.forEach(function (n) {
        ul.appendChild(MP.taskItem.notice(n, { canDismiss: !viewing(), disabled: loading || sending || !!failed, onDismiss: dismiss }));
      });
      var more = ui.$('notice-more');
      more.hidden = !data.noticeMore;
      more.textContent = data.noticeMore ? 'ほか ' + data.noticeMore + ' 件は「依頼したもの」の画面で確かめられます' : '';
    }

    /** 知らせの ✕。版を上げない印なので列を通さずに送る。もう変わっていた知らせ（skipped）があれば読み直す */
    function dismiss(n) {
      // ほかの操作を送っている間・止まっている間は押せない（古い表示に対する操作を並べて送らない。Codex 実装1回目 low）
      if (loading || sending || queue.length || failed || viewing()) return;
      MP.api.call('task.notice.dismiss', { items: [{ taskId: n.taskId, kind: n.kind, stamp: n.stamp }] }, { requestId: MP.api.newRequestId() }).then(function (res) {
        if (!res.ok) { ui.pageMessage(res.message || '知らせを消せませんでした', 'error'); return; }
        data.notices = data.notices.filter(function (x) { return !(x.taskId === n.taskId && x.kind === n.kind && x.stamp === n.stamp); });
        if (res.data.skipped && res.data.skipped.length) { if (!sending && !queue.length) reloadNow(); return; }
        renderNotices();
      });
    }

    /** 自分に来た新しい依頼を「見た」にする（出したものだけ・1回だけ）。印はこの画面を読み直すまで出したまま */
    function sendSeen() {
      if (viewing() || !data) return;
      var mine = data.items.filter(function (i) { return i.fresh && i.owner === me.employeeId && (mode === 'table' || i.date === day); })
        .filter(function (i) { return !seenSent[i.taskId + ':' + i.recordVersion]; });
      if (!mine.length) return;
      mine.forEach(function (i) { seenSent[i.taskId + ':' + i.recordVersion] = true; });
      var max = data.rules.seenMax || 100;
      var send = function (part) {
        MP.api.call('task.request.seen', { items: part.map(function (i) { return { taskId: i.taskId, baseVersion: i.recordVersion }; }) }, { requestId: MP.api.newRequestId() }).then(function (res) {
          // 送れなかったときは「送った」の印を外す（次に描くときにもう一度送る。内部レビュー low）
          if (!res.ok) part.forEach(function (i) { delete seenSent[i.taskId + ':' + i.recordVersion]; });
        });
      };
      for (var k = 0; k < mine.length; k += max) send(mine.slice(k, k + max));
    }

    /** 部署のまとめの名前を押した: その人の欄へ */
    function jumpTo(employeeId) {
      if (mode === 'table') {
        var c = cols.map(function (p) { return p.employeeId; }).indexOf(employeeId);
        if (c >= 0 && grid) { var s = grid.selection(); grid.select(s.r2, c + 1); grid.focus(); updateTools(); }
        return;
      }
      openCards[employeeId] = true;
      renderList();
      var card = document.getElementById('card-' + employeeId);
      if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start' });
    }

    // ------------------------------------------------------------------ 月の表

    function buildRows() {
      rows = [];
      cols = shownPeople();
      for (var n = CT.dayNumber(data.from); n <= CT.dayNumber(data.to); n++) {
        var d = CT.dateOf(n);
        var max = 0;
        cols.forEach(function (p) { max = Math.max(max, TV.entries(data, p.employeeId, d).length); });
        for (var k = 0; k <= max; k++) rows.push({ date: d, idx: k, first: k === 0, count: max });
      }
    }

    /** 表のマス: 0 列目 = 番号、1〜 = 担当、最後 = 申し送り */
    function cellOf(r, c) {
      var row = rows[r];
      if (c === 0) return { kind: 'no', n: row.idx < row.count ? row.idx + 1 : 0 };
      if (c === cols.length + 1) return { kind: 'memo', date: row.date, first: row.first };
      var owner = cols[c - 1];
      var list = TV.entries(data, owner.employeeId, row.date);
      if (row.idx < list.length) return list[row.idx];
      if (row.idx === list.length) return { kind: 'empty', owner: owner, date: row.date };
      return { kind: 'none' };
    }

    function memoText(date) {
      return TV.handovers(data, deptId, date).map(function (x) { return (x.kind === 'memo' ? '〔前のメモ〕' : '') + x.h.content.replace(/\n/g, ' '); }).join(' ／ ');
    }

    function renderTable() {
      var keep = grid ? grid.selection() : null;
      var sc0 = ui.$('grid').querySelector('.grid-scroll');
      var top0 = sc0 ? sc0.scrollTop : 0, left0 = sc0 ? sc0.scrollLeft : 0;
      buildRows();
      var columns = [{ key: 'no', label: '番', kind: 'calc' }];
      cols.forEach(function (p) { columns.push({ key: p.employeeId, label: p.name + (p.employeeId === me.employeeId ? '（自分）' : '') + (p.active ? '' : '（利用停止）'), kind: 'text' }); });
      columns.push({ key: 'memo', label: '申し送り', kind: 'text' });
      grid = MP.grid.create(ui.$('grid'), {
        columns: columns,
        rowCount: rows.length,
        rowHead: function (r) {
          var row = rows[r], w = CT.dowOf(row.date);
          return { text: row.first ? md(row.date) + '（' + DOW[w] + '）' : '', label: dayLabel(row.date),
            cls: (w === 0 ? 'sun' : w === 6 ? 'sat' : '') + (row.first ? ' blk-top' : '') + (row.date === data.taskToday ? ' today' : '') };
        },
        value: function (r, c) {
          var x = cellOf(r, c);
          return x.kind === 'task' ? x.it.content : '';
        },
        display: function (r, c) {
          var x = cellOf(r, c);
          if (x.kind === 'no') return x.n ? String(x.n) : '';
          if (x.kind === 'task' || x.kind === 'mark') return TV.cellText(x, data);
          if (x.kind === 'memo') return x.first ? memoText(x.date) : '';
          return '';
        },
        editable: function (r, c) {
          if (viewing() || sending || loading) return false;
          var x = cellOf(r, c);
          if (x.kind === 'task') return x.it.can.edit;
          if (x.kind === 'empty') return x.owner.active;
          return false; // 番号・申し送り（申し送りは上の欄で書く・直す）・空きの下
        },
        cellState: function (r, c) {
          var x = cellOf(r, c), row = rows[r];
          var edge = (row.first ? ' blk-top' : '') + (row.idx % 2 ? ' stripe' : '') + (c >= 1 && c <= cols.length && cols[c - 1].employeeId === me.employeeId ? ' mine' : '');
          if (x.kind === 'task' || x.kind === 'mark') {
            var d = x.kind === 'task' ? TV.due(x.it, data) : null;
            return { cls: TV.cls(x) + edge + (d ? ' due-' + d.level : ''), title: TV.fullText(x, data) };
          }
          if (x.kind === 'memo') return { cls: 'tk-memo' + edge, title: x.first ? memoText(x.date) : '' };
          return { cls: (x.kind === 'no' ? 'tk-no' : '') + edge };
        },
        change: onGridChange,
        notify: function (text, kind) { ui.pageMessage(text, kind || 'warn'); },
      });
      var sc = ui.$('grid').querySelector('.grid-scroll');
      var y = window.scrollY; // 描き直しでページ全体が動かないように（マスを選ぶと、表の部品がそのマスを見える位置へ動かすため）
      if (jumpToday) {
        jumpToday = false;
        goToDayInTable(day);
      } else if (keep && keep.r2 < rows.length && keep.c2 < columns.length) {
        grid.select(keep.r2, keep.c2);
        if (sc) { sc.scrollTop = top0; sc.scrollLeft = left0; }
      }
      window.scrollTo(0, y);
      updateTools();
    }

    /** 月の表で、その日の段へ動く（自分の列の1行目を選び、段の頭が表の箱の上に来る位置に） */
    function goToDayInTable(d) {
      if (!grid) return;
      var r = -1;
      for (var k = 0; k < rows.length; k++) if (rows[k].date === d && rows[k].first) { r = k; break; }
      if (r < 0) return;
      var c = cols.map(function (p) { return p.employeeId; }).indexOf(me.employeeId);
      grid.select(r, c >= 0 ? c + 1 : 1);
      var sc = ui.$('grid').querySelector('.grid-scroll');
      var tr = ui.$('grid').querySelectorAll('tbody tr')[r];
      var head = ui.$('grid').querySelector('thead');
      if (sc && tr) sc.scrollTop = Math.max(0, tr.offsetTop - (head ? head.offsetHeight : 0));
    }

    /** 表でマスを選んだ: その行の日を「選んでいる日」にして、申し送り・まとめを出し直す */
    function onSelect() {
      if (mode !== 'table' || !grid) return;
      var s = grid.selection();
      var d = rows[s.r2] ? rows[s.r2].date : day;
      if (d !== day) { day = shownDay = d; renderSide(); sendSeen(); }
      updateTools();
    }

    /** 打った・貼り付けた内容（まとめて） */
    function onGridChange(list) {
      var adds = [];
      list.forEach(function (ch) {
        var x = cellOf(ch.r, ch.c);
        var v = String(ch.value || '').replace(/^[\s　]+|[\s　]+$/g, '');
        if (x.kind === 'empty' && v !== '') {
          adds.push({ ownerId: x.owner.employeeId, date: x.date, content: v });
        } else if (x.kind === 'task' && v !== '' && v !== x.it.content) {
          var id = x.it.taskId;
          enqueue({ action: 'task.update', args: function () { var cur = findItem(id); return { taskId: id, baseVersion: cur ? cur.recordVersion : 0, content: v }; }, label: '「' + v + '」' });
        }
      });
      if (adds.length === 1) enqueue({ action: 'task.add', args: function () { return Object.assign({ urgency: '通常', hidden: false }, adds[0]); }, label: '「' + adds[0].content + '」', reload: true });
      else if (adds.length > 1) {
        for (var i = 0; i < adds.length; i += 50) {
          (function (part, last) { enqueue({ action: 'task.addMany', args: function () { return { items: part }; }, label: part.length + ' 件のタスク', reload: last }); })(adds.slice(i, i + 50), i + 50 >= adds.length);
        }
      }
      if (grid) grid.refresh();
    }

    /** 選んでいるセルのタスク（無ければ null） */
    function selectedEntry() {
      if (mode !== 'table' || !grid) return null;
      var s = grid.selection();
      if (!rows[s.r2]) return null;
      var x = cellOf(s.r2, s.c2);
      return x.kind === 'task' || x.kind === 'mark' ? x : null;
    }
    function selectedTask() { var e = selectedEntry(); return e && e.kind === 'task' ? e.it : null; }

    function updateTools() {
      var e = selectedEntry();
      var it = e && e.kind === 'task' ? e.it : null;
      var busy = sending || loading || !!failed || viewing();
      var set = function (id, ok) { ui.$(id).disabled = busy || !ok; };
      set('t-complete', it && it.can.complete && it.state === '未完了');
      set('t-reopen', it && it.can.complete && it.state === '完了');
      set('t-defer', it && it.can.defer && it.state === '未完了');
      set('t-due', it && it.can.edit);
      set('t-cancel', it && it.can.cancel && it.state === '未完了');
      set('t-uncancel', it && it.can.cancel && it.state === '取りやめ');
      set('t-urgency', it && it.can.edit);
      set('t-hide', it && it.can.edit);
      set('t-note', it && it.can.note);
      set('t-consult', it && it.can.consult);
      set('t-up', it && it.can.move && !!TV.moveArgs(data, it, -1));
      set('t-down', it && it.can.move && !!TV.moveArgs(data, it, 1));
      set('t-delete', it && it.can.del);
      ui.$('t-today').disabled = loading;
      ui.$('sel-info').textContent = e ? '選んでいるタスク: ' + TV.fullText(e, data) : '';
    }

    // ------------------------------------------------------------------ 日付ごとの一覧（スマホ）

    function renderList() {
      ui.$('day-label').textContent = dayLabel(day);
      ui.$('text-mode').textContent = textMode === 'clip' ? '長い内容を全部出す' : '長い内容を1行で切る';
      var box = ui.clear(ui.$('day-list'));
      box.className = 'day-list text-' + textMode;
      shownPeople().forEach(function (p) { box.appendChild(card(p)); });
      ui.$('add-box').hidden = viewing();
    }

    /** 1人の欄。自分の欄はいつも開いている（残りは全部出す）。ほかの人の欄は見出しを押すと開く */
    function card(p) {
      var mine = p.employeeId === me.employeeId;
      var list = TV.entries(data, p.employeeId, day);
      var n = TV.counts(list);
      var open = mine || !!openCards[p.employeeId];
      var urgent = list.filter(function (e) { return e.kind === 'task' && e.it.state === '未完了' && e.it.urgency !== '通常'; }).length;
      var over = list.filter(function (e) { var d = e.kind === 'task' ? TV.due(e.it, data) : null; return d && d.level === 'over'; }).length;
      var title = p.name + (mine ? '（自分）' : '') + (p.active ? '' : '（利用停止）');
      var count = n.total ? '残り ' + n.open + ' ／ 全 ' + n.total + ' 件' : 'タスクなし';
      if (!mine && urgent) count += '・急ぎ ' + urgent;
      if (!mine && over) count += '・〆過ぎ ' + over;
      var head = mine
        ? ui.el('div', { class: 'person-head' }, [ui.el('span', { class: 'person-name', text: title }), ui.el('span', { class: 'person-count', text: count })])
        : ui.el('button', { type: 'button', class: 'person-head', 'aria-expanded': open ? 'true' : 'false',
          on: { click: function () { openCards[p.employeeId] = !open; renderList(); } } },
        [ui.el('span', { class: 'person-name', text: title }), ui.el('span', { class: 'person-count', text: count + (open ? '　▲' : '　▼') })]);
      var sec = ui.el('section', { class: 'person-card' + (mine ? ' mine' : ''), id: 'card-' + p.employeeId, 'aria-label': title }, [head]);
      if (!open) return sec;
      var ul = ui.el('ul', { class: 'tk-list' });
      var live = list.filter(function (e) { return e.kind === 'task' && e.it.state === '未完了'; });
      var rest = list.filter(function (e) { return !(e.kind === 'task' && e.it.state === '未完了'); });
      live.forEach(function (e) { ul.appendChild(rowOf(e)); });
      if (!list.length) ul.appendChild(ui.el('li', { class: 'tk-empty sub', text: 'この日のタスクはありません' }));
      if (rest.length) {
        var shown = !!openDone[p.employeeId];
        var done = rest.filter(function (e) { return e.kind === 'task' && e.it.state === '完了'; }).length;
        var label = '✓ 完了 ' + done + ' 件' + (rest.length > done ? '・ほか ' + (rest.length - done) + ' 件' : '') + (shown ? '　▲' : '　▼');
        ul.appendChild(ui.el('li', { class: 'tk-fold' }, [ui.el('button', { type: 'button', class: 'fold-btn', text: label, 'aria-expanded': shown ? 'true' : 'false',
          on: { click: function () { openDone[p.employeeId] = !shown; renderList(); } } })]));
        if (shown) rest.forEach(function (e) { ul.appendChild(rowOf(e)); });
      }
      sec.appendChild(ul);
      return sec;
    }

    /** 1件の行: [番号] [□] [急ぎ 内容 … 印] [〆] 。□ は完了（押せる人だけ）、行を押すとメニュー */
    function rowOf(e) {
      var it = e.it;
      var canCheck = e.kind === 'task' && it.can.complete && it.state !== '取りやめ' && !viewing();
      return MP.taskItem.row(e, data, {
        canCheck: canCheck, disabled: sending || loading,
        onCheck: function (t, done) { stateOp(t, done ? 'reopen' : 'complete'); },
        onOpen: function (t, no) { menu(t, no); },
      });
    }

    function button(label, fn, kind) { return ui.el('button', { type: 'button', class: 'btn' + (kind ? ' ' + kind : ''), text: label, disabled: sending || loading, on: { click: fn } }); }

    /** 行を押したときのメニュー（全文と、その人ができる操作だけ） */
    function menu(it0, no) {
      var it = findItem(it0.taskId) || it0;
      var buttons = [];
      var add = function (label, value, kind) { buttons.push({ label: label, value: value, kind: kind || '' }); };
      if (!viewing()) {
        if (it.can.complete && it.state === '未完了') add('完了にする', 'complete', 'primary');
        if (it.can.complete && it.state === '完了') add('未完了に戻す', 'reopen');
        if (it.can.note) add(it.note ? '完了の一言を直す' : '完了の一言を足す', 'note');
        if (it.can.defer && it.state === '未完了') add('先送り', 'defer');
        if (it.can.edit) { add('締め切り', 'due'); add('急ぎの度合い', 'urgency'); add('内容を直す', 'content'); add(it.hidden ? '見せる（🔒 を外す）' : '隠す（🔒）', 'hide'); }
        if (it.can.consult) add(it.consult ? '相談を直す' : '依頼した人に相談する', 'consult');
        if (it.can.cancel && it.state === '未完了') add('取りやめ', 'cancel');
        if (it.can.cancel && it.state === '取りやめ') add('取りやめから戻す', 'uncancel');
        if (it.can.move && TV.moveArgs(data, it, -1)) add('上へ', 'up');
        if (it.can.move && TV.moveArgs(data, it, 1)) add('下へ', 'down');
        if (it.can.del) add('消す', 'delete', 'danger');
      }
      add('閉じる', null);
      return ui.dialog({ title: 'タスク', text: TV.fullText({ kind: 'task', it: it, no: no }, data), buttons: buttons }).then(function (v) {
        if (!v || loading) return;
        if (v === 'complete' || v === 'reopen' || v === 'cancel' || v === 'uncancel') return stateOp(it, v);
        if (v === 'defer') return deferOp(it);
        if (v === 'due') return dueOp(it);
        if (v === 'urgency') return urgencyOp(it);
        if (v === 'content') return contentOp(it);
        if (v === 'hide') return hideOp(it);
        if (v === 'note') return noteOp(it);
        if (v === 'consult') return consultOp(it);
        if (v === 'up') return moveOp(it, -1);
        if (v === 'down') return moveOp(it, 1);
        if (v === 'delete') return deleteOp(it);
      });
    }

    // ------------------------------------------------------------------ 操作

    function updateOp(it, fields, reload) {
      var id = it.taskId;
      enqueue({ action: 'task.update', args: function () { var cur = findItem(id); return Object.assign({ taskId: id, baseVersion: cur ? cur.recordVersion : 0 }, fields); }, label: '「' + it.content + '」', reload: !!reload });
    }

    function stateOp(it, op, extra) {
      var id = it.taskId;
      hideUndo();
      enqueue({ action: 'task.state', args: function () { var cur = findItem(id); return Object.assign({ taskId: id, baseVersion: cur ? cur.recordVersion : 0, op: op }, extra || {}); },
        label: '「' + it.content + '」', reload: op === 'defer', undo: op === 'complete' });
    }

    function deferOp(it) {
      return TD.defer({ it: it, today: data.taskToday, rules: data.rules }).then(function (to) { if (to) stateOp(it, 'defer', { to: to }); });
    }

    function dueOp(it) {
      return TD.due({ it: it, rules: data.rules, today: data.taskToday }).then(function (v) {
        if (!v || (v.due === it.due && v.dueTime === it.dueTime)) return;
        updateOp(it, { due: v.due, dueTime: v.dueTime });
      });
    }

    function urgencyOp(it) {
      var buttons = data.rules.urgency.map(function (u) { return { label: u, value: u, kind: u === it.urgency ? 'primary' : '' }; });
      buttons.push({ label: 'やめる', value: null });
      return ui.dialog({ title: '急ぎの度合い', text: '「' + it.content + '」', buttons: buttons }).then(function (u) {
        if (!u || u === it.urgency) return;
        updateOp(it, { urgency: u });
      });
    }

    function contentOp(it) {
      return TD.text({ title: '内容を直す', label: '内容', value: it.content, max: data.rules.contentMax, required: true, okLabel: '直す' }).then(function (v) {
        if (v === null || v === it.content) return;
        updateOp(it, { content: v });
      });
    }

    function hideOp(it) { updateOp(it, { hidden: !it.hidden }, true); }

    function noteOp(it) {
      return TD.text({ title: '完了の一言', label: '一言', value: it.note || '', max: data.rules.noteMax, okLabel: '決める',
        hint: it.requester ? '依頼した人への知らせに出ます。空にすると消えます。' : '空にすると消えます。' }).then(function (v) {
        if (v === null || v === (it.note || '')) return;
        var id = it.taskId;
        enqueue({ action: 'task.note', args: function () { var cur = findItem(id); return { taskId: id, baseVersion: cur ? cur.recordVersion : 0, note: v }; }, label: '「' + it.content + '」の一言' });
      });
    }

    function consultOp(it) {
      return TD.text({ title: '依頼した人に相談する', label: '相談', value: it.consult ? it.consult.text : '', max: data.rules.noteMax, okLabel: '送る',
        hint: it.requesterName + 'さんのタスクリストに知らせが出ます。空にすると相談を取り消します。' }).then(function (v) {
        if (v === null || v === (it.consult ? it.consult.text : '')) return;
        var id = it.taskId;
        enqueue({ action: 'task.request.consult', args: function () { var cur = findItem(id); return { taskId: id, baseVersion: cur ? cur.recordVersion : 0, text: v }; }, label: '「' + it.content + '」の相談' });
      });
    }

    function deleteOp(it) {
      return ui.confirm('タスクを消す', '「' + it.content + '」を消しますか？', '消す', 'danger').then(function (ok) {
        if (!ok) return;
        var id = it.taskId;
        enqueue({ action: 'task.delete', args: function () { var cur = findItem(id); return { taskId: id, baseVersion: cur ? cur.recordVersion : 0 }; }, label: '「' + it.content + '」', reload: true });
      });
    }

    /** 並べ替え（送る直前に、今の姿から並びと版を作る。同じ群の中でだけ。競合したら読み直して並べ直してもらう。Codex 実装1回目 medium） */
    function moveOp(it, dir) {
      var id = it.taskId;
      enqueue({ action: 'task.move', label: '並べ替え', reload: true, noRetry: true, args: function () {
        var cur = findItem(id);
        return cur ? TV.moveArgs(data, cur, dir) : null; // 動かせない（端・群の境目・もう無い）→ 送らない
      } });
    }

    /** 足す・依頼する（ダイアログ）。ownerId は初めに選んでおく担当 */
    function addDialog(ownerId, request) {
      return TD.add({ request: !!request, people: data.people, departments: data.departments, meId: me.employeeId, ownerId: ownerId, date: day, rules: data.rules }).then(function (v) {
        if (!v) return;
        enqueue({ action: 'task.add', args: function () { return v; }, label: '「' + v.content + '」', reload: true });
      });
    }

    function handoverOp(h) {
      return TD.handover({ h: h || null, departments: data.departments, myDeptId: data.myDeptId, canAnyDept: isBoss(), deptId: deptId || data.myDeptId, date: day, rules: data.rules }).then(function (v) {
        if (!v) return;
        if (v.remove) {
          enqueue({ action: 'task.handover.delete', args: function () { return { handoverId: h.handoverId, baseVersion: h.recordVersion }; }, label: '申し送り', reload: true });
          return;
        }
        enqueue({ action: 'task.handover.save', label: '申し送り', reload: true,
          args: function () { return { handoverId: h ? h.handoverId : null, baseVersion: h ? h.recordVersion : 0, deptId: v.deptId, from: v.from, to: v.to, content: v.content }; } });
      });
    }

    // ------------------------------------------------------------------ 完了の直後の帯（押し間違えを取り消す）

    function hideUndo() {
      if (undo && undo.timer) window.clearTimeout(undo.timer);
      undo = null;
      ui.$('undo-bar').hidden = true;
    }

    function showUndo(it) {
      hideUndo();
      ui.$('undo-text').textContent = '「' + it.content + '」を完了にしました';
      ui.$('undo-bar').hidden = false;
      undo = { taskId: it.taskId, timer: window.setTimeout(hideUndo, UNDO_MS) };
    }

    ui.$('undo-btn').addEventListener('click', function () {
      if (!undo || loading) return;
      var it = findItem(undo.taskId);
      hideUndo();
      if (it && it.state === '完了') stateOp(it, 'reopen');
    });
    ui.$('undo-note').addEventListener('click', function () {
      if (!undo || loading) return;
      var it = findItem(undo.taskId);
      hideUndo();
      if (it && it.state === '完了') noteOp(it);
    });

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
        if (f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
      }
      if (mode === 'table' && grid) updateTools(); // 送っている間・止まっている間は、操作のボタンを止める
      Array.prototype.forEach.call(document.querySelectorAll('#day-list button.tk-check, #day-list button.tk-main, #notices button'), function (b) { b.disabled = sending || loading || !!failed; });
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
        // 足す・先送り・隠す・消す・並べ替え・申し送りは、印や並び・番号が変わるので読み直す
        if (op.reload) return load(false).then(function () { pump(); });
        jumpToday = false;
        render();
        if (op.undo && res.data.item && res.data.item.state === '完了') showUndo(res.data.item);
        pump();
      }, function () {
        sending = false;
        failed = { op: op, kind: 'unknown', message: '送れたか分かりません' };
        renderQueue();
      });
    }

    /**
     * 答えの姿を手元に入れる（版を次の操作に使う）。
     * 並びの順位（rank）は月の表の答えにだけ付く（保存した並びの値は画面に来ない）ので、手元の順位を引き継ぐ。
     * 急ぎ・締め切り・状態が変わって群が移ったときの群の中の順は、次に読み直すまで手元の順位のまま
     */
    function applyResult(op, d) {
      var set = function (it) {
        if (!it) return;
        var k = data.items.map(function (i) { return i.taskId; }).indexOf(it.taskId);
        it.rank = k >= 0 ? data.items[k].rank : 99999;
        it.order = it.rank;
        if (k >= 0) data.items[k] = it; else data.items.push(it);
      };
      if (d.item && d.item.taskId) set(d.item);
      if (d.results) d.results.forEach(function (x) { set(x.item); });
      if (d.results && d.results.some(function (x) { return x.status === 'error'; })) {
        ui.pageMessage(d.results.filter(function (x) { return x.status === 'error'; }).map(function (x) { return (x.index + 1) + '件目: ' + x.message; }).join('\n'), 'warn');
      }
    }

    // ------------------------------------------------------------------ ボタン

    // 表でマスを選んだとき（押す・キーで動く）。表は描き直すたびに作り直すが、箱（#grid）は同じなので、ここで1回だけ付ける
    ui.$('grid').addEventListener('click', onSelect);
    ui.$('grid').addEventListener('keyup', onSelect);

    function withSel(fn) { return function () { if (loading) return; var it = selectedTask(); if (it) fn(it); }; }
    ui.$('t-complete').addEventListener('click', withSel(function (it) { stateOp(it, 'complete'); }));
    ui.$('t-reopen').addEventListener('click', withSel(function (it) { stateOp(it, 'reopen'); }));
    ui.$('t-defer').addEventListener('click', withSel(deferOp));
    ui.$('t-due').addEventListener('click', withSel(dueOp));
    ui.$('t-cancel').addEventListener('click', withSel(function (it) { stateOp(it, 'cancel'); }));
    ui.$('t-uncancel').addEventListener('click', withSel(function (it) { stateOp(it, 'uncancel'); }));
    ui.$('t-urgency').addEventListener('click', withSel(urgencyOp));
    ui.$('t-hide').addEventListener('click', withSel(hideOp));
    ui.$('t-note').addEventListener('click', withSel(noteOp));
    ui.$('t-consult').addEventListener('click', withSel(consultOp));
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
    ui.$('to-list').addEventListener('click', function () { mode = 'list'; put(VIEW_KEY, 'list'); jumpToday = false; render(); });
    ui.$('to-table').addEventListener('click', function () { mode = 'table'; put(VIEW_KEY, 'table'); jumpToday = true; render(); });
    ui.$('text-mode').addEventListener('click', function () { textMode = textMode === 'clip' ? 'wrap' : 'clip'; put(TEXT_KEY, textMode); renderList(); });

    /** 今日へ（タスクの今日）。ほかの月を見ているときは、その月を読み直す */
    function goToday() {
      if (loading) return;
      var t = data.taskToday;
      if (t.slice(0, 7) === ym) {
        day = shownDay = t;
        if (mode === 'table') { goToDayInTable(t); updateTools(); renderSide(); } else { renderList(); renderSide(); sendSeen(); }
        return;
      }
      if (sending || queue.length) return;
      day = t; ym = t.slice(0, 7);
      reloadNow();
    }
    ui.$('t-today').addEventListener('click', goToday);
    ui.$('day-today').addEventListener('click', goToday);

    /** 日を動かす。月をまたぐときは、その日のまま月を読み直す（月初の「前日」で前月末へ。Codex 実装4回目 medium） */
    function goDay(k) {
      if (loading) return;
      var d = CT.addDays(day, k);
      if (d >= data.from && d <= data.to) { day = shownDay = d; renderList(); renderSide(); sendSeen(); return; }
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
    ui.$('add-detail').addEventListener('click', function () { if (!loading && !viewing()) addDialog(me.employeeId, false); });
    ui.$('request-btn').addEventListener('click', function () {
      if (loading || viewing()) return;
      // 初めに選んでおく相手: 見ている部署のほかの人（いなければ、ほかのだれか）
      var others = shownPeople().concat(data.people).filter(function (p) { return p.active && p.employeeId !== me.employeeId; });
      if (!others.length) { ui.pageMessage('依頼できる相手がいません', 'error'); return; }
      addDialog(others[0].employeeId, true);
    });
    ui.$('handover-add').addEventListener('click', function () { if (!loading && !viewing()) handoverOp(null); });

    // 初め: タスクの今日の月。見る形は端末で最後に使った方（初めはパソコンの幅なら表、スマホは一覧）
    var q = new URLSearchParams(window.location.search);
    explicitMonth = /^\d{4}-\d{2}$/.test(q.get('month') || '');
    ym = explicitMonth ? q.get('month') : guessToday().slice(0, 7);
    mode = got(VIEW_KEY) === 'table' || got(VIEW_KEY) === 'list' ? got(VIEW_KEY) : window.innerWidth >= 600 ? 'table' : 'list';
    textMode = got(TEXT_KEY) === 'wrap' ? 'wrap' : 'clip';
    return load(true);
  });
})();
