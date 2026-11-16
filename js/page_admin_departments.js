/* 管理者: 部署の一覧・追加・編集（master.admin.list / master.admin.saveDepartment）。
   休憩方式・会社カレンダーも部署で決める（計画 stage1-break-types-plan.md 6-2）。選択肢・説明・カレンダーはサーバーの答えから */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    return MP.guard.enter({ admin: true, load: { action: 'master.admin.list' } }).then(function (entered) {
      var save = MP.api.saver();
      var depts = [];
      var calendars = [];
      var options = { breakTypes: [], breakTypeNotes: {} };
      var hasRules = false; // サーバーが部署の休憩方式・カレンダーを返すか（1 つ前のサーバーは返さない。そのときは 2 項目を出さない・送らない）
      var editing = null; // 直している部署（新しい部署なら null）

      function show(view) {
        $('list-view').hidden = view !== 'list';
        $('edit-view').hidden = view !== 'edit';
        window.scrollTo(0, 0);
      }

      function calName(id) {
        var c = calendars.filter(function (x) { return x.calendarId === id; })[0];
        return c ? c.name + (c.active ? '' : '（使っていない）') : id;
      }

      /** 一覧に出す「現場作業員・通信班」の文と、未設定か */
      function rulesText(d) {
        var unset = !d.breakType || !d.calendarId;
        return { text: (d.breakType || '休憩方式は未設定') + '・' + (d.calendarId ? calName(d.calendarId) : '会社カレンダーは未設定'), unset: unset };
      }

      function render() {
        var list = ui.clear($('dept-list'));
        depts.forEach(function (d) {
          var r = hasRules ? rulesText(d) : null;
          list.appendChild(el('li', {}, [
            el('div', { class: 'item-title' }, [d.name + ' ', d.active ? null : el('span', { class: 'tag off', text: '無効' }),
              r && r.unset ? el('span', { class: 'tag warn', text: '未設定' }) : null]),
            r ? el('div', { class: 'sub dept-rules', text: r.text }) : null,
            el('div', { class: 'sub', text: '表示順 ' + (d.order === null ? '—' : d.order) }),
            el('div', { class: 'item-actions' }, [el('button', { type: 'button', class: 'btn', text: '直す', on: { click: function () { open(d); } } })]),
          ]));
        });
        if (!depts.length) list.appendChild(el('li', { class: 'sub', text: '部署はまだありません。「部署を追加」から作ってください' }));
      }

      function apply(r) {
        if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
        depts = r.data.departments;
        calendars = r.data.calendars || [];
        var o = r.data.options || {};
        options = { breakTypes: o.breakTypes || [], breakTypeNotes: o.breakTypeNotes || {} };
        hasRules = !!o.breakTypeNotes && depts.every(function (d) { return Object.prototype.hasOwnProperty.call(d, 'breakType'); });
        render();
        $('list-view').hidden = !$('edit-view').hidden;
      }

      function load() {
        return MP.api.call('master.admin.list', {}).then(apply);
      }

      /** 休憩方式・会社カレンダーの選ぶ所（d … 直す部署。新しい部署なら null） */
      function fillRules(d) {
        $('rules-fields').hidden = !hasRules;
        if (!hasRules) return;
        var brk = ui.clear($('dept-break'));
        brk.appendChild(el('option', { value: '', text: '選んでください' }));
        options.breakTypes.forEach(function (t) { brk.appendChild(el('option', { value: t, text: t })); });
        brk.value = d && options.breakTypes.indexOf(d.breakType) >= 0 ? d.breakType : '';
        var notes = ui.clear($('dept-break-notes'));
        options.breakTypes.forEach(function (t) {
          if (options.breakTypeNotes[t]) notes.appendChild(el('p', { class: 'hint', text: t + ': ' + options.breakTypeNotes[t] }));
        });
        // カレンダー: 使っているものと、今付いているもの（使わなくしたものでも、前と同じなら選べる）
        var keep = d ? d.calendarId : '';
        var cal = ui.clear($('dept-cal'));
        cal.appendChild(el('option', { value: '', text: '未設定' }));
        calendars.filter(function (c) { return c.active || c.calendarId === keep; }).forEach(function (c) {
          cal.appendChild(el('option', { value: c.calendarId, text: c.name + (c.active ? '' : '（使っていない）') }));
        });
        cal.value = keep || '';
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
        fillRules(d);
        show('edit');
      }

      /** もう値が入っている部署の休憩方式かカレンダーを変えるときは、今までの日報にも効くことを確かめる */
      function confirmRules(next) {
        var d = editing;
        var changed = !!d && ((d.breakType && next.breakType !== d.breakType) || (d.calendarId && next.calendarId !== d.calendarId));
        if (!changed) return Promise.resolve(true);
        return ui.confirm('休憩方式・会社カレンダーを変えますか？',
          'この部署にいた期間の、今までの日報にも効きます。休憩方式を変えると「計算し直しが要る」の印が付き、会社カレンダーを変えると所定がすぐに変わります。' +
          '途中の日から変えたいときは、新しい部署を作って、社員の「いつから」で移してください', '変える');
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
        if (hasRules && !$('dept-break').value) { ui.fieldError($('dept-break'), '休憩方式を選んでください'); bad = true; }
        if (bad) return;
        var next = { name: name, order: order, active: $('dept-active').checked };
        var base = editing ? { name: editing.name, order: editing.order, active: editing.active } : null;
        if (hasRules) {
          next.breakType = $('dept-break').value;
          next.calendarId = $('dept-cal').value;
          if (base) { base.breakType = editing.breakType; base.calendarId = editing.calendarId; }
        }
        var args = editing ? { deptId: editing.deptId, base: base, next: next } : { deptId: null, base: null, next: next };
        confirmRules(next).then(function (yes) {
          if (!yes) return;
          ui.run(function () {
            return save('master.admin.saveDepartment', args).then(function (r) {
              if (r.ok) {
                return load().then(function () { show('list'); ui.pageMessage('保存しました', 'ok'); });
              }
              if (r.code === 'CONFLICT') {
                var lines = ['名前: ' + next.name, '表示順: ' + next.order, next.active ? '有効' : '無効'];
                if (hasRules) lines.push('休憩方式: ' + next.breakType, '会社カレンダー: ' + (next.calendarId ? calName(next.calendarId) : '未設定'));
                return ui.notice('他の人が先に変更しました', '一覧を読み込み直します。\n\n入力していた内容:\n' + lines.join('\n'))
                  .then(load).then(function () { show('list'); });
              }
              ui.pageMessage(r.message, 'error');
            });
          });
        });
      });

      apply(entered.res); // 開いたときは、入口の問い合わせの答えをそのまま使う（問い合わせ1回）
    });
  });
})();
