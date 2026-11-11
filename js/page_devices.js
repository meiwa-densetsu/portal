/* 端末の追加コードの発行・取消・一覧と、「ホーム画面で使う」 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    return MP.guard.enter({ load: { action: 'auth.myDeviceCodes' } }).then(function (entered) {
      var me = entered.me;
      $('devices').hidden = false;
      var input = $('new-name');
      var homeSteps = false;
      $('home-screen').hidden = !ui.iosNotStandalone();

      function showCode(d) {
        var c = String(d.code);
        $('code-value').textContent = c.slice(0, 4) + '-' + c.slice(4);
        $('code-info').textContent = '「' + d.deviceName + '」用・' + ui.fmtTime(d.expiresAt) + ' まで（10分）・1回だけ使えます';
        $('app-url').textContent = window.location.href.replace(/[^/]*$/, '');
        $('steps-normal').hidden = homeSteps;
        $('steps-home').hidden = !homeSteps;
        $('code-cancel').onclick = function () { cancel(d.codeRef); };
        $('code-panel').hidden = false;
        $('code-panel').scrollIntoView({ block: 'nearest' });
      }

      function issue(deviceName) {
        ui.pageMessage('');
        return ui.run(function () {
          return MP.api.call('auth.issueDeviceCode', { deviceName: deviceName }).then(function (r) {
            if (r.ok) { showCode(r.data); return load(); }
            if (r.code === 'NETWORK') ui.pageMessage('コードを出せたか分かりません。もう一度押してください。前に出たものは使わないでください', 'error');
            else if (r.code === 'BAD_REQUEST') ui.fieldError(input, r.message);
            else ui.pageMessage(r.message, 'error');
          });
        });
      }

      function cancel(codeRef) {
        ui.confirm('このコードを取り消しますか？', '取り消したコードは使えなくなります。', '取り消す', 'danger').then(function (yes) {
          if (!yes) return;
          ui.run(function () {
            return MP.api.call('auth.cancelDeviceCode', { codeRef: codeRef }).then(function (r) {
              if (!r.ok) ui.pageMessage(r.message, 'error');
              else $('code-panel').hidden = true;
              return load();
            });
          });
        });
      }

      function line(x) {
        var name = '「' + x.deviceName + '」';
        if (x.status === 'used') return el('li', {}, [ui.fmtDateTime(x.usedAt) + ' に' + name + 'が登録されました ', el('span', { class: 'tag ok', text: '登録済み' })]);
        if (x.status === 'canceled') return el('li', {}, [name + ' ', el('span', { class: 'tag', text: '取消' })]);
        if (x.status === 'expired') return el('li', {}, [name + ' ', el('span', { class: 'tag', text: '期限切れ' })]);
        return el('li', {}, [
          name + ' ', el('span', { class: 'tag warn', text: '未使用（' + ui.fmtTime(x.expiresAt) + ' まで）' }),
          el('div', { class: 'item-actions' }, [el('button', { type: 'button', class: 'btn danger', text: '取り消す', on: { click: function () { cancel(x.codeRef); } } })]),
        ]);
      }

      function apply(r) {
        var list = ui.clear($('code-list'));
        if (!r.ok) { list.appendChild(el('li', { text: '一覧を読み込めませんでした。「更新」を押してください' })); return; }
        if (!r.data.length) { list.appendChild(el('li', { class: 'sub', text: '最近7日に出したコードはありません' })); return; }
        r.data.forEach(function (x) { list.appendChild(line(x)); });
      }

      function load() {
        return MP.api.call('auth.myDeviceCodes', {}).then(apply);
      }

      $('issue-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        var name = input.value.trim();
        if (!name || name.length > 40) { ui.fieldError(input, '新しい端末の名前を1〜40文字で入れてください'); return; }
        ui.fieldError(input, '');
        homeSteps = false;
        issue(name);
      });

      $('home-issue').addEventListener('click', function () {
        homeSteps = true;
        var base = MP.store.deviceName() || me.deviceName || 'iPhone';
        issue((base.slice(0, 40 - 7) + '・ホーム画面'));
      });

      $('refresh').addEventListener('click', function () { ui.run(load); });
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') load(); });
      apply(entered.res); // 開いたときは、入口の問い合わせの答えをそのまま使う（問い合わせ1回）
    });
  });
})();
