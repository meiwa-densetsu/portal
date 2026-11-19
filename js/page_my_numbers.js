/* 本人の保険の番号（me.insuranceNumbers。計画 stage2-employee-fields-plan.md 3-2）
 * - 番号はサーバーが伏せた形（末尾 4 けた）だけを受け取り、そのまま出す（画面では伏せない・全部の番号を受け取らない）
 * - 答えは端末に覚えない（MP.store・localStorage に入れない）
 * - 管理者が「社員の画面を見る」間は、サーバーに聞かずに「出せません」と出す（サーバーも VIEW_ONLY で断る）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;

    function render(items) {
      var list = ui.clear($('number-list'));
      items.forEach(function (i) {
        list.appendChild(el('dt', { text: i.label }));
        list.appendChild(i.registered
          ? el('dd', { class: 'my-number', 'data-key': i.key, text: i.masked })
          : el('dd', { class: 'sub', 'data-key': i.key, text: 'まだ登録されていません' }));
      });
    }

    function viewingNote() {
      $('viewing-note').hidden = false;
      $('number-lead').hidden = true;
      $('numbers').hidden = false;
    }

    if (MP.guard.viewing()) {
      return MP.guard.enter({}).then(viewingNote);
    }
    return MP.guard.enter({ load: { action: 'me.insuranceNumbers' } }).then(function (entered) {
      var items = entered.res.data && Array.isArray(entered.res.data.items) ? entered.res.data.items : [];
      render(items);
      $('numbers').hidden = false;
    });
  });
})();
