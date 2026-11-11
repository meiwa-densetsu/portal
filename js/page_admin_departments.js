/* 管理者: 部署の一覧・追加・編集（master.admin.list / master.admin.saveDepartment） */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    return MP.guard.enter({ admin: true }).then(function () {
      var save = MP.api.saver();
      var depts = [];
      var editing = null; // 直している部署（新しい部署なら null）

      function show(view) {
        $('list-view').hidden = view !== 'list';
        $('edit-view').hidden = view !== 'edit';
        window.scrollTo(0, 0);
      }

      function render() {
        var list = ui.clear($('dept-list'));
        depts.forEach(function (d) {
          list.appendChild(el('li', {}, [
            el('div', { class: 'item-title' }, [d.name + ' ', d.active ? null : el('span', { class: 'tag off', text: '無効' })]),
            el('div', { class: 'sub', text: '表示順 ' + (d.order === null ? '—' : d.order) }),
            el('div', { class: 'item-actions' }, [el('button', { type: 'button', class: 'btn', text: '直す', on: { click: function () { open(d); } } })]),
          ]));
        });
        if (!depts.length) list.appendChild(el('li', { class: 'sub', text: '部署はまだありません。「部署を追加」から作ってください' }));
      }

      function load() {
        return MP.api.call('master.admin.list', {}).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
          depts = r.data.departments;
          render();
          $('list-view').hidden = !$('edit-view').hidden;
        });
      }

      function open(d) {
        editing = d;
        ui.pageMessage('');
        ui.clearFieldErrors($('edit-form'));
        $('edit-title').textContent = d ? '部署を直す' : '部署を追加';
        $('dept-name').value = d ? d.name : '';
        $('dept-order').value = d ? (d.order === null ? '' : d.order) : (depts.length ? Math.max.apply(null, depts.map(function (x) { return x.order || 0; })) + 1 : 1);
        $('dept-active').checked = d ? d.active : true;
        $('active-field').hidden = !d;
        show('edit');
      }

      $('add').addEventListener('click', function () { open(null); });
      $('cancel').addEventListener('click', function () { ui.pageMessage(''); show('list'); });

      $('edit-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        ui.pageMessage('');
        ui.clearFieldErrors($('edit-form'));
        var name = $('dept-name').value.trim();
        var order = Number($('dept-order').value);
        var bad = false;
        if (!name || name.length > 30) { ui.fieldError($('dept-name'), '部署の名前を1〜30文字で入れてください'); bad = true; }
        if (!/^\d+$/.test($('dept-order').value.trim()) || order < 1 || order > 9999) { ui.fieldError($('dept-order'), '表示順を 1〜9999 の数字で入れてください'); bad = true; }
        if (bad) return;
        var next = { name: name, order: order, active: $('dept-active').checked };
        var args = editing
          ? { deptId: editing.deptId, base: { name: editing.name, order: editing.order, active: editing.active }, next: next }
          : { deptId: null, base: null, next: next };
        ui.run(function () {
          return save('master.admin.saveDepartment', args).then(function (r) {
            if (r.ok) {
              return load().then(function () { show('list'); ui.pageMessage('保存しました', 'ok'); });
            }
            if (r.code === 'CONFLICT') {
              return ui.notice('他の人が先に変更しました', '一覧を読み込み直します。\n\n入力していた内容:\n名前: ' + next.name + '\n表示順: ' + next.order + '\n' + (next.active ? '有効' : '無効'))
                .then(load).then(function () { show('list'); });
            }
            ui.pageMessage(r.message, 'error');
          });
        });
      });

      return load();
    });
  });
})();
