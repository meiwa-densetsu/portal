/* ホーム（入口。メニューは決まった中身なので、控えの「自分の情報」があればすぐ出す。計画 stage2-switch-speed-plan.md 1-2） */
(function () {
  'use strict';
  MP.boot.start(function () {
    /** メニューを出す（管理者・部長のメニューの出し分け）。本物の答えが来たら、もう一度呼ばれる */
    function show(me) {
      MP.ui.$('home').hidden = false;
      MP.ui.$('admin-menu').hidden = !MP.guard.isAdmin(me);
      MP.ui.$('manager-menu').hidden = me.role !== '部長'; // 部長の一覧（手順9）。管理者は管理者のメニューから
    }
    return MP.guard.enter({ instant: true, onMe: show }).then(show);
  });
})();
