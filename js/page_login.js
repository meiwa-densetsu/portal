/* ログイン（名前の一覧 auth.names → auth.login） */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, store = MP.store;
    if (!store.deviceKey()) { MP.go('register.html'); return; }
    ui.showFlash();

    var select = $('login-id'), pw = $('password'), shared = $('shared'), userField = $('username');
    $('device-label').textContent = 'この端末: ' + (store.deviceName() || '（名前なし）');
    shared.addEventListener('change', function () { $('shared-note').hidden = !shared.checked; });
    select.addEventListener('change', function () {
      userField.value = select.selectedIndex >= 0 ? select.options[select.selectedIndex].textContent : '';
    });

    $('redo').addEventListener('click', function () {
      ui.confirm('端末の登録をやり直しますか？', 'この端末の登録を消します。もう一度使うには、追加コードか招待リンクが必要です。', '登録を消す', 'danger')
        .then(function (yes) {
          if (!yes) return;
          store.clearDevice();
          MP.go('register.html');
        });
    });

    MP.api.call('auth.names', { deviceKey: store.deviceKey() }).then(function (res) {
      if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
      var names = res.data;
      var inviteName = store.takeInviteName();
      var last = store.lastLoginId();
      var initial = '';
      if (inviteName) {
        var same = names.filter(function (n) { return n.name === inviteName; });
        if (same.length === 1) initial = same[0].loginId; // 同じ名前が2人いたら選ばない
      } else if (names.some(function (n) { return n.loginId === last; })) {
        initial = last;
      }
      ui.clear(select);
      select.appendChild(ui.el('option', { value: '', text: '名前を選んでください' }));
      names.forEach(function (n) { select.appendChild(ui.el('option', { value: n.loginId, text: n.name })); });
      select.value = initial;
      select.dispatchEvent(new Event('change'));
      $('login-form').hidden = false;
    });

    $('login-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      ui.pageMessage('');
      var bad = false;
      if (!select.value) { ui.fieldError(select, '名前を選んでください'); bad = true; } else ui.fieldError(select, '');
      if (!pw.value) { ui.fieldError(pw, 'パスワードを入れてください'); bad = true; }
      else if (pw.value.length > 200) { ui.fieldError(pw, 'パスワードは200文字までです'); bad = true; }
      else ui.fieldError(pw, '');
      if (bad) return;
      var isShared = shared.checked, loginId = select.value;
      ui.run(function () {
        return MP.api.call('auth.login', { deviceKey: store.deviceKey(), loginId: loginId, password: pw.value, shared: isShared }).then(function (r) {
          if (!r.ok) {
            if (r.code === 'LOGIN_FAILED') pw.value = ''; // 通信の失敗などでは、入力を消さない
            ui.pageMessage(r.message, 'error');
            return;
          }
          store.setToken(r.data.token, isShared);
          if (!isShared) store.setLastLoginId(loginId);
          MP.go(r.data.mustChangePassword ? 'password.html' : 'home.html');
          return new Promise(function () {});
        });
      });
    });
  });
})();
