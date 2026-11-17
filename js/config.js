/*
 * 画面の設定。ここに秘密は書かない（GAS の /exec の住所は公開してよい）
 * APP_VERSION … 画面の版。変えたら、全 HTML の「?v=」も同じ値にする（tests/web_static_test.js が確かめる）
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  MP.config = {
    EXEC_URL: 'https://script.google.com/macros/s/AKfycbzHNIBbtfQnjemKMHmp6Qh2PypQ82cq2OGoax2by7pDBg4Sht6cGMlVu80k9I38b5IrqA/exec',
    API_VERSION: 8,
    APP_VERSION: '21',
    // リマインダー（計画 stage2-tasklist-v3-plan.md 第6章）: 一覧を読み直す間隔（分）・時刻を確かめる間隔（秒）・過ぎてから出す限り（分）・操作の後に読み直すまで（秒）
    REMIND: { REFRESH_MIN: 10, CHECK_SEC: 20, LATE_MAX_MIN: 720, AFTER_OP_SEC: 5 },
    // タスクの「今日」が切り替わる時刻（0 時からの分。360 = 6:00）。サーバーの RULES.TASK.DAY_START_MIN と同じ値（tests/web_static_test.js が確かめる）。
    // 使う所: 開く月の見当・6:00 より前のリマインダーを次の日の時刻として読む（仕上げの計画 第3章 C5・第4章）
    TASK_DAY_START_MIN: 360,
  };
})();
