/* 管理者: 会社カレンダーの一覧・追加・名前の変更・1年分の区分の入力と確定（calendar.admin.list / get / saveCalendar / saveDays / confirm） */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el, V = MP.calView;
    return MP.guard.enter({ admin: true, load: { action: 'calendar.admin.list' } }).then(function (entered) {
      var C = window.CalcCalendar;
      var save = MP.api.saver();
      var list = null;      // calendar.admin.list の答え
      var editing = null;   // 名前を直しているカレンダー（新しいものなら null）
      var cur = null;       // 開いている1年分: { calendar, period, row, base（保存済みの文字）, days（今の配列）, today, rules, view }
      var VIEWS = ['list-view', 'edit-view', 'days-view'];

      function show(view) {
        VIEWS.forEach(function (v) { $(v).hidden = v !== view; });
        window.scrollTo(0, 0);
      }

      /** 送信の間はボタンを押せなくする（ui.run）。終わると ui.run が押せる姿に戻すので、保存・確定のボタンの状態を付け直す */
      function run(fn) {
        return ui.run(fn).then(function (v) { if (cur) renderSummary(); return v; });
      }

      // ------------------------------------------------ 一覧
      function renderList() {
        var ul = ui.clear($('cal-list'));
        list.calendars.forEach(function (c) {
          var lines = c.periods.length ? c.periods.map(function (p) {
            return V.periodName(p) + ': ' + (p.confirmed ? '確定済み' : '下書き') + (p.workDays === null ? '' : '・出勤 ' + p.workDays + '日');
          }) : ['まだ日を入れていません'];
          if (c.variant === false) lines.unshift('協定なし（法律の目安は 1 日 8 時間・週 40 時間）');
          if (c.variant === null) lines.unshift('協定の印が読めません。「名前などを直す」で選び直してください');
          ul.appendChild(el('li', {}, [
            el('div', { class: 'item-title' }, [c.name + ' ', c.active ? null : el('span', { class: 'tag off', text: '使っていない' })]),
            el('div', { class: 'sub' }, lines.map(function (t) { return el('div', { text: t }); })),
            el('div', { class: 'item-actions' }, [
              el('button', { type: 'button', class: 'btn primary', text: '今年度の日を見る・変える', on: { click: function () { openDays(c.calendarId, list.currentPeriod.from); } } }),
              el('button', { type: 'button', class: 'btn', text: '名前などを直す', on: { click: function () { openEdit(c); } } }),
            ]),
          ]));
        });
        if (!list.calendars.length) ul.appendChild(el('li', { class: 'sub', text: 'カレンダーはまだありません。「カレンダーを追加」から作ってください（例: 通信班・鉄道班・名鉄EI出向班）' }));
        var un = list.employees.filter(function (e) { return !e.calendarId; });
        $('unassigned').textContent = un.length
          ? 'カレンダーが未設定の社員が ' + un.length + ' 人います（' + un.map(function (e) { return e.name; }).join('・') + '）。「部署の管理」で、その人の部署の会社カレンダーを選んでください'
          : '';
        $('unassigned').hidden = !un.length;
      }

      function applyList(r) {
        if (!r.ok) { ui.pageMessage(r.message, 'error'); return false; }
        list = r.data;
        renderList();
        return true;
      }

      function loadList() { return MP.api.call('calendar.admin.list', {}).then(applyList); }

      // ------------------------------------------------ 名前・表示順・使っているか
      function openEdit(c) {
        editing = c;
        ui.pageMessage('');
        ui.clearFieldErrors($('edit-form'));
        $('edit-title').textContent = c ? 'カレンダーを直す' : 'カレンダーを追加';
        $('cal-name').value = c ? c.name : '';
        $('cal-order').value = c ? (c.order === null ? '' : c.order) : (list.calendars.length ? Math.max.apply(null, list.calendars.map(function (x) { return x.order || 0; })) + 1 : 1);
        $('cal-active').checked = c ? c.active : true;
        $('active-field').hidden = !c;
        // 協定の印（計画 stage2-standard-hours-plan.md 第4章）: 新しく足すときは入れておく。読めない（null）ときは空にして知らせる
        $('cal-variant').checked = c ? c.variant === true : true;
        $('variant-unknown').hidden = !(c && c.variant === null);
        show('edit-view');
      }

      $('add').addEventListener('click', function () { openEdit(null); });
      $('cancel').addEventListener('click', function () { ui.pageMessage(''); show('list-view'); });

      $('edit-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        ui.pageMessage('');
        ui.clearFieldErrors($('edit-form'));
        var name = $('cal-name').value.trim();
        var order = Number($('cal-order').value);
        var bad = false;
        if (!name || name.length > 30) { ui.fieldError($('cal-name'), 'カレンダーの名前を1〜30文字で入れてください'); bad = true; }
        if (!/^\d+$/.test($('cal-order').value.trim()) || order < 1 || order > 9999) { ui.fieldError($('cal-order'), '表示順を 1〜9999 の数字で入れてください'); bad = true; }
        if (bad) return;
        var next = { name: name, order: order, active: $('cal-active').checked, variant: $('cal-variant').checked };
        var base = editing ? { name: editing.name, order: editing.order, active: editing.active, variant: editing.variant } : null;
        // 前の版のサーバー（variant を返さない）には送らない
        if (editing && editing.variant === undefined) { delete next.variant; delete base.variant; }
        var args = editing
          ? { calendarId: editing.calendarId, base: base, next: next }
          : { calendarId: null, base: null, next: next };
        run(function () {
          return save('calendar.admin.saveCalendar', args).then(function (r) {
            if (r.ok) return loadList().then(function () { show('list-view'); ui.pageMessage('保存しました', 'ok'); });
            if (r.code === 'CONFLICT') {
              return ui.notice('他の人が先に変更しました', '一覧を読み込み直します。\n\n入力していた内容:\n名前: ' + next.name + '\n表示順: ' + next.order)
                .then(loadList).then(function () { show('list-view'); });
            }
            if (r.code === 'DUPLICATE_NAME') { ui.fieldError($('cal-name'), r.message); return; }
            ui.pageMessage(r.message, 'error');
          });
        });
      });

      // ------------------------------------------------ 1年分の区分
      function changedCount() {
        if (!cur) return 0;
        var n = 0;
        for (var i = 0; i < cur.days.length; i++) if (cur.days[i] !== cur.base.charAt(i)) n++;
        return n;
      }
      function dirty() { return !!cur && (changedCount() > 0); }

      /** 押せない日: 日曜（法定休日）と、確定後の今日以前 */
      function locked(i, date, dow) {
        if (dow === cur.rules.LEGAL_HOLIDAY_DOW) return '日曜は法定休日';
        if (cur.row && cur.row.confirmed && date <= cur.today) return '確定後は今日以前を変えられません';
        return '';
      }

      function renderSummary() {
        var s = C.summarize(cur.days.join(''), cur.period, cur.rules);
        var dl = ui.clear($('days-sum'));
        [['出勤日数', s.workDays + '日'], ['うち有給推奨', s.paidDays + '日'], ['休み', s.offDays + '日'], ['年間の所定', Math.floor(s.scheduledMinutes / 60) + '時間' + (s.scheduledMinutes % 60 ? (s.scheduledMinutes % 60) + '分' : '')],
          ['保存していない変更', changedCount() + '日']].forEach(function (kv) {
          dl.appendChild(el('div', {}, [el('dt', { text: kv[0] }), el('dd', { text: kv[1] })]));
        });
        var confirmed = cur.row && cur.row.confirmed;
        $('save-days').disabled = !!cur.row && !dirty();
        $('save-days').textContent = cur.row ? '保存する' : '保存する（この年度を作る）';
        $('confirm-days').hidden = !!confirmed;
        $('confirm-days').disabled = !cur.row || dirty();
        $('confirm-hint').textContent = confirmed ? ''
          : !cur.row ? '確定するには、先に保存してください'
            : dirty() ? '変えた日を保存してから確定できます'
              : '確定すると、法律の目安（時間外）はこのカレンダーで数えます。今日以前の日は、あとから変えられなくなります';
      }

      function renderDays() {
        $('days-title').textContent = cur.calendar.name + ' ' + V.periodName(cur.period);
        var st = $('days-status');
        if (!cur.row) { st.className = 'msg warn'; st.textContent = 'この年度はまだ作っていません。初めは「月〜金が出勤、土・日が休み」です。協定のカレンダーに合わせて日を押して直し、「保存する」を押してください'; }
        else if (cur.row.confirmed) { st.className = 'msg ok'; st.textContent = '確定済み（' + ui.fmtDateTime(cur.row.confirmedAt) + '）。今日（' + ui.fmtDate(cur.today) + '）以前の日は変えられません。明日以降の日は変えられます（変えても、法律の目安は確定したときのカレンダーで数えます）'; }
        else { st.className = 'msg info'; st.textContent = '下書きです。すべての日を変えられます。協定のカレンダーと合っていたら「確定する」を押してください'; }
        ui.clear($('legend')).appendChild(V.legend([['changed W', '出', '太い枠 = 保存していない変更']]));
        cur.view = V.render($('months'), {
          period: cur.period, rules: cur.rules,
          cell: function (i, date, dow) {
            var why = locked(i, date, dow);
            return { type: cur.days[i], disabled: !!why, changed: cur.days[i] !== cur.base.charAt(i), note: why };
          },
          onClick: function (i) {
            var next = { W: 'H', H: 'P', P: 'W' };
            cur.days[i] = next[cur.days[i]] || 'W';
            cur.view.refresh(i);
            renderSummary();
          },
        });
        renderSummary();
      }

      function applyDays(r) {
        if (!r.ok) { ui.pageMessage(r.message, 'error'); return false; }
        var d = r.data;
        // まだ作っていない年度は、初めの区分（月〜金 出勤）を元にする。初めの区分そのものは「変更」に数えない（保存のボタンは押せる）
        var base = d.row ? d.row.days : d.defaultDays;
        cur = { calendar: d.calendar, period: d.period, row: d.row, base: base, days: base.split(''), today: d.today, rules: d.rules, view: null };
        renderDays();
        show('days-view');
        return true;
      }

      function loadDays(calendarId, from) {
        return MP.api.call('calendar.admin.get', { calendarId: calendarId, from: from }).then(applyDays);
      }

      /** 保存していない変更があれば確かめる。進んでよければ true */
      function leaveOk() {
        if (!dirty()) return Promise.resolve(true);
        return ui.confirm('保存していない変更があります', changedCount() + '日の変更が消えます。保存せずに移りますか？', '保存せずに移る', 'danger');
      }

      function openDays(calendarId, from) {
        ui.pageMessage('');
        return run(function () { return loadDays(calendarId, from); });
      }

      function shiftPeriod(dir) {
        leaveOk().then(function (ok) {
          if (!ok) return;
          var n = dir < 0 ? C.dayNumber(cur.period.from) - 1 : C.dayNumber(cur.period.to) + 1;
          openDays(cur.calendar.calendarId, C.periodOf(C.dateOf(n), cur.rules).from);
        });
      }
      $('prev-period').addEventListener('click', function () { shiftPeriod(-1); });
      $('next-period').addEventListener('click', function () { shiftPeriod(1); });
      $('days-back').addEventListener('click', function () {
        leaveOk().then(function (ok) {
          if (!ok) return;
          cur = null;
          ui.pageMessage('');
          run(function () { return loadList().then(function () { show('list-view'); }); });
        });
      });

      window.addEventListener('beforeunload', function (ev) { if (dirty()) { ev.preventDefault(); ev.returnValue = ''; } });

      // ------------------------------------------------ ファイルから取り込む（計画 stage2-calendar-import-sw-plan.md 1-2）
      // 画面の区分（cur.days）を書き換えるだけ。保存はしない（今の「保存する」で保存する）。ファイルの中身はサーバーに送らない
      var CI = MP.calImport;
      var importing = false;

      function importFailed(errors) {
        return ui.notice('このファイルは取り込めません', 'カレンダーは何も変えていません。\n\n' + CI.errorText(errors));
      }

      function importFile(f) {
        var at = cur;
        var kind = CI.kindOf(f.name);
        if (!kind) return importFailed([{ line: null, text: '.csv か .xlsx のファイルを選んでください' }]);
        if (f.size > CI.LIMITS.FILE_MAX_BYTES) return importFailed([{ line: null, text: 'ファイルが大きすぎます（2MB まで）' }]); // 大きすぎるファイルは読まない
        return f.arrayBuffer().then(function (buf) {
          return CI.read(window.ExcelJS, kind, buf);
        }, function () {
          return { error: 'ファイルを読めませんでした' };
        }).then(function (r) {
          if (cur !== at) return;
          if (r.error) return importFailed([{ line: null, text: r.error }]);
          var c = CI.check(r.rows, { C: C, period: cur.period, rules: cur.rules, today: cur.today, confirmed: !!(cur.row && cur.row.confirmed), base: cur.base, days: cur.days });
          if (!c.ok) return importFailed(c.errors);
          var s = c.summary;
          var text = 'ファイル: ' + f.name + '\n' +
            '出勤 ' + s.workDays + ' 日（うち有給推奨 ' + s.paidDays + ' 日）・休み ' + s.offDays + ' 日\n' +
            '変わる日 ' + c.changed + ' 日・ファイルに無い日 ' + c.missing + ' 日（今のまま）' +
            (c.unsaved ? '\n\n保存していない変更 ' + c.unsaved + ' 日があります。その上に取り込みます。' : '') +
            '\n\n取り込んでも、まだ保存しません。見比べてから「保存する」を押してください。';
          return ui.confirm('このファイルを取り込みますか？', text, '取り込む').then(function (yes) {
            if (!yes || cur !== at) return;
            cur.days = c.days;
            cur.view.refreshAll();
            renderSummary();
            ui.pageMessage('取り込みました（まだ保存していません）。太い枠の日が変わった日です。見比べてから「保存する」を押してください', 'ok');
          });
        });
      }

      $('import').addEventListener('click', function () {
        if (!cur || importing) return;
        $('import-file').value = '';
        $('import-file').click();
      });
      $('import-file').addEventListener('change', function () {
        var input = $('import-file');
        var f = input.files && input.files[0];
        if (!f || !cur || importing) { input.value = ''; return; }
        importing = true;
        ui.pageMessage('');
        var p = run(function () { return importFile(f); });
        // 同じ名前のファイルを選び直しても読めるように、欄を空に戻す
        var end = function () { importing = false; input.value = ''; };
        if (p) p.then(end, function () { end(); ui.pageMessage('ファイルを読めませんでした', 'error'); }); else end();
      });

      function reloadAfterConflict(text) {
        return ui.notice('他の人が先に変更しました', text + '\n\n読み込み直します。変えていた日は、もう一度押し直してください。')
          .then(function () { return loadDays(cur.calendar.calendarId, cur.period.from); });
      }

      $('save-days').addEventListener('click', function () {
        ui.pageMessage('');
        var args = { calendarId: cur.calendar.calendarId, from: cur.period.from, baseVersion: cur.row ? cur.row.recordVersion : 0, days: cur.days.join('') };
        run(function () {
          return save('calendar.admin.saveDays', args).then(function (r) {
            if (r.ok) return loadDays(args.calendarId, args.from).then(function () { ui.pageMessage('保存しました', 'ok'); });
            if (r.code === 'CONFLICT') return reloadAfterConflict('このカレンダーは、開いた後に別の画面で保存されました。');
            ui.pageMessage(r.message, 'error');
          });
        });
      });

      $('confirm-days').addEventListener('click', function () {
        ui.pageMessage('');
        var s = C.summarize(cur.days.join(''), cur.period, cur.rules);
        ui.confirm('このカレンダーを確定しますか？',
          cur.calendar.name + ' ' + V.periodName(cur.period) + '\n出勤 ' + s.workDays + '日（うち有給推奨 ' + s.paidDays + '日）・年間 ' + Math.floor(s.scheduledMinutes / 60) + '時間\n\n' +
          '確定すると、法律の目安（時間外）はこのカレンダーで数えます。今日（' + ui.fmtDate(cur.today) + '）以前の日は、あとから変えられなくなります。確定は取り消せません。',
          '確定する').then(function (yes) {
          if (!yes) return;
          var args = { calendarId: cur.calendar.calendarId, from: cur.period.from, baseVersion: cur.row.recordVersion };
          run(function () {
            return save('calendar.admin.confirm', args).then(function (r) {
              if (r.ok) return loadDays(args.calendarId, args.from).then(function () { ui.pageMessage('確定しました', 'ok'); });
              if (r.code === 'CONFLICT') return reloadAfterConflict(r.message);
              ui.pageMessage(r.message, 'error');
            });
          });
        });
      });

      if (applyList(entered.res)) show('list-view'); // 開いたときは、入口の問い合わせの答えをそのまま使う（問い合わせ1回）
    });
  });
})();
