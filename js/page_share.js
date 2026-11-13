/*
 * 日報を見せる・見せてもらう（手順9。計画 docs/plans/stage1-step9-plan.md 2-6）
 *
 * 見せる: 締めの期間を選び、「写すのを許す」を選んでコードを出す（share.issue）。自分のコードの一覧と取り消し（share.mine・share.cancel）
 * 見せてもらう: コードを入れる（share.use）→ 見せてもらっている日報の一覧（share.received）→ 開く（share_view.html）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, el = ui.el;
    var data = null;
    var issueSave = MP.api.saver(), cancelSave = MP.api.saver(), useSave = MP.api.saver();
    var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

    function load(date, first) {
      var args = { date: date };
      var p = first ? MP.guard.enter({ load: { action: 'share.mine', args: args } })
        : MP.api.call('share.mine', args).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        data = r.res.data;
        ui.$('view').hidden = false;
        render();
        return MP.api.call('share.received', {}).then(function (res) {
          if (res.ok) renderReceived(res.data);
        });
      });
    }

    function render() {
      var p = data.period;
      ui.$('period-label').textContent = p.label;
      ui.$('period-note').textContent = '見せる日: ' + ui.fmtDate(p.from) + '〜' + ui.fmtDate(p.to < data.today ? p.to : data.today) + (p.to > data.today ? '（今日まで）' : '');
      ui.$('next').disabled = !data.nextDate;
      var ul = ui.clear(ui.$('mine'));
      ui.$('mine-empty').hidden = data.codes.length > 0;
      data.codes.forEach(function (c) {
        var state = c.cancelled ? '取り消し済み' : c.alive ? '使える（' + ui.fmtDateTime(c.expiresAt) + ' まで）' : '期限切れ';
        ul.appendChild(el('li', {}, [
          el('div', { class: 'item-title', text: ui.fmtDate(c.from) + '〜' + ui.fmtDate(c.to) }),
          el('div', { class: 'sub', text: state + (c.allowCopy ? '・写すのを許す' : '') }),
          el('div', { class: 'sub', text: c.viewers.length ? '見た人: ' + c.viewers.join('・') : 'まだ誰も見ていません' }),
          c.alive ? el('div', { class: 'item-actions' }, [el('button', { type: 'button', class: 'btn', text: '取り消す', on: { click: function () { cancel(c); } } })]) : null,
        ]));
      });
    }

    function renderReceived(list) {
      var ul = ui.clear(ui.$('received'));
      ui.$('received-empty').hidden = list.length > 0;
      list.forEach(function (c) {
        var href = 'share_view.html?code=' + encodeURIComponent(c.codeRef) + '&from=' + encodeURIComponent(c.from) + '&to=' + encodeURIComponent(c.to);
        ul.appendChild(el('li', {}, [
          el('div', { class: 'item-title', text: c.ownerName + 'さんの日報' }),
          el('div', { class: 'sub', text: ui.fmtDate(c.from) + '〜' + ui.fmtDate(c.to) + '・' + ui.fmtDateTime(c.expiresAt) + ' まで' + (c.allowCopy ? '・写せる' : '') }),
          el('div', { class: 'item-actions' }, [el('a', { class: 'btn primary', href: href, text: '開く' })]),
        ]));
      });
    }

    function issue() {
      var p = data.period;
      var args = { from: p.from, to: p.to, allowCopy: ui.$('allow-copy').checked };
      ui.run(function () {
        return issueSave('share.issue', args).then(function (res) {
          if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
          var box = ui.$('code-box');
          box.hidden = false;
          if (res.data.code) {
            ui.$('code-text').textContent = res.data.code.slice(0, 4) + '-' + res.data.code.slice(4);
            ui.$('code-note').textContent = ui.fmtDateTime(res.data.expiresAt) + ' まで使えます。このコードを相手に口頭か画面で伝えてください（この画面を閉じると、もう表示できません）';
          } else {
            ui.$('code-text').textContent = '—';
            ui.$('code-note').textContent = 'コードは出してありますが、もう表示できません。出し直すには、下の一覧で取り消してから新しく出してください';
          }
          return load(p.from);
        });
      });
    }

    function cancel(c) {
      ui.confirm('コードを取り消す', '取り消すと、見ている人も見られなくなります。', '取り消す', 'danger').then(function (ok) {
        if (!ok) return;
        ui.run(function () {
          return cancelSave('share.cancel', { codeRef: c.codeRef }).then(function (res) {
            if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
            ui.pageMessage('取り消しました', 'ok');
            return load(data.period.from);
          });
        });
      });
    }

    function use(ev) {
      ev.preventDefault();
      var code = ui.$('code-input').value.trim();
      if (!code) { ui.fieldError(ui.$('code-input'), 'コードを入れてください'); return; }
      ui.fieldError(ui.$('code-input'), '');
      ui.run(function () {
        return useSave('share.use', { code: code }).then(function (res) {
          if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
          var c = res.data;
          MP.go('share_view.html?code=' + encodeURIComponent(c.codeRef) + '&from=' + encodeURIComponent(c.from) + '&to=' + encodeURIComponent(c.to));
          return new Promise(function () {});
        });
      });
    }

    ui.$('prev').addEventListener('click', function () { ui.run(function () { return load(data.prevDate); }); });
    ui.$('next').addEventListener('click', function () { if (data.nextDate) ui.run(function () { return load(data.nextDate); }); });
    ui.$('issue').addEventListener('click', issue);
    ui.$('use-form').addEventListener('submit', use);
    return load(today, true);
  });
})();
