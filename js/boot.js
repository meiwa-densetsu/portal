/*
 * すべての HTML が最初に読み込む。各画面の処理を始める唯一の入口 MP.boot.start(fn) を持つ。
 * - 他のサイトの枠（iframe）の中で開かれたら、fn を呼ばない（画面の組み立て・サーバーの呼び出し・ボタンの登録を1つも始めない）
 * - HTML の本文は初めは隠してある（<body hidden>）。ここで見せる
 * 各画面のスクリプトは、MP.boot.start の外では何もしない
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};

  // 画面の表示中の問題の文（2 つの失敗の道で、管理者に知らせる「最近の失敗」と画面の一言の両方に、この 1 つを渡す。計画 stage2-error-report-plan.md 2-1）
  var SCREEN_TEXT = '画面の表示中に問題が起きました。読み込み直してください';
  var framed;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }

  function only(text) {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    var p = document.createElement('p');
    p.className = 'framed-note';
    p.textContent = text;
    document.body.appendChild(p);
    document.body.hidden = false;
  }

  /** 別の画面へ移る（戻るボタンで戻らないように置き換える） */
  var leaving = false; // この画面が自分で別の画面へ移っている途中か（ログインの見張りを休む）
  var LEAVE_RESUME_MS = 1000;
  MP.go = function (page) {
    if (MP.ui && MP.ui.stopped && MP.ui.stopped()) return; // 日報の 4 画面が「読み込み直す」だけになった後は、画面を移らない（読み込み直すだけ）
    leaving = true;
    // 移らなかった（離れる確認で「留まる」を選んだなど）ときは、少し後に印を下ろして見張りを再開する（計画 stage4-board-plan.md 24-14）
    window.setTimeout(function () { leaving = false; if (watch) loginOk(); }, LEAVE_RESUME_MS);
    window.location.replace(page);
  };

  /*
   * ログインが変わったら、開いている画面の表示を消す（計画 stage4-board-plan.md 20-2・21-6・21-7・21-8・22-2・22-5・23-4）。
   * ログインが要る画面（guard.js を読む画面）だけで見張る。画面を始めたときの token の目印（そのタブで使っている token。共有のログインは sessionStorage を先に見る）を覚え、
   * ほかのタブの保存領域の知らせ・画面に戻ったとき・2 秒ごとに比べる。違えば閉じる: 本文をすぐに消してから、自分で開き直す（案A）。
   * 開き直すまでの間は送らない・ファイルを作らない・離れる確認を出さない
   */
  var LOGIN_POLL_MS = 2000;
  var watch = null; // { mark } … 見張っている画面だけ
  var rawAdd = {}; // 包む前の addEventListener（boot.js の見張りの受け口だけが使う）
  var closed = false;
  function markNow() { try { return MP.store && MP.store.tokenMark ? MP.store.tokenMark() : ''; } catch (e) { return ''; } }
  function closeForLogin() {
    if (closed) return;
    closed = true;
    try { if (MP.remind && MP.remind.stop) MP.remind.stop(); } catch (e) { /* 止められなくても続ける */ } // リマインダー・安否の帯の見張りを止める
    try {
      Array.prototype.slice.call(document.querySelectorAll('dialog')).forEach(function (d) { try { d.close(); } catch (e) { /* 閉じられなくても消す */ } if (d.parentNode) d.parentNode.removeChild(d); });
    } catch (e) { /* 続ける */ }
    // 前の人の表示を先に（同じ処理の中で）すべて消してから、今のログインの人の画面へ自分で開き直す（案A。2026-11-18 ユーザー決定。
    // ログアウトしていれば、開き直した画面の入口がログインの画面へ移す）。閉じた後は送らない・離れる確認を出さない
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    var box = document.createElement('main');
    box.className = 'wrap';
    box.id = 'login-changed';
    var p = document.createElement('p');
    p.className = 'msg info';
    p.setAttribute('role', 'status');
    p.textContent = 'ログインが変わったので、画面を開き直しています…';
    box.appendChild(p);
    document.body.appendChild(box);
    document.body.hidden = false;
    closeFns.forEach(function (fn) { try { fn(); } catch (e) { /* 止められなくても続ける */ } }); // 画面の繰り返し（安否の送り直しなど）を止める
    // このタブに残る前の人の印（社員の画面を見ている印など）を消し、住所の「?」より後ろ（選んでいた社員・項目など）も外して開き直す（24-12）
    try { if (MP.store && MP.store.clearTabMarks) MP.store.clearTabMarks(); } catch (e) { /* 消せなくても続ける */ }
    try { window.location.replace(window.location.pathname); } catch (e) { /* 開き直せなくても、前の人の表示は消えている */ }
  }
  var closeFns = []; // 閉じたときに呼ぶ（MP.boot.onClose）
  var unloadFns = []; // 画面のスクリプトが付けた離れる確認（beforeunload）の受け口（保存していない入力があるかを聞くため）
  /** 画面の離れる確認の受け口に聞いて、保存していない入力があるか（どれかが止めようとすれば真） */
  function hasUnsaved() {
    return unloadFns.some(function (fn) {
      var ev = { type: 'beforeunload', defaultPrevented: false, returnValue: undefined, preventDefault: function () { this.defaultPrevented = true; } };
      try { fn.call(window, ev); } catch (e) { return false; }
      return ev.defaultPrevented || (ev.returnValue !== undefined && ev.returnValue !== null);
    });
  }
  /**
   * ログアウト・ログインが切れたときに、移る前に本文を消す（24-14）。閉じた扱いにするので、離れる確認は出ない（前の人の入力は送らない）・
   * 送らない・ファイルを作らない。この後に呼んだ側が MP.go でログインの画面へ移る
   */
  function clearForLogout() {
    if (closed) return;
    closed = true;
    try { if (MP.remind && MP.remind.stop) MP.remind.stop(); } catch (e) { /* 続ける */ }
    try { Array.prototype.slice.call(document.querySelectorAll('dialog')).forEach(function (d) { try { d.close(); } catch (e) { /* 消す */ } if (d.parentNode) d.parentNode.removeChild(d); }); } catch (e) { /* 続ける */ }
    closeFns.forEach(function (fn) { try { fn(); } catch (e) { /* 続ける */ } });
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    var p = document.createElement('p');
    p.className = 'msg info';
    p.id = 'logging-out';
    p.setAttribute('role', 'status');
    p.textContent = 'ログインの画面へ移っています…';
    document.body.appendChild(p);
    document.body.hidden = false;
  }
  /**
   * 今もこの画面を使ってよいか（閉じていない・ログインが同じ）。違えば閉じて偽。
   * mark を渡したら、その目印（呼んだ側が読んだ token の目印）で比べる（保存領域を読み直さない）
   */
  function loginOk(mark) {
    if (closed) return false;
    if (!watch) return true;
    if ((mark === undefined ? markNow() : mark) === watch.mark) return true;
    closeForLogin();
    return false;
  }
  function startWatch() {
    if (watch || !MP.guard) return; // ログインの画面などでは見張らない
    watch = { mark: markNow() };
    // この画面が自分で離れている途中（ログアウトの後のログインの画面への移動など）は見張らない（離れるときの visibilitychange で、次の画面への一言を消さない）
    var check = function () { if (!leaving) loginOk(); };
    rawAdd.win.call(window, 'pagehide', function () { leaving = true; });
    rawAdd.win.call(window, 'storage', function (ev) { if (ev.key === null || ev.key === 'mp.token') check(); });
    rawAdd.win.call(window, 'focus', check);
    rawAdd.win.call(window, 'pageshow', function () { leaving = false; check(); });
    rawAdd.doc.call(document, 'visibilitychange', check);
    window.setInterval(check, LOGIN_POLL_MS);
  }
  // 画面のスクリプトより先に包む: 閉じた後は、window・document の受け口（離れる確認・戻ったときの読み込み直し・storage など）を動かさない・
  // ファイルを作らない・ダウンロードを始めない（21-7・22-5・23-4。boot.js の見張りの受け口は元の関数で付ける）
  (function () {
    var wrapAdd = function (target) {
      var add = target.addEventListener;
      target.addEventListener = function (type, fn, opt) {
        if (typeof fn === 'function') {
          var inner = fn;
          if (type === 'beforeunload' && target === window) unloadFns.push(inner);
          fn = function (ev) { if (closed) return undefined; return inner.call(this, ev); };
        }
        return add.call(this, type, fn, opt);
      };
      return add;
    };
    rawAdd.win = wrapAdd(window);
    rawAdd.doc = wrapAdd(document);
    try {
      if (window.URL && typeof window.URL.createObjectURL === 'function') {
        var make = window.URL.createObjectURL;
        window.URL.createObjectURL = function (o) {
          if (!loginOk()) throw new Error('ログインが変わったため、ファイルを作りません');
          return make.call(window.URL, o);
        };
      }
      if (window.HTMLAnchorElement && window.HTMLAnchorElement.prototype && window.HTMLAnchorElement.prototype.click) {
        var click = window.HTMLAnchorElement.prototype.click;
        window.HTMLAnchorElement.prototype.click = function () { if (!loginOk()) return undefined; return click.apply(this, arguments); };
      }
    } catch (e) { /* 包めないブラウザでは、閉じた画面の本文を消すだけ */ }
  })();

  MP.boot = {
    framed: framed,
    /** 今もこの画面を使ってよいか（ログインが変わっていれば閉じて偽）。api.js が送る前・返事を扱う前に呼ぶ */
    loginOk: loginOk,
    /** 保存していない入力があるか（画面の離れる確認の受け口に聞く） */
    hasUnsaved: hasUnsaved,
    /** ログアウト・ログインが切れたときに、移る前に本文を消す（離れる確認を出さない） */
    clearForLogout: clearForLogout,
    /** 閉じたか */
    closed: function () { return closed; },
    /** 同じタブで正しく token を替えたとき（パスワードの変更）に、覚えた目印を新しくする */
    acceptLogin: function () { if (watch && !closed) watch.mark = markNow(); },
    /** ログインが変わって閉じたときに呼ぶ関数を足す（画面の繰り返しを止めるため） */
    onClose: function (fn) { if (typeof fn === 'function') closeFns.push(fn); },
    start: function (fn) {
      // 最初の表示の問題を知らせる（画面がもう「読み込み直す」だけになっていても、この知らせと管理者に知らせるボタンは出す）
      var failed = function () {
        if (MP.report) MP.report.screenFailure(SCREEN_TEXT);
        if (!MP.ui) return;
        if (MP.ui.isBroken && MP.ui.isBroken()) MP.ui.brokenMessage(SCREEN_TEXT, 'error');
        else MP.ui.pageMessage(SCREEN_TEXT, 'error');
      };
      var run = function () {
        if (framed) { only('この画面は枠の中では使えません'); return; }
        if (!MP.store || !MP.store.available()) {
          only('このブラウザではログインを覚えられません。通常のモード（プライベートブラウズではないモード）で開いてください');
          return;
        }
        startWatch();
        document.body.hidden = false;
        try {
          var r = fn();
          // 例外の中身・スタックは送らない・残さない（画面のコードや入力が混ざるかもしれないため）
          if (r && typeof r.then === 'function') r.then(null, function () { failed(); });
        } catch (e) {
          failed();
        }
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
      else run();
    },
  };
})();
