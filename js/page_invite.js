/* 招待リンクの使用（auth.inviteInfo → 端末の名前を入れて auth.useInvite） */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$;
    // 招待の文字列は「#」の後ろ。読んだ直後に住所の欄から消す（履歴や画面の共有に残さない）。保存もしない
    var raw = window.location.hash.replace(/^#/, '');
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    var invite = /^[0-9a-f]{64}$/.test(raw) ? raw : '';
    // 同じ画面のままリンクを開き直すと「#」だけが変わり、画面は読み直されない。開き直したら読み直す
    // （読み直しや通信の失敗で招待を読めなくなったとき「LINE のリンクをもう一度開いて」の案内どおりに動くように）
    window.addEventListener('hashchange', function () { window.location.reload(); });

    function show(id) {
      ['invite-loading', 'invite-bad', 'invite-registered', 'invite-form'].forEach(function (x) { $(x).hidden = x !== id; });
    }
    function bad(text) { $('invite-bad-text').textContent = text; show('invite-bad'); }

    if (MP.store.deviceKey()) { show('invite-registered'); return; }
    if (!raw) { bad('招待リンクを読み取れませんでした。LINE に届いたリンクを、もう一度開いてください'); return; }
    if (!invite) { bad('この招待リンクは使えません。管理者に新しい招待を頼んでください'); return; }

    var input = $('device-name');
    input.value = ui.guessDeviceName();

    MP.api.call('auth.inviteInfo', { invite: invite }).then(function (res) {
      if (!res.ok) { bad(res.message); return; }
      var name = res.data.name;
      $('invite-who').textContent = name + ' さんの招待です（' + ui.fmtDateTime(res.data.expiresAt) + ' まで）';
      show('invite-form');

      $('invite-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        ui.pageMessage('');
        var deviceName = input.value.trim();
        if (!deviceName || deviceName.length > 40) { ui.fieldError(input, '端末の名前を1〜40文字で入れてください'); return; }
        ui.fieldError(input, '');
        ui.run(function () {
          return MP.api.call('auth.useInvite', { invite: invite, deviceName: deviceName }).then(function (r) {
            if (r.ok) {
              MP.store.setDevice(r.data.deviceKey, r.data.deviceName);
              MP.store.setInviteName(name);
              MP.go('login.html');
              return new Promise(function () {});
            }
            if (r.code === 'NETWORK') {
              ui.pageMessage('登録できたか分かりません。もう一度押して「使えません」と出たら、登録済みの端末から追加コードを出すか、管理者に招待の再発行を頼んでください', 'error');
            } else if (r.code === 'BAD_REQUEST') {
              ui.fieldError(input, r.message);
            } else {
              ui.pageMessage(r.message, 'error');
            }
          });
        });
      });
    });
  });
})();
