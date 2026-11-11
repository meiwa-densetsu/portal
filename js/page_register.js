/* 登録されていない端末で開いたとき: 追加コードの入力（確認 → 登録）と、招待リンクの案内 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$;
    ui.showFlash();
    if (MP.store.deviceKey()) { $('register-done').hidden = false; $('register-form').hidden = true; return; }

    var input = $('code');
    $('register-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      ui.pageMessage('');
      var code = input.value;
      if (code.replace(/[\s\-]/g, '').length !== 8) { ui.fieldError(input, '8桁のコードを入れてください'); return; }
      ui.fieldError(input, '');
      ui.run(function () {
        return MP.api.call('auth.deviceCodeInfo', { code: code }).then(function (res) {
          if (!res.ok) { ui.pageMessage(res.message, 'error'); return null; }
          return res.data;
        });
      }).then(function (info) {
        if (!info) return;
        return ui.confirm('この端末を登録しますか？',
          info.issuerName + ' さんが「' + info.deviceName + '」として発行したコードです。\n心当たりが無いときは「やめる」を押してください。', '登録する')
          .then(function (yes) {
            if (!yes) return; // 何も送らない（コードは使用済みにならない）
            return ui.run(function () {
              return MP.api.call('auth.useDeviceCode', { code: code }).then(function (r) {
                if (r.ok) {
                  MP.store.setDevice(r.data.deviceKey, r.data.deviceName);
                  MP.go('login.html');
                  return new Promise(function () {});
                }
                ui.pageMessage(r.code === 'NETWORK'
                  ? '登録できたか分かりません。もう一度押して「使えません」と出たら、登録済みの端末から追加コードを出し直してください'
                  : r.message, 'error');
              });
            });
          });
      });
    });
  });
})();
