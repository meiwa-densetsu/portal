/* 管理者: 端末の一覧と取消・ロックの解除・最近の「多い」の記録・通信にかかった時間 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    return MP.guard.enter({ admin: true, load: { action: 'auth.admin.status' } }).then(function (entered) {
      $('admin').hidden = false;

      function kv(pairs) {
        var dl = el('dl', { class: 'kv' });
        pairs.forEach(function (p) { dl.appendChild(el('dt', { text: p[0] })); dl.appendChild(el('dd', { text: p[1] || '—' })); });
        return dl;
      }

      function revoke(d, mine) {
        ui.confirm('この端末を取消しますか？',
          '「' + d.name + '」は使えなくなり、この端末でのログインも切れます。' + (mine ? '\nこの端末を取消すと、今のログインも切れます。' : ''), '取消す', 'danger')
          .then(function (yes) {
            if (!yes) return;
            ui.run(function () {
              return MP.api.call('auth.admin.revokeDevice', { deviceRef: d.deviceRef }).then(function (r) {
                if (!r.ok) ui.pageMessage(r.code === 'NETWORK' ? '取消できたか分かりません。一覧を確かめて、残っていたらもう一度押してください' : r.message, 'error');
                return load();
              });
            });
          });
      }

      function unlock(k) {
        ui.confirm('ロックを解除しますか？', '「' + k.label + '」のロックを解除します。', '解除する').then(function (yes) {
          if (!yes) return;
          ui.run(function () {
            return MP.api.call('auth.admin.unlock', { kind: k.kind, target: k.target }).then(function (r) {
              if (!r.ok) ui.pageMessage(r.message, 'error');
              return load();
            });
          });
        });
      }

      function render(s) {
        $('count').textContent = '登録中の端末: ' + s.activeDevices + ' 台（上限 ' + s.deviceLimit + ' 台）';
        $('near-limit').hidden = !s.nearLimit;

        var list = ui.clear($('device-list'));
        s.devices.forEach(function (d) {
          var mine = d.deviceRef === s.currentDeviceRef;
          var li = el('li', {}, [
            el('div', { class: 'item-title' }, [d.name + ' ', mine ? el('span', { class: 'tag ok', text: 'この端末' }) : null,
              d.revokedAt ? el('span', { class: 'tag off', text: '取消済み' }) : null]),
            kv([['登録', ui.fmtDateTime(d.registeredAt) + '（' + (d.registeredBy || '—') + '・' + d.method + '）'],
              ['最後に使った人', d.lastUser], ['最終利用', ui.fmtDateTime(d.lastUsedAt)]]),
          ]);
          if (!d.revokedAt) {
            li.appendChild(el('div', { class: 'item-actions' }, [
              el('button', { type: 'button', class: 'btn danger', text: '取消', on: { click: function () { revoke(d, mine); } } })]));
          }
          list.appendChild(li);
        });
        if (!s.devices.length) list.appendChild(el('li', { class: 'sub', text: '端末はありません' }));

        var locks = ui.clear($('lock-list'));
        s.locks.forEach(function (k) {
          var kind = k.kind === 'employee' ? '社員' : k.kind === 'device' ? '端末' : '処理';
          locks.appendChild(el('li', {}, [
            kind + '「' + k.label + '」 ' + ui.fmtDateTime(k.until) + ' まで',
            el('div', { class: 'item-actions' }, [el('button', { type: 'button', class: 'btn', text: '解除', on: { click: function () { unlock(k); } } })]),
          ]));
        });
        if (!s.locks.length) locks.appendChild(el('li', { class: 'sub', text: '今ロック中のものはありません' }));

        var alerts = ui.clear($('alert-list'));
        s.alerts.forEach(function (a) { alerts.appendChild(el('li', { text: ui.fmtDateTime(a.at) + ' ' + a.content })); });
        if (!s.alerts.length) alerts.appendChild(el('li', { class: 'sub', text: '最近7日の記録はありません' }));
      }

      function renderTimings() {
        var list = ui.clear($('timing-list'));
        var rows = MP.store.timings().slice().reverse();
        rows.forEach(function (t) {
          var d = new Date(t.at);
          var at = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
          list.appendChild(el('li', { text: at + '  ' + t.action + '  ' + (t.ms / 1000).toFixed(1) + '秒' }));
        });
        if (!rows.length) list.appendChild(el('li', { class: 'sub', text: '記録はありません' }));
      }

      function apply(r) {
        if (!r.ok) ui.pageMessage(r.message, 'error'); else render(r.data);
        renderTimings();
      }

      function load() {
        return MP.api.call('auth.admin.status', {}).then(apply);
      }

      $('refresh').addEventListener('click', function () { ui.run(load); });
      apply(entered.res); // 開いたときは、入口の問い合わせの答えをそのまま使う（問い合わせ1回）
    });
  });
})();
