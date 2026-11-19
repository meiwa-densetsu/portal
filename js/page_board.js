/* お知らせ（board.list・board.get・board.ack。計画 stage4-board-plan.md 第3章・11-9。Q5・Q6）
 * - 一覧から開くと本文を出す（サーバーが「読んだ」を書く。重要の印のものは「読みました」ボタン）
 * - 本文は行ごとに要素を分け、確かめを通った https の URL だけをリンクにする（MP.portal.body。値を HTML として入れない）
 * - 社員の画面を見ている間は「読みました」を出さない（サーバーも VIEW_ONLY で断る）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    var save = MP.api.saver();
    var current = null;

    function showList() {
      $('list-view').hidden = false;
      $('post-view').hidden = true;
    }

    function renderList(posts, more) {
      var ul = ui.clear($('post-list'));
      if (!posts.length) ul.appendChild(el('li', { class: 'sub', text: 'お知らせはありません' }));
      posts.forEach(function (p) {
        ul.appendChild(el('li', { 'data-post': p.postId }, [
          el('a', { class: 'item-title', href: 'board.html?id=' + encodeURIComponent(p.postId), text: p.title,
            on: { click: function (ev) { ev.preventDefault(); open(p.postId); } } }),
          el('div', { class: 'item-tags' }, [
            p.important ? el('span', { class: 'tag off', text: '重要' }) : null,
            p.read ? null : el('span', { class: 'tag warn', text: '未読' }),
            el('span', { class: 'sub', text: MP.portal.dateLabel(p.date) }),
          ]),
        ]));
      });
      if (more) ul.appendChild(el('li', { class: 'sub', text: '古いお知らせは出していません' }));
    }

    function renderPost(p) {
      current = p;
      $('list-view').hidden = true;
      $('post-view').hidden = false;
      $('post-title').textContent = p.title;
      ui.clear($('post-tags')).appendChild(el('span', { class: 'sub', text: MP.portal.dateLabel(p.date) }));
      if (p.important) $('post-tags').appendChild(el('span', { class: 'tag off', text: '重要' }));
      if (!p.visible) $('post-tags').appendChild(el('span', { class: 'tag', text: '社員には出していません' }));
      ui.clear($('post-body')).appendChild(MP.portal.body(p.body));
      var needAck = p.important && !p.read && p.visible && !MP.guard.viewing();
      $('ack').hidden = !needAck;
      $('ack-note').hidden = !needAck;
      if (p.important && p.read) $('post-tags').appendChild(el('span', { class: 'tag ok', text: '読みました' }));
      window.scrollTo(0, 0);
    }

    function open(id) {
      return ui.run(function () {
        return MP.api.call('board.get', { postId: id }).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
          ui.pageMessage('');
          try { window.history.replaceState(null, '', 'board.html?id=' + encodeURIComponent(id)); } catch (e) { /* 住所を変えられなくても続ける */ }
          renderPost(r.data.post);
        });
      });
    }

    function loadList() {
      return MP.api.call('board.list', {}).then(function (r) {
        if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
        renderList(r.data.posts, r.data.more);
      });
    }

    $('ack').addEventListener('click', function () {
      if (!current) return;
      var id = current.postId;
      ui.run(function () {
        return save('board.ack', { postId: id }).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
          current.read = true;
          renderPost(current);
          ui.pageMessage('「読みました」を記録しました', 'ok');
        });
      });
    });
    $('back-list').addEventListener('click', function () {
      try { window.history.replaceState(null, '', 'board.html'); } catch (e) { /* 住所を変えられなくても続ける */ }
      ui.pageMessage('');
      showList();
      loadList();
    });

    var id = new URLSearchParams(window.location.search).get('id');
    var openId = id && /^P\d{5}$/.test(id) ? id : null;
    return MP.guard.enter({ load: openId ? { action: 'board.get', args: { postId: openId } } : { action: 'board.list' } }).then(function (entered) {
      $('board').hidden = false;
      if (openId) { renderPost(entered.res.data.post); loadList(); }
      else renderList(entered.res.data.posts, entered.res.data.more);
    });
  });
})();
