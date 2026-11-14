/*
 * 画面のファイルを端末に覚える仕組み（sw.js）を登録するだけ（計画 stage1-step12-sw-plan.md 2-2）
 * 他のサイトの枠の中・仕組みの無いブラウザでは何もしない。失敗しても画面はそのまま動く
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  if (!MP.boot || MP.boot.framed) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    try {
      navigator.serviceWorker.register('sw.js').then(null, function () {});
    } catch (e) { /* 登録できなくても画面は動く */ }
  });
})();
