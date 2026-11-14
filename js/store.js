/*
 * ブラウザの保存領域の読み書き（計画 stage1-step2b-3-plan.md 2-2）
 *
 *   mp.deviceKey   localStorage                 端末の鍵
 *   mp.deviceName  localStorage                 登録したときの端末名（表示用）
 *   mp.token       localStorage（通常）／sessionStorage（「他の人も使う」）  ログインの記憶
 *   mp.lastLoginId localStorage（通常のログインのときだけ）  前回選んだ名前
 *   mp.timings     localStorage                 最近20回の通信（処理の名前・かかった時間・日時だけ）
 *   mp.me          token と同じ領域            自分の情報の控え（表示用。{ k: token の目印, me }。計画 stage2-switch-speed-plan.md 1-1）
 *   mp.view.tasks  sessionStorage              タスクリストの今月の控え（表示用。{ k, id: 社員ID, data }。同 1-3）
 *   mp.viewAs     sessionStorage  管理者が見ている社員の画面（そのタブだけ）
 *   mp.flash / mp.inviteName / mp.reloaded  sessionStorage  次の画面に1回だけ渡す文・名前、読み込み直しの印（秘密ではない）
 *
 * パスワード・仮パスワード・招待の文字列・追加コードは保存しない
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  var K = { viewAs: 'mp.viewAs', deviceKey: 'mp.deviceKey', deviceName: 'mp.deviceName', token: 'mp.token', lastLoginId: 'mp.lastLoginId', timings: 'mp.timings',
    flash: 'mp.flash', inviteName: 'mp.inviteName', reloaded: 'mp.reloaded', me: 'mp.me', taskView: 'mp.view.tasks' };
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
    clearToken: function () {
      sealed = true; // 初めに立てる（この後に来る pagehide などで控えを書き直さない）
      del(L(), K.token); del(S(), K.token); del(S(), K.viewAs); // 見ている印も消す（残るとログインの依頼に viewAs が付いて断られる）
      wipe(L(), K.me); wipe(S(), K.me); wipe(S(), K.taskView);
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
    /** 本物の答えの me を覚える。clearToken の後・token が無い・形が違うときは書かずに消す。見ている間は何もしない */
    setMe: function (me) {
      if (sealed) return;
      if (MP.store.viewAs() || (me && me.viewAs)) return;
      var a = tokenArea();
      if (!a || !validMe(me)) { wipe(L(), K.me); wipe(S(), K.me); return; }
      wipe(a === L() ? S() : L(), K.me);
      if (!set(a, K.me, JSON.stringify({ k: mark(MP.store.token()), me: me }))) wipe(a, K.me);
    },

    /** タスクリストの今月の控え（表示用。同 1-3）。今の token・控えの me の社員のものだけ返す */
    taskView: function () {
      var me = MP.store.me();
      if (!me) return null;
      var o = parse(get(S(), K.taskView));
      return o && o.k === mark(MP.store.token()) && o.id === me.employeeId && o.data && typeof o.data === 'object' ? o.data : null;
    },
    /** タスクの控えを書く。clearToken の後は何もしない。token が無い・控えの me と社員が違う・大きすぎる・書けないときは消す */
    setTaskView: function (employeeId, data) {
      if (sealed) return;
      var me = MP.store.me();
      if (!me || me.employeeId !== employeeId) { wipe(S(), K.taskView); return; }
      var text;
      try { text = JSON.stringify({ k: mark(MP.store.token()), id: employeeId, data: data }); } catch (e) { text = ''; }
      if (!text || text.length > VIEW_MAX_CHARS || !set(S(), K.taskView, text)) wipe(S(), K.taskView);
    },
    clearTaskView: function () { wipe(S(), K.taskView); },

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
      try {
        var o = JSON.parse(v);
        return o && typeof o.employeeId === 'string' && /^E\d{4}$/.test(o.employeeId) && typeof o.name === 'string' ? o : null;
      } catch (e) { return null; }
    },
    setViewAs: function (o) { set(S(), K.viewAs, JSON.stringify({ employeeId: o.employeeId, name: o.name })); },
    clearViewAs: function () { del(S(), K.viewAs); },
  };
})();
