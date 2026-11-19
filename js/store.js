/*
 * ブラウザの保存領域の読み書き（計画 stage1-step2b-3-plan.md 2-2）
 *
 *   mp.deviceKey   localStorage                 端末の鍵
 *   mp.deviceName  localStorage                 登録したときの端末名（表示用）
 *   mp.token       localStorage（通常）／sessionStorage（「他の人も使う」）  ログインの記憶
 *   mp.lastLoginId localStorage（通常のログインのときだけ）  前回選んだ名前
 *   mp.timings     localStorage                 最近20回の通信（処理の名前・かかった時間・日時だけ）
 *   mp.me          token と同じ領域            自分の情報の控え（表示用。{ k: token の目印, me }。計画 stage2-switch-speed-plan.md 1-1）
 *   mp.view.tasks  localStorage                タスクリストの今月の控え（表示用。{ k, id: 社員ID, data }。同 1-3）。共有のログインでは書かない・使わない。
 *                  2026-11-16 に sessionStorage から移した（ホーム画面のアイコンから開いても控えを出す。計画 stage2-task-open-speed-plan.md 第1章）。前の版の sessionStorage の分は読むときに消す
 *   mp.remind      sessionStorage              今日の前後 1 日の自分のリマインダーの控え（{ k, id, at, offset, items, more }。計画 stage2-tasklist-v3-plan.md 3-4）
 *   mp.remind.done localStorage                知らせ済みの印（{ 鍵: 時刻 }。鍵は タスクID|日付|時刻|種類。**内容は入れない**。3 日で捨てる。ログアウトでは消さない＝同じ知らせをもう一度出さない）
 *   mp.viewAs     sessionStorage  管理者が見ている社員の画面（そのタブだけ）
 *   mp.netlog     sessionStorage  通信が駄目だったときの控え（時刻・処理の名前・答えの番号・ホスト名・答えのページの分類（決まった言葉）だけ。本文の文字・token・args は入れない。ログアウトで消す）
 *   mp.report.pending  localStorage（通常のログイン中・ログインの前に押した）／sessionStorage（共有のログイン中に押した）
 *                  管理者に知らせる（report.js）の、まだ送れていない控え（[{ rid, id: 押したときの社員ID か空, at, report }]。report は計画 stage2-error-report-plan.md 2-2 の形だけ）。
 *                  どちらの領域も 3 件まで・3 日まで。clearToken は sessionStorage の分だけを消す（localStorage の分は、送るときに社員を見る。同 2-4）
 *   mp.flash / mp.inviteName / mp.reloaded  sessionStorage  次の画面に1回だけ渡す文・名前、読み込み直しの印（秘密ではない）
 *   mp_bulk_pending:<社員ID>:<requestId>  localStorage  まとめて登録の、結果の分からない保存の記録（page_admin_bulk.js。{ action, requestId, at } だけ。送る中身・名前・番号・金額は入れない）。
 *                  結果がはっきりしたら消す（計画 stage2-employee-fields-plan.md 10-7）
 *   mp_bulk_import:<社員ID>  localStorage  まとめて登録の、1 回の取り込みの全部の操作（{ at, count, items: [{ requestId, action }] } だけ。同 10-9）。
 *                  「取り込みを終える」・次の取り込みで消す。mp_bulk_ の記録は、ログアウトしたとき（clearBulk）と、別の人でログインしたとき（guard.js が clearBulk(社員ID)）にも消す。
 *                  「他の人も使う」のログインでは、まとめて登録を使わせない
 *   mp_bulk_storage_check  localStorage  まとめて登録の、記録できるかの試し（書いてすぐ消す）
 *
 * パスワード・仮パスワード・招待の文字列・追加コードは保存しない
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  var K = { viewAs: 'mp.viewAs', deviceKey: 'mp.deviceKey', deviceName: 'mp.deviceName', token: 'mp.token', lastLoginId: 'mp.lastLoginId', timings: 'mp.timings',
    flash: 'mp.flash', inviteName: 'mp.inviteName', reloaded: 'mp.reloaded', me: 'mp.me', taskView: 'mp.view.tasks', remind: 'mp.remind', remindDone: 'mp.remind.done', netLog: 'mp.netlog', reportPending: 'mp.report.pending' };
  var REPORT_PENDING_MAX = 3;                  // 管理者に知らせる控えの数の上限（領域ごと。新しいものを残す）
  var REPORT_PENDING_KEEP_MS = 3 * 86400000;   // 控えを残す長さ（3 日）
  var RID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var NETLOG_MAX = 5;           // 通信の控えの数の上限
  var REMIND_DONE_KEEP_MS = 3 * 86400000; // 知らせ済みの印を残す長さ
  var REMIND_DONE_MAX = 2000;             // 印の数の上限（古いものから捨てる）
  var TIMINGS_MAX = 20;
  var VIEW_MAX_CHARS = 1500000; // タスクの控えの大きさの上限（超えたら覚えない）
  var sealed = false;           // clearToken の後は、このページではもう控えを書かない（消した後の pagehide で書き直さない）

  function area(name) { try { return window[name]; } catch (e) { return null; } }
  function get(a, k) { try { var v = a.getItem(k); return typeof v === 'string' ? v : ''; } catch (e) { return ''; } }
  function set(a, k, v) { try { a.setItem(k, v); return true; } catch (e) { return false; } }
  function del(a, k) { try { a.removeItem(k); } catch (e) { /* 消せないときは何もしない */ } }
  function L() { return area('localStorage'); }
  function S() { return area('sessionStorage'); }
  function take(k) { var v = get(S(), k); del(S(), k); return v; }
  /** 消す。消せずに残っていたら、空の文字で上書きする（読む側は空を「無い」として扱う） */
  function wipe(a, k) { del(a, k); if (get(a, k)) set(a, k, ''); }
  /** token の目印（53 ビットのハッシュ cyrb53）。認証・認可には使わない。控えが今のログインのものかを見分けるだけ */
  function mark(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return String(4294967296 * (2097151 & h2) + (h1 >>> 0));
  }
  /** token がある領域（「他の人も使う」は sessionStorage、通常は localStorage）。無ければ null */
  function tokenArea() { return get(S(), K.token) ? S() : get(L(), K.token) ? L() : null; }
  /** その答えを頼んだときのログイン（目印 sentMark）が、今のログインと同じか。目印が無い・token が無いときは偽（書かない・消さない） */
  function sameLogin(sentMark) {
    var t = get(S(), K.token) || get(L(), K.token);
    return typeof sentMark === 'string' && sentMark !== '' && !!t && sentMark === mark(t);
  }
  function parse(text) { try { var o = JSON.parse(text); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } }
  function str(v) { return typeof v === 'string' && v !== ''; }
  /** 控えに使える「自分の情報」の形か（仮パスワードのまま・見ている間のものは使わない） */
  function validMe(me) {
    return !!me && typeof me === 'object' && str(me.employeeId) && str(me.name) && str(me.role) && me.mustChangePassword === false && !me.viewAs;
  }

  MP.store = {
    /** 両方の保存領域に書けるか */
    available: function () {
      var ok = function (a) {
        if (!a) return false;
        try { a.setItem('mp.test', '1'); a.removeItem('mp.test'); return true; } catch (e) { return false; }
      };
      return ok(L()) && ok(S());
    },

    deviceKey: function () { return get(L(), K.deviceKey); },
    deviceName: function () { return get(L(), K.deviceName); },
    setDevice: function (key, name) { set(L(), K.deviceKey, key); set(L(), K.deviceName, name || ''); },
    /** 端末の登録が無効になったとき: 端末の情報とログインの記憶をすべて消す */
    clearDevice: function () {
      del(L(), K.deviceKey); del(L(), K.deviceName); del(L(), K.lastLoginId);
      MP.store.clearToken();
    },

    token: function () { return get(S(), K.token) || get(L(), K.token); },
    /** 今のログインが「他の人も使う」（共有）か */
    tokenShared: function () { return !!get(S(), K.token); },
    /** 先に両方から消してから、選んだ置き場所にだけ保存する（古い通常のログインが残って復活しないように） */
    setToken: function (token, shared) {
      MP.store.clearToken();
      set(shared ? S() : L(), K.token, token);
      if (shared) del(L(), K.lastLoginId);
    },
    /**
     * まとめて登録の途中の記録（mp_bulk_pending:・mp_bulk_import:）を消す。keepId（社員ID）を渡すと、その人の記録だけ残す
     * （ログアウトで全部・別の人のログインでその人以外。計画 stage2-employee-fields-plan.md 10-4）
     */
    clearBulk: function (keepId) {
      var a = L();
      if (!a) return;
      var drop = [];
      try {
        for (var i = 0; i < a.length; i++) {
          var k = a.key(i);
          var m = k ? /^mp_bulk_(?:pending|import):([^:]*)/.exec(k) : null;
          if (m && !(keepId && m[1] === keepId)) drop.push(k);
        }
      } catch (e) { return; }
      drop.forEach(function (k) { del(a, k); });
    },
    clearToken: function () {
      sealed = true; // 初めに立てる（この後に来る pagehide などで控えを書き直さない）
      del(L(), K.token); del(S(), K.token); del(S(), K.viewAs); // 見ている印も消す（残るとログインの依頼に viewAs が付いて断られる）
      wipe(L(), K.me); wipe(S(), K.me); wipe(L(), K.taskView); wipe(S(), K.taskView); wipe(S(), K.remind); wipe(S(), K.netLog);
      MP.store.clearReportShared(); // 知らせの控えは、共有のログイン中に押した分（sessionStorage）だけ消す。localStorage の分は残す（計画 stage2-error-report-plan.md 2-4）
      MP.store.clearPortal(); // ホームの控え・動いている安否確認の控え・共有のログインの安否の控え（計画 stage4-board-plan.md 11-2・11-3）
    },

    /*
     * 管理者に知らせる控え（計画 stage2-error-report-plan.md 2-4）。形の違うもの・3 日より古いもの・未来すぎるものは捨てる。
     * 返すもの: 古い順の [{ rid, id, at, report, shared }]（shared … sessionStorage の分）
     */
    reportPending: function () {
      var now = Date.now();
      var read = function (a, shared) {
        var list = parse(get(a, K.reportPending));
        if (!Array.isArray(list)) { if (get(a, K.reportPending)) wipe(a, K.reportPending); return []; }
        var ok = list.filter(function (x) {
          return !!x && typeof x === 'object' && typeof x.rid === 'string' && RID.test(x.rid) && typeof x.id === 'string' && (x.id === '' || /^E\d{4}$/.test(x.id)) &&
            typeof x.at === 'number' && isFinite(x.at) && now - x.at <= REPORT_PENDING_KEEP_MS && x.at - now <= 60000 &&
            !!x.report && typeof x.report === 'object' && !Array.isArray(x.report);
        });
        // 古い・形の違う控えは、読むときに捨てる（送らずに消す）
        if (ok.length !== list.length) { if (ok.length) set(a, K.reportPending, JSON.stringify(ok)); else wipe(a, K.reportPending); }
        return ok.map(function (x) { return { rid: x.rid, id: x.id, at: x.at, report: x.report, shared: shared }; });
      };
      return read(L(), false).concat(read(S(), true)).sort(function (a, b) { return a.at - b.at; });
    },
    /** 控えを足す（shared なら sessionStorage）。その領域の 3 日より古いものを捨て、新しい 3 件だけ残す。書けなければ偽 */
    addReportPending: function (item, shared) {
      var mine = MP.store.reportPending().filter(function (x) { return x.shared === !!shared && x.rid !== item.rid; });
      mine.push({ rid: item.rid, id: item.id, at: item.at, report: item.report });
      var keep = mine.slice(-REPORT_PENDING_MAX).map(function (x) { return { rid: x.rid, id: x.id, at: x.at, report: x.report }; });
      var text;
      try { text = JSON.stringify(keep); } catch (e) { return false; }
      if (!set(shared ? S() : L(), K.reportPending, text)) return false;
      return MP.store.reportPending().some(function (x) { return x.rid === item.rid; });
    },
    /** 控えから外す（両方の領域から） */
    removeReportPending: function (rid) {
      var all = MP.store.reportPending();
      [[L(), false], [S(), true]].forEach(function (p) {
        var rest = all.filter(function (x) { return x.shared === p[1] && x.rid !== rid; })
          .map(function (x) { return { rid: x.rid, id: x.id, at: x.at, report: x.report }; });
        if (rest.length) set(p[0], K.reportPending, JSON.stringify(rest)); else wipe(p[0], K.reportPending);
      });
    },
    /** 共有のログイン中に押した控え（sessionStorage）を消す */
    clearReportShared: function () { wipe(S(), K.reportPending); },

    /** 通信が駄目だったときの控え（「詳しく」で出す。新しいものが後ろ。最近の NETLOG_MAX 回まで）。形が違えば空 */
    netLog: function () {
      var list = parse(get(S(), K.netLog));
      return Array.isArray(list) ? list.filter(function (x) { return x && typeof x.at === 'number' && typeof x.action === 'string' && Array.isArray(x.tries); }) : [];
    },
    addNetLog: function (rec) {
      var list = MP.store.netLog();
      list.push(rec);
      set(S(), K.netLog, JSON.stringify(list.slice(-NETLOG_MAX)));
    },

    /**
     * 自分の情報の控え（表示用。計画 stage2-switch-speed-plan.md 1-1）。今の token のもので、形が正しいときだけ返す。
     * 見ている間（なりすまし）は使わない。token がある領域だけを読む（もう一方の領域の控えは見ない）
     */
    me: function () {
      if (MP.store.viewAs()) return null;
      var a = tokenArea();
      if (!a) return null;
      var o = parse(get(a, K.me));
      return o && o.k === mark(MP.store.token()) && validMe(o.me) ? o.me : null;
    },
    /** 今の token の目印（無ければ空）。画面が「開いたときと同じログインか」を見分けるのに使う（認証・認可には使わない） */
    tokenMark: function () { var t = MP.store.token(); return t ? mark(t) : ''; },
    /** 渡した token の目印（無ければ空）。読んだ token で確かめるため（保存領域を読み直さない。計画 stage4-board-plan.md 22-2） */
    markOf: function (t) { return t ? mark(t) : ''; },
    /**
     * 本物の答えの me を覚える。clearToken の後・token が無い・形が違うときは書かずに消す。見ている間は何もしない。
     * sentMark … その答えを頼んだときのログインの目印。今のログインと違う・無いときは、書きも消しもしない
     * （ほかのタブでログインし直した後に届いた古い答えで、新しいログインの控えを書き換えない・消さない。計画 stage2-task-open-speed-plan.md 1-2）
     */
    setMe: function (me, sentMark) {
      if (sealed) return;
      if (!sameLogin(sentMark)) return;
      if (MP.store.viewAs() || (me && me.viewAs)) return;
      var a = tokenArea();
      if (!a || !validMe(me)) { wipe(L(), K.me); wipe(S(), K.me); return; }
      wipe(a === L() ? S() : L(), K.me);
      if (!set(a, K.me, JSON.stringify({ k: mark(MP.store.token()), me: me }))) wipe(a, K.me);
    },

    /** タスクリストの今月の控え（表示用。同 1-3）。今の token・控えの me の社員のものだけ返す。localStorage から読む（前の版の sessionStorage の分は消す） */
    taskView: function () {
      if (get(S(), K.taskView)) wipe(S(), K.taskView); // 前の版（sessionStorage）の控えはもう使わない
      var me = MP.store.me();
      if (!me || MP.store.tokenShared()) return null; // 共有のログイン（他の人も使う端末）では、控えを使わない（前の人の内容を次の人に見せない。仕上げの計画 第3章 C3）
      var o = parse(get(L(), K.taskView));
      return o && o.k === mark(MP.store.token()) && o.id === me.employeeId && o.data && typeof o.data === 'object' ? o.data : null;
    },
    /**
     * タスクの控えを書く。clearToken の後は何もしない。sentMark が今のログインと違う・無いときは、書きも消しもしない（1-2）。
     * 共有のログイン・token が無い・控えの me と社員が違う・大きすぎる・書けない（容量が足りない）ときは消す
     */
    setTaskView: function (employeeId, data, sentMark) {
      if (sealed) return;
      if (!sameLogin(sentMark)) return;
      var me = MP.store.me();
      if (!me || me.employeeId !== employeeId) return; // 今のログインの人と違う（ほかのタブでログインし直した）: 書きも消しもしない（1-2）
      if (MP.store.tokenShared()) { wipe(L(), K.taskView); return; } // 共有のログインでは残さない
      var text;
      try { text = JSON.stringify({ k: mark(MP.store.token()), id: employeeId, data: data }); } catch (e) { text = ''; }
      if (!text || text.length > VIEW_MAX_CHARS || !set(L(), K.taskView, text)) wipe(L(), K.taskView);
    },
    /** タスクの控えを消す（書く条件を満たさないとき）。sentMark が今のログインと同じときだけ（ほかのタブの新しいログインの控えを消さない。1-2） */
    clearTaskView: function (sentMark) { if (sameLogin(sentMark)) wipe(L(), K.taskView); },

    /**
     * リマインダーの控え（計画 stage2-tasklist-v3-plan.md 3-4）。今の token・控えの me の社員・頼んだ社員のものだけ返す（形が違えば null）。
     * 知らせを出す処理は、出す直前に必ずこれを通す（ログアウトの後・見ている間は null）
     */
    remind: function (employeeId) {
      var me = MP.store.me();
      if (!me || me.employeeId !== employeeId) return null;
      var o = parse(get(S(), K.remind));
      return o && o.k === mark(MP.store.token()) && o.id === me.employeeId && Array.isArray(o.items) && typeof o.at === 'number' && typeof o.offset === 'number' ? o : null;
    },
    /** リマインダーの控えを書く。clearToken の後は何もしない。token が無い・控えの me と社員が違う・書けないときは消す */
    setRemind: function (employeeId, v) {
      if (sealed) return;
      var me = MP.store.me();
      if (!me || me.employeeId !== employeeId) { wipe(S(), K.remind); return; }
      var text;
      try { text = JSON.stringify({ k: mark(MP.store.token()), id: employeeId, at: v.at, offset: v.offset, items: v.items, more: v.more === true }); } catch (e) { text = ''; }
      if (!text || text.length > VIEW_MAX_CHARS || !set(S(), K.remind, text)) wipe(S(), K.remind);
    },
    clearRemind: function () { wipe(S(), K.remind); },
    REMIND_DONE_KEY: K.remindDone,
    /** 知らせ済みの印 { 鍵: 時刻 }。時刻が正 = 知らせた、負 = 出さないことにした（時刻を過ぎた）。内容は入っていない */
    remindDone: function () {
      var o = parse(get(L(), K.remindDone));
      var out = {};
      if (!o || Array.isArray(o)) return out;
      Object.keys(o).forEach(function (k) { if (typeof o[k] === 'number' && o[k] !== 0) out[k] = o[k]; });
      return out;
    },
    /** 印を足す（quiet が真なら「出さないことにした」印）。3 日より古い印は捨てる。書けなければ偽 */
    addRemindDone: function (keys, quiet) {
      var now = Date.now();
      var o = MP.store.remindDone();
      Object.keys(o).forEach(function (k) { if (now - Math.abs(o[k]) > REMIND_DONE_KEEP_MS) delete o[k]; });
      (keys || []).forEach(function (k) { if (!o[k]) o[k] = quiet ? -now : now; });
      var all = Object.keys(o);
      if (all.length > REMIND_DONE_MAX) {
        all.sort(function (a, b) { return Math.abs(o[a]) - Math.abs(o[b]); }).slice(0, all.length - REMIND_DONE_MAX).forEach(function (k) { delete o[k]; });
      }
      return set(L(), K.remindDone, JSON.stringify(o));
    },

    lastLoginId: function () { return get(L(), K.lastLoginId); },
    setLastLoginId: function (id) { set(L(), K.lastLoginId, id); },

    timings: function () {
      try {
        var list = JSON.parse(get(L(), K.timings) || '[]');
        return Array.isArray(list) ? list : [];
      } catch (e) { return []; }
    },
    addTiming: function (action, ms) {
      var list = MP.store.timings();
      list.push({ action: String(action), ms: Math.round(ms), at: Date.now() });
      set(L(), K.timings, JSON.stringify(list.slice(-TIMINGS_MAX)));
    },

    setFlash: function (text) { set(S(), K.flash, text); },
    takeFlash: function () { return take(K.flash); },
    setInviteName: function (name) { set(S(), K.inviteName, name); },
    takeInviteName: function () { return take(K.inviteName); },
    reloaded: function () { return get(S(), K.reloaded); },
    setReloaded: function (v) { if (v) set(S(), K.reloaded, v); else del(S(), K.reloaded); },
    /** 管理者が見ている社員の画面（{ employeeId, name }。そのタブだけ。計画 stage1-viewas-plan.md 1-6）。無い・形が違えば null */
    viewAs: function () {
      var v = get(S(), K.viewAs);
      if (!v) return null;
      var o = parse(v);
      // 印には、見始めたときのログインの目印（k）が入っている。今のログインと違う・目印が無い（古い形）・形が違うときは使わずに消す
      // （ログインが変わった後に、前の管理者が見ていた社員の画面を引き継がない。印を消すのに失敗していても防ぐ。計画 stage4-board-plan.md 24-13）
      var t = MP.store.token();
      var ok = !!o && typeof o.employeeId === 'string' && /^E\d{4}$/.test(o.employeeId) && typeof o.name === 'string' &&
        typeof o.k === 'string' && o.k !== '' && !!t && o.k === mark(t);
      if (!ok) { wipe(S(), K.viewAs); return null; }
      return { employeeId: o.employeeId, name: o.name };
    },
    setViewAs: function (o) {
      var t = MP.store.token();
      if (!t) return;
      set(S(), K.viewAs, JSON.stringify({ employeeId: o.employeeId, name: o.name, k: mark(t) }));
    },
    clearViewAs: function () { del(S(), K.viewAs); },

    // ---- 段階4（計画 stage4-board-plan.md 11-2・11-3）----
    /*
     *   mp.view.home   localStorage  ホームの控え（{ k, id, savedAt, data }。見出しだけ。本文・健康診断の区分・確定日・ほかの人の情報は入れない）。
     *                  答えを頼んだときのログインが今と同じ・見ている間でない・共有のログインでないときだけ書く。HOME_VIEW_MAX_H 時間より古いものは使わない
     *   mp.safety.active  token と同じ領域  動いている安否確認の控え（{ k, id, checkId, title, training, at }。電波が無いときに安否の画面でボタンを出すため）
     *   mp.safety.p:・mp.safety.done:・mp.safety.c:  送れていない安否の答えの控え（web/js/safety_pending.js。共有のログインは sessionStorage）
     */
    /** ホームの控え（今のログイン・今の社員・決めた時間の中のものだけ）。無ければ null */
    homeView: function () {
      var me = MP.store.me();
      if (!me || MP.store.tokenShared()) return null;
      var o = parse(get(L(), 'mp.view.home'));
      var maxMs = (MP.config.HOME_VIEW_MAX_H || 12) * 3600000;
      return o && o.k === mark(MP.store.token()) && o.id === me.employeeId && typeof o.savedAt === 'number' && Date.now() - o.savedAt <= maxMs && Date.now() - o.savedAt >= -60000 &&
        o.data && typeof o.data === 'object' ? o.data : null;
    },
    /** ホームの控えを書く（sentMark が今のログインと違う・無いときは書きも消しもしない。共有のログインでは残さない） */
    setHomeView: function (employeeId, data, sentMark) {
      if (sealed || !sameLogin(sentMark) || MP.store.viewAs()) return;
      var me = MP.store.me();
      if (!me || me.employeeId !== employeeId) return;
      if (MP.store.tokenShared()) { wipe(L(), 'mp.view.home'); return; }
      var text;
      try { text = JSON.stringify({ k: mark(MP.store.token()), id: employeeId, savedAt: Date.now(), data: data }); } catch (e) { text = ''; }
      if (!text || text.length > VIEW_MAX_CHARS || !set(L(), 'mp.view.home', text)) wipe(L(), 'mp.view.home');
    },
    /** 動いている安否確認の控え（今のログイン・今の社員のものだけ）。無ければ null */
    safetyActive: function (employeeId) {
      var a = tokenArea();
      if (!a) return null;
      var o = parse(get(a, 'mp.safety.active'));
      return o && o.k === mark(MP.store.token()) && o.id === employeeId && typeof o.checkId === 'string' && /^S\d{4}$/.test(o.checkId) ? o : null;
    },
    /**
     * 安否確認の印（task.reminders・portal.home・safety.get の答え）を控える。本人のログインのときだけ（sentMark が今と同じ・見ている間でない）。
     * 印が「動いていない」なら消す
     */
    setSafetyActive: function (employeeId, safety, sentMark) {
      if (sealed || !sameLogin(sentMark) || MP.store.viewAs()) return;
      var a = tokenArea();
      if (!a || typeof employeeId !== 'string') return;
      if (!safety || safety.active !== true || typeof safety.checkId !== 'string') { wipe(a, 'mp.safety.active'); return; }
      set(a, 'mp.safety.active', JSON.stringify({ k: mark(MP.store.token()), id: employeeId, checkId: safety.checkId, title: String(safety.title || ''), training: safety.training === true,
        answered: safety.answered === true, at: Date.now() }));
    },
    /**
     * ログインが変わって画面を開き直す前に、このタブに残る「前の人の印」を消す（計画 stage4-board-plan.md 24-12）:
     * 社員の画面を見ている印・通信の控え・次の画面に渡す一言・招待の名前・読み込み直しの印・リマインダーの控え・このタブの動いている安否確認の控え。
     * token・ログインの目印で守っている控え（me・ホーム・タスクの控えなど）はそのまま（目印が違えば使われない）
     */
    clearTabMarks: function () {
      var s = S();
      del(s, K.viewAs); wipe(s, K.netLog); del(s, K.flash); del(s, K.inviteName); del(s, K.reloaded); wipe(s, K.remind); wipe(s, 'mp.safety.active');
    },
    /** ログアウトのとき: ホームの控え・動いている安否確認の控えと、共有のログインの安否の控え（sessionStorage）を消す。localStorage の安否の控えは残す（送るときに社員を確かめる） */
    clearPortal: function () {
      wipe(L(), 'mp.view.home'); wipe(L(), 'mp.safety.active'); wipe(S(), 'mp.safety.active');
      var s = S();
      if (!s) return;
      var drop = [];
      try { for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k && /^mp\.safety\./.test(k)) drop.push(k); } } catch (e) { return; }
      drop.forEach(function (k) { del(s, k); });
    },
    /** 共有のログインの安否の控え（sessionStorage の送れていない答え）の数。ログインが切れて消す前に、知らせるかを決めるため（24-15） */
    sharedSafetyPending: function () {
      var s = S();
      var n = 0;
      if (!s) return 0;
      try { for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k && k.indexOf('mp.safety.p:') === 0) n++; } } catch (e) { return 0; }
      return n;
    },
  };
})();
