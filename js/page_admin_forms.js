/* 管理者: 受付の一覧（form.admin.list・form.admin.setShow。計画 stage4-board-plan.md 第6章）
 * 項目ごとのスイッチで、社員のホームに出す・出さないを決める（切っても回答は残る）。作る・直すは admin_form_edit.html、集計は admin_form_result.html
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    var save = MP.api.saver();
    var data = null;

    function render() {
      var add = ui.clear($('add-buttons'));
      data.kinds.forEach(function (k) {
        add.appendChild(el('a', { class: 'btn primary', href: 'admin_form_edit.html?kind=' + encodeURIComponent(k.kind), text: k.label + 'を作る' }));
      });
      var ul = ui.clear($('form-list'));
      if (!data.forms.length) ul.appendChild(el('li', { class: 'sub', text: '受付項目はまだありません' }));
      data.forms.forEach(function (f) {
        var sw = el('input', { type: 'checkbox', checked: f.show, 'aria-label': f.title + ' をホームに出す', on: { change: function () { toggle(f, sw); } } });
        ul.appendChild(el('li', { 'data-form': f.formId }, [
          el('div', { class: 'item-title', text: f.title }),
          el('div', { class: 'item-tags' }, [
            el('span', { class: 'tag', text: f.kindLabel }),
            f.open ? el('span', { class: 'tag ok', text: '受付中' }) : el('span', { class: 'tag', text: '受付の外' }),
            el('span', { class: 'sub', text: '締切 ' + f.deadlineLabel + '・' + MP.portal.targetText(f.target, data.choices) + '・回答 ' + f.answeredCount + ' / ' + f.targetCount }),
          ]),
          el('div', { class: 'item-actions' }, [
            el('label', { class: 'check' }, [sw, ' ホームに出す']),
            el('a', { class: 'btn', href: 'admin_form_edit.html?id=' + encodeURIComponent(f.formId), text: '直す' }),
            el('a', { class: 'btn', href: 'admin_form_result.html?id=' + encodeURIComponent(f.formId), text: '集計' }),
          ]),
        ]));
      });
    }

    function load() {
      return MP.api.call('form.admin.list', {}).then(function (r) {
        if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
        data = r.data;
        render();
      });
    }

    function toggle(f, sw) {
      ui.run(function () {
        return save('form.admin.setShow', { formId: f.formId, baseVersion: f.recordVersion, show: sw.checked }).then(function (r) {
          if (!r.ok) { sw.checked = !sw.checked; ui.pageMessage(r.message, 'error'); return load(); }
          ui.pageMessage(sw.checked ? '「' + f.title + '」をホームに出しました' : '「' + f.title + '」をホームから外しました（回答は残ります）', 'ok');
          return load();
        });
      });
    }

    return MP.guard.enter({ admin: true, load: { action: 'form.admin.list' } }).then(function (entered) {
      data = entered.res.data;
      $('admin').hidden = false;
      render();
    });
  });
})();
