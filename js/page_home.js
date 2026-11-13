/* ホーム（今は入口だけ。日報などは後の手順で足す） */
(function () {
  'use strict';
  MP.boot.start(function () {
    return MP.guard.enter({}).then(function (me) {
      MP.ui.$('home').hidden = false;
      MP.ui.$('admin-menu').hidden = !MP.guard.isAdmin(me);
      MP.ui.$('manager-menu').hidden = me.role !== '部長'; // 部長の一覧（手順9）。管理者は管理者のメニューから
    });
  });
})();
