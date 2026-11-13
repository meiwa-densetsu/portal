/*
 * ログインが要る画面の入口の確認と、上の帯（「〇〇でログイン中」・ログアウト）
 *
 *   MP.guard.enter({ admin, allowTemp }) → Promise<me>（auth.me の値）
 *   MP.guard.enter({ admin, allowTemp, load: { action, args } }) → Promise<{ me, res }>（res はその処理の答え。問い合わせ1回）
 *     admin     … 管理者でなければ home へ戻す
 *     allowTemp … 仮パスワードのままでも入れる（パスワードの変更の画面だけ）
 *     load      … 画面のデータの処理。その答えに付く me を使い、auth.me を別に聞かない（me が無ければ聞き直す）
 *     retryable … load の通信の失敗（NETWORK）・混み合い（BUSY）を、止めずに { me: null, res } で返す（画面が「もう一度」を出す）
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

  var endSave = null;

  /** 社員の画面を見るのを終える（監査ログに終わりを残す）→ 社員の管理へ */
  function endViewAs() {
    var ui = MP.ui;
    var v = MP.store.viewAs();
    if (!v) { MP.go('admin_employees.html'); return; }
    if (!endSave) endSave = MP.api.saver({ noViewAs: true });
    ui.run(function () {
      return endSave('auth.admin.viewAsEnd', { employeeId: v.employeeId }).then(function (res) {
        if (!res.ok && (res.code === 'NETWORK' || res.code === 'BUSY' || res.code === 'INTERNAL')) {
          ui.pageMessage('終わりを記録できたか分かりません。もう一度「終わる」を押してください', 'error');
          return;
        }
        MP.store.clearViewAs();
        MP.store.setFlash(res.ok ? v.name + 'さんの画面の表示を終えました' : '社員の画面の表示を終えました（' + res.message + '）');
        MP.go('admin_employees.html');
        return new Promise(function () {});
      });
    });
  }

  function renderTopbar(me, opts) {
    var ui = MP.ui;
    var bar = ui.$('topbar');
    if (!bar) return;
    ui.clear(bar);
    if (me.viewAs) {
      // 社員の画面を見ている間の帯（計画 stage1-viewas-plan.md 1-6）。ログアウトは出さず「終わる」だけ
      var band = ui.el('div', { class: 'topbar-inner viewas-bar', role: 'status' });
      band.appendChild(ui.el('span', { class: 'topbar-who', id: 'who', text: me.viewAs.name + 'さんの画面を見ています（見るだけ・保存はできません）' }));
      band.appendChild(ui.el('button', { type: 'button', class: 'btn', id: 'viewas-end', text: '終わる', on: { click: endViewAs } }));
      bar.appendChild(ui.el('div', { class: 'topbar-inner' }, [ui.el('a', { class: 'topbar-home', href: 'home.html', text: '名和電設ポータル' })]));
      bar.appendChild(band);
      bar.hidden = false;
      return;
    }
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
    /** 社員の画面を見ている間か（保存のボタンを止めるのに使う。本当の守りはサーバー） */
    viewing: function () { return !!MP.store.viewAs(); },
    /*
     * load: { action, args } … 画面のデータの処理。auth.me を別に聞かずに、その処理の答えに付く me を使う（問い合わせ1回）。
     *   返すもの: { me, res }（res はその処理の答え。ok のときだけ返る）
     *   答えに me が無い（古いサーバー）ときは、auth.me を聞き直す
     * load が無いとき: 今までどおり auth.me を聞き、me を返す
     */
    enter: function (opts) {
      var o = opts || {};
      var never = new Promise(function () {});
      if (!MP.store.deviceKey()) { MP.go('register.html'); return never; }
      if (!MP.store.token()) { MP.go('login.html'); return never; }
      // 社員の画面を見ている間は、管理者だけの画面を開かない（サーバーに聞く前にホームへ。計画 stage1-viewas-plan.md 1-6）
      if (o.admin && MP.store.viewAs()) {
        MP.store.setFlash('社員の画面を見ている間は、管理者の画面は開けません。上の「終わる」を押してください');
        MP.go('home.html');
        return never;
      }
      function failed(res) {
        // 見るだけでは使えない画面（管理者の画面・端末の追加など）は、ホームへ戻す
        if (res.code === 'VIEW_ONLY') { MP.store.setFlash('社員の画面を見ている間は、この画面は開けません'); MP.go('home.html'); return never; }
        MP.ui.pageMessage(res.message + '\n画面を読み込み直してください', 'error');
        return never;
      }
      function pass(me) {
        if (me.mustChangePassword && !o.allowTemp) { MP.go('password.html'); return false; }
        if (o.admin && me.role !== ROLE_ADMIN) { MP.go('home.html'); return false; }
        renderTopbar(me, o);
        MP.ui.showFlash();
        return true;
      }
      if (!o.load) {
        return MP.api.call('auth.me', {}).then(function (res) {
          if (!res.ok) return failed(res);
          return pass(res.data) ? res.data : never;
        });
      }
      return MP.api.call(o.load.action, o.load.args || {}).then(function (res) {
        // retryable … 通信の失敗・混み合いは、画面の側で「もう一度」を出せるように { me: null, res } で返す（手順10 2-4。Codex 実装1回目 medium）
        if (!res.ok && o.retryable && (res.code === 'NETWORK' || res.code === 'BUSY')) return { me: null, res: res };
        if (!res.ok) return failed(res);
        if (res.me && typeof res.me === 'object') return pass(res.me) ? { me: res.me, res: res } : never;
        return MP.api.call('auth.me', {}).then(function (r2) {
          if (!r2.ok) return failed(r2);
          return pass(r2.data) ? { me: r2.data, res: res } : never;
        });
      });
    },
  };
})();
