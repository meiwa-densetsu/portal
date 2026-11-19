/* 管理者: 受付項目を作る・直す（form.admin.save。計画 stage4-board-plan.md 第6章・11-8）
 * - 種類は作るときに決め、後から変えられない
 * - 選択肢（品目・サイズ・病院）は、保存したものは消さずに「出さない」にする（回答が残る。サーバーも消すのを断る）。まだ保存していないものは消せる
 * - 締切は日付で入れる（その日の 23:59 まで受け付ける。サーバーは次の日の 0:00 を締切として保存する）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    var CF = window.CalcForm;
    var save = MP.api.saver();
    var q = new URLSearchParams(window.location.search);
    var id = q.get('id');
    var kind = q.get('kind');
    var form = null, picker = null, settingsUi = null, choices = null;
    if (id && !/^F\d{4}$/.test(id)) id = null;

    /** 選択肢の行の一覧（name・hidden）。保存済みの行には「消す」を出さない */
    function optionList(label, list, onAddExtra) {
      var wrap = el('div', { class: 'subbox' }, [el('h3', { text: label })]);
      var rowsBox = el('div');
      wrap.appendChild(rowsBox);
      var rows = [];
      function addRow(o) {
        var name = el('input', { type: 'text', maxlength: '100', autocomplete: 'off', value: o ? o.name : '', 'aria-label': label + 'の名前' });
        var hide = el('input', { type: 'checkbox', checked: !!(o && o.hidden) });
        var row = { id: o ? o.id : null, name: name, hide: hide, extra: null };
        var line = el('div', { class: 'option-row' }, [name, el('label', { class: 'check' }, [hide, ' 出さない'])]);
        var holder = el('div', {}, [line]);
        if (!row.id) {
          line.appendChild(el('button', { type: 'button', class: 'btn', text: '消す', on: { click: function () {
            rows.splice(rows.indexOf(row), 1); rowsBox.removeChild(holder);
          } } }));
        }
        if (onAddExtra) row.extra = onAddExtra(holder, o);
        rows.push(row);
        rowsBox.appendChild(holder);
      }
      (list || []).forEach(addRow);
      wrap.appendChild(el('button', { type: 'button', class: 'btn', text: label + 'を足す', on: { click: function () { addRow(null); } } }));
      if (!list || !list.length) addRow(null);
      return { el: wrap, read: function () {
        return rows.map(function (r) {
          var o = { name: r.name.value, hidden: r.hide.checked };
          if (r.id) o.id = r.id;
          if (r.extra) o.sizes = r.extra.read();
          return o;
        });
      } };
    }

    function buildSettings(k, s) {
      var box = ui.clear($('f-settings'));
      if (k === 'attend') {
        var when = el('input', { type: 'text', id: 's-when', maxlength: '100', autocomplete: 'off', value: s.when || '' });
        var place = el('input', { type: 'text', id: 's-place', maxlength: '100', autocomplete: 'off', value: s.place || '' });
        var guests = el('input', { type: 'checkbox', id: 's-guests', checked: !!s.guests });
        box.appendChild(el('div', { class: 'field' }, [el('label', { for: 's-when', text: '日時（例 12/20 18:00〜）' }), when]));
        box.appendChild(el('div', { class: 'field' }, [el('label', { for: 's-place', text: '場所' }), place]));
        box.appendChild(el('label', { class: 'check', for: 's-guests' }, [guests, ' 同伴の人数の欄を出す']));
        return { read: function () { return { when: when.value, place: place.value, guests: guests.checked }; } };
      }
      if (k === 'order') {
        var items = optionList('品目', s.items, function (holder, o) {
          var sizes = optionList('サイズ', o ? o.sizes : null);
          holder.appendChild(sizes.el);
          return sizes;
        });
        box.appendChild(el('p', { class: 'hint', text: '金額は扱いません。1 品目の数量の上限は決まりの設定のとおりです' }));
        box.appendChild(items.el);
        return { read: function () { return { items: items.read() }; } };
      }
      var year = el('input', { type: 'text', id: 's-year', inputmode: 'numeric', maxlength: '4', autocomplete: 'off', value: String(s.year || defaultYear()) });
      box.appendChild(el('div', { class: 'field' }, [el('label', { for: 's-year', text: '対象の年度（例 2026 = 2026/4/1〜2027/3/31）' }), year,
        el('p', { class: 'hint', text: '区分（40 歳以上は特定健診）は、この年度の終わり（3/31）の年齢で決まります' })]));
      var hs = optionList('病院', s.hospitals);
      box.appendChild(hs.el);
      return { read: function () { return { year: Number(year.value), hospitals: hs.read() }; } };
    }

    function defaultYear() {
      var d = new Date(Date.now() + 9 * 3600000);
      return d.getUTCMonth() + 1 >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    }

    /** 締切のミリ秒 → { date, time }（0:00 なら前の日で時刻は空 = 日付だけで入れた締切） */
    function deadlineParts(ms) {
      if (CF.timeText(ms) === '00:00') return { date: CF.dateText(ms - CF.DAY_MS), time: '' };
      return { date: CF.dateText(ms), time: CF.timeText(ms) };
    }
    /** 受付の初めのミリ秒 → { date, time }（0:00 なら時刻は空） */
    function startParts(ms) {
      return { date: CF.dateText(ms), time: CF.timeText(ms) === '00:00' ? '' : CF.timeText(ms) };
    }
    /** 日付と時刻（空・H:mm・HH:mm）→ サーバーに送る文字（'yyyy-MM-dd' か 'yyyy-MM-ddTHH:mm'）。時刻の形が違えば null */
    function joinDateTime(date, time) {
      var t = String(time || '').trim();
      if (!t) return date;
      var m = /^(\d{1,2}):(\d{2})$/.exec(t);
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
      return date + 'T' + ('0' + m[1]).slice(-2) + ':' + m[2];
    }

    function render() {
      $('admin').hidden = false;
      var k = form ? form.kind : kind;
      var label = CF.KIND_LABEL[k] || '';
      $('edit-title').textContent = form ? '受付項目を直す' : label + 'を作る';
      $('f-kind').textContent = '種類: ' + label + (form ? '（種類は変えられません）' : '');
      $('f-title').value = form ? form.title : (k === 'attend' ? '飲み会の出欠' : k === 'order' ? '制服の注文' : '健康診断の日程');
      $('f-desc').value = form ? form.desc : '';
      settingsUi = buildSettings(k, form ? form.settings : {});
      var sp = form && form.start ? startParts(form.start) : { date: '', time: '' };
      var dp = form ? deadlineParts(form.deadline) : { date: '', time: '' };
      $('f-start').value = sp.date; $('f-start-time').value = sp.time; // 保存してある時刻を、題名だけ直したときも変えない
      $('f-deadline').value = dp.date; $('f-deadline-time').value = dp.time;
      $('f-show').checked = form ? form.show : true;
      var box = ui.clear($('f-target'));
      picker = MP.portal.targetPicker('f-target', choices);
      box.appendChild(picker.el);
      picker.set(form ? form.target : { type: 'all' });
    }

    $('edit-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var k = form ? form.kind : kind;
      var target = picker.get();
      if (target.type !== 'all' && !target.ids.length) { ui.pageMessage('対象を 1 つ以上選んでください', 'error'); return; }
      if (!CF.isDate($('f-deadline').value)) { ui.pageMessage('締切の日を入れてください', 'error'); return; }
      var deadline = joinDateTime($('f-deadline').value, $('f-deadline-time').value);
      var start = $('f-start').value ? joinDateTime($('f-start').value, $('f-start-time').value) : '';
      if (deadline === null || start === null) { ui.pageMessage('時刻は 17:00 のように入れてください', 'error'); return; }
      var args = { formId: form ? form.formId : null, baseVersion: form ? form.recordVersion : 0, kind: k, title: $('f-title').value, desc: $('f-desc').value,
        settings: settingsUi.read(), start: start, deadline: deadline, target: target, show: $('f-show').checked };
      ui.run(function () {
        return save('form.admin.save', args).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
          MP.store.setFlash('受付項目を保存しました');
          MP.go('admin_forms.html');
          return new Promise(function () {});
        });
      });
    });

    return MP.guard.enter({ admin: true, load: { action: 'form.admin.list' } }).then(function (entered) {
      choices = entered.res.data.choices;
      if (id) {
        form = entered.res.data.forms.filter(function (f) { return f.formId === id; })[0] || null;
        if (!form) { ui.pageMessage('その受付は見つかりません', 'error'); return; }
      } else if (CF.KINDS.indexOf(kind) < 0) {
        ui.pageMessage('作る受付の種類が分かりません。受付の管理から開き直してください', 'error');
        return;
      }
      render();
    });
  });
})();
