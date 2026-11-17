/* ホーム（入口。メニューは決まった中身なので、控えの「自分の情報」があればすぐ出す。計画 stage2-switch-speed-plan.md 1-2） */
(function () {
  'use strict';
  MP.boot.start(function () {
    var VERSION_WAIT_MS = 2000; // 控えの仕組み（sw.js）の答えを待つ長さ。来なければ「なし」
    var asked = false;

    /** 今この画面を受け持っている sw.js に版を聞く → 版の文字か null（受け持つものが無い・答えが来ない・形が違う） */
    function swVersion() {
      return new Promise(function (resolve) {
        var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
        if (!sw || typeof MessageChannel !== 'function') { resolve(null); return; }
        var ch = new MessageChannel();
        var timer = setTimeout(function () { resolve(null); }, VERSION_WAIT_MS);
        ch.port1.onmessage = function (ev) {
          clearTimeout(timer);
          var v = ev.data && ev.data.version;
          resolve(typeof v === 'string' && /^[A-Za-z0-9._-]{1,20}$/.test(v) ? v : null);
        };
        try { sw.postMessage({ type: 'version' }, [ch.port2]); } catch (e) { clearTimeout(timer); resolve(null); }
      });
    }

    /** 管理者のホームにだけ、一番下に「画面の版 22・控えの仕組み 22」（計画 stage2-calendar-import-sw-plan.md 第6章） */
    function showVersion(me) {
      var p = MP.ui.$('app-version');
      var admin = MP.guard.isAdmin(me);
      p.hidden = !admin;
      if (!admin || asked) return;
      asked = true;
      var app = '画面の版 ' + MP.config.APP_VERSION;
      p.textContent = app + '・控えの仕組み 確かめています';
      swVersion().then(function (v) { p.textContent = app + '・控えの仕組み ' + (v || 'なし'); });
    }

    /** メニューを出す（管理者・部長のメニューの出し分け）。本物の答えが来たら、もう一度呼ばれる */
    function show(me) {
      MP.ui.$('home').hidden = false;
      MP.ui.$('admin-menu').hidden = !MP.guard.isAdmin(me);
      MP.ui.$('manager-menu').hidden = me.role !== '部長'; // 部長の一覧（手順9）。管理者は管理者のメニューから
      showVersion(me);
    }
    return MP.guard.enter({ instant: true, onMe: show }).then(show);
  });
})();
