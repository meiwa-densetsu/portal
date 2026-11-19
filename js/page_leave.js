/*
 * 休暇の画面（全員）。計画 docs/plans/stage2-leave-plan.md 第11章
 *
 * 上に残り（有給・振替残高・もうすぐ消える・確定待ち）、休みの申請（下見 → 送る。欠勤になるときは確かめ）、申請の一覧（直す・取り消す）。
 * leave.html?employeeId=E0002 … 管理者が自分のログインのまま、その社員の分を代わりに申請・直す（なりすましではない）
 * leave.html?date=2026-11-12 … その日を選んで開く（日報の画面の「休みを申請する」から）
 * 社員の画面を見ている間は見るだけ（送る・直すのボタンを出さない。サーバーも断る）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, LV = MP.leaveView;
    var params = new URLSearchParams(window.location.search);
    var targetId = /^E\d{4}$/.test(params.get('employeeId') || '') ? params.get('employeeId') : null;
    var startDate = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : null;
    var data = null;
    var editing = null;     // 直している申請
    var chosen = null;      // 推奨日をまとめて選んだ日（null なら日付の欄から）
    var previewed = null;   // 下見した引数の文字（同じときだけ送れる）
    var save = MP.api.saver();
    var cancelSave = MP.api.saver();
    var FORM_IDS = ['date-from', 'date-to', 'unit', 'from', 'to', 'note', 'kind'];
    var settled = null;     // 書きかけでない欄の中身（開いたとき・送り終えたとき・やめたとき・直すを始めたとき）。今の中身と違えば書きかけ
    var apiLeaving = false; // 共通の扱いが画面を移している途中（離れる確認を出さない。タスクの画面と同じ）

    function args() { return targetId ? { employeeId: targetId } : {}; }

    function load(first) {
      var p = first ? MP.guard.enter({ load: { action: 'leave.mine', args: args() } })
        : MP.api.call('leave.mine', args()).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        data = r.res.data;
        ui.$('view').hidden = false;
        render();
      });
    }

    function dayMin() { return data.balance && data.balance.dayMin ? data.balance.dayMin : 480; }
    function jp(d) { return Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日'; }
    var DOW = ['日', '月', '火', '水', '木', '金', '土'];
    function jpDow(d) { return jp(d) + '（' + DOW[new Date(d + 'T00:00:00Z').getUTCDay()] + '）'; }

    function kv(list, label, value, sub) {
      list.appendChild(ui.el('dt', { text: label }));
      list.appendChild(ui.el('dd', {}, [value, sub ? ui.el('span', { class: 'sub', text: '　' + sub }) : null]));
    }

    function render() {
      ui.$('title').textContent = targetId ? '休暇（' + data.employee.name + '・管理者が代わりに申請）' : data.viewOnly ? '休暇（' + data.employee.name + '）' : '休暇';
      ui.$('viewonly-note').hidden = !data.viewOnly;
      ui.$('notready').hidden = data.ready;
      ui.$('balance').hidden = !data.ready;
      ui.$('cols').hidden = !data.ready;
      if (!data.ready) return;
      renderBalance();
      renderForm();
      renderList();
    }

    function renderBalance() {
      var b = data.balance, dm = dayMin();
      var list = ui.clear(ui.$('balance-list'));
      kv(list, '有給の残り', LV.dh(b.paid, dm), b.paidReserved ? '先の日の申請を引くと ' + LV.dh(b.paid - b.paidReserved, dm) : '');
      kv(list, '振替残高', LV.hm(b.furikae), '振替出勤 ' + LV.hm(b.earned) + '・振替休日 ' + LV.hm(b.used));
      if (b.borrowed) kv(list, '前借り', LV.hm(b.borrowed), '上限 ' + LV.hm(b.borrowLimit) + '（次に付く有給の分）');
      if (b.soon.length) kv(list, 'もうすぐ消える有給', b.soon.map(function (s) { return jp(s.expire) + ' に ' + LV.dh(s.minutes, dm); }).join('・'));
      if (data.hourly && data.hourly.limit !== null) kv(list, '時間の休み（今の 1 年）', LV.hm(data.hourly.used), '上限 ' + LV.hm(data.hourly.limit));
      (data.care || []).forEach(function (c) {
        var ct = LV.careText(c);
        kv(list, ct.label, ct.value, ct.sub);
      });
      var w = ui.clear(ui.$('warn-list'));
      b.pending.forEach(function (p) {
        w.appendChild(ui.el('p', { class: 'msg info', text: jp(p.date) + 'に有給が付く予定です（管理者の確定待ち）。確定したら振り分け直します' }));
      });
      (data.warnings || []).forEach(function (x) {
        var t = x.code === 'BORROW_OVER' ? '前借りが上限を超えています。管理者に相談してください'
          : x.code === 'BORROW_NEAR' ? '前借りが上限に近づいています（' + LV.hm(x.borrowed) + ' / ' + LV.hm(x.limit) + '）'
            : x.code === 'FIVE_DAY' ? '付与から 1 年の間に有給を 5 日取る決まりです（今 ' + x.taken + ' 日・予定 ' + x.planned + ' 日）' : '';
        if (t) w.appendChild(ui.el('p', { class: 'msg warn', text: t }));
      });
      if (data.fresh === false) w.appendChild(ui.el('p', { class: 'sub', text: '残りはその場で計算しました' }));
    }

    function timeOptions(sel, from, to) {
      ui.clear(sel);
      for (var m = from; m <= to; m += data.rules.LEAVE.STEP_MIN) sel.appendChild(ui.el('option', { value: String(m), text: LV.time(m) }));
    }

    function renderForm() {
      var canEdit = data.canEdit && !data.viewOnly;
      ui.$('form-card').hidden = !canEdit;
      if (!canEdit) return;
      // 書きかけでなければ（初めて・送り終えた・やめた後）、下で初めの値を補った後の中身を基準にし直す（推奨日を送った後に日付を補っても止めない）
      var wasClean = settled === null || formState() === settled;
      if (!ui.$('from').options.length) {
        timeOptions(ui.$('from'), 0, 1410);
        timeOptions(ui.$('to'), 30, 1440);
        ui.$('from').value = '540';
        ui.$('to').value = '600';
      }
      var kindSel = ui.$('kind');
      var targets = (data.careTargets || []).filter(function (t) { return t.active; });
      ui.$('kind-field').hidden = !targets.length;
      if (targets.length && !kindSel.options.length) {
        kindSel.appendChild(ui.el('option', { value: 'leave', text: '休み（有給 → 振替休日 → 欠勤の順）' }));
        targets.forEach(function (t) { kindSel.appendChild(ui.el('option', { value: t.kind + ':' + t.targetId, text: (t.kind === 'kaigo' ? '介護休暇' : '看護休暇') + '（' + t.name + '）' })); });
      }
      var d = ui.$('date-from');
      if (!d.value) d.value = startDate || data.today;
      d.min = data.calendar.from;
      ui.$('date-to').min = data.calendar.from;
      syncUnit();
      if (wasClean) settle();
    }

    function syncUnit() {
      var hour = ui.$('unit').value === 'hour';
      var timed = hour || ui.$('unit').value === 'half'; // 半日にも始め・終わり（第17章 17-2。量は 1 日 ÷ 2 のまま）
      ui.$('time-fields').hidden = !timed;
      ui.$('lunch-note').hidden = !hour;
      ui.$('date-to-field').hidden = !!editing || !!chosen;
      ui.$('date-field').hidden = !!chosen;
      ui.$('date-from').disabled = !!editing;
      ui.$('kind').disabled = !!editing;
      ui.$('reset').hidden = !editing && !chosen;
    }

    function stale() {
      previewed = null;
      ui.$('send').disabled = true;
      ui.$('preview-box').hidden = true;
    }

    /** フォームから送る引数（形が足りなければ null と文） */
    function formArgs() {
      var a = { employeeId: targetId, unit: ui.$('unit').value, note: ui.$('note').value.trim(), confirmAbsent: false };
      if (a.unit === 'hour' || a.unit === 'half') { a.from = Number(ui.$('from').value); a.to = Number(ui.$('to').value); }
      if (editing) {
        a.leaveId = editing.leaveId;
        a.baseVersion = editing.recordVersion;
        return { args: a };
      }
      a.leaveId = null;
      var kind = ui.$('kind-field').hidden ? 'leave' : ui.$('kind').value;
      if (kind !== 'leave') { a.kind = kind.split(':')[0]; a.targetId = kind.split(':')[1]; }
      var dates;
      if (chosen) dates = chosen;
      else {
        var from = ui.$('date-from').value, to = ui.$('date-to').value;
        if (!from) return { error: '日付を選んでください' };
        if (!to || to === from) dates = [from];
        else if (to < from) return { error: '「この日まで」は日付より後にしてください' };
        else {
          dates = LV.workDates(data.calendar, from, to);
          if (!dates.length) return { error: 'その間に会社の出勤日がありません' };
        }
      }
      if (dates.length > data.rules.LEAVE.BATCH_MAX) return { error: '一度に申請できるのは ' + data.rules.LEAVE.BATCH_MAX + ' 日までです' };
      a.dates = dates;
      return { args: a };
    }

    function renderPreview(p) {
      var box = ui.clear(ui.$('preview-box'));
      box.hidden = false;
      box.appendChild(ui.el('h3', { text: '振り分けの下見' }));
      var ul = ui.el('ul', { class: 'list' });
      p.alloc.forEach(function (x) {
        var t = LV.allocText({ paid: x.paid, furikae: x.furikae, absent: x.absent, carePaid: x.carePaid, careUnpaid: x.careUnpaid }, 'leave');
        ul.appendChild(ui.el('li', {}, [ui.el('span', { class: 'item-title', text: jpDow(x.date) }), ' ', t || '0', x.absent ? ui.el('span', { class: 'tag warn', text: '欠勤あり' }) : null]));
      });
      box.appendChild(ul);
      var tot = p.total;
      box.appendChild(ui.el('p', { text: '合計: ' + (LV.allocText(tot, 'leave') || '0') }));
      if (tot.absent) box.appendChild(ui.el('p', { class: 'msg warn', text: '有給と振替休日が足りないため、欠勤（無給）になる時間があります。送るときに確かめます' }));
    }

    function preview() {
      var f = formArgs();
      if (f.error) { ui.pageMessage(f.error, 'error'); return Promise.resolve(); }
      ui.pageMessage('');
      return MP.api.call('leave.preview', f.args).then(function (res) {
        if (!res.ok) { stale(); ui.pageMessage(res.message, 'error'); return; }
        renderPreview(res.data);
        previewed = JSON.stringify(f.args);
        ui.$('send').disabled = false;
      });
    }

    function send(confirmAbsent) {
      var f = formArgs();
      if (f.error) { ui.pageMessage(f.error, 'error'); return Promise.resolve(); }
      if (JSON.stringify(f.args) !== previewed) { stale(); ui.pageMessage('入力が変わりました。もう一度下見してください', 'error'); return Promise.resolve(); }
      var a = Object.assign({}, f.args, { confirmAbsent: !!confirmAbsent });
      return save('leave.request.save', a).then(function (res) {
        if (!res.ok && res.code === 'ABSENT_CONFIRM') {
          return ui.confirm('欠勤になる時間があります', res.message + '\n欠勤（無給）として送りますか？', '欠勤として送る', 'danger').then(function (yes) {
            if (yes) return send(true);
          });
        }
        if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
        var done = editing ? '休みを直しました' : '休みを送りました（' + res.data.leaveIds.length + '日）';
        resetForm();
        return load(false).then(function () { ui.pageMessage(done, 'ok'); });
      });
    }

    /** 送る中身として使う欄だけ（formArgs と同じ選び方。隠れた時刻・直すときの日付などは比べない） */
    function formState() {
      var unit = ui.$('unit').value;
      var o = { unit: unit, note: ui.$('note').value.trim() };
      if (unit === 'hour' || unit === 'half') { o.from = ui.$('from').value; o.to = ui.$('to').value; }
      if (!editing) {
        if (chosen) o.chosen = chosen.join(',');
        else {
          o.dateFrom = ui.$('date-from').value;
          var to = ui.$('date-to').value;
          o.dateTo = to === o.dateFrom ? '' : to; // 「この日まで」が空・開始日と同じ日は、送る中身が同じ（その日だけ）
        }
        o.kind = ui.$('kind-field').hidden ? 'leave' : ui.$('kind').value;
      }
      return JSON.stringify(o);
    }
    function settle() { settled = formState(); }
    /** 送っていない書きかけがあるか（送れる欄が出ていて、中身が基準と違う） */
    function unsent() { return settled !== null && !ui.$('form-card').hidden && formState() !== settled; }

    function resetForm() {
      editing = null;
      chosen = null;
      ui.$('edit-note').hidden = true;
      ui.$('note').value = '';
      ui.$('dates-chosen').hidden = true;
      ui.$('date-to').value = '';
      stale();
      syncUnit();
      settle(); // 送り終えた・やめた後の中身が基準
    }

    function startEdit(l) {
      resetForm();
      editing = l;
      ui.$('date-from').value = l.date;
      ui.$('unit').value = l.unit;
      if ((l.unit === 'hour' || l.unit === 'half') && typeof l.from === 'number') { ui.$('from').value = String(l.from); ui.$('to').value = String(l.to); }
      ui.$('note').value = l.note || '';
      ui.$('edit-note').textContent = jpDow(l.date) + 'の休みを直しています（日付は変えられません。日を変えるときは取り消して、新しく申請してください）';
      ui.$('edit-note').hidden = false;
      syncUnit();
      settle(); // 直す前の申請の中身が基準
      ui.$('form-card').scrollIntoView({ block: 'start' });
    }

    function cancel(l) {
      ui.confirm('休みを取り消す', jpDow(l.date) + ' ' + LV.label(l) + ' を取り消しますか？', '取り消す', 'danger').then(function (yes) {
        if (!yes) return;
        ui.run(function () {
          return cancelSave('leave.request.cancel', { employeeId: targetId, leaveId: l.leaveId, baseVersion: l.recordVersion }).then(function (res) {
            if (!res.ok) return load(false).then(function () { ui.pageMessage(res.message, 'error'); });
            return load(false).then(function () { ui.pageMessage('休みを取り消しました', 'ok'); });
          });
        });
      });
    }

    function recommend() {
      var have = {};
      data.requests.forEach(function (l) { if (l.state === '有効') have[l.date] = true; });
      var tomorrow = new Date(Date.parse(data.today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
      var list = [];
      var base = Date.parse(data.calendar.from + 'T00:00:00Z');
      for (var i = 0; i < data.calendar.marks.length; i++) {
        var d = new Date(base + i * 86400000).toISOString().slice(0, 10);
        if (d >= tomorrow && data.calendar.marks.charAt(i) === 'P' && !have[d]) list.push(d);
      }
      list = list.slice(0, data.rules.LEAVE.BATCH_MAX);
      if (!list.length) { ui.pageMessage('この先に、まだ申請していない有給推奨日はありません', 'info'); return; }
      resetForm();
      chosen = list;
      ui.$('unit').value = 'day';
      ui.$('dates-chosen').textContent = '有給推奨日: ' + list.map(jpDow).join('・');
      ui.$('dates-chosen').hidden = false;
      syncUnit(); // 選んだ日は基準（resetForm の中で取った）と違うので書きかけ
      ui.pageMessage('');
    }

    function renderList() {
      var ul = ui.clear(ui.$('list'));
      if (!data.requests.length) { ul.appendChild(ui.el('li', { class: 'sub', text: 'まだ申請はありません' })); return; }
      data.requests.forEach(function (l) {
        var active = l.state === '有効';
        var mark = LV.markOf(data.calendar, l.date) === 'P' ? ui.el('span', { class: 'tag', text: '推奨日' }) : null;
        var actions = [];
        if (l.editable) {
          actions.push(ui.el('button', { type: 'button', class: 'btn', text: '直す', on: { click: function () { startEdit(l); } } }));
          actions.push(ui.el('button', { type: 'button', class: 'btn danger', text: '取り消す', on: { click: function () { cancel(l); } } }));
        }
        ul.appendChild(ui.el('li', { class: 'leave-item' + (active ? '' : ' off') }, [
          ui.el('div', { class: 'item-title' }, [jpDow(l.date) + ' ', mark, ' ', active ? null : ui.el('span', { class: 'tag off', text: '取消' }), l.closed ? ui.el('span', { class: 'tag', text: '締め' }) : null]),
          ui.el('div', { text: LV.label(l) + (l.kind !== 'leave' ? '' : '') }),
          l.alloc && active ? ui.el('div', { class: 'sub', text: '振り分け: ' + (LV.allocText(l.alloc, l.kind) || '0') }) : null,
          l.note ? ui.el('div', { class: 'sub', text: 'メモ: ' + l.note }) : null,
          l.conflict ? ui.el('div', { class: 'msg warn', text: l.conflict === 'WORKED_DAY' ? '1日の休みと勤務が両方あります。休みを直してください' : '休みと勤務の時刻が重なっています。休みを直してください' }) : null,
          actions.length ? ui.el('div', { class: 'item-actions' }, actions) : null,
        ]));
      });
    }

    FORM_IDS.forEach(function (id) {
      ui.$(id).addEventListener('input', function () { if (id === 'unit') syncUnit(); stale(); });
      ui.$(id).addEventListener('change', function () { if (id === 'unit') syncUnit(); stale(); });
    });
    // 書きかけのまま閉じようとしたら止める（日報の画面と同じ）。ログインが変わって開き直すときは boot.js が止めない
    MP.api.onLeave(function () { apiLeaving = true; });
    window.addEventListener('beforeunload', function (ev) { if (!apiLeaving && unsent()) { ev.preventDefault(); ev.returnValue = ''; } });
    ui.$('preview').addEventListener('click', function () { ui.run(preview); });
    ui.$('send').addEventListener('click', function () { ui.run(function () { return send(false); }); });
    ui.$('recommend').addEventListener('click', recommend);
    ui.$('reset').addEventListener('click', function () { resetForm(); ui.pageMessage(''); });

    return load(true);
  });
})();
