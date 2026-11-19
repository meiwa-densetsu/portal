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
    ui.watchBroken(['page_share.js']); // このファイルから出て誰も拾わなかった例外が出たら「読み込み直す」だけにする（保険）
    var data = null;
    var receivedSeq = 0; // 見せてもらっている一覧の読み込みの番号（新しい方だけを描く）
    var broken = false; // 読み込んだ後の描画が例外で止まった（出ている期間と data の期間が食い違うかもしれない）。描画が終わるまでコードを出さない
    var issueSave = MP.api.saver(), cancelSave = MP.api.saver(), useSave = MP.api.saver();
    var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

    function load(date, first) {
      var args = { date: date };
      var p = first ? MP.guard.enter({ load: { action: 'share.mine', args: args } })
        : MP.api.call('share.mine', args).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (ui.isBroken()) return; // 「読み込み直す」だけにした後に届いた返事では、画面を描き直さない
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        data = r.res.data;
        broken = true; // 描画が最後まで終わったら外す
        // mineToo: 自分のコードの一覧も描く。res: 見せてもらっている一覧の答え（無ければ描かない）
        var show = function (res, mineToo) {
          if (ui.isBroken()) return; // 「読み込み直す」だけにした後に届いた返事では、画面を描き直さない
          try {
            if (mineToo) { ui.$('view').hidden = false; render(); }
            if (res && res.ok) renderReceived(res.data);
          } catch (e) {
            ui.showBroken(); // 描画が止まったら、画面の中身を隠して「読み込み直す」だけを出す（前の期間の表示や押せる物を残さない）
            throw e;
          }
          if (mineToo) broken = false;
        };
        // 見せてもらっている一覧の読み込みには番号を付け、後から始めた読み込みがあれば、古い返事は使わない（最初の表示の遅い返事が、期間を移って描いた一覧を上書きしない）
        var received = function (mineToo) {
          var my = ++receivedSeq;
          return MP.api.call('share.received', {}).then(function (res) {
            if (my !== receivedSeq) { if (mineToo) show(null, true); return; }
            show(res, mineToo);
          }, function (e) {
            if (my !== receivedSeq) { if (mineToo) show(null, true); return; } // 古い読み込みの失敗は、新しい方に任せる
            show(null, mineToo);
            throw e;
          });
        };
        if (first) {
          // 最初の表示: 自分のコードの一覧を先に出し、見せてもらっている一覧は返事が来てから足す（返事が遅くても、コードを出す・取り消すを待たせない。
          // ui.run の外なので、先に出した「取り消す」もすぐ押せる）
          show(null, true);
          received(false).then(null, function (e) { ui.showBroken(); throw e; });
          return;
        }
        // 期間を移るとき（ui.run の中）: 見せてもらっている一覧も読んでから、まとめて出す（先に出すと、作り直した「取り消す」が読み込みの途中に押せて、送信中のため何も起きない）
        return received(true);
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
          c.alive ? el('div', { class: 'item-actions' }, [el('button', { type: 'button', class: 'btn', text: '取り消す', on: { click: ui.drawing(function () { cancel(c); }) } })]) : null,
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

    /** 描画が止まった後は「コードを出す」を押せなくする。ui.run が戻した後に呼ぶ（描画が終わっていれば押せる形に戻す。ほかに止める所は無い） */
    function lockBroken() { ui.$('issue').disabled = broken; }

    /** ui.run の後に lockBroken を呼ぶ（動かなかったときは何もしない） */
    function runThen(fn) {
      var started = false;
      var after = function () { if (started) lockBroken(); };
      return ui.run(function () { started = true; return fn(); }).then(ui.drawing(function (v) { after(); return v; }), ui.drawing(function (e) { after(); throw e; })); // ui.run の後の決め直しも包む
    }

    function issue() {
      if (broken) return; // 描画が止まった後（出ている期間と食い違うかもしれない）
      var p = data.period;
      var args = { from: p.from, to: p.to, allowCopy: ui.$('allow-copy').checked };
      runThen(function () {
        return issueSave('share.issue', args).then(function (res) {
          if (ui.isBroken()) return; // 「読み込み直す」だけにした後に届いた返事では、描き直さない
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
      ui.confirm('コードを取り消す', '取り消すと、見ている人も見られなくなります。', '取り消す', 'danger').then(ui.drawing(function (ok) {
        if (!ok) return;
        runThen(function () {
          return cancelSave('share.cancel', { codeRef: c.codeRef }).then(function (res) {
            if (ui.isBroken()) return; // 「読み込み直す」だけにした後に届いた返事では、描き直さない
            if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
            ui.pageMessage('取り消しました', 'ok');
            return load(data.period.from);
          });
        });
      }));
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

    /** 期間を移る。ui.run は終わるとボタンを押せる形に戻すので、「次」は終わった後に決め直す（給与の目安・法律の時間外の画面と同じ） */
    function move(date) {
      var started = false;
      var again = function () { if (started && data) ui.$('next').disabled = !data.nextDate; if (started) lockBroken(); };
      ui.run(function () { started = true; return load(date); }).then(ui.drawing(again), ui.drawing(function (e) { again(); throw e; })); // ui.run の後の決め直しも包む
    }
    // 押したときの処理は、すべて ui.drawing で包む（途中で止まったら「読み込み直す」だけにする）
    ui.$('prev').addEventListener('click', ui.drawing(function () { move(data.prevDate); }));
    ui.$('next').addEventListener('click', ui.drawing(function () { if (data.nextDate) move(data.nextDate); }));
    ui.$('issue').addEventListener('click', ui.drawing(issue));
    ui.$('use-form').addEventListener('submit', ui.drawing(use));
    return load(today, true).then(null, function (e) { lockBroken(); throw e; });
  });
})();
