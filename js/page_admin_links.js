/* 管理者: リンク集の管理（links.admin.list・links.admin.save。計画 stage4-board-plan.md 第3章・11-9）
 * URL は https:// で始まる決まった形だけ（画面でも MP.portal.urlOk で確かめる。本当の確かめはサーバー）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    var save = MP.api.saver();
    var links = [], editing = null;

    function render() {
      var ul = ui.clear($('link-list'));
      if (!links.length) ul.appendChild(el('li', { class: 'sub', text: 'リンクはまだありません' }));
      links.forEach(function (l) {
        ul.appendChild(el('li', { 'data-link': l.linkId }, [
          el('div', { class: 'item-title' }, [MP.portal.link(l.name, l.url), l.show ? null : el('span', { class: 'tag', text: '出していない' })]),
          el('div', { class: 'sub', text: l.url }),
          el('div', { class: 'item-actions' }, [el('button', { type: 'button', class: 'btn', text: '直す', on: { click: function () { open(l); } } })]),
        ]));
      });
    }

    function load() {
      return MP.api.call('links.admin.list', {}).then(function (r) {
        if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
        links = r.data.links;
        render();
      });
    }

    function open(l) {
      editing = l || null;
      $('edit-title').textContent = l ? 'リンクを直す' : 'リンクを足す';
      $('l-name').value = l ? l.name : '';
      $('l-url').value = l ? l.url : 'https://';
      $('l-order').value = l ? String(l.order) : String(links.length + 1);
      $('l-show').checked = l ? l.show : true;
      $('l-delete').hidden = !l;
      ui.clearFieldErrors($('edit-view'));
      $('edit-view').hidden = false;
      $('l-name').focus();
    }

    function close() { $('edit-view').hidden = true; editing = null; }

    function after(r, text) {
      if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
      ui.pageMessage(text, 'ok');
      close();
      return load();
    }

    $('add').addEventListener('click', function () { open(null); });
    $('l-cancel').addEventListener('click', close);
    $('edit-view').addEventListener('submit', function (ev) {
      ev.preventDefault();
      ui.clearFieldErrors($('edit-view'));
      var url = $('l-url').value.trim();
      if (!MP.portal.urlOk(url)) { ui.fieldError($('l-url'), 'https:// で始まる住所を入れてください（空白・引用符・< > は使えません）'); return; }
      var order = /^\d{1,4}$/.test($('l-order').value.trim()) ? Number($('l-order').value.trim()) : NaN;
      if (isNaN(order)) { ui.fieldError($('l-order'), '0〜9999 の数を入れてください'); return; }
      var args = { linkId: editing ? editing.linkId : null, baseVersion: editing ? editing.recordVersion : 0, name: $('l-name').value, url: url, order: order, show: $('l-show').checked };
      ui.run(function () { return save('links.admin.save', args).then(function (r) { return after(r, '保存しました'); }); });
    });
    $('l-delete').addEventListener('click', function () {
      if (!editing) return;
      var l = editing;
      ui.dialog({ title: 'リンクを消す', text: '「' + l.name + '」を消しますか？', buttons: [{ label: '消す', value: true, kind: 'danger' }, { label: 'やめる', value: false }] }).then(function (ok) {
        if (!ok) return;
        ui.run(function () { return save('links.admin.save', { linkId: l.linkId, baseVersion: l.recordVersion, deleted: true }).then(function (r) { return after(r, '消しました'); }); });
      });
    });

    return MP.guard.enter({ admin: true, load: { action: 'links.admin.list' } }).then(function (entered) {
      links = entered.res.data.links;
      $('admin').hidden = false;
      render();
    });
  });
})();
