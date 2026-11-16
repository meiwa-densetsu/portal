/*
 * タスクリスト（計画 docs/plans/stage2-tasklist-plan.md 2-8・改善の計画 docs/plans/stage2-tasklist-v2-plan.md）
 *
 * パソコン: 月の表（列 = 番号・担当〔選んだ部署の人〕・申し送り。行 = 日付ごとのタスク＋新しいタスクの空きの行。1マス = 1件）。日報の表と同じ部品（grid.js）
 * スマホ: 日付を選んで、人ごとの欄（自分を先に）。1件を1行に（□ で完了・行を押すとメニュー）。終わったものはたたむ
 * 上に 申し送り・依頼したタスクの知らせ（完了・相談。✕ で消す）・部署のまとめ（部長と管理者）
 * 送り方: すべての操作を1つの順番待ちの列で送る（前の答えが返ってから次。答えの版を使う）。通信の結果が分からないときは同じ requestId で送り直す。
 *         CONFLICT（ほかの人が直した）のときは自分の入力を残し、「最新を読む」「自分の入力をもう一度送る」を選べる
 *         「見た」「✕」は版を上げない印なので、列を通さずに送る
 *         月の表の空きのマスに 1 件打って足すときは、保存を待たずに「保存中」の仮のタスクを出して続けて打てる（答えが来たら本物に差し替える。月は読み直さない）
 *         月の表でタスクのマスを空にする（選んで Backspace・Delete）と、確かめてから消す
 *         消した後は 10 秒「元に戻す」の帯を出す（task.restore。計画 docs/plans/stage2-task-undo-delete-plan.md 第3章）
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
    var UNDO_DELETE_MS = 10000; // 消した後の帯（ユーザー決定 2026-11-16 Q2: A 10 秒）。時計は、その回の消すがすべて終わってから数える
    // 二つの姿（計画 stage2-task-speed-plan.md 3-1）: base = サーバーの姿（読んだ答え・操作の返事。月の表で打った仮のタスクも入る）、
    // data = 描くための姿（base に、まだ届いていない「押したらすぐ」の操作をかけたもの。rebuildView で作り直す。描く関数は data だけを見る）
    var me = null, base = null, data = null, ym = null, grid = null, mode = null, day = null;
    var rebuildAfterEdit = false; // 月の表で打っている最中に行が変わった: 編集が終わってから表を作り直す（4-2）
    var TIMING = /(?:^|[?&])timing=1(?:&|$)/.test(window.location.search.slice(1)); // 開くときの時間を出す（第6章）
    var timing = { stale: null, fresh: null, serverMs: null };
    var deptId = null;     // 見ている部署（'' = 全員。null = まだ決めていない）
    var textMode = 'clip'; // 長い内容: clip（1行で切る）・wrap（全部出す）
    var openCards = {};    // スマホ: 開いている人の欄（社員ID → 真）
    var openDone = {};     // スマホ: 終わったものを開いている人の欄
    var rows = [];         // 表の行: [{ date, idx, first, count }]
    var cols = [];         // 表に出している人
    var queue = [];        // 送る操作の列
    var sending = false;
    var current = null;    // 送っている最中の操作
    var tmpSeq = 0;        // 月の表で打って足した「保存中」の仮のタスクの連番
    var muteCleared = false; // 消すかを確かめている間、表の部品の「セルを空にしました」の知らせを出さない
    var rebuildTyped = null; // 打って足した後、表を作り直すのを待っている間の「打ったマス」{ r, c }
    var failed = null;     // CONFLICT などで止まった操作 { op, message }
    var seenSent = {};     // 「見た」を送ったタスク（タスクID:版）
    var undo = null;       // 帯: 完了にした直後 { kind: 'complete', taskId, timer }／消した直後 { kind: 'delete', batch, timer }
    var latestBatch = null; // いちばん新しい「消す」の束（確かめの窓で「消す」を押した回ごと。{ done: [消せた分], ops: [消すの操作] }）
    var explicitMonth = false, firstLoad = true;
    // 前に開いたときの内容（控え）を先に出す（計画 stage2-switch-speed-plan.md 1-3）
    var stale = false;     // 控えを出している間（loading は立てたまま。書く操作はすべて loading で止まる）
    var gotFresh = false;  // この画面で、本物の task.month を 1 回は読めた
    var sideCalls = 0;     // 列を通らない通信（依頼を見た印・知らせの ✕）の途中の数
    var sideUnknown = false; // その通信が、結果の分からないまま終わった（画面を離れるときに打ち切られた・電波なし）。次に最新を読むまで控えを書かない
    var STALE_TEXT = '前に開いたときの内容です。最新を確かめています…';
    var STALE_FAILED_TEXT = '前に開いたときの内容です（最新を読めませんでした。画面を読み込み直してください）';

    function viewing() { return MP.guard.viewing(); }
    /** 結果が分からない失敗か（通信が切れた・混み合い・途中で止まった。画面を離れるときにブラウザが打ち切った通信も NETWORK になる） */
    function unknownResult(res) { return res.code === 'NETWORK' || res.code === 'BUSY' || res.code === 'INTERNAL'; }
    /** 開く月の初めの見当（端末の時計で、タスクの今日の切り替わり〔設定 TASK_DAY_START_MIN。朝 6 時〕より前は前の日。本当の「タスクの今日」はサーバーの答えで決め直す） */
    function guessToday() { return new Date(Date.now() + 9 * 3600000 - MP.config.TASK_DAY_START_MIN * 60000).toISOString().slice(0, 10); }
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

    /**
     * 月を読む。番号で見分け、最後に頼んだ読み込み以外の答えは捨てる（月を続けて切り替えたとき。Codex 実装2回目 medium）。
     * 読めたら真、読めなければ偽で終わる（3-7。止まった操作の帯は、読めたときだけ先へ進む）。
     * before … 読めた後、描く前に呼ぶ（止まった操作を捨てる・送り直す整理。読めなければ呼ばない。3-7 の「読めた後の順番」）
     */
    function load(first, before) {
      var my = ++loadSeq;
      var args = { month: ym };
      // 同じ月の読み直し（操作の後・「新しくする」）では、表の位置と選んでいるマスを保つ。初めて開いたとき・控えの後・月を切り替えたときは今日の段へ
      var keep = !first && !!data && !stale && data.month === ym;
      var hadFocus = keep && tableFocused();
      setLoading(true);
      var p = first ? MP.guard.enter({ load: { action: 'task.month', args: args }, noLoadingNote: stale, onFail: staleFailed })
        : MP.api.call('task.month', args).then(function (res) { return { me: me, res: res }; });
      return p.then(function (r) {
        if (my !== loadSeq) return false; // 古い答え
        me = r.me;
        // 控えを出している間に読めなかった: 止めたまま（loading を下ろさない）にして、一言だけ変える
        if (!r.res.ok && stale) { staleFailed(); ui.pageMessage(r.res.message + '\n画面を読み込み直してください', 'error'); return false; }
        setLoading(false);
        if (!r.res.ok) { // 読めなければ、今出している月と日に戻す（月の移動で day を空にしていても。Codex 実装5回目 medium）
          if (data) { ym = data.month; day = shownDay; render(); }
          ui.pageMessage(r.res.message, 'error'); return false;
        }
        if (r.res.data.month !== ym) return false; // 念のため: 頼んだ月と違う答えは使わない
        // 初めに開いたとき: 端末の時計で見当を付けた月が、サーバーの「タスクの今日」の月と違えば、その月を読み直す（月の変わり目の夜中）
        if (firstLoad && !explicitMonth && r.res.data.taskToday.slice(0, 7) !== ym) {
          firstLoad = false;
          ym = r.res.data.taskToday.slice(0, 7);
          return load(false, before);
        }
        firstLoad = false;
        base = r.res.data;
        stale = false;
        gotFresh = true;
        sideUnknown = false; // 最新を読めた
        ui.$('stale-note').hidden = true;
        if (before) before(); // 止まった操作の整理（捨てる・送り直す）。描く前に
        restorePending();
        rebuildView();
        saveView(); // 描く前に（描くと「依頼を見た印」の通信が始まることがある）
        adopt(keep);
        if (hadFocus && mode === 'table' && grid) grid.focus(); // 表の中で打っていたら、押し直さずに続けて打てるように
        if (TIMING && timing.fresh === null) { timing.fresh = now(); timing.serverMs = typeof r.res.serverMs === 'number' ? r.res.serverMs : null; renderTiming(); }
        return true;
      });
    }

    function now() { return window.performance && performance.now ? performance.now() : 0; }
    /** ?timing=1 のときだけ、開くときの時間を一言で出す（第6章。数字だけ） */
    function renderTiming() {
      if (!TIMING) return;
      var n = document.getElementById('timing-note');
      if (!n) {
        n = ui.el('p', { id: 'timing-note', class: 'sub', role: 'status' });
        var s = ui.$('stale-note');
        s.parentNode.insertBefore(n, s);
      }
      var sec = function (ms) { return (Math.round(ms / 100) / 10).toFixed(1) + ' 秒'; };
      var parts = [];
      if (timing.stale !== null) parts.push('控え ' + sec(timing.stale));
      if (timing.fresh !== null) parts.push('最新 ' + sec(timing.fresh) + (timing.serverMs !== null ? '（サーバーの中 ' + sec(timing.serverMs) + '）' : ''));
      n.textContent = parts.join('・');
    }

    /** data（本物の答え・控え）を画面に出す。日と部署を決めてから描く。keep = 月の表の位置と選んでいるマスを保つ（同じ月の読み直し） */
    function adopt(keep) {
      ui.$('view').hidden = false;
      ui.$('to-export').hidden = !MP.guard.isAdmin(me) || viewing();
      if (!day || day.slice(0, 7) !== ym) day = data.taskToday.slice(0, 7) === ym ? data.taskToday : data.from;
      shownDay = day;
      if (deptId === null) { // 初めは端末に覚えた部署。無ければ自分の部署（部署が無い人は全員）
        var saved = got(DEPT_KEY);
        deptId = saved !== null && (saved === '' || data.departments.some(function (d) { return d.deptId === saved; })) ? saved : (data.myDeptId || '');
      } else if (deptId !== '' && !data.departments.some(function (d) { return d.deptId === deptId; })) deptId = '';
      jumpToday = !keep;
      render();
    }

    /** まだ送り終わっていない操作（送っている最中・止まっている・列で待っている） */
    function pendingOps() { return (current ? [current] : []).concat(failed ? [failed.op] : [], queue); }

    /** 月を読み直して data を入れ替えた後: まだ送り終わっていない操作の仮のタスク（保存中）を入れ直す */
    function restorePending() {
      pendingOps().forEach(function (o) {
        var t = o.tmp;
        if (!t || base.items.indexOf(t) >= 0) return;
        if (t.date < base.from || t.date > base.to) return; // ほかの月の分は入れない（止まったまま月を移したとき）
        // 結果が分からず止まった操作は、サーバーで入っていることがある。同じ担当・日・内容の本物があれば重ねない
        // （取り違えても見かけだけ。操作は止まったまま残り、「もう一度送る」で入る）
        if (failed && failed.op === o && failed.kind === 'unknown' && base.items.some(function (i) {
          return !i.pending && i.owner === t.owner && i.date === t.date && i.content === t.content && i.state === '未完了';
        })) return;
        base.items.push(t);
      });
    }

    /** やめた操作の仮のタスクを外す（読み直しに失敗しても「保存中」のまま残さない）。仮のタスクは base の中のものだけを扱う（3-1） */
    function dropPending(ops) {
      if (!base) return;
      ops.forEach(function (o) { var k = o.tmp ? base.items.indexOf(o.tmp) : -1; if (k >= 0) base.items.splice(k, 1); });
    }

    /** 月の表の中にフォーカスがあるか（表を作り直した後に戻すため） */
    function tableFocused() { return mode === 'table' && !!grid && ui.$('grid').contains(document.activeElement); }

    /** 控えを出している間に、最新を読めなかった: 一言を変える（止めたままなのは loading が立ったままだから） */
    function staleFailed() {
      if (!stale) return;
      var n = ui.$('stale-note');
      n.textContent = STALE_FAILED_TEXT;
      n.hidden = false;
    }

    /**
     * 今の内容を、次に開くときの控えとして覚える（最新を読めたとき・画面を離れるとき）。
     * 条件が 1 つでも欠ければ、書かずに古い控えを消す。見ている間（なりすまし）は何もしない
     */
    function saveView() {
      if (viewing()) return;
      // 書くのはサーバーの姿（base）。「押したらすぐ」の姿は書かない（送り残しがあるときは、そもそも書かない。3-7）
      var ok = gotFresh && !stale && !loading && !sending && !current && !queue.length && !failed && !sideCalls && !sideUnknown
        && !!base && !!me && base.month === String(base.taskToday).slice(0, 7)
        && !base.items.some(function (i) { return i.pending; }); // 「保存中」の仮のタスクは控えに書かない（念のため）
      if (ok) MP.store.setTaskView(me.employeeId, base); else MP.store.clearTaskView();
    }

    /** 控えとして出せる形か（今月・端末の時計の見当と同じ「タスクの今日」・一覧が配列） */
    function usableView(v) {
      return !!v && v.month === ym && v.taskToday === guessToday() && typeof v.from === 'string' && typeof v.to === 'string'
        && Array.isArray(v.items) && Array.isArray(v.people) && Array.isArray(v.departments) && !!v.rules && typeof v.rules === 'object';
    }

    /** 初めに: 控えがあれば、最新を待たずに出す（loading を立てたまま ＝ 見るだけ） */
    function showStale() {
      if (explicitMonth || viewing()) return;
      var cm = MP.store.me();
      var v = cm ? MP.store.taskView() : null;
      if (!usableView(v)) return;
      stale = true;
      me = cm;
      base = v;
      rebuildView();
      loading = true; // 描く前に立てる（描く中の sendSeen・行のボタンが loading を見る）
      try {
        adopt();
      } catch (e) { // 控えの中身が今の画面と合わない（古い版の控えなど）: 捨てて、今までどおり最新を待つ
        stale = false; me = null; base = null; data = null; day = null; shownDay = null; deptId = null;
        ui.$('view').hidden = true;
        MP.store.clearTaskView();
        return;
      }
      var n = ui.$('stale-note');
      n.textContent = STALE_TEXT;
      n.hidden = false;
      if (TIMING) { timing.stale = now(); renderTiming(); }
    }

    /** 描いている姿のタスク（押したときの判定・メニュー・帯） */
    function findViewItem(taskId) { return data ? data.items.filter(function (i) { return i.taskId === taskId; })[0] || null : null; }
    /** サーバーの姿のタスク（送る中身の版 baseVersion はこれだけから取る。描く姿で先に消したタスクも見つかる。3-3） */
    function findBaseItem(taskId) { return base ? base.items.filter(function (i) { return i.taskId === taskId; })[0] || null : null; }
    function baseVersionOf(taskId) { var cur = findBaseItem(taskId); return cur ? cur.recordVersion : 0; }

    /**
     * 描くための姿にかける操作（3-2）: 送っている最中 → 結果が分からないで止まった操作 → 列の順。
     * 断られた・競合で止まった操作はかけない（すぐ元の姿に戻る）
     */
    function optOps() {
      var list = [];
      if (current && current.opt) list.push(current.opt);
      if (failed && failed.kind === 'unknown' && failed.op.opt) list.push(failed.op.opt);
      queue.forEach(function (o) { if (o.opt) list.push(o.opt); });
      return list;
    }
    /**
     * そのタスクを消す操作が、まだ届いていないか（もう消しているので、もう一度消させない）。
     * 完了・未完了の送り待ちのタスクは、続けて消す・直すができる（送る直前に base の版で作るので順番どおりに通る。Codex 実装 1 回目 medium）
     */
    function pendingDelete(taskId) { return optOps().some(function (x) { return x.kind === 'delete' && x.taskId === taskId; }); }
    /** 描くための姿を作り直す（base が変わった・列が変わった・失敗が決まったとき） */
    function rebuildView() { data = base ? MP.taskOpt.view(base, optOps(), canOfView) : null; }
    /**
     * 押したらすぐ状態を変えたタスクの「できること」（サーバーの答えと同じ CalcTask.canAll。
     * 完了の送り待ちのタスクは消せない・直せない＝サーバーで断られる操作を押させない）
     */
    function canOfView(it) {
      return CT.canAll({ employeeId: me.employeeId, role: me.role }, { owner: it.owner, requester: it.requester, hidden: it.hidden, state: it.state });
    }

    /**
     * その人・その日の並び（TV.entries と同じ答え）。描く姿 data ごとに 1 回だけ人と日ごとに分けて覚える
     * （月の表を塗り直すとマスの数だけ呼ぶので、毎回全部のタスクをたどらない。B10）。data は rebuildView でしか変わらないので、data が替われば作り直す
     */
    var entCache = { data: null, get: null };
    function entriesOf(owner, date) {
      if (entCache.data !== data) entCache = { data: data, get: TV.entriesIndex(data) };
      return entCache.get(owner, date);
    }
    function shownPeople() { return TV.people(data, deptId, me.employeeId); }

    function render() {
      ui.$('month-label').textContent = Number(data.month.slice(0, 4)) + '年' + Number(data.month.slice(5, 7)) + '月';
      renderDeptBar();
      if (mode === 'table') renderTable(); else renderList();
      ui.$('table-pane').hidden = mode !== 'table';
      ui.$('list-pane').hidden = mode === 'table';
      ui.$('add-tools').hidden = viewing();
      ui.$('plan-more').hidden = data.planMore !== true; // 定型タスクの予定を上限で切ったとき（計画 stage2-task-plan-ahead-plan.md 3-2）
      renderNotify();
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
      sideCalls++; // 答えが来るまでは、控えを書かない
      MP.api.call('task.notice.dismiss', { items: [{ taskId: n.taskId, kind: n.kind, stamp: n.stamp }] }, { requestId: MP.api.newRequestId() }).then(function (res) {
        sideCalls--;
        if (!res.ok && unknownResult(res)) sideUnknown = true;
        if (!res.ok) { ui.pageMessage(res.message || '知らせを消せませんでした', 'error'); return; }
        if (base) base.notices = base.notices.filter(function (x) { return !(x.taskId === n.taskId && x.kind === n.kind && x.stamp === n.stamp); });
        rebuildView();
        if (res.data.skipped && res.data.skipped.length) { if (!sending && !queue.length) reloadNow(); return; }
        renderNotices();
      });
    }

    /** 自分に来た新しい依頼を「見た」にする（出したものだけ・1回だけ）。印はこの画面を読み直すまで出したまま */
    function sendSeen() {
      // サーバーへ書く処理なので、読み込みの間（控えを出している間も）は送らない。読み終わった後の render でもう一度呼ばれる
      if (viewing() || !data || loading) return;
      var mine = data.items.filter(function (i) { return i.fresh && i.owner === me.employeeId && (mode === 'table' || i.date === day); })
        .filter(function (i) { return !seenSent[i.taskId + ':' + i.recordVersion]; });
      if (!mine.length) return;
      mine.forEach(function (i) { seenSent[i.taskId + ':' + i.recordVersion] = true; });
      var max = data.rules.seenMax || 100;
      var send = function (part) {
        sideCalls++; // 答えが来るまでは、控えを書かない
        MP.api.call('task.request.seen', { items: part.map(function (i) { return { taskId: i.taskId, baseVersion: i.recordVersion }; }) }, { requestId: MP.api.newRequestId() }).then(function (res) {
          sideCalls--;
          if (!res.ok && unknownResult(res)) sideUnknown = true;
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

    function calcRows(people) {
      var out = [];
      for (var n = CT.dayNumber(data.from); n <= CT.dayNumber(data.to); n++) {
        var d = CT.dateOf(n);
        var max = 0;
        people.forEach(function (p) { max = Math.max(max, entriesOf(p.employeeId, d).length); });
        for (var k = 0; k <= max; k++) out.push({ date: d, idx: k, first: k === 0, count: max });
      }
      return out;
    }

    function buildRows() {
      cols = shownPeople();
      rows = calcRows(cols);
    }

    /** 今の data で作り直しても、表の行と列が今出しているものと同じか（同じなら塗り直すだけで足りる） */
    function sameTable() {
      var p = shownPeople();
      if (p.length !== cols.length || p.some(function (x, i) { return x.employeeId !== cols[i].employeeId; })) return false;
      var next = calcRows(p);
      return next.length === rows.length && next.every(function (x, i) { return x.date === rows[i].date && x.idx === rows[i].idx && x.count === rows[i].count; });
    }

    /** 作り直す前に選んでいた行（at = { date, idx }）が、新しい表の何行目か。その段が無くなっていたら、その日の最後の行 */
    function rowFor(at, fallback) {
      if (!at) return fallback;
      var last = -1;
      for (var k = 0; k < rows.length; k++) {
        if (rows[k].date !== at.date) continue;
        if (rows[k].idx === at.idx) return k;
        last = k;
      }
      return last >= 0 ? last : fallback;
    }

    /** 表のマス: 0 列目 = 番号、1〜 = 担当、最後 = 申し送り */
    function cellOf(r, c) {
      var row = rows[r];
      if (c === 0) return { kind: 'no', n: row.idx < row.count ? row.idx + 1 : 0 };
      if (c === cols.length + 1) return { kind: 'memo', date: row.date, first: row.first };
      var owner = cols[c - 1];
      var list = entriesOf(owner.employeeId, row.date);
      if (row.idx < list.length) return list[row.idx];
      if (row.idx === list.length) return { kind: 'empty', owner: owner, date: row.date };
      return { kind: 'none' };
    }

    function memoText(date) {
      return TV.handovers(data, deptId, date).map(function (x) { return (x.kind === 'memo' ? '〔前のメモ〕' : '') + x.h.content.replace(/\n/g, ' '); }).join(' ／ ');
    }

    /** 月の表を作り直す。typed = 打って足した直後の「打ったマス」{ r, c }（すぐ下へ動いていたら、足した行のすぐ下の空きのマスを選ぶ） */
    function renderTable(typed) {
      var keep = grid ? grid.selection() : null;
      var at = keep && rows[keep.r2] ? { date: rows[keep.r2].date, idx: rows[keep.r2].idx } : null;
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
          if (x.kind === 'task' || x.kind === 'mark' || x.kind === 'plan') return TV.cellText(x, data);
          if (x.kind === 'memo') return x.first ? memoText(x.date) : '';
          return '';
        },
        editable: function (r, c) {
          if (viewing() || loading) return false;
          var x = cellOf(r, c);
          // タスクのマスは、送っている間も直せる・消せる（3-8）。完了の送り待ちのタスクも（版は送る直前に base から取る）
          if (x.kind === 'task') return !failed && !x.it.pending && x.it.can.edit;
          if (x.kind === 'empty') return !failed && x.owner.active; // 空きのマスは、前の保存を待たずに続けて打てる
          return false; // 番号・申し送り（申し送りは上の欄で書く・直す）・空きの下
        },
        key: keyOf,
        // マスの先頭のチェック（4-3）。タスクのマスで、一覧と同じく完了にできるときだけ
        mark: function (r, c) {
          var x = cellOf(r, c);
          if (x.kind !== 'task' || !TV.canCheck(x.it, viewing())) return null;
          var done = x.it.state === '完了';
          return { on: done, label: (done ? '未完了に戻す: ' : '完了にする: ') + x.it.content, disabled: loading || !!failed };
        },
        onMark: function (r, c) {
          var x = cellOf(r, c);
          if (x.kind !== 'task' || !TV.canCheck(x.it, viewing()) || loading || failed) return;
          stateOp(x.it, x.it.state === '完了' ? 'reopen' : 'complete');
        },
        editEnd: function () { if (rebuildAfterEdit) { rebuildAfterEdit = false; rebuildSoon(null); } },
        cellState: function (r, c) {
          var x = cellOf(r, c), row = rows[r];
          var edge = (row.first ? ' blk-top' : '') + (row.idx % 2 ? ' stripe' : '') + (c >= 1 && c <= cols.length && cols[c - 1].employeeId === me.employeeId ? ' mine' : '');
          if (x.kind === 'task' || x.kind === 'mark' || x.kind === 'plan') {
            var d = x.kind === 'task' ? TV.due(x.it, data) : null;
            return { cls: TV.cls(x) + edge + (d ? ' due-' + d.level : ''), title: TV.fullText(x, data) };
          }
          if (x.kind === 'memo') return { cls: 'tk-memo' + edge, title: x.first ? memoText(x.date) : '' };
          return { cls: (x.kind === 'no' ? 'tk-no' : '') + edge };
        },
        change: onGridChange,
        notify: function (text, kind) { if (muteCleared && text.indexOf('空にしました') >= 0) return; ui.pageMessage(text, kind || 'warn'); },
      });
      var sc = ui.$('grid').querySelector('.grid-scroll');
      var y = window.scrollY; // 描き直しでページ全体が動かないように（マスを選ぶと、表の部品がそのマスを見える位置へ動かすため）
      if (jumpToday) {
        jumpToday = false;
        goToDayInTable(day);
      } else if (keep && keep.c2 < columns.length) {
        // 選んでいたマスを引き継ぐ（同じ日・同じ段。行が増えたり減ったりしても、ずれない）
        var r = typed && keep.r2 === typed.r + 1 && keep.c2 === typed.c ? keep.r2 : rowFor(at, keep.r2);
        if (r < rows.length) {
          grid.select(r, keep.c2);
          if (sc) { sc.scrollTop = top0; sc.scrollLeft = left0; }
        }
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

    /**
     * マスの対象の鍵（4-2）。タスク = 't:' + タスクID、空き = 'e:' + 担当 + '|' + 日付。ほかは座標（直せないマス）。
     * 表の部品は、編集を始めたときの鍵で確定する（打っている間に並びが変わっても、始めたときのタスクに入る）
     */
    function keyOf(r, c) {
      if (!rows[r]) return 'x:' + r + ',' + c;
      var x = cellOf(r, c);
      if (x.kind === 'task') return 't:' + x.it.taskId;
      if (x.kind === 'empty') return 'e:' + x.owner.employeeId + '|' + x.date;
      return 'x:' + r + ',' + c;
    }
    /** 鍵から、今の姿のマスの中身を探す（見つからなければ null。消えたタスクなど） */
    function cellOfKey(key) {
      if (typeof key !== 'string') return null;
      if (key.indexOf('t:') === 0) { var it = findViewItem(key.slice(2)); return it ? { kind: 'task', it: it } : null; }
      if (key.indexOf('e:') === 0) {
        var k = key.indexOf('|'), id = key.slice(2, k), date = key.slice(k + 1);
        var p = data.people.filter(function (q) { return q.employeeId === id; })[0];
        return p ? { kind: 'empty', owner: p, date: date } : null;
      }
      return null;
    }

    /** 打った・貼り付けた・空にした内容（まとめて）。どのマスかは鍵で決める（座標は使わない） */
    function onGridChange(list) {
      var adds = [], dels = [], kept = 0, gone = 0, noEdit = 0;
      list.forEach(function (ch) {
        var x = cellOfKey(ch.key);
        var v = String(ch.value || '').replace(/^[\s　]+|[\s　]+$/g, '');
        if (!x) { if (String(ch.key).indexOf('t:') === 0) gone++; return; } // その間に消えたタスク（直さない）
        if (x.kind === 'empty' && v !== '') {
          adds.push({ ownerId: x.owner.employeeId, date: x.date, content: v });
        } else if (x.kind === 'task' && v === '') {
          // タスクのマスを空にした（選んで Backspace・Delete など）: 消したい。消せるタスクだけ集め、下で 1 回だけ確かめる
          if (x.it.can.del && !x.it.pending && !pendingDelete(x.it.taskId)) dels.push(x.it); else kept++;
        } else if (x.kind === 'task' && v !== '' && v !== x.it.content) {
          if (x.it.pending || !x.it.can.edit) { noEdit++; return; } // 直せない（保存中の仮のタスクなど）。消すの「消せません」とは分ける（内部レビュー low）
          var id = x.it.taskId;
          enqueue({ action: 'task.update', args: function () { return { taskId: id, baseVersion: baseVersionOf(id), content: v }; }, label: '「' + v + '」' });
        }
      });
      if (adds.length === 1) addQuick(adds[0], { r: list[0].r, c: list[0].c });
      else if (adds.length > 1) {
        for (var i = 0; i < adds.length; i += 50) {
          (function (part, last) { enqueue({ action: 'task.addMany', args: function () { return { items: part }; }, label: part.length + ' 件のタスク', reload: last }); })(adds.slice(i, i + 50), i + 50 >= adds.length);
        }
      }
      if (dels.length || kept) askDelete(dels, kept); // 足す・直すは上ですぐ送る。消すのは確かめてから
      else if (gone) ui.pageMessage('そのタスクはもうありません（直していません）', 'warn'); // 打っている間に消えた（4-2）
      else if (noEdit) ui.pageMessage('送っている途中のタスクは、送り終わってから直してください', 'warn');
      if (grid) grid.refresh();
    }

    /**
     * 月の表でタスクのマスを空にした: 確かめの窓を 1 回だけ出して、消す。
     * list = 消せるタスク、kept = 消せないタスクの数（残す）。「消す」なら 1 件ずつ列に積み、月の読み直しは最後の 1 回だけ
     */
    function askDelete(list, kept) {
      // 表の部品がこの後に出す「◯ 個のセルを空にしました」は出さない（消したのではなく、これから確かめるので）
      muteCleared = true;
      Promise.resolve().then(function () { muteCleared = false; });
      if (!list.length) { ui.pageMessage(kept === 1 ? 'このタスクは消せません' : '選んだタスクは消せません', 'warn'); return; }
      var text = list.length === 1 ? '「' + list[0].content + '」を消しますか？'
        : list.length + ' 件のタスクを消しますか？\n' + list.slice(0, 5).map(function (i) { return '・' + i.content; }).join('\n') + (list.length > 5 ? '\nほか ' + (list.length - 5) + ' 件' : '');
      if (kept) text += '\n消せない ' + kept + ' 件は残します';
      ui.confirm('タスクを消す', text, '消す', 'danger').then(function (ok) {
        if (mode === 'table' && grid) grid.focus(); // 窓を閉じた後も、表のキー操作を続けられるように
        if (!ok || refuseLoading()) return;
        // 窓を出している間に無くなった・ほかの操作の対象になったものは送らない
        var ids = list.map(function (i) { return i.taskId; }).filter(function (id) { return !!findViewItem(id) && !pendingDelete(id); });
        if (!ids.length) return;
        var batch = newBatch();
        ids.forEach(function (id) {
          var it = findViewItem(id);
          // 月は読み直さない（3-9）。押したらすぐ表から消す（opt）。版は送る直前に base から取る
          enqueueDelete(batch, { action: 'task.delete', args: function () { return { taskId: id, baseVersion: baseVersionOf(id) }; },
            label: '「' + it.content + '」', content: it.content, opt: { kind: 'delete', taskId: id } });
        });
        showDeleteBar(batch);
        afterPress();
      });
    }

    /**
     * 空きのマスに 1 件打って足した: 保存を待たずに「保存中」の仮のタスクとして表に出し、続けて打てるようにする。
     * 答えが来たら仮のタスクを本物に差し替える（applyResult。月を読み直さない）
     */
    function addQuick(a, typed) {
      if (refuseLoading()) return; // 読み込みの間は足さない（仮のタスクも出さない）
      var n = ++tmpSeq;
      var tmp = { taskId: 'tmp-' + n, pending: true, owner: a.ownerId, date: a.date, content: a.content, state: '未完了', urgency: '通常', hidden: false,
        requester: '', requesterName: '', due: '', dueTime: '', note: '', consult: null, fresh: false, deferCount: 0, remindTime: '', recordVersion: 0,
        rank: 99999 + n, order: 99999 + n, // その日の最後に並ぶ
        can: { edit: false, complete: false, defer: false, cancel: false, del: false, move: false, consult: false, note: false, remind: false } };
      base.items.push(tmp); // 仮のタスクは base にだけ入れる（描く姿は同じものを指す。3-1）
      rebuildView();
      enqueue({ action: 'task.add', args: function () { return Object.assign({ urgency: '通常', hidden: false }, a); }, label: '「' + a.content + '」', tmp: tmp });
      rebuildSoon(typed);
    }

    /**
     * 行の数が変わったので、月の表を作り直す。表の部品は「内容を渡す → その後に選んでいるマスを下へ動かす」の順なので、
     * 渡された中ですぐ作り直すと、移動が古い表に掛かって失われる。動き終わった後（この出来事の処理の直後）に作り直す。
     * 打っている最中（編集中）は作り直さず、編集が終わったときに 1 回だけ作り直す（4-2。入力の箱を壊さない）
     */
    var rebuildQueued = false;
    function rebuildSoon(typed) {
      if (typed) rebuildTyped = typed;
      if (rebuildQueued) return;
      rebuildQueued = true;
      Promise.resolve().then(function () {
        rebuildQueued = false;
        var t = rebuildTyped;
        rebuildTyped = null;
        if (mode !== 'table' || !grid || loading) return; // 読み込みの間は、読み終わったときに作り直す
        if (grid.isEditing()) { rebuildAfterEdit = true; grid.refresh(); return; }
        var had = tableFocused();
        var y = window.scrollY;
        jumpToday = false;
        renderTable(t);
        renderSide();
        if (had) grid.focus(); // マウスで押し直さずに、続けて打てるように
        window.scrollTo(0, y);
      });
    }

    /** 選んでいるセルのタスク（無ければ null） */
    function selectedEntry() {
      if (mode !== 'table' || !grid) return null;
      var s = grid.selection();
      if (!rows[s.r2]) return null;
      var x = cellOf(s.r2, s.c2);
      return x.kind === 'task' || x.kind === 'mark' || x.kind === 'plan' ? x : null; // 予定も下の帯に全文を出す（道具のボタンはタスクだけ）
    }
    function selectedTask() { var e = selectedEntry(); return e && e.kind === 'task' ? e.it : null; }

    function updateTools() {
      var e = selectedEntry();
      var it = e && e.kind === 'task' ? e.it : null;
      var busy = sending || loading || !!failed || viewing();
      var set = function (id, ok) { ui.$(id).disabled = busy || !ok; };
      // 完了・未完了に戻す・消すは、送っている間も押せる（列に積む。3-8）。まだ届いていない操作の対象のタスクの「消す」は押せない
      var quick = function (id, ok) { ui.$(id).disabled = loading || !!failed || viewing() || !ok; };
      quick('t-complete', it && TV.canCheck(it, viewing()) && it.state === '未完了');
      quick('t-reopen', it && TV.canCheck(it, viewing()) && it.state === '完了');
      set('t-defer', it && it.can.defer && it.state === '未完了');
      set('t-due', it && it.can.edit);
      set('t-remind', it && it.can.remind);
      set('t-cancel', it && it.can.cancel && it.state === '未完了');
      set('t-uncancel', it && it.can.cancel && it.state === '取りやめ');
      set('t-urgency', it && it.can.edit);
      set('t-hide', it && it.can.edit);
      set('t-note', it && it.can.note);
      set('t-consult', it && it.can.consult);
      set('t-up', it && it.can.move && !!TV.moveArgs(data, it, -1));
      set('t-down', it && it.can.move && !!TV.moveArgs(data, it, 1));
      quick('t-delete', it && it.can.del && !it.pending && !pendingDelete(it.taskId));
      ui.$('t-today').disabled = loading;
      ui.$('sel-info').textContent = e ? (e.kind === 'plan' ? '選んでいる予定: ' : '選んでいるタスク: ') + TV.fullText(e, data) : '';
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
      var list = entriesOf(p.employeeId, day);
      var n = TV.counts(list);
      var open = mine || !!openCards[p.employeeId];
      var urgent = list.filter(function (e) { return e.kind === 'task' && e.it.state === '未完了' && e.it.urgency !== '通常'; }).length;
      var over = list.filter(function (e) { var d = e.kind === 'task' ? TV.due(e.it, data) : null; return d && d.level === 'over'; }).length;
      var title = p.name + (mine ? '（自分）' : '') + (p.active ? '' : '（利用停止）');
      var count = n.total ? '残り ' + n.open + ' ／ 全 ' + n.total + ' 件' : 'タスクなし';
      var planN = TV.planCount(list);
      if (planN) count += '・予定 ' + planN;
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
      // 定型タスクの予定は、残っているタスクの下に見出しを付けて出す（たたみの中には入れない。計画 stage2-task-plan-ahead-plan.md 3-2）
      var plans = list.filter(function (e) { return e.kind === 'plan'; });
      var rest = list.filter(function (e) { return e.kind !== 'plan' && !(e.kind === 'task' && e.it.state === '未完了'); });
      live.forEach(function (e) { ul.appendChild(rowOf(e)); });
      if (!list.length) ul.appendChild(ui.el('li', { class: 'tk-empty sub', text: 'この日のタスクはありません' }));
      if (plans.length) {
        ul.appendChild(ui.el('li', { class: 'tk-plan-head sub', text: '当日に入る定型タスク（予定）' }));
        plans.forEach(function (e) { ul.appendChild(rowOf(e)); });
      }
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
      var canCheck = e.kind === 'task' && TV.canCheck(it, viewing());
      return MP.taskItem.row(e, data, {
        // チェックは送っている間も押せる（列に積む。3-8）。本文（メニュー）は今どおり送っている間は止める
        canCheck: canCheck, disabled: sending || loading, checkDisabled: loading || !!failed,
        onCheck: function (t, done) { stateOp(t, done ? 'reopen' : 'complete'); },
        onOpen: function (t, no) { menu(t, no); },
      });
    }

    function button(label, fn, kind) { return ui.el('button', { type: 'button', class: 'btn' + (kind ? ' ' + kind : ''), text: label, disabled: sending || loading, on: { click: fn } }); }

    /** 行を押したときのメニュー（全文と、その人ができる操作だけ） */
    function menu(it0, no) {
      var it = findViewItem(it0.taskId) || it0;
      var buttons = [];
      var add = function (label, value, kind) { buttons.push({ label: label, value: value, kind: kind || '' }); };
      if (!viewing()) {
        if (it.can.complete && it.state === '未完了') add('完了にする', 'complete', 'primary');
        if (it.can.complete && it.state === '完了') add('未完了に戻す', 'reopen');
        if (it.can.note) add(it.note ? '完了の一言を直す' : '完了の一言を足す', 'note');
        if (it.can.defer && it.state === '未完了') add('先送り', 'defer');
        if (it.can.remind) add(it.remindTime ? 'リマインダーを直す' : 'リマインダーを付ける', 'remind');
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
        if (v === 'remind') return remindOp(it);
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
      enqueue({ action: 'task.update', args: function () { return Object.assign({ taskId: id, baseVersion: baseVersionOf(id) }, fields); }, label: '「' + it.content + '」', reload: !!reload });
    }

    /**
     * 状態を変える。完了・未完了に戻すは「押したらすぐ」画面を変える（opt。3-4）。取りやめ・先送りは今どおり返事を待つ。
     * 版は送る直前に base から取る（3-3）
     */
    function stateOp(it, op, extra) {
      var id = it.taskId;
      if (loading || failed) return; // 読み込みの間・止まった操作があるときは積まない（押すボタンも止めてある）
      dropUndo();
      var quick = op === 'complete' || op === 'reopen';
      var o = { action: 'task.state', args: function () { return Object.assign({ taskId: id, baseVersion: baseVersionOf(id), op: op }, extra || {}); },
        label: '「' + it.content + '」', reload: op === 'defer' };
      if (quick) o.opt = { kind: 'state', taskId: id, to: op === 'complete' ? '完了' : '未完了' };
      enqueue(o);
      if (!quick) return;
      afterPress();
      if (op === 'complete') showUndo(it, o); // 完了の帯は押したときに出す（その操作を覚える）
    }

    /**
     * 「押したらすぐ」の操作を積んだ後: 描く姿を作り直して描く。
     * 月の表で行が変わる（消した）ときは、打って足すときと同じ作り直し方にする（キーの入力先を表に残し、続けて矢印・Backspace を使える）
     */
    function afterPress() {
      rebuildView();
      if (mode === 'table' && grid && !sameTable()) { rebuildSoon(null); renderQueue(); return; }
      renderAfter();
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

    /** リマインダーを付ける・直す・外す（担当と管理者。v3 計画 3-2）。内容などを直す処理とは別の処理で送る */
    function remindOp(it) {
      return TD.remind({ it: it, rules: data.rules }).then(function (v) {
        if (!v || (v.remindTime === (it.remindTime || '') && (v.remindEarly || '') === (it.remindEarly || ''))) return;
        var id = it.taskId;
        enqueue({ action: 'task.remind', label: '「' + it.content + '」のリマインダー',
          args: function () { return { taskId: id, baseVersion: baseVersionOf(id), remindTime: v.remindTime, remindEarly: v.remindEarly }; } });
      });
    }

    /** まとめて取り込む（Excel の 1 列を貼り付ける。v3 計画 第4章）。送るのは今までの「まとめて足す」（50 件ずつ） */
    function importOp() {
      return MP.taskImport.open({
        people: data.people, meId: me.employeeId, isAdmin: me.role === '管理者', date: day, rules: data.rules,
        existing: function (ownerId, date) {
          return data.items.filter(function (i) { return i.owner === ownerId && i.date === date && i.state !== '取りやめ'; }).map(function (i) { return i.content; });
        },
      }).then(function (v) {
        if (!v || loading) return;
        var adds = v.contents.map(function (c) { return { ownerId: v.ownerId, date: v.date, content: c }; });
        var tally = { saved: 0, errors: [] }; // 塊をまたいで数える（入った数・入らなかったものと理由）
        for (var i = 0; i < adds.length; i += 50) {
          (function (part, last) {
            enqueue({ action: 'task.addMany', args: function () { return { items: part }; }, label: part.length + ' 件の取り込み', reload: last,
              names: part.map(function (x) { return x.content; }), tally: tally, last: last });
          })(adds.slice(i, i + 50), i + 50 >= adds.length);
        }
      });
    }

    /** リマインダーの通知（パソコンのポップアップ）の状態と、許可のボタン（v3 計画 3-4） */
    function renderNotify() {
      var box = ui.$('notify-box');
      box.hidden = viewing() || !MP.remind;
      if (box.hidden) return;
      var p = MP.remind.permission();
      ui.$('notify-state').textContent = p === 'granted' ? 'この端末では、リマインダーの時刻に通知（ポップアップ）も出します。ポータルを開いている間だけ出ます。'
        : p === 'denied' ? '通知はブラウザの設定で止められています。出したいときは、ブラウザのアドレス欄の左の印から、このページの「通知」を許可してください。リマインダーは画面の上の帯で知らせます。'
        : p === 'default' ? 'リマインダーは画面の上の帯で知らせます。パソコンでは、下のボタンで通知（ポップアップ）も出せます。ポータルを開いている間だけ出ます。'
        : 'この端末では通知（ポップアップ）は使えません。リマインダーは、ポータルを開いている間、画面の上の帯で知らせます。';
      ui.$('notify-btn').hidden = p !== 'default';
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
        enqueue({ action: 'task.note', args: function () { return { taskId: id, baseVersion: baseVersionOf(id), note: v }; }, label: '「' + it.content + '」の一言' });
      });
    }

    function consultOp(it) {
      return TD.text({ title: '依頼した人に相談する', label: '相談', value: it.consult ? it.consult.text : '', max: data.rules.noteMax, okLabel: '送る',
        hint: it.requesterName + 'さんのタスクリストに知らせが出ます。空にすると相談を取り消します。' }).then(function (v) {
        if (v === null || v === (it.consult ? it.consult.text : '')) return;
        var id = it.taskId;
        enqueue({ action: 'task.request.consult', args: function () { return { taskId: id, baseVersion: baseVersionOf(id), text: v }; }, label: '「' + it.content + '」の相談' });
      });
    }

    function deleteOp(it) {
      return ui.confirm('タスクを消す', '「' + it.content + '」を消しますか？', '消す', 'danger').then(function (ok) {
        if (!ok || refuseLoading() || failed) return;
        var id = it.taskId;
        if (!findViewItem(id) || pendingDelete(id)) return; // 窓を出している間に無くなった・もう消している
        // 月は読み直さない。押したらすぐ消す（3-9）
        var batch = newBatch();
        enqueueDelete(batch, { action: 'task.delete', args: function () { return { taskId: id, baseVersion: baseVersionOf(id) }; },
          label: '「' + it.content + '」', content: it.content, opt: { kind: 'delete', taskId: id } });
        showDeleteBar(batch);
        afterPress();
      });
    }

    /**
     * 並べ替え（送る直前に、サーバーの姿 base から並びと版を作る。同じ群の中でだけ。競合したら読み直して並べ直してもらう。Codex 実装1回目 medium）。
     * 送る直前には前の操作がすべて届いているので、base が今のサーバーの姿（3-3）
     */
    function moveOp(it, dir) {
      var id = it.taskId;
      enqueue({ action: 'task.move', label: '並べ替え', reload: true, noRetry: true, args: function () {
        var cur = findBaseItem(id);
        return cur ? TV.moveArgs(base, cur, dir) : null; // 動かせない（端・群の境目・もう無い）→ 送らない
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
      ui.$('undo-btn').disabled = false;
      ui.$('undo-btn').textContent = '元に戻す';
    }

    /** 帯を消し、前の「消す」の束も画面から戻せなくする（新しい操作の帯に替わる・月を切り替えた。計画 第0章 8） */
    function dropUndo() {
      hideUndo();
      latestBatch = null;
    }

    /** 完了の帯（押したときに出す。その完了の操作 op を覚える。3-4 の 4.） */
    function showUndo(it, op) {
      dropUndo();
      if (viewing()) return;
      ui.$('undo-text').textContent = '「' + it.content + '」を完了にしました';
      ui.$('undo-note').hidden = false;
      ui.$('undo-bar').hidden = false;
      undo = { kind: 'complete', taskId: it.taskId, op: op, timer: window.setTimeout(hideUndo, UNDO_MS) };
    }

    /** 消す帯（確かめの窓で「消す」を押したときに出す。文とボタンは renderUndo が束の様子から決める。3-9） */
    function showDeleteBar(batch) {
      if (viewing() || batch !== latestBatch) return;
      hideUndo();
      undo = { kind: 'delete', batch: batch, timer: null };
      ui.$('undo-note').hidden = true;
      ui.$('undo-bar').hidden = false;
      renderUndo();
    }

    /** 確かめの窓で「消す」を押した回ごとの束（前の帯は、ここで替わる） */
    function newBatch() {
      dropUndo();
      latestBatch = { done: [], ops: [] };
      return latestBatch;
    }

    /** 消すの操作を束に入れて列に積む */
    function enqueueDelete(batch, op) {
      op.delBatch = batch;
      batch.ops.push(op);
      enqueue(op);
    }

    /**
     * 消すが成功した: 戻すのに要る値（消した後の版・消したときの requestId）を覚え、帯を出す・文を書き直す。
     * 帯の時計はここでは始めない（その回の消すと月の読み直しがすべて終わった後に renderUndo が始める）
     */
    function noteDeleted(op, item) {
      op.delBatch.done.push({ taskId: item.taskId, baseVersion: item.recordVersion, deleteRequestId: op.rid, content: item.content });
      // 帯の文・ボタン・時計は renderUndo（この後の renderQueue）が決める
    }

    /**
     * 消した帯の文・ボタン・時計（3-9）。束の操作は「送り待ち（送っている最中・列・結果が分からないで止まった）」「成功（done）」
     * 「断られた（止まった帯が出ている間）」「捨てた（列から外れた）」のどれか。
     *   送り待ちがある間は「消しています…」で押せない。送り待ちが無くなったら、成功した分だけ戻せる（時計をここで始める）。成功が 0 件なら帯を消す
     */
    function renderUndo() {
      if (!undo || undo.kind !== 'delete') return;
      var b = undo.batch, pend = pendingOps();
      var refusedHere = !!failed && failed.kind !== 'unknown' && b.ops.indexOf(failed.op) >= 0;
      var waiting = b.ops.filter(function (o) { return pend.indexOf(o) >= 0 && !(refusedHere && failed.op === o); });
      var restoring = pend.some(function (o) { return o.restore === b; });
      if (!waiting.length && !refusedHere && !restoring && !b.done.length) { dropUndo(); return; } // 1 件も消せなかった
      var names = b.done.map(function (e) { return e.content; }).concat(waiting.map(function (o) { return o.content; }));
      ui.$('undo-text').textContent = names.length === 1 ? '「' + names[0] + '」を消しました' : names.length + ' 件を消しました';
      var btn = ui.$('undo-btn');
      btn.disabled = !!failed || restoring || waiting.length > 0 || !b.done.length;
      btn.textContent = restoring ? '元に戻しています…' : waiting.length ? '消しています…' : '元に戻す';
      if (!undo.timer && !loading && !sending && !waiting.length && !refusedHere && !restoring) {
        undo.timer = window.setTimeout(function () { if (undo && undo.batch === b) dropUndo(); }, UNDO_DELETE_MS);
      }
    }

    /** 「元に戻す」（消した帯）: まだ送っていない消すを外し、消せた分を task.restore で戻す（中身は送る直前に作る。100 件ずつ） */
    function restoreBatch(b) {
      if (failed || refuseLoading()) return;
      if (pendingOps().some(function (o) { return o.restore === b; })) return; // もう戻している
      queue = queue.filter(function (o) { return o.delBatch !== b; }); // 消していないので、戻すものも無い
      var max = b.done.length + (current && current.delBatch === b ? 1 : 0); // 送っている最中の 1 件は止められない（成功すれば戻す）
      var size = data.rules.restoreMax || 100;
      var tally = { ok: 0, errors: [] };
      for (var k = 0; k * size < max; k++) {
        (function (k) {
          enqueue({ action: 'task.restore', label: '元に戻す', restore: b, restoreTally: tally, noRetry: true, args: function () {
            var part = b.done.slice(k * size, (k + 1) * size);
            if (!part.length) return null;
            this.reload = this.last = (k + 1) * size >= b.done.length; // 最後の塊の後に月を読み直す
            return { items: part.map(function (e) { return { taskId: e.taskId, baseVersion: e.baseVersion, deleteRequestId: e.deleteRequestId }; }) };
          } });
        })(k);
      }
      renderQueue();
    }

    /** 戻した答え（塊ごと）。最後の塊の後に、戻せなかったものだけ理由を 1 回だけ出して帯を消す */
    function tallyRestore(op, d) {
      var t = op.restoreTally;
      d.results.forEach(function (x) {
        if (x.status !== 'error') { t.ok++; return; }
        var e = op.restore.done.filter(function (z) { return z.taskId === x.taskId; })[0];
        t.errors.push('「' + (e ? e.content : x.taskId) + '」: ' + x.message);
      });
      if (!op.last) return;
      if (undo && undo.batch === op.restore) dropUndo();
      if (!t.errors.length) ui.pageMessage('元に戻しました', 'ok');
      else ui.pageMessage((t.ok ? t.ok + ' 件を元に戻しました。' : '') + t.errors.length + ' 件は元に戻せませんでした:\n' + t.errors.join('\n'), 'warn');
    }

    ui.$('undo-btn').addEventListener('click', function () {
      if (undo && undo.kind === 'delete') { restoreBatch(undo.batch); return; }
      if (!undo || loading) return;
      var op = undo.op, it = findViewItem(undo.taskId);
      hideUndo();
      // その完了がまだ列にある（送っていない）: 列から外すだけ（送らない）。送っている最中・送った後なら、未完了に戻すを積む（3-4 の 4.）
      if (op && queue.indexOf(op) >= 0) { queue = queue.filter(function (x) { return x !== op; }); afterPress(); return; }
      if (it && it.state === '完了') stateOp(it, 'reopen');
    });
    ui.$('undo-note').addEventListener('click', function () {
      if (!undo || undo.kind !== 'complete' || loading) return;
      var it = findViewItem(undo.taskId);
      hideUndo();
      if (it && it.state === '完了') noteOp(it);
    });

    // ------------------------------------------------------------------ 順番待ちの列

    /** 読み込みの間の操作は断る（古い姿のまま送らない）。断ったら真 */
    function refuseLoading() {
      if (loading) ui.pageMessage('読み込み中です。終わってからもう一度操作してください', 'error');
      return loading;
    }

    function enqueue(op) {
      if (refuseLoading()) return;
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
        // 捨てる: 止まった操作と列の残り（仮のタスクも外す・完了の帯がその操作なら消す。消す束は renderUndo が「捨てた」と見る）
        var dropAll = function () { var all = [op].concat(queue); dropPending(all); dropUndoOf(all); queue = []; failed = null; };
        if (failed.kind === 'unknown') {
          // 同じ requestId・同じ中身（op.sent）で送り直す（二重にしない）
          btns.push(button('もう一度送る', function () { failed = null; queue.unshift(op); pump(); }));
          btns.push(button('やめて最新を読む', function () { recover(dropAll); }));
        } else if (failed.kind === 'conflict') {
          btns.push(button('最新を読む（自分の入力は捨てる）', function () { recover(dropAll); }));
          // 読み直した版で中身を作り直し、新しい requestId で送る（読めたときだけ）
          if (!op.noRetry) btns.push(button('自分の入力をもう一度送る', function () { recover(function () { failed = null; op.rid = MP.api.newRequestId(); op.sent = null; queue.unshift(op); }, pump); }));
        } else {
          // 断られた操作は捨てる（仮のタスクも消える）。列に残りがあれば、読み直した後に続きを送る
          btns.push(button('閉じる', function () { recover(function () { dropPending([op]); dropUndoOf([op]); failed = null; }, pump); }));
        }
        f.appendChild(ui.el('div', { class: 'item-actions' }, btns));
        if (f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
      }
      if (mode === 'table' && grid) updateTools(); // 送っている間・止まっている間は、操作のボタンを止める
      Array.prototype.forEach.call(document.querySelectorAll('#day-list button.tk-main, #notices button'), function (b) { b.disabled = sending || loading || !!failed; });
      Array.prototype.forEach.call(document.querySelectorAll('#day-list button.tk-check'), function (b) { b.disabled = loading || !!failed; }); // チェックは送っている間も押せる（3-8）
      renderUndo();
    }

    function reloadNow() { return ui.run(function () { return load(false); }); }

    var RELOAD_FAILED_TEXT = '最新を読めませんでした。電波の良いところで、もう一度押してください';
    /**
     * 止まった操作の帯のボタン（3-7）: 最新を読み、読めたときだけ before（整理: 捨てる・送り直す）→ 描く → after（続きを送る）。
     * 読めなければ base も姿も変えず、止まった帯を残して一言だけ変える（送り直さない・ほかの操作もさせない）
     */
    function recover(before, after) {
      if (loading) return;
      ui.run(function () { return load(false, before); }).then(function (ok) {
        if (ok) { if (after) after(); return; }
        if (failed) { failed.message = RELOAD_FAILED_TEXT; renderQueue(); }
      });
    }

    /** 捨てた操作の中に、完了の帯が覚えている操作があれば帯を消す */
    function dropUndoOf(ops) {
      if (undo && undo.kind === 'complete' && undo.op && ops.indexOf(undo.op) >= 0) hideUndo();
    }

    /** 消すが成功した: サーバーの姿からも、そのタスクと先送りの印・知らせを外す（3-5。外さないと印が戻ってくる） */
    function dropFromBase(taskId) {
      var not = function (x) { return x.taskId !== taskId; };
      base.items = base.items.filter(not);
      base.marks = (base.marks || []).filter(not);
      base.notices = (base.notices || []).filter(not);
    }

    function pump() {
      if (sending || failed || loading || !queue.length) { renderQueue(); return; } // 読み込みの間は送らない（読み終わった後に pump が呼ばれる）
      var op = queue.shift();
      if (!op.sent) op.sent = op.args(); // 中身は最初に送るときに固める（送り直しでは同じ中身）
      if (!op.sent) { pump(); return; }   // 送るものが無い（並べ替えで端など）
      sending = true;
      current = op;
      renderQueue();
      if (grid) grid.refresh();
      var attempt = function (tries) {
        // FORBIDDEN はホームへ移らずに返してもらい、その場で元の姿に戻して理由を出す（3-6）
        return MP.api.call(op.action, op.sent, { requestId: op.rid, keep: ['FORBIDDEN'] }).then(function (res) {
          // 通信の結果が分からない（NETWORK・BUSY）ときは、同じ中身・同じ requestId で送り直す（3回まで）
          if (!res.ok && (res.code === 'NETWORK' || res.code === 'BUSY') && tries < 3) return attempt(tries + 1);
          return res;
        });
      };
      attempt(1).then(function (res) {
        // この後に月を読み直す操作: 表を作り直す前に、打っている途中の空きのマスを確定して列に積む（sending のうちに。読み直した後で送る）
        if (res.ok && op.reload && tableFocused() && grid.isEditing()) { grid.commitEdit(); grid.focus(); }
        sending = false;
        current = null;
        if (!res.ok) {
          var unknown = res.code === 'NETWORK' || res.code === 'BUSY' || res.code === 'INTERNAL';
          failed = { op: op, kind: unknown ? 'unknown' : res.code === 'CONFLICT' ? 'conflict' : 'refused', message: res.message || '送れませんでした' };
          // 断られた・競合: その操作を描く姿にかけない＝すぐ元の姿に戻る。完了の帯がその操作なら消す（3-6）
          if (!unknown) dropUndoOf([op]);
          rebuildView();
          renderAfter();
          return;
        }
        applyResult(op, res.data);
        // 描く姿もすぐ作り直す。まだ届いていない操作もかけ直す（続けて押した「完了 → 未完了」がチラつかない。3-5）。
        // この後の月の読み直しが失敗しても、保存できた分は画面に出る（内部レビュー medium）
        rebuildView();
        if (op.delBatch && res.data.item) noteDeleted(op, res.data.item);
        if (MP.remind) MP.remind.touch(); // 操作の後、少し待ってからリマインダーの一覧を読み直す（v3 計画 3-4）
        // 足す（ダイアログ・スマホの一覧・まとめて）・先送り・隠す・並べ替え・申し送り・元に戻すは、印や並び・番号が変わるので読み直す（消すは読み直さない。3-9）
        if (op.reload) return load(false).then(function () { pump(); });
        renderAfter();
        pump();
      }, function () {
        sending = false;
        current = null;
        failed = { op: op, kind: 'unknown', message: '送れたか分かりません' };
        rebuildView();
        renderQueue();
      });
    }

    /**
     * 答えを手元に入れた後に描く。月の表で行と列が変わらなければ、作り直さずに塗り直すだけにする
     * （次のマスを打っている最中でも、入力の箱を壊さない。表の部品は編集中のマスを塗らない）。
     * 行が変わるときも、打っている最中は作り直さず、編集が終わってから作り直す（4-2）
     */
    function renderAfter() {
      jumpToday = false;
      if (mode === 'table' && grid && !sameTable() && grid.isEditing()) {
        rebuildAfterEdit = true;
        grid.refresh();
        renderSide();
        renderQueue();
        return;
      }
      if (mode !== 'table' || !grid || !sameTable()) { render(); return; }
      grid.refresh();
      renderSide();
      renderQueue();
      sendSeen();
    }

    /**
     * 答えの姿を手元に入れる（版を次の操作に使う）。
     * 月の表で打って足した操作（op.tmp）は、仮のタスク（保存中）を答えの本物に差し替える（順位は仮のものを引き継ぐ）。
     * 並びの順位（rank）は月の表の答えにだけ付く（保存した並びの値は画面に来ない）ので、手元の順位を引き継ぐ。
     * 急ぎ・締め切り・状態が変わって群が移ったときの群の中の順は、次に読み直すまで手元の順位のまま
     */
    function applyResult(op, d) {
      // 答えはサーバーの姿 base に入れる（描く姿は、この後の rebuildView で作り直す。3-5）
      var set = function (it, tmp) {
        if (!it) return;
        var k = base.items.map(function (i) { return i.taskId; }).indexOf(it.taskId);
        if (k < 0 && tmp) k = base.items.indexOf(tmp);
        it.rank = k >= 0 ? base.items[k].rank : 99999;
        it.order = it.rank;
        if (k >= 0) base.items[k] = it; else base.items.push(it);
      };
      if (op.opt && op.opt.kind === 'delete') dropFromBase(op.opt.taskId); // 消した: 答えの item（消した後の版）は戻すのに覚えるだけ（noteDeleted）
      else if (d.item && d.item.taskId) set(d.item, op.tmp);
      // 仮のタスクは、本物を入れた後に必ず外す（読み直しで本物と仮のタスクが並んでいたときも、「保存中」を残さない）
      var left = op.tmp ? base.items.indexOf(op.tmp) : -1;
      if (left >= 0) base.items.splice(left, 1);
      if (d.results) d.results.forEach(function (x) { set(x.item); });
      if (d.results && op.restoreTally) {
        tallyRestore(op, d); // 消したタスクを元に戻した（計画 3-2 の 4.）
      } else if (d.results && op.tally) {
        // 取り込み: 最後の塊の答えの後に、まとめて 1 回だけ出す
        d.results.forEach(function (x) {
          if (x.status === 'error') op.tally.errors.push('「' + (op.names[x.index] || (x.index + 1) + '件目') + '」: ' + x.message); else op.tally.saved++;
        });
        if (op.last) {
          var er = op.tally.errors;
          ui.pageMessage(op.tally.saved + ' 件を取り込みました' + (er.length ? '。' + er.length + ' 件は入りませんでした:\n' + er.join('\n') : ''), er.length ? 'warn' : 'ok');
        }
      } else if (d.results && d.results.some(function (x) { return x.status === 'error'; })) {
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
    ui.$('t-remind').addEventListener('click', withSel(remindOp));
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
      dropUndo(); // 月を切り替えたら帯は消す
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
      dropUndo();
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
      dropUndo();
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
    ui.$('import-btn').addEventListener('click', function () { if (!loading && !viewing()) importOp(); });
    ui.$('notify-btn').addEventListener('click', function () { MP.remind.ask().then(renderNotify); });

    // 初め: タスクの今日の月。見る形は端末で最後に使った方（初めはパソコンの幅なら表、スマホは一覧）
    var q = new URLSearchParams(window.location.search);
    explicitMonth = /^\d{4}-\d{2}$/.test(q.get('month') || '');
    ym = explicitMonth ? q.get('month') : guessToday().slice(0, 7);
    mode = got(VIEW_KEY) === 'table' || got(VIEW_KEY) === 'list' ? got(VIEW_KEY) : window.innerWidth >= 600 ? 'table' : 'list';
    textMode = got(TEXT_KEY) === 'wrap' ? 'wrap' : 'clip';
    // 画面を離れるとき: 今の内容を控えに（送っている途中などは、書かずに消す）
    window.addEventListener('pagehide', saveView);
    // 送り残し（送っている最中・列・止まった操作）があるまま離れようとしたら止める（第5章）。
    // ログインが切れたなど、共通の処理が画面を移すときは止めない（送り残しはもう送れない）
    var apiLeaving = false;
    MP.api.onLeave(function () { apiLeaving = true; });
    window.addEventListener('beforeunload', function (ev) {
      if (apiLeaving || viewing()) return;
      if (current || queue.length || failed) { ev.preventDefault(); ev.returnValue = ''; }
    });
    // 「戻る」で前のページがそのまま戻ったとき: 古いまま操作させず、最新を読み直す
    // 開いたときと違うログイン（ログアウトした・別の人がログインした）なら、入口からやり直す（前の人の名前のまま、次の人の内容を読まない。セキュリティの確認 Low）
    var openedAs = MP.store.tokenMark();
    window.addEventListener('pageshow', function (e) {
      if (!e.persisted) return;
      if (MP.store.tokenMark() !== openedAs) { window.location.reload(); return; }
      if (!loading && !sending && !queue.length && !failed) reloadNow();
    });
    showStale();
    return load(true);
  });
})();
