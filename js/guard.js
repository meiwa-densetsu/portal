/*
 * ログインが要る画面の入口の確認と、上の帯（「〇〇でログイン中」・ログアウト）
 *
 *   MP.guard.enter({ admin, allowTemp }) → Promise<me>（auth.me の値）
 *     admin     … 管理者でなければ home へ戻す
 *     allowTemp … 仮パスワードのままでも入れる（パスワードの変更の画面だけ）
 *
 * 画面の出し分けは見た目だけ。本当の守りは、サーバーの権限の確認
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  var ROLE_ADMIN = '管理者';

  function logout() {
    var ui = MP.ui;
    ui.dialog({
      title: 'ログアウト', text: 'どの端末からログアウトしますか？', dismiss: null,
      buttons: [
        { label: 'この端末だけログアウト', value: 'one', kind: 'primary' },
        { label: 'すべての端末からログアウト', value: 'all' },
        { label: 'やめる', value: null },
      ],
    }).then(function (choice) {
      if (!choice) return;
      var all = choice === 'all';
      ui.run(function () {
        return MP.api.call('auth.logout', { all: all }, { raw: true }).then(function (res) {
          // 通信の結果にかかわらず、この端末のログインの記憶は消す
          MP.store.clearToken();
          // 「すべての端末」で成功が確かめられないとき（通信の失敗・混雑・途中で止まったなど）は、できたと言わない
          if (all && !res.ok) {
            MP.store.setFlash('他の端末のログアウトができたか分かりません。もう一度ログインして、やり直してください');
          } else {
            MP.store.setFlash('ログアウトしました');
          }
          MP.go('login.html');
          return new Promise(function () {});
        });
      });
    });
  }

  function renderTopbar(me, opts) {
    var ui = MP.ui;
    var bar = ui.$('topbar');
    if (!bar) return;
    ui.clear(bar);
    var inner = ui.el('div', { class: 'topbar-inner' });
    // 仮パスワードのままのときは、他の画面への入口を出さない
    inner.appendChild(me.mustChangePassword
      ? ui.el('span', { class: 'topbar-home', text: '名和電設ポータル' })
      : ui.el('a', { class: 'topbar-home', href: 'home.html', text: '名和電設ポータル' }));
    inner.appendChild(ui.el('span', { class: 'topbar-who', id: 'who', text: me.name + ' でログイン中' }));
    inner.appendChild(ui.el('button', { type: 'button', class: 'btn', id: 'logout', text: 'ログアウト', on: { click: logout } }));
    bar.appendChild(inner);
    bar.hidden = false;
  }

  MP.guard = {
    ROLE_ADMIN: ROLE_ADMIN,
    isAdmin: function (me) { return !!me && me.role === ROLE_ADMIN; },
    enter: function (opts) {
      var o = opts || {};
      var never = new Promise(function () {});
      if (!MP.store.deviceKey()) { MP.go('register.html'); return never; }
      if (!MP.store.token()) { MP.go('login.html'); return never; }
      return MP.api.call('auth.me', {}).then(function (res) {
        if (!res.ok) {
          MP.ui.pageMessage(res.message + '\n画面を読み込み直してください', 'error');
          return never;
        }
        var me = res.data;
        if (me.mustChangePassword && !o.allowTemp) { MP.go('password.html'); return never; }
        if (o.admin && me.role !== ROLE_ADMIN) { MP.go('home.html'); return never; }
        renderTopbar(me, o);
        MP.ui.showFlash();
        return me;
      });
    },
  };
})();
