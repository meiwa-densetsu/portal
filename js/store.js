/*
 * ブラウザの保存領域の読み書き（計画 stage1-step2b-3-plan.md 2-2）
 *
 *   mp.deviceKey   localStorage                 端末の鍵
 *   mp.deviceName  localStorage                 登録したときの端末名（表示用）
 *   mp.token       localStorage（通常）／sessionStorage（「他の人も使う」）  ログインの記憶
 *   mp.lastLoginId localStorage（通常のログインのときだけ）  前回選んだ名前
 *   mp.timings     localStorage                 最近20回の通信（処理の名前・かかった時間・日時だけ）
 *   mp.flash / mp.inviteName / mp.reloaded  sessionStorage  次の画面に1回だけ渡す文・名前、読み込み直しの印（秘密ではない）
 *
 * パスワード・仮パスワード・招待の文字列・追加コードは保存しない
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  var K = { deviceKey: 'mp.deviceKey', deviceName: 'mp.deviceName', token: 'mp.token', lastLoginId: 'mp.lastLoginId', timings: 'mp.timings',
    flash: 'mp.flash', inviteName: 'mp.inviteName', reloaded: 'mp.reloaded' };
  var TIMINGS_MAX = 20;

  function area(name) { try { return window[name]; } catch (e) { return null; } }
  function get(a, k) { try { var v = a.getItem(k); return typeof v === 'string' ? v : ''; } catch (e) { return ''; } }
  function set(a, k, v) { try { a.setItem(k, v); return true; } catch (e) { return false; } }
  function del(a, k) { try { a.removeItem(k); } catch (e) { /* 消せないときは何もしない */ } }
  function L() { return area('localStorage'); }
  function S() { return area('sessionStorage'); }
  function take(k) { var v = get(S(), k); del(S(), k); return v; }

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
    clearToken: function () { del(L(), K.token); del(S(), K.token); },

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
  };
})();
