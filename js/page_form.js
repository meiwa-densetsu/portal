/* 受付に答える（form.get・form.answer。計画 stage4-board-plan.md 第6章・11-4・11-7・11-8・12-4。Q7〜Q10）
 * - 種類ごとに欄を出す: 飲み会の出欠（出席・欠席・未定・一言・同伴の人数）／制服の注文（品目ごとのサイズと数量）／健康診断（病院・区分・第 1〜第 3 希望）
 * - 健康診断の区分は、サーバーが返した「選べる区分」だけを出す（生年月日・年齢は受け取らない）
 * - 締切の後・確定日の後・社員の画面を見ている間は、読むだけ（サーバーも断る）
 * - 管理者が集計の画面から開いたとき（?emp=社員ID）は、その人の回答を直す（form.admin.answer。締切の後も直せる）
 * - 回答の形の確かめは shared/calc_form.js（サーバーと同じもの）で、送る前にも行う
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    var CF = window.CalcForm;
    var save = MP.api.saver();
    var q = new URLSearchParams(window.location.search);
    var formId = q.get('id');
    var emp = q.get('emp');
    if (!formId || !/^F\d{4}$/.test(formId)) formId = null;
    if (emp && !/^E\d{4}$/.test(emp)) emp = null;
    var data = null;
    var fields = null; // { read(): 回答 }

    function rules() { return data.rules; }

    function pickRow(id, options, value) {
      var row = el('div', { class: 'choice-row', id: id, role: 'group' });
      options.forEach(function (o) {
        row.appendChild(el('button', { type: 'button', class: 'btn', 'data-value': o, 'aria-pressed': o === value ? 'true' : 'false', text: o,
          on: { click: function () {
            Array.prototype.slice.call(row.children).forEach(function (b) { b.setAttribute('aria-pressed', b === this ? 'true' : 'false'); }, this);
          } } }));
      });
      return { el: row, get: function () { var b = row.querySelector('[aria-pressed="true"]'); return b ? b.getAttribute('data-value') : ''; } };
    }

    function numSelect(id, max, value, zeroText) {
      var s = el('select', { id: id });
      for (var i = 0; i <= max; i++) s.appendChild(el('option', { value: String(i), text: i === 0 && zeroText ? zeroText : String(i) }));
      s.value = String(value || 0);
      return s;
    }

    function field(label, input, hint) {
      return el('div', { class: 'field' }, [el('label', { for: input.id, text: label }), input, hint ? el('p', { class: 'hint', text: hint }) : null]);
    }

    function noteInput(value) {
      return el('input', { type: 'text', id: 'a-note', maxlength: '300', autocomplete: 'off', value: value || '' });
    }

    function buildAttend(f, a) {
      var box = ui.clear($('answer-fields'));
      var st = pickRow('a-status', CF.ATTEND, a ? a.status : '');
      box.appendChild(el('div', { class: 'field' }, [el('p', { class: 'item-title', text: '出欠' }), st.el]));
      var guests = null;
      if (f.settings.guests) {
        guests = numSelect('a-guests', rules().guestMax, a ? a.guests : 0, 'なし');
        box.appendChild(field('同伴の人数（出席のときだけ数えます）', guests));
      }
      var note = noteInput(a && a.note);
      box.appendChild(field('一言（なくてもよい）', note, rules().noteMax + ' 字まで'));
      return { read: function () {
        var o = { status: st.get(), note: note.value };
        if (guests && Number(guests.value) > 0) o.guests = Number(guests.value);
        return o;
      } };
    }

    function buildOrder(f, a) {
      var box = ui.clear($('answer-fields'));
      var lines = a && Array.isArray(a.lines) ? a.lines : [];
      var rows = [];
      box.appendChild(el('p', { class: 'hint', text: '品目ごとに、サイズと数量を選んでください（1 品目 ' + rules().qtyMax + ' つまで。要らない品目は 0）' }));
      (f.settings.items || []).forEach(function (it, i) {
        var mine = lines.filter(function (l) { return l.item === it.id; })[0];
        var size = el('select', { id: 'a-size-' + i });
        it.sizes.forEach(function (z) { size.appendChild(el('option', { value: z.id, text: z.name })); });
        if (mine) size.value = mine.size;
        var qty = numSelect('a-qty-' + i, rules().qtyMax, mine ? mine.qty : 0);
        box.appendChild(el('div', { class: 'subbox' }, [
          el('h3', { text: it.name }),
          el('div', { class: 'order-line' }, [field('サイズ', size), el('div'), field('数量', qty)]),
        ]));
        rows.push({ item: it.id, size: size, qty: qty });
      });
      return { read: function () {
        return { lines: rows.filter(function (r) { return Number(r.qty.value) > 0; }).map(function (r) { return { item: r.item, size: r.size.value, qty: Number(r.qty.value) }; }) };
      } };
    }

    function buildHealth(f, a) {
      var box = ui.clear($('answer-fields'));
      var c = data.choices || {};
      if (c.noBirth) {
        box.appendChild(el('p', { class: 'msg warn', text: '生年月日が登録されていないため、健診の区分を選べません。管理者に伝えてください' }));
        return null;
      }
      var hos = el('select', { id: 'a-hospital' }, [el('option', { value: '', text: '選んでください' })]);
      (f.settings.hospitals || []).forEach(function (h) { hos.appendChild(el('option', { value: h.id, text: h.name })); });
      if (a) hos.value = a.hospital;
      box.appendChild(field('病院', hos));
      var cat = el('select', { id: 'a-category' }, [el('option', { value: '', text: '選んでください' })]);
      (c.categories || []).forEach(function (k) { cat.appendChild(el('option', { value: k, text: k })); });
      if (a && (c.categories || []).indexOf(a.category) >= 0) cat.value = a.category;
      box.appendChild(field('区分', cat, '選べる区分は、年度の終わりの年齢で決まっています'));
      var wishes = [];
      for (var i = 0; i < rules().wishMax; i++) {
        var w = el('input', { type: 'date', id: 'a-wish-' + i, value: a && a.wishes && a.wishes[i] ? a.wishes[i] : '' });
        box.appendChild(field('第 ' + (i + 1) + ' 希望' + (i === 0 ? '' : '（なくてもよい）'), w));
        wishes.push(w);
      }
      var note = noteInput(a && a.note);
      box.appendChild(field('一言（なくてもよい）', note, rules().noteMax + ' 字まで'));
      return { read: function () {
        return { hospital: hos.value, category: cat.value, wishes: wishes.map(function (x) { return x.value; }).filter(function (v) { return v; }), note: note.value };
      } };
    }

    function render() {
      var f = data.form;
      $('form').hidden = false;
      $('form-title').textContent = f.title;
      $('form-kind').textContent = f.kindLabel + (data.employee ? '・' + data.employee.name + 'さんの回答を直す（管理者）' : '');
      ui.clear($('form-desc')).appendChild(MP.portal.body(f.desc));
      var info = ui.clear($('form-info'));
      if (f.kind === 'attend') {
        if (f.settings.when) { info.appendChild(el('dt', { text: '日時' })); info.appendChild(el('dd', { text: f.settings.when })); }
        if (f.settings.place) { info.appendChild(el('dt', { text: '場所' })); info.appendChild(el('dd', { text: f.settings.place })); }
      }
      $('form-deadline').textContent = '締切 ' + f.deadlineLabel + (f.open ? '' : '（締切を過ぎました）');
      var s = data.summary;
      $('form-summary').hidden = !s;
      if (s) $('form-summary').textContent = '今の出席 ' + s.attending + ' 人' + (f.settings.guests ? '（同伴 ' + s.guests + ' 人・合計 ' + s.total + ' 人）' : '');
      var state = '';
      if (data.confirmedDate) state = '受診日が ' + MP.portal.dateLabel(data.confirmedDate) + '（' + data.confirmedDate + '）に決まりました。変えたいときは管理者に伝えてください';
      else if (data.answer && !data.canEdit) state = '回答済みです（締切を過ぎたため直せません。変えたいときは管理者に伝えてください）';
      else if (data.answer) state = '回答済みです。締切の前なら直せます';
      else if (!data.canEdit && MP.guard.viewing()) state = '社員の画面を見ている間は、回答できません';
      else if (!data.canEdit) state = '締切を過ぎたため、回答できません';
      $('form-state').hidden = !state;
      $('form-state').textContent = state;
      if (data.confirmedDate) $('form-state').className = 'msg ok';
      $('answer-form').hidden = !data.canEdit;
      if (!data.canEdit) return;
      fields = f.kind === 'attend' ? buildAttend(f, data.answer) : f.kind === 'order' ? buildOrder(f, data.answer) : buildHealth(f, data.answer);
      $('answer-save').hidden = !fields;
      $('answer-cancel').hidden = !data.answer;
      $('answer-head').textContent = data.answer ? '回答を直す' : '回答';
      if (data.employee) $('back').setAttribute('href', 'admin_form_result.html?id=' + encodeURIComponent(f.formId));
    }

    function after(r, doneText) {
      if (!r.ok) {
        if (r.code === 'CONFLICT') { ui.pageMessage(r.message, 'error'); return reload(); }
        ui.pageMessage(r.message, 'error');
        return;
      }
      ui.pageMessage(doneText, 'ok');
      return reload();
    }

    function send(args) {
      var action = emp ? 'form.admin.answer' : 'form.answer';
      if (emp) args.employeeId = emp;
      return save(action, args);
    }

    $('answer-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!fields) return;
      if (data.form.kind === 'health' && $('a-wish-0') && !$('a-wish-0').value) { ui.pageMessage('第 1 希望を入れてください', 'error'); return; } // 空欄を詰める前に確かめる
      var answer = fields.read();
      var check = CF.checkAnswer(data.form.kind, data.form.settings, answer, { NOTE_MAX: rules().noteMax, ATTEND_GUEST_MAX: rules().guestMax, ORDER_QTY_MAX: rules().qtyMax,
        HEALTH_WISH_MAX: rules().wishMax, HEALTH_WISH_DAYS: rules().wishDays }, { categories: (data.choices || {}).categories || [], today: data.today });
      if (!check.ok) { ui.pageMessage(check.message, 'error'); return; }
      ui.run(function () {
        return send({ formId: data.form.formId, baseVersion: data.recordVersion, answer: answer }).then(function (r) { return after(r, '回答を送りました'); });
      });
    });

    $('answer-cancel').addEventListener('click', function () {
      ui.dialog({ title: '回答を取り消す', text: 'この回答を取り消しますか？', buttons: [{ label: '取り消す', value: true, kind: 'danger' }, { label: 'やめる', value: false }] }).then(function (ok) {
        if (!ok) return;
        ui.run(function () {
          return send({ formId: data.form.formId, baseVersion: data.recordVersion, cancel: true }).then(function (r) { return after(r, '回答を取り消しました'); });
        });
      });
    });

    function args() { var a = { formId: formId }; if (emp) a.employeeId = emp; return a; }
    function reload() {
      return MP.api.call('form.get', args()).then(function (r) {
        if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
        data = r.data;
        render();
      });
    }

    if (!formId) {
      return MP.guard.enter({}).then(function () { ui.pageMessage('受付が見つかりません。ホームから開き直してください', 'error'); });
    }
    return MP.guard.enter({ admin: !!emp, load: { action: 'form.get', args: args() } }).then(function (entered) {
      data = entered.res.data;
      render();
    });
  });
})();
