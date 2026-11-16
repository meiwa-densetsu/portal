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
  MP.go = function (page) { window.location.replace(page); };

  MP.boot = {
    framed: framed,
    start: function (fn) {
      var run = function () {
        if (framed) { only('この画面は枠の中では使えません'); return; }
        if (!MP.store || !MP.store.available()) {
          only('このブラウザではログインを覚えられません。通常のモード（プライベートブラウズではないモード）で開いてください');
          return;
        }
        document.body.hidden = false;
        try {
          var r = fn();
          // 例外の中身・スタックは送らない・残さない（画面のコードや入力が混ざるかもしれないため）
          if (r && typeof r.then === 'function') r.then(null, function () {
            if (MP.report) MP.report.screenFailure(SCREEN_TEXT);
            if (MP.ui) MP.ui.pageMessage(SCREEN_TEXT, 'error');
          });
        } catch (e) {
          if (MP.report) MP.report.screenFailure(SCREEN_TEXT);
          if (MP.ui) MP.ui.pageMessage(SCREEN_TEXT, 'error');
        }
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
      else run();
    },
  };
})();
