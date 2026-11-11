/* 入口。保存領域を見て移すだけ（サーバーは呼ばない） */
(function () {
  'use strict';
  MP.boot.start(function () {
    if (!MP.store.deviceKey()) MP.go('register.html');
    else if (!MP.store.token()) MP.go('login.html');
    else MP.go('home.html');
  });
})();
