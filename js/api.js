/*
 * GAS の呼び出し（計画 stage1-step2b-3-plan.md 2-3）
 *
 *   MP.api.call(action, args, opts) → Promise<{ ok: true, data } | { ok: false, code, message }>
 *     opts.requestId … 送り直すときに同じものを使う保存（社員マスタ）で渡す。無ければ毎回新しく作る
 *     opts.raw       … 共通の扱い（下の表）をせず、結果をそのまま返す（ログアウト用）
 *
 * 通信の失敗・時間切れ（60秒）・JSON でない応答・形の違う応答は、すべて code: 'NETWORK'（結果が分からない）
 * どの処理にも共通の扱い:
 *   RELOAD → 読み込み直す（続けて2回目は読み込み直さずに文を返す）／UNAUTHORIZED → ログインの記憶を消して login へ／
 *   PASSWORD_CHANGE_REQUIRED → password へ／INVALID_DEVICE → 端末の情報を消して register へ／FORBIDDEN → home へ
 *   画面を移るときは、返す Promise を終わらせない（呼んだ側は何もしなくてよい。送信中の表示のまま移る）
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  var TIMEOUT_MS = 60000;
  var NETWORK_TEXT = '通信できませんでした。電波の良いところでもう一度お試しください';

  function newRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function network() { return { ok: false, code: 'NETWORK', message: NETWORK_TEXT }; }

  /** 応答の文字を、決まった形に直す。形が違えば NETWORK */
  function normalize(text) {
    var o;
    try { o = JSON.parse(text); } catch (e) { return network(); }
    if (!o || typeof o !== 'object') return network();
    if (o.ok === true && Object.prototype.hasOwnProperty.call(o, 'data')) {
      // me … ログインが要る処理の答えに付く「自分の情報」（auth.me と同じ中身。画面を開くときに使う）
      return o.me && typeof o.me === 'object' ? { ok: true, data: o.data, me: o.me } : { ok: true, data: o.data };
    }
    if (o.ok === false && o.error && typeof o.error.code === 'string' && o.error.code && typeof o.error.message === 'string') {
      return { ok: false, code: o.error.code, message: o.error.message };
    }
    return network();
  }

  function send(action, args, requestId, viewAs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    var t0 = Date.now();
    var env = { action: action, apiVersion: MP.config.API_VERSION, token: MP.store.token(), requestId: requestId, args: args || {} };
    if (viewAs) env.viewAs = viewAs.employeeId; // 社員の画面を見ているときだけ（計画 stage1-viewas-plan.md 1-1）
    var body = JSON.stringify(env);
    return fetch(MP.config.EXEC_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body,
      redirect: 'follow', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctrl.signal,
    }).then(function (r) { return r.text(); }).then(normalize, network).then(function (res) {
      clearTimeout(timer);
      MP.store.addTiming(action, Date.now() - t0);
      return res;
    });
  }

  var never = function () { return new Promise(function () {}); };

  /**
   * 社員の画面を見ているときの答えの確かめ（計画 stage1-viewas-plan.md 1-6。今までの共通の扱い common より前）。
   *   成功で me.viewAs が頼んだ社員 → そのまま／成功でそれ以外 → 渡さずに終える（ホームへ）
   *   VIEW_ONLY・NETWORK・BUSY・INTERNAL → 続ける／それ以外の誤り → 先に見るのをやめてから common へ
   */
  function checkViewAs(res, sentAs) {
    if (!sentAs) return res;
    if (res.ok) {
      if (res.me && res.me.viewAs && res.me.viewAs.employeeId === sentAs.employeeId) return res;
      MP.store.clearViewAs();
      MP.store.setFlash('社員の画面の表示を終えました');
      MP.go('home.html');
      return never();
    }
    if (['VIEW_ONLY', 'NETWORK', 'BUSY', 'INTERNAL'].indexOf(res.code) >= 0) return res;
    MP.store.clearViewAs();
    return res;
  }

  function common(res) {
    if (res.ok) { MP.store.setReloaded(''); return res; }
    var here = window.location.pathname;
    switch (res.code) {
      case 'RELOAD':
        if (MP.store.reloaded() === here) {
          return { ok: false, code: 'RELOAD', message: '画面が古くなっています。しばらくしてから開き直してください' };
        }
        MP.store.setReloaded(here);
        window.location.reload();
        return never();
      case 'UNAUTHORIZED':
        MP.store.clearToken();
        MP.store.setFlash('もう一度ログインしてください');
        MP.go('login.html');
        return never();
      case 'PASSWORD_CHANGE_REQUIRED':
        MP.go('password.html');
        return never();
      case 'INVALID_DEVICE':
        MP.store.clearDevice();
        MP.store.setFlash('この端末の登録が無効になりました。もう一度登録してください');
        MP.go('register.html');
        return never();
      case 'FORBIDDEN':
        MP.store.setFlash('この操作はできません');
        MP.go('home.html');
        return never();
      default:
        return res;
    }
  }

  /**
   * 保存用の呼び出しを作る（社員マスタなど）。「1回の保存の操作」ごとに requestId を1つ作り、
   * 結果が分からない（NETWORK）・途中で止まった（INTERNAL）・混雑（BUSY）の後に同じ内容で送り直すときは、同じ requestId を使う。
   * 内容を変えたとき・結果がはっきりした後（成功・断られた）は、新しく作る
   */
  function saver(opts) {
    var last = null; // { key, requestId }
    var extra = opts || {};
    return function (action, args) {
      var key = action + '\n' + JSON.stringify(args);
      if (!last || last.key !== key) last = { key: key, requestId: newRequestId() };
      var mine = last;
      return MP.api.call(action, args, { requestId: mine.requestId, noViewAs: !!extra.noViewAs }).then(function (res) {
        var unknown = !res.ok && (res.code === 'NETWORK' || res.code === 'INTERNAL' || res.code === 'BUSY');
        if (!unknown && last === mine) last = null;
        if (!res.ok && res.code === 'NETWORK') res.message = '保存できたか分かりません。もう一度同じボタンを押してください';
        return res;
      });
    };
  }

  MP.api = {
    saver: saver,
    newRequestId: newRequestId,
    NETWORK_TEXT: NETWORK_TEXT,
    call: function (action, args, opts) {
      var o = opts || {};
      // noViewAs … 社員の画面を見る開始・終了（本人の管理者として送る）
      var sentAs = o.noViewAs ? null : MP.store.viewAs();
      var p = send(action, args, o.requestId || newRequestId(), sentAs).then(function (res) { return checkViewAs(res, sentAs); });
      return o.raw ? p : p.then(common);
    },
  };
})();
