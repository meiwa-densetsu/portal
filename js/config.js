/*
 * 画面の設定。ここに秘密は書かない（GAS の /exec の住所は公開してよい）
 * APP_VERSION … 画面の版。変えたら、全 HTML の「?v=」も同じ値にする（tests/web_static_test.js が確かめる）
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  MP.config = {
    EXEC_URL: 'https://script.google.com/macros/s/AKfycbzHNIBbtfQnjemKMHmp6Qh2PypQ82cq2OGoax2by7pDBg4Sht6cGMlVu80k9I38b5IrqA/exec',
    API_VERSION: 10,
    APP_VERSION: '31',
    // リマインダー（計画 stage2-tasklist-v3-plan.md 第6章）: 一覧を読み直す間隔（分）・時刻を確かめる間隔（秒）・過ぎてから出す限り（分）・操作の後に読み直すまで（秒）
    REMIND: { REFRESH_MIN: 10, CHECK_SEC: 20, LATE_MAX_MIN: 720, AFTER_OP_SEC: 5 },
    // タスクの「今日」が切り替わる時刻（0 時からの分。360 = 6:00）。サーバーの RULES.TASK.DAY_START_MIN と同じ値（tests/web_static_test.js が確かめる）。
    // 使う所: 開く月の見当・6:00 より前のリマインダーを次の日の時刻として読む（仕上げの計画 第3章 C5・第4章）
    TASK_DAY_START_MIN: 360,
    // 段階4（計画 stage4-board-plan.md 11-2・11-3）: ホームの控えを使う長さ（時間）・安否の答えの送り直しの間隔（秒）・控えを残す日数・控えを持つ人の数・管理者の安否の一覧を読み直す間隔（秒）
    HOME_VIEW_MAX_H: 12,
    SAFETY: { RESEND_SEC: 30, KEEP_DAYS: 3, PEOPLE_MAX: 5, ADMIN_REFRESH_SEC: 60, REPLACES_MAX: 10 },
  };
})();
