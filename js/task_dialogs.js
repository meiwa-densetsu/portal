/*
 * タスクリストの入力のダイアログ（計画 docs/plans/stage2-tasklist-v2-plan.md 2-2・2-5・2-7・2-9）。
 * どれも MP.ui.dialog で出し、入力の形を確かめてから値を返す（やめたら null）。送るのは呼んだ側（page_tasks.js）
 *
 *   MP.taskDialogs.add(o)      … 自分のタスクを足す／依頼する（o.request が真。相手は自分以外を部署ごとに）。
 *                                o: { request, people, departments, meId, ownerId, date, rules } → { ownerId, date, content, urgency, hidden, due, dueTime }
 *   MP.taskDialogs.defer(o)    … 先送り先の日。o: { it, today, rules } → 'yyyy-MM-dd'（締め切りを過ぎるときは確かめる）
 *   MP.taskDialogs.due(o)      … 締め切り。o: { it, rules, today } → { due, dueTime }
 *   MP.taskDialogs.text(o)     … 1行の文字（一言・相談）。o: { title, label, value, max, hint, okLabel } → 文字（空もあり）
 *   MP.taskDialogs.handover(o) … 申し送り。o: { h?, departments, myDeptId, canAnyDept, date, rules } → { deptId, from, to, content } / { remove: true }
 */
(function () {
  'use strict';
  var CT = window.CalcTask;
  var seq = 0;

  function field(ui, label, input) {
    return ui.el('div', { class: 'field' }, [ui.el('label', { for: input.id, text: label }), input]);
  }
  function md(d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)); }

  /**
   * ダイアログを出し、「決める」を押したら read() で値を作る。read が文字を返したら、その文字を誤りとして出して開いたままにする
   * （ui.dialog は押すと閉じるので、誤りのときはもう一度開く）
   */
  function ask(ui, o, read) {
    var err = ui.el('p', { class: 'field-error', role: 'alert', hidden: true });
    var body = ui.el('div', {}, [o.body, err]);
    var loop = function () {
      var buttons = [{ label: o.okLabel || '決める', value: 'ok', kind: 'primary' }];
      (o.extra || []).forEach(function (b) { buttons.push(b); });
      buttons.push({ label: 'やめる', value: null });
      return ui.dialog({ title: o.title, body: body, buttons: buttons }).then(function (v) {
        if (v === null) return null;
        if (v !== 'ok') return { extra: v };
        var r = read();
        if (typeof r === 'string') { err.textContent = r; err.hidden = false; return loop(); }
        return { value: r };
      });
    };
    return loop();
  }

  function trim(s) { return String(s || '').replace(/^[\s　]+|[\s　]+$/g, ''); }

  /** 締め切りの欄（日付と時刻）。返す値: { box, read() → { due, dueTime } か 誤りの文字 } */
  function dueFields(ui, id, due, dueTime) {
    var d = ui.el('input', { type: 'date', id: id + '-due', value: due || '' });
    // 時刻は、日報の画面と同じく「時」と「分」を選ぶ形（分は 5 分きざみ。今の値が 5 分きざみでなければ、その値も選べるようにする）
    var h = ui.el('select', { id: id + '-due-h', 'aria-label': '締め切りの時' });
    var m = ui.el('select', { id: id + '-due-m', 'aria-label': '締め切りの分' });
    h.appendChild(ui.el('option', { value: '', text: '時刻なし' }));
    for (var i = 0; i < 24; i++) h.appendChild(ui.el('option', { value: ('0' + i).slice(-2), text: i + ' 時' }));
    var mins = [];
    for (var k = 0; k < 60; k += 5) mins.push(('0' + k).slice(-2));
    var curM = dueTime ? dueTime.slice(3, 5) : '00';
    if (mins.indexOf(curM) < 0) { mins.push(curM); mins.sort(); }
    mins.forEach(function (x) { m.appendChild(ui.el('option', { value: x, text: x + ' 分' })); });
    h.value = dueTime ? dueTime.slice(0, 2) : '';
    m.value = curM;
    var timeRow = ui.el('div', { class: 'field' }, [ui.el('label', { for: h.id, text: '締め切りの時刻（無ければ「時刻なし」）' }), ui.el('div', { class: 'time-row' }, [h, m])]);
    var box = ui.el('div', {}, [field(ui, '締め切りの日（無ければ空のまま）', d), timeRow]);
    return {
      box: box,
      read: function () {
        var t = h.value === '' ? '' : h.value + ':' + m.value;
        if (d.value !== '' && !CT.isDate(d.value)) return '締め切りの日を選び直してください';
        if (d.value === '' && t !== '') return '時刻だけは入れられません。締め切りの日も選んでください';
        if (t !== '' && !CT.isTime(t)) return '締め切りの時刻を選び直してください';
        return { due: d.value, dueTime: d.value === '' ? '' : t };
      },
    };
  }

  function add(o) {
    var ui = MP.ui;
    var id = 'tdlg' + (++seq);
    // 依頼する（o.request）: 相手は自分以外を、部署ごとに分けて並べる（自分は選べない。v2 計画 2-7）。
    // 自分のタスクを足す: 担当は自分で決まり（相手の欄は出さない）
    var owner = null;
    if (o.request) {
      owner = ui.el('select', { id: id + '-owner' });
      var groups = (o.departments || []).map(function (d) { return { label: d.name, deptId: d.deptId }; });
      groups.push({ label: '部署なし', deptId: '' });
      var known = {};
      (o.departments || []).forEach(function (d) { known[d.deptId] = true; });
      groups.forEach(function (g) {
        var list = o.people.filter(function (p) {
          return p.active && p.employeeId !== o.meId && (g.deptId ? p.deptId === g.deptId : !known[p.deptId]);
        });
        if (!list.length) return;
        var box = (o.departments || []).length ? ui.el('optgroup', { label: g.label }) : owner;
        list.forEach(function (p) { box.appendChild(ui.el('option', { value: p.employeeId, text: p.name })); });
        if (box !== owner) owner.appendChild(box);
      });
      owner.value = o.ownerId;
    }
    var date = ui.el('input', { type: 'date', id: id + '-date', value: o.date });
    var content = ui.el('input', { type: 'text', id: id + '-content', autocomplete: 'off', maxlength: String(o.rules.contentMax * 2) });
    var urgency = ui.el('select', { id: id + '-urgency' });
    o.rules.urgency.slice().reverse().forEach(function (u) { urgency.appendChild(ui.el('option', { value: u, text: u })); });
    urgency.value = '通常';
    var hidden = ui.el('input', { type: 'checkbox', id: id + '-hidden' });
    var dueF = dueFields(ui, id, '', '');
    var body = ui.el('div', {}, [
      owner ? field(ui, '相手（依頼する人）', owner) : null,
      field(ui, 'やる日', date),
      field(ui, '内容（' + o.rules.contentMax + ' 字まで）', content),
      field(ui, '急ぎの度合い', urgency),
      dueF.box,
      ui.el('label', { class: 'check' }, [hidden, document.createTextNode(o.request ? '相手・自分・管理者だけに見せる 🔒' : '自分と管理者だけに見せる 🔒')]),
    ]);
    return ask(ui, { title: o.request ? '依頼する' : 'タスクを足す', body: body, okLabel: o.request ? '依頼を送る' : '足す' }, function () {
      var c = trim(content.value);
      var ownerId = owner ? owner.value : o.meId;
      if (!ownerId || ownerId === o.meId && o.request) return '相手を選んでください';
      if (!CT.isDate(date.value)) return 'やる日を選んでください';
      if (c === '') return '内容を入れてください';
      if (/[\r\n]/.test(c)) return '内容に改行は入れられません';
      var du = dueF.read();
      if (typeof du === 'string') return du;
      return { ownerId: ownerId, date: date.value, content: c, urgency: urgency.value, hidden: hidden.checked, due: du.due, dueTime: du.dueTime };
    }).then(function (r) { return r && r.value ? r.value : null; });
  }

  function defer(o) {
    var ui = MP.ui;
    var it = o.it;
    var input = ui.el('input', { type: 'date', id: 'defer-date', min: o.today, max: CT.addDays(o.today, o.rules.deferMaxDays), value: CT.nextBusinessDay(it.date < o.today ? o.today : it.date, null) });
    var body = ui.el('div', {}, [field(ui, '先送り先の日', input)]);
    if (it.due) body.appendChild(ui.el('p', { class: 'sub', text: '締め切りは ' + md(it.due) + ' です（先送りしても締め切りは変わりません）' }));
    return ask(ui, { title: '先送り', body: body, okLabel: '先送りする' }, function () {
      if (!CT.isDate(input.value)) return '日付を選んでください';
      if (input.value === it.date) return '同じ日へは先送りできません';
      return { to: input.value }; // 文字をそのまま返すと「誤りの文」と見なされるので、包んで返す
    }).then(function (r) {
      if (!r || !r.value) return null;
      var to = r.value.to;
      if (it.due && to > it.due) {
        return ui.confirm('締め切りを過ぎます', '締め切り（' + md(it.due) + '）より後の ' + md(to) + ' へ先送りします。よろしいですか？', '先送りする').then(function (ok) { return ok ? to : null; });
      }
      return to;
    });
  }

  function due(o) {
    var ui = MP.ui;
    var id = 'tdlg' + (++seq);
    var f = dueFields(ui, id, o.it.due, o.it.dueTime);
    var body = ui.el('div', {}, [ui.el('p', { class: 'dialog-body', text: '「' + o.it.content + '」' }), f.box]);
    return ask(ui, { title: '締め切り', body: body }, function () { return f.read(); })
      .then(function (r) { return r && r.value ? r.value : null; });
  }

  function text(o) {
    var ui = MP.ui;
    var id = 'tdlg' + (++seq);
    var input = ui.el('input', { type: 'text', id: id + '-text', autocomplete: 'off', value: o.value || '', maxlength: String(o.max * 2) });
    var body = ui.el('div', {}, [field(ui, o.label + '（' + o.max + ' 字まで）', input)]);
    if (o.hint) body.appendChild(ui.el('p', { class: 'sub', text: o.hint }));
    return ask(ui, { title: o.title, body: body, okLabel: o.okLabel }, function () {
      var v = trim(input.value);
      if (/[\r\n]/.test(v)) return '改行は入れられません';
      if (o.required && v === '') return o.label + 'を入れてください';
      return { text: v };
    }).then(function (r) { return r && r.value ? r.value.text : null; });
  }

  function handover(o) {
    var ui = MP.ui;
    var id = 'tdlg' + (++seq);
    var h = o.h || null;
    var dept = ui.el('select', { id: id + '-dept' });
    var opts = [];
    // 社員は自分の部署か全員。部長・管理者はどの部署でも。直すときは、今の部署もそのまま選べる
    o.departments.forEach(function (d) {
      if (o.canAnyDept || d.deptId === o.myDeptId || (h && h.deptId === d.deptId)) opts.push({ value: d.deptId, text: d.name });
    });
    if (h && h.deptId !== '全員' && !opts.some(function (x) { return x.value === h.deptId; })) opts.push({ value: h.deptId, text: h.deptName || h.deptId });
    opts.push({ value: '全員', text: '全員' });
    opts.forEach(function (x) { dept.appendChild(ui.el('option', { value: x.value, text: x.text })); });
    dept.value = h ? h.deptId : (o.deptId && opts.some(function (x) { return x.value === o.deptId; }) ? o.deptId : opts[0].value);
    var from = ui.el('input', { type: 'date', id: id + '-from', value: h ? h.from : o.date });
    var to = ui.el('input', { type: 'date', id: id + '-to', value: h ? h.to : o.date });
    var content = ui.el('textarea', { id: id + '-content', rows: '4' });
    content.value = h ? h.content : '';
    var body = ui.el('div', {}, [
      field(ui, 'だれに（部署）', dept),
      field(ui, '出し始める日', from),
      field(ui, '出し終わる日（' + o.rules.handoverMaxDays + ' 日先まで）', to),
      field(ui, '内容（' + o.rules.memoMax + ' 字まで）', content),
    ]);
    var extra = h ? [{ label: 'この申し送りを消す', value: 'remove', kind: 'danger' }] : [];
    return ask(ui, { title: h ? '申し送りを直す' : '申し送りを書く', body: body, okLabel: h ? '直す' : '書く', extra: extra }, function () {
      var c = trim(content.value);
      if (!CT.isDate(from.value) || !CT.isDate(to.value)) return '日付を選んでください';
      if (to.value < from.value) return '出し終わる日は、出し始める日より後にしてください';
      if (CT.dayNumber(to.value) - CT.dayNumber(from.value) + 1 > o.rules.handoverMaxDays) return '期間は ' + o.rules.handoverMaxDays + ' 日までです';
      if (c === '') return '内容を入れてください';
      return { deptId: dept.value, from: from.value, to: to.value, content: c };
    }).then(function (r) {
      if (!r) return null;
      if (r.extra === 'remove') {
        return ui.confirm('申し送りを消す', 'この申し送りを消しますか？', '消す', 'danger').then(function (ok) { return ok ? { remove: true } : null; });
      }
      return r.value;
    });
  }

  MP.taskDialogs = { add: add, defer: defer, due: due, text: text, handover: handover };
})();
