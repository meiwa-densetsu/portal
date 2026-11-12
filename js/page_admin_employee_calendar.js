/* 管理者: 社員ごとの出勤日と休みの入れ替え（calendar.admin.list / employee / saveSwap / cancelSwap） */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el, V = MP.calView;
    return MP.guard.enter({ admin: true, load: { action: 'calendar.admin.list' } }).then(function (entered) {
      var C = window.CalcCalendar;
      var save = MP.api.saver();
      var list = entered.res.data;
      var cur = null;      // calendar.admin.employee の答え
      var from = list.currentPeriod.from;
      var pending = {};    // 押した日: { 日の番号: 区分 }
      var view = null;
      var STATUS_TEXT = { UNASSIGNED: 'カレンダーが未設定', NO_PERIOD: 'この年度のカレンダーがまだ無い', DRAFT: 'カレンダーが下書き（未確定）' };

      function pendingCount() { return Object.keys(pending).length; }

      // ------------------------------------------------ 社員の選択
      var sel = ui.clear($('emp'));
      sel.appendChild(el('option', { value: '', text: '選んでください' }));
      list.employees.forEach(function (e) { sel.appendChild(el('option', { value: e.employeeId, text: e.name + (e.calendarId ? '' : '（カレンダー未設定）') })); });
      var selected = '';   // いま表示している社員（読み込みに成功したときだけ変わる）
      var busy = 0;

      /**
       * 送信の間はボタンと社員の選択を押せなくする（ui.run はボタンだけを止めるため）。
       * 終わると ui.run が押せる姿に戻すので、保存・元に戻すのボタンの状態を付け直し、選択を表示中の社員に合わせる
       */
      function run(fn) {
        busy++;
        sel.disabled = true;
        var end = function () {
          if (--busy === 0) sel.disabled = false;
          sel.value = selected;
          if (cur) renderPending();
        };
        return ui.run(fn).then(function (v) { end(); return v; }, function (e) { end(); throw e; });
      }

      function leaveOk() {
        if (!pendingCount()) return Promise.resolve(true);
        return ui.confirm('保存していない入れ替えがあります', pendingCount() + '日の入れ替えが消えます。保存せずに移りますか？', '保存せずに移る', 'danger');
      }

      sel.addEventListener('change', function () {
        var want = sel.value;
        leaveOk().then(function (ok) {
          if (!ok) { sel.value = selected; return; }
          if (!want) { selected = ''; cur = null; pending = {}; $('detail').hidden = true; return; }
          run(function () { return load(want, from); });
        });
      });

      function shiftPeriod(dir) {
        leaveOk().then(function (ok) {
          if (!ok) return;
          var p = C.periodOf(from, list.rules);
          var n = dir < 0 ? C.dayNumber(p.from) - 1 : C.dayNumber(p.to) + 1;
          var next = C.periodOf(C.dateOf(n), list.rules).from;
          if (!selected) { from = next; return; }
          run(function () { return load(selected, next); });
        });
      }
      $('prev-period').addEventListener('click', function () { shiftPeriod(-1); });
      $('next-period').addEventListener('click', function () { shiftPeriod(1); });

      window.addEventListener('beforeunload', function (ev) { if (pendingCount()) { ev.preventDefault(); ev.returnValue = ''; } });

      // ------------------------------------------------ 表示
      function calName(id) {
        var c = cur.calendars.filter(function (x) { return x.calendarId === id; })[0];
        return c ? c.name : id;
      }

      function renderPending() {
        var n = pendingCount();
        $('pending').textContent = n ? '保存していない入れ替え: ' + n + '日（' + Object.keys(pending).map(Number).sort(function (a, b) { return a - b; })
          .map(function (i) { return V.md(cur.days[i].date) + ' ' + V.TYPE_TEXT[pending[i]]; }).join('・') + '）' : '押した日はありません。';
        $('save').disabled = !n;
        $('undo').disabled = !n;
      }

      function renderSwaps() {
        var ul = ui.clear($('swaps'));
        cur.swaps.forEach(function (s) {
          ul.appendChild(el('li', {}, [
            el('div', { class: 'item-title' }, [s.items.map(function (it) { return V.md(it.date) + ' ' + V.TYPE_TEXT[it.type]; }).join('・') + ' ',
              s.cancelled ? el('span', { class: 'tag off', text: '取り消し済み' }) : null]),
            el('div', { class: 'sub', text: '入れた日時: ' + ui.fmtDateTime(s.createdAt) + '（' + s.createdBy + '）' + (s.cancelled ? '／取り消し: ' + ui.fmtDateTime(s.cancelledAt) + '（' + s.cancelledBy + '）' : '') }),
            s.cancelled ? null : el('div', { class: 'item-actions' }, [el('button', { type: 'button', class: 'btn danger', text: '取り消す', on: { click: function () { cancel(s); } } })]),
          ]));
        });
        if (!cur.swaps.length) ul.appendChild(el('li', { class: 'sub', text: '入れ替えはまだありません' }));
      }

      function render() {
        $('title').textContent = cur.employee.name + ' さん ' + V.periodName(cur.period);
        $('ranges').textContent = cur.ranges.length
          ? 'カレンダー: ' + cur.ranges.map(function (r) { return V.md(r.from) + '〜' + V.md(r.to) + ' ' + (r.calendarId ? calName(r.calendarId) : '未設定'); }).join('、')
          : 'この年度に当たる社員履歴がありません';
        var bad = {};
        cur.days.forEach(function (d) { if (d.status !== 'OK') bad[d.status] = (bad[d.status] || 0) + 1; });
        var msgs = Object.keys(bad).map(function (k) { return STATUS_TEXT[k] + 'の日が ' + bad[k] + '日あります'; });
        $('status').textContent = msgs.length ? msgs.join('。') + '。その日は入れ替えられません（「—」の日）。会社カレンダー・社員の管理で直してください' : '';
        $('status').hidden = !msgs.length;
        ui.clear($('legend')).appendChild(V.legend([['swap W', '出', '黄色の枠 = 入れ替え済み'], ['changed H', '休', '太い枠 = 保存していない入れ替え']]));
        view = V.render($('months'), {
          period: cur.period, rules: cur.rules,
          cell: function (i, date, dow) {
            var d = cur.days[i];
            if (d.status !== 'OK') return { type: null, disabled: true, note: STATUS_TEXT[d.status] };
            var shown = Object.prototype.hasOwnProperty.call(pending, i) ? pending[i] : d.companyType;
            var notes = [];
            if (d.swapId) notes.push('入れ替え済み');
            if (d.legalType !== d.companyType) notes.push('確定時のカレンダーでは' + V.TYPE_TEXT[d.legalType]);
            if (dow === cur.rules.LEGAL_HOLIDAY_DOW) notes.push('日曜は法定休日');
            return { type: shown, disabled: dow === cur.rules.LEGAL_HOLIDAY_DOW, changed: Object.prototype.hasOwnProperty.call(pending, i), swap: !!d.swapId, note: notes.join('。') };
          },
          onClick: function (i) {
            var d = cur.days[i];
            var shown = Object.prototype.hasOwnProperty.call(pending, i) ? pending[i] : d.companyType;
            var next = { W: 'H', H: 'P', P: 'W' }[shown] || 'W';
            if (next === d.companyType) delete pending[i]; else pending[i] = next;
            view.refresh(i);
            renderPending();
          },
        });
        renderPending();
        renderSwaps();
        $('detail').hidden = false;
      }

      /** 社員と年度を読み込む。成功したときだけ、表示中の社員（selected）と年度（from）を切り替える */
      function load(employeeId, wantFrom) {
        return MP.api.call('calendar.admin.employee', { employeeId: employeeId, from: wantFrom }).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return; }
          selected = employeeId;
          from = wantFrom;
          cur = r.data;
          pending = {};
          ui.pageMessage('');
          render();
        });
      }

      $('undo').addEventListener('click', function () { pending = {}; view.refreshAll(); renderPending(); });

      function conflict() {
        return ui.notice('他の人が先に変更しました', 'この人の入れ替えは、開いた後に別の画面で変わりました。読み込み直します。押していた日は、もう一度押し直してください。').then(function () { return load(selected, from); });
      }

      $('save').addEventListener('click', function () {
        var items = Object.keys(pending).map(Number).sort(function (a, b) { return a - b; }).map(function (i) { return { date: cur.days[i].date, type: pending[i] }; });
        if (!items.length) return;
        var args = { employeeId: cur.employee.employeeId, baseVersion: cur.swapVersion, items: items };
        run(function () {
          return save('calendar.admin.saveSwap', args).then(function (r) {
            if (r.ok) return load(selected, from).then(function () { ui.pageMessage('保存しました', 'ok'); });
            if (r.code === 'CONFLICT') return conflict();
            ui.pageMessage(r.message, 'error');
          });
        });
      });

      function cancel(s) {
        var text = s.items.map(function (it) { return V.md(it.date) + ' ' + V.TYPE_TEXT[it.type]; }).join('・');
        var warn = pendingCount() ? '\n\n保存していない入れ替え（' + pendingCount() + '日）は消えます。' : '';
        ui.confirm('この入れ替えを取り消しますか？', text + '\n\n取り消すと、その日はカレンダーどおりに戻ります（別の入れ替えがあれば、そちらが効きます）。' + warn, '取り消す', 'danger').then(function (yes) {
          if (!yes) return;
          var args = { employeeId: cur.employee.employeeId, swapId: s.swapId, baseVersion: cur.swapVersion };
          run(function () {
            return save('calendar.admin.cancelSwap', args).then(function (r) {
              if (r.ok) return load(selected, from).then(function () { ui.pageMessage('取り消しました', 'ok'); });
              if (r.code === 'CONFLICT') return conflict();
              ui.pageMessage(r.message, 'error');
            });
          });
        });
      }

      $('main').hidden = false;
    });
  });
})();
