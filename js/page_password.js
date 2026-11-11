/* パスワードの変更（auth.changePassword）。仮パスワードのままでも入れる */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, store = MP.store;
    return MP.guard.enter({ allowTemp: true }).then(function (me) {
      $('username').value = me.name;
      $('temp-note').hidden = !me.mustChangePassword;
      $('back').hidden = !!me.mustChangePassword;
      $('password-form').hidden = false;
      var cur = $('current'), next = $('next'), again = $('again');

      $('password-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        ui.pageMessage('');
        ui.clearFieldErrors($('password-form'));
        var bad = false;
        if (!cur.value) { ui.fieldError(cur, '今のパスワードを入れてください'); bad = true; }
        if (next.value.length < 8 || next.value.length > 200) { ui.fieldError(next, '新しいパスワードは8〜200文字にしてください'); bad = true; }
        if (next.value !== again.value) { ui.fieldError(again, '新しいパスワードが、上の欄と違います'); bad = true; }
        if (bad) return;
        var shared = store.tokenShared();
        ui.run(function () {
          return MP.api.call('auth.changePassword', { current: cur.value, next: next.value }).then(function (r) {
            if (r.ok) {
              store.setToken(r.data.token, shared); // 元と同じ置き場所に
              return ui.notice('変更しました', '他の端末は、ログインし直しになります。').then(function () {
                MP.go('home.html');
                return new Promise(function () {});
              });
            }
            if (r.code === 'NETWORK') {
              store.clearToken();
              store.setFlash('変更できたか分かりません。新しいパスワードでログインし直してください。できなければ前のパスワードで');
              MP.go('login.html');
              return new Promise(function () {});
            }
            if (r.code === 'CURRENT_WRONG') ui.fieldError(cur, r.message);
            else if (r.code === 'WEAK_PASSWORD') ui.fieldError(next, r.message);
            else ui.pageMessage(r.message, 'error');
          });
        });
      });
    });
  });
})();
