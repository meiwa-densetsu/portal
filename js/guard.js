/*
 * ログインが要る画面の入口の確認と、上の帯（「〇〇でログイン中」・ログアウト）
 *
 *   MP.guard.enter({ admin, allowTemp }) → Promise<me>（auth.me の値）
 *   MP.guard.enter({ admin, allowTemp, load: { action, args } }) → Promise<{ me, res }>（res はその処理の答え。問い合わせ1回）
 *     admin     … 管理者でなければ home へ戻す
 *     allowTemp … 仮パスワードのままでも入れる（パスワードの変更の画面だけ）
 *     load      … 画面のデータの処理。その答えに付く me を使い、auth.me を別に聞かない（me が無ければ聞き直す）
 *     instant   … 控えの me（MP.store.me）が使えれば、サーバーに聞く前にその me を返す（ホームだけ。load が無いとき）。
 *                 本物の me が来たら onMe(me) を呼ぶ（計画 stage2-switch-speed-plan.md 1-2）。
 *                 load と一緒なら { me: 控え, res: null, early: true } をすぐ返し、本物の答えで onMe(me, res) を呼ぶ（計画 stage4-board-plan.md 11-5）
 *     onFail    … 失敗の文を出した直後に呼ぶ（画面を移るときは呼ばない）
 *     noLoadingNote … 待つ間の「読み込み中…」を出さない（画面が自分で一言を出すとき）
 *   控えの me が使えるときは、どの画面でも、サーバーに聞く前に上の帯を出す（見た目だけ。画面を移る判定は本物の me だけで行う）
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
    // 保存していない入力があれば、ここで知らせる（ログアウトでは離れる確認を出さずに移り、入力は送らない。計画 stage4-board-plan.md 24-14）
    var unsaved = MP.boot.hasUnsaved && MP.boot.hasUnsaved();
    // 共有のログインで送れていない安否確認の答えがあれば、ログアウトで消えることを知らせる（21-5。計画 stage4-board-plan.md 24-17）
    var lostSafety = MP.store.sharedSafetyPending ? MP.store.sharedSafetyPending() : 0;
    ui.dialog({
      title: 'ログアウト', text: 'どの端末からログアウトしますか？' + (unsaved ? '\n保存していない入力があります。ログアウトすると、その入力は消えます。' : '') +
        (lostSafety ? '\n送れていない安否確認の答えがあります。ログアウトすると、その答えは消えます。ログインし直してから、もう一度答えてください。' : ''), dismiss: null,
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
          // 通信の結果にかかわらず、この端末のログインの記憶は消す。まとめて登録の途中の記録も消す（計画 stage2-employee-fields-plan.md 10-4）
          MP.store.clearBulk();
          MP.store.clearToken();
          if (MP.boot.clearForLogout) MP.boot.clearForLogout(); // 移る前に本文を消す（離れる確認より前に。24-14）
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
          if (MP.report) MP.report.attach(res); // 文を書き換えて出したので、その失敗のボタンをつなぐ
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
    if (ui.stopped && ui.stopped()) return; // 日報の 4 画面が「読み込み直す」だけになった後は、帯を作り直さない（ボタンを戻さない）
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
      // 控えの me が使えるか（仮パスワード・見ている間の控えは MP.store.me が返さない。管理者の画面は、控えが管理者のときだけ）
      var early = MP.store.me();
      if (early && o.admin && early.role !== ROLE_ADMIN) early = null;
      var note = null; // 待つ間の「読み込み中…」
      function endNote() { if (note && note.parentNode) note.parentNode.removeChild(note); note = null; }
      if (early) {
        renderTopbar(early, o);
        var msg = MP.ui.$('msg');
        if (o.load && !o.noLoadingNote && msg && msg.parentNode) {
          note = MP.ui.el('p', { class: 'loading-note', id: 'loading-note', role: 'status', text: '読み込み中…' });
          msg.parentNode.insertBefore(note, msg.nextSibling);
        }
      }
      function failed(res) {
        endNote();
        // 見るだけでは使えない画面（管理者の画面・端末の追加など）は、ホームへ戻す
        if (res.code === 'VIEW_ONLY') { MP.store.setFlash('社員の画面を見ている間は、この画面は開けません'); MP.go('home.html'); return never; }
        // 保管済みの月（3 年より前）を住所やお気に入りから直接開いた: 読み込み直しても開けないので、ホームへ戻して一言だけ出す
        if (res.code === 'ARCHIVED') { MP.store.setFlash(res.message); MP.go('home.html'); return never; }
        MP.ui.pageMessage(res.message + '\n画面を読み込み直してください', 'error');
        if (MP.report) MP.report.attach(res); // 文を書き換えて出したので、その失敗のボタンをつなぐ
        if (o.onFail) o.onFail(res);
        return never;
      }
      // sentMark … その答えを頼んだときのログインの目印（MP.api.call の答えの res.sentMark）。今のログインと違えば控えを書かない（ほかのタブでログインし直した。計画 stage2-task-open-speed-plan.md 1-2）
      function pass(me, sentMark) {
        endNote();
        MP.store.setMe(me, sentMark); // 次に開くときの控え（仮パスワードのままなら消える。見ている間は何もしない）
        if (me.mustChangePassword && !o.allowTemp) { MP.go('password.html'); return false; }
        // 別の人でログインした端末では、前の人のまとめて登録の途中の記録を消す（見ている間は消さない。計画 stage2-employee-fields-plan.md 10-4）
        if (!me.viewAs && typeof me.employeeId === 'string' && /^E\d{4,}$/.test(me.employeeId) && MP.store.clearBulk) MP.store.clearBulk(me.employeeId);
        if (o.admin && me.role !== ROLE_ADMIN) { MP.go('home.html'); return false; }
        renderTopbar(me, o);
        MP.ui.showFlash();
        // リマインダー（計画 stage2-tasklist-v3-plan.md 3-4）: 本物の me を確かめた後に始める。見ている間・仮パスワードの間は始めない
        if (MP.remind && !me.viewAs && !me.mustChangePassword) MP.remind.start(me);
        return true;
      }
      if (!o.load) {
        var asked = MP.api.call('auth.me', {}).then(function (res) {
          if (!res.ok) return failed(res);
          return pass(res.data, res.sentMark) ? res.data : never;
        });
        if (o.instant && early) {
          // 控えですぐに始める。本物の答えは後から onMe に渡す（失敗・画面の移動は上の failed・pass と MP.api の共通の扱いのまま）
          MP.ui.showFlash();
          asked.then(function (me) { if (o.onMe) o.onMe(me); });
          return Promise.resolve(early);
        }
        return asked;
      }
      var loaded = MP.api.call(o.load.action, o.load.args || {}).then(function (res) {
        // retryable … 通信の失敗・混み合いは、画面の側で「もう一度」を出せるように { me: null, res } で返す（手順10 2-4。Codex 実装1回目 medium）
        if (!res.ok && o.retryable && (res.code === 'NETWORK' || res.code === 'BUSY')) { endNote(); return { me: null, res: res }; } // 「読み込み中…」を残さない（内部レビュー medium）
        if (!res.ok) return failed(res);
        if (res.me && typeof res.me === 'object') return pass(res.me, res.sentMark) ? { me: res.me, res: res } : never;
        return MP.api.call('auth.me', {}).then(function (r2) {
          if (!r2.ok) return failed(r2);
          return pass(r2.data, r2.sentMark) ? { me: r2.data, res: res } : never;
        });
      });
      // load と instant を一緒に指定したとき（ホームだけ。計画 stage4-board-plan.md 11-5）: 控えの me があれば { me: 控え, res: null, early: true } をすぐ返し、
      // 本物の答えが来たら onMe(me, res) を呼ぶ（失敗・画面の移動は上の failed・pass のまま）。どちらか 1 つだけを指定する画面の動きは変えない
      if (o.instant && early) {
        MP.ui.showFlash();
        loaded.then(function (v) { if (v && o.onMe) o.onMe(v.me, v.res); });
        return Promise.resolve({ me: early, res: null, early: true });
      }
      return loaded;
    },
  };
})();
