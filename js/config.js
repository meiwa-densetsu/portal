/*
 * 画面の設定。ここに秘密は書かない（GAS の /exec の住所は公開してよい）
 * APP_VERSION … 画面の版。変えたら、全 HTML の「?v=」も同じ値にする（tests/web_static_test.js が確かめる）
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  MP.config = {
    EXEC_URL: 'https://script.google.com/macros/s/AKfycbzHNIBbtfQnjemKMHmp6Qh2PypQ82cq2OGoax2by7pDBg4Sht6cGMlVu80k9I38b5IrqA/exec',
    API_VERSION: 1,
    APP_VERSION: '2',
  };
})();
