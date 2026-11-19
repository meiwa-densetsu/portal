/* 管理者: お知らせの管理（board.admin.list・save・setShow・delete・board.readers。計画 stage4-board-plan.md 第3章・第4章）
 * 一覧のスイッチで、社員のホームに出す・出さないを決める。重要の印・対象（全員・部署・個人）・掲載の期間。既読の一覧
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    var save = MP.api.saver();
    var data = null, editing = null, picker = null;

    function show(view) {
      $('list-view').hidden = view !== 'list';
      $('edit-view').hidden = view !== 'edit';
      $('readers-view').hidden = view !== 'readers';
      window.scrollTo(0, 0);
    }

    function render() {
      var ul = ui.clear($('post-list'));
      if (!data.posts.length) ul.appendChild(el('li', { class: 'sub', text: 'お知らせはまだありません' }));
      data.posts.forEach(function (p) {
        var period = (p.from || p.to) ? '掲載 ' + (p.from ? MP.portal.dateLabel(p.from) : '') + '〜' + (p.to ? MP.portal.dateLabel(p.to) : '') : '';
        var sw = el('input', { type: 'checkbox', checked: p.show, 'aria-label': p.title + ' をホームに出す', on: { change: function () { toggle(p, sw); } } });
        ul.appendChild(el('li', { 'data-post': p.postId }, [
          el('div', { class: 'item-title', text: p.title }),
          el('div', { class: 'item-tags' }, [
            p.important ? el('span', { class: 'tag off', text: '重要' }) : null,
            el('span', { class: 'sub', text: MP.portal.dateLabel(p.date) + '・' + MP.portal.targetText(p.target, data.choices) + (period ? '・' + period : '') }),
            el('span', { class: 'sub', text: '読んだ人 ' + p.readCount + ' / ' + p.targetCount }),
          ]),
          el('div', { class: 'item-actions' }, [
            el('label', { class: 'check' }, [sw, ' ホームに出す']),
            el('button', { type: 'button', class: 'btn', text: '直す', on: { click: function () { open(p); } } }),
            el('button', { type: 'button', class: 'btn', text: '読んだ人', on: { click: function () { readers(p); } } }),
          ]),
        ]));
      });
    }

    function load() {
      return MP.api.call('board.admin.list', {}).then(function (r) {
        if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
        data = r.data;
        render();
      });
    }

    function toggle(p, sw) {
      ui.run(function () {
        return save('board.admin.setShow', { postId: p.postId, baseVersion: p.recordVersion, show: sw.checked }).then(function (r) {
          if (!r.ok) { sw.checked = !sw.checked; ui.pageMessage(r.message, 'error'); return load(); }
          ui.pageMessage(sw.checked ? '「' + p.title + '」をホームに出しました' : '「' + p.title + '」をホームから外しました（読んだ記録は残ります）', 'ok');
          return load();
        });
      });
    }

    function open(p) {
      editing = p || null;
      $('edit-title').textContent = p ? 'お知らせを直す' : 'お知らせを書く';
      $('p-delete').hidden = !p;
      ui.clearFieldErrors($('edit-view'));
      var finish = function (body) {
        $('p-title').value = p ? p.title : '';
        $('p-body').value = body;
        $('p-important').checked = !!(p && p.important);
        $('p-from').value = p ? p.from : '';
        $('p-to').value = p ? p.to : '';
        $('p-show').checked = p ? p.show : true;
        var box = ui.clear($('p-target'));
        picker = MP.portal.targetPicker('p-target', data.choices);
        box.appendChild(picker.el);
        picker.set(p ? p.target : { type: 'all' });
        show('edit');
      };
      if (!p) return finish('');
      ui.run(function () {
        return MP.api.call('board.get', { postId: p.postId }).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
          finish(r.data.post.body);
        });
      });
    }

    function readers(p) {
      ui.run(function () {
        return MP.api.call('board.readers', { postId: p.postId }).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
          $('readers-title').textContent = '読んだ人: ' + r.data.title;
          var ul = ui.clear($('readers'));
          r.data.readers.forEach(function (x) {
            ul.appendChild(el('li', {}, [el('span', { text: x.name + '　' }), x.read ? el('span', { class: 'tag ok', text: '読んだ ' + x.at }) : el('span', { class: 'tag warn', text: 'まだ' })]));
          });
          if (!r.data.readers.length) ul.appendChild(el('li', { class: 'sub', text: '対象の人がいません' }));
          r.data.outside.forEach(function (x) { ul.appendChild(el('li', { class: 'sub', text: x.name + '（今は対象外）読んだ ' + x.at })); });
          show('readers');
        });
      });
    }

    $('add').addEventListener('click', function () { open(null); });
    $('p-cancel').addEventListener('click', function () { show('list'); });
    $('readers-back').addEventListener('click', function () { show('list'); });
    $('edit-view').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var target = picker.get();
      if (target.type !== 'all' && !target.ids.length) { ui.pageMessage('対象を 1 つ以上選んでください', 'error'); return; }
      var args = { postId: editing ? editing.postId : null, baseVersion: editing ? editing.recordVersion : 0, title: $('p-title').value, body: $('p-body').value,
        important: $('p-important').checked, target: target, show: $('p-show').checked, from: $('p-from').value, to: $('p-to').value };
      ui.run(function () {
        return save('board.admin.save', args).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
          ui.pageMessage('保存しました', 'ok');
          show('list');
          return load();
        });
      });
    });
    $('p-delete').addEventListener('click', function () {
      if (!editing) return;
      var p = editing;
      ui.dialog({ title: 'お知らせを消す', text: '「' + p.title + '」を消しますか？（社員のホームから消えます）', buttons: [{ label: '消す', value: true, kind: 'danger' }, { label: 'やめる', value: false }] }).then(function (ok) {
        if (!ok) return;
        ui.run(function () {
          return save('board.admin.delete', { postId: p.postId, baseVersion: p.recordVersion }).then(function (r) {
            if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
            ui.pageMessage('消しました', 'ok');
            show('list');
            return load();
          });
        });
      });
    });

    return MP.guard.enter({ admin: true, load: { action: 'board.admin.list' } }).then(function (entered) {
      data = entered.res.data;
      $('admin').hidden = false;
      render();
      show('list');
    });
  });
})();
