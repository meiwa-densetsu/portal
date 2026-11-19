/* 安否確認の一覧（safety.list・safety.answer〔代わりに入れる〕・safety.admin.start・safety.admin.end。計画 stage4-board-plan.md 第5章・11-6・11-7・12-3。Q2・Q4）
 * - 管理者: 始める（題・訓練か）・LINE のグループに貼る文（画面への住所つき。写しのボタン）・全員の一覧・終える・電話で聞いた分を代わりに入れる
 * - 部長: 自分の範囲の社員の一覧と、代わりに入れる（始める・終えるはできない）
 * - 開いている間は 1 分ごとに読み直す。並びは 助けが必要 → けが → 未回答 → 無事（サーバーが並べる）
 * - 代わりに入れたときに本人の答えとぶつかったら（saved: false）、本人の答えを見せて「上書きしますか」と聞く
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    var C = MP.config.SAFETY || { ADMIN_REFRESH_SEC: 60 };
    var save = MP.api.saver();
    var data = null, timer = null, busy = false;
    var selected = null; // 履歴から選んだ確認ID（null なら、動いている確認か最新の確認を追う）

    function timeText(ms) {
      if (typeof ms !== 'number') return '';
      var d = new Date(ms + 9 * 3600000);
      return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + d.getUTCHours() + ':' + ('0' + d.getUTCMinutes()).slice(-2);
    }

    function lineText(c) {
      var url;
      try { url = new URL('safety.html', window.location.href).href; } catch (e) { url = 'safety.html'; }
      return (c.training ? '【訓練】' : '') + '【安否確認】' + c.title + '\n名和電設ポータルを開いて、今の状態を答えてください。\n' + url + '\n（送れないときは、電話かこの LINE で知らせてください）';
    }

    function render() {
      $('admin').hidden = false;
      var admin = data.role === 'admin';
      if (data.role === 'staff') {
        ui.pageMessage('この画面は部長・管理者のものです。自分の安否は「安否確認」の画面で答えてください', 'info');
      }
      var c = data.check;
      var active = !!(c && c.active);
      $('start-box').hidden = !admin || active;
      $('check-box').hidden = !c;
      if (c) {
        $('check-title').textContent = (c.training ? '【訓練】' : '') + c.title + (active ? '（動いています）' : '（終わりました）');
        var n = data.counts;
        $('check-counts').textContent = n ? '助けが必要 ' + n['助けが必要'] + ' 人・けがあり ' + n['けがあり'] + ' 人・未回答 ' + n.unanswered + ' 人・無事 ' + n['無事'] + ' 人' : '';
        $('check-updated').textContent = '始めた ' + timeText(c.startedAt) + (c.endedAt ? '・終えた ' + timeText(c.endedAt) : '') + '・読み込んだ ' + timeText(Date.now());
        $('line-box').hidden = !admin || !active;
        if (admin && active) $('line-text').value = lineText(c);
        $('end').hidden = !admin || !active;
      }
      $('list-head').textContent = data.role === 'manager' ? '答え（自分の範囲の社員）' : '答え';
      var ul = ui.clear($('rows'));
      if (!data.rows.length) ul.appendChild(el('li', { class: 'sub', text: c ? '出す人がいません' : '安否確認はまだありません' }));
      data.rows.forEach(function (r) {
        var tag = r.status === '助けが必要' ? el('span', { class: 'tag off', text: '助けが必要' }) : r.status === 'けがあり' ? el('span', { class: 'tag warn', text: 'けがあり' })
          : r.status === '無事' ? el('span', { class: 'tag ok', text: '無事' }) : el('span', { class: 'tag', text: '未回答' });
        ul.appendChild(el('li', { 'data-emp': r.employeeId }, [
          el('div', { class: 'item-title' }, [r.name + '　', tag]),
          r.status ? el('div', { class: 'sub', text: '出社 ' + r.canWork + '・' + timeText(r.acceptedAt) + (r.proxy ? '・' + r.enteredByName + 'さんが代わりに入れた' : '') + (r.deptName ? '・' + r.deptName : '') }) : null,
          r.note ? el('div', { class: 'sub', text: '一言: ' + r.note }) : null,
          r.mail ? el('div', { class: r.mail.indexOf('分かりません') >= 0 || r.mail.indexOf('送れません') >= 0 || r.mail.indexOf('確かめられません') >= 0 ? 'msg warn' : 'sub', text: r.mail }) : null,
          r.canProxy ? el('div', { class: 'item-actions' }, [el('button', { type: 'button', class: 'btn', text: '代わりに入れる', on: { click: function () { proxy(r); } } })]) : null,
        ]));
      });
      var hb = $('history-box');
      var past = (data.checks || []).filter(function (x) { return !c || x.checkId !== c.checkId; });
      var hl0 = null;
      hb.hidden = !past.length && !selected;
      if (selected) hl0 = el('li', {}, [el('button', { type: 'button', class: 'btn', text: '今の安否確認を見る', on: { click: function () { selected = null; load(); } } })]);
      var hl = ui.clear($('history'));
      if (hl0) hl.appendChild(hl0);
      past.forEach(function (x) {
        hl.appendChild(el('li', {}, [el('button', { type: 'button', class: 'btn link-btn', text: (x.training ? '【訓練】' : '') + x.title + '（' + timeText(x.startedAt) + '）', on: { click: function () { selected = x.checkId; load(); } } })]));
      });
    }

    var seq = 0; // 最後に始めた読み込みだけが画面を変える（返事の順が入れ替わっても古い答えで戻らない）
    function load() {
      if (busy) return Promise.resolve();
      var my = ++seq;
      var args = selected ? { checkId: selected } : {};
      return MP.api.call('safety.list', args).then(function (r) {
        if (my !== seq) return;
        if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
        data = r.data;
        render();
      });
    }

    /** 代わりに入れる（電話で聞いた分）。ぶつかったら本人の答えを見せて聞く */
    function proxy(row) {
      var st = el('select', { id: 'px-status' }, data.options.statuses.map(function (s) { return el('option', { value: s, text: s }); }));
      var cw = el('select', { id: 'px-work' }, data.options.canWork.map(function (s) { return el('option', { value: s, text: s }); }));
      var nt = el('input', { type: 'text', id: 'px-note', maxlength: '200', autocomplete: 'off' });
      if (row.status) { st.value = row.status; cw.value = row.canWork; nt.value = row.note || ''; }
      var checkId = data.check.checkId; // 開いたときの確認（その間に一覧が別の確認に替わっても、この確認に入れる）
      var body = el('div', {}, [
        el('div', { class: 'field' }, [el('label', { for: 'px-status', text: '状態' }), st]),
        el('div', { class: 'field' }, [el('label', { for: 'px-work', text: '出社できるか' }), cw]),
        el('div', { class: 'field' }, [el('label', { for: 'px-note', text: '一言（なくてもよい）' }), nt]),
      ]);
      busy = true;
      ui.dialog({ title: row.name + 'さんの安否を代わりに入れる', body: body, buttons: [{ label: '入れる', value: true, kind: 'primary' }, { label: 'やめる', value: false }] }).then(function (ok) {
        if (!ok) { busy = false; return; }
        var answer = { status: st.value, canWork: cw.value, note: nt.value };
        send(row, answer, row.recordVersion, checkId);
      });
    }

    function send(row, answer, base, checkId) {
      ui.run(function () {
        return save('safety.answer', { checkId: checkId, employeeId: row.employeeId, status: answer.status, canWork: answer.canWork, note: answer.note,
          baseVersion: base, replaces: [] }).then(function (r) {
          if (!r.ok) { busy = false; ui.pageMessage(r.message, 'error'); return load(); }
          if (r.data.saved) { busy = false; ui.pageMessage(row.name + 'さんの安否を入れました', 'ok'); return load(); }
          var c = r.data.conflict;
          var who = c.proxy ? c.enteredByName + 'さんが入れた答え' : '本人の答え';
          return ui.dialog({ title: '答えがあります', text: who + '「' + (c.status || '（なし）') + '」（' + timeText(c.acceptedAt) + '）があります。上書きしますか？',
            buttons: [{ label: '上書きする', value: true, kind: 'danger' }, { label: 'やめる', value: false }] }).then(function (yes) {
            if (yes) { send(row, answer, c.recordVersion, checkId); return; }
            busy = false;
            return load();
          });
        });
      });
    }

    $('start').addEventListener('click', function () {
      ui.run(function () {
        return save('safety.admin.start', { title: $('s-title').value, training: $('s-training').checked }).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return load(); }
          ui.pageMessage('安否確認を始めました。下の文を LINE のグループに貼ってください', 'ok');
          data = null;
          selected = null;
          return load();
        });
      });
    });
    $('end').addEventListener('click', function () {
      var c = data.check;
      ui.dialog({ title: '安否確認を終える', text: '「' + c.title + '」を終えますか？（終えた後は、社員は答えられません）', buttons: [{ label: '終える', value: true, kind: 'danger' }, { label: 'やめる', value: false }] }).then(function (ok) {
        if (!ok) return;
        ui.run(function () {
          return save('safety.admin.end', { checkId: c.checkId }).then(function (r) {
            if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
            ui.pageMessage('安否確認を終えました', 'ok');
            return load();
          });
        });
      });
    });
    $('copy').addEventListener('click', function () {
      var text = $('line-text').value;
      var done = function () { ui.pageMessage('文を写しました。LINE のグループに貼ってください', 'ok'); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { $('line-text').select(); ui.pageMessage('写せませんでした。文を長押しして写してください', 'warn'); }); return; }
      } catch (e) { /* 使えないブラウザ */ }
      $('line-text').select();
      ui.pageMessage('文を長押しして写してください', 'warn');
    });

    return MP.guard.enter({ load: { action: 'safety.list' } }).then(function (entered) {
      data = entered.res.data;
      render();
      timer = window.setInterval(function () { if (!document.hidden) load(); }, (C.ADMIN_REFRESH_SEC || 60) * 1000);
    });
  });
})();
