/* 管理者: 社員の一覧・追加・基本の編集・履歴（権限・部署など）・招待リンク・利用停止（master.admin.* と auth.admin.*） */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    return MP.guard.enter({ admin: true }).then(function () {
      var save = MP.api.saver();
      var data = { employees: [], departments: [], today: '', options: { roles: [], employmentTypes: [], breakTypes: [] } };
      var currentId = '';   // 詳しい画面で開いている社員
      var histBase = null;  // 直している履歴の行（新しい行なら null）
      var VIEWS = ['list-view', 'detail-view', 'hist-view', 'add-view'];
      var ROLE_MANAGER = '部長';

      function show(view) {
        VIEWS.forEach(function (v) { $(v).hidden = v !== view; });
        window.scrollTo(0, 0);
      }
      function findEmp(id) { return data.employees.filter(function (e) { return e.employeeId === id; })[0] || null; }
      function deptName(id) {
        var d = data.departments.filter(function (x) { return x.deptId === id; })[0];
        return d ? d.name + (d.active ? '' : '（無効）') : (id ? id : '—');
      }
      /** 今日の時点で有効な履歴の行（無ければ null） */
      function effective(e) {
        var best = null;
        e.history.forEach(function (h) { if (h.since <= data.today && (!best || h.since > best.since)) best = h; });
        return best;
      }
      function statusOf(e) {
        if (!e.active) return ['利用停止', 'off'];
        if (!e.history.length) return ['履歴なし', 'warn'];
        if (e.tempPassword) return e.tempValid ? ['仮パスワード', 'warn'] : ['招待待ち', 'warn'];
        return ['利用中', 'ok'];
      }
      function minutesText(n) { return n === null ? '—' : Math.floor(n / 60) + '時間' + (n % 60 ? (n % 60) + '分' : ''); }

      // ---------------- 入力の部品 ----------------

      function selectOf(id, label, values, texts) {
        var s = el('select', { id: id, 'aria-label': label });
        s.appendChild(el('option', { value: '', text: '選んでください' }));
        values.forEach(function (v, i) { s.appendChild(el('option', { value: String(v), text: texts ? texts[i] : String(v) })); });
        return s;
      }
      function setSelect(s, value, textIfMissing) {
        var v = String(value === null || value === undefined ? '' : value);
        if (v && !Array.prototype.some.call(s.options, function (o) { return o.value === v; })) s.appendChild(el('option', { value: v, text: textIfMissing || v }));
        s.value = v;
      }
      function field(labelText, forId, control, hint) {
        return el('div', { class: 'field' }, [
          forId ? el('label', { for: forId, text: labelText }) : el('span', { class: 'label', text: labelText }),
          control, hint ? el('p', { class: 'hint', text: hint }) : null,
        ]);
      }
      function range(a, b) { var out = []; for (var i = a; i <= b; i++) out.push(i); return out; }

      /** 日付（年・月・日の3つのプルダウン）。get() は { ok, value }（空なら ''） */
      function dateCtl(prefix, label, fromYear, toYear, required) {
        var years = range(fromYear, toYear).reverse();
        var y = selectOf(prefix + '-y', label + '（年）', years, years.map(function (v) { return v + '年'; }));
        var m = selectOf(prefix + '-m', label + '（月）', range(1, 12), range(1, 12).map(function (v) { return v + '月'; }));
        var d = selectOf(prefix + '-d', label + '（日）', range(1, 31), range(1, 31).map(function (v) { return v + '日'; }));
        var row = el('div', { class: 'row', id: prefix }, [y, m, d]);
        return {
          node: field(label, '', row, required ? '' : '分からなければ、3つとも「選んでください」のままにします'),
          row: row,
          set: function (v) {
            var p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
            setSelect(y, p ? Number(p[1]) : '', p ? Number(p[1]) + '年' : ''); m.value = p ? String(Number(p[2])) : ''; d.value = p ? String(Number(p[3])) : '';
          },
          get: function () {
            if (!y.value && !m.value && !d.value) return { ok: !required, value: '' };
            if (!y.value || !m.value || !d.value) return { ok: false, value: '' };
            var last = new Date(Date.UTC(Number(y.value), Number(m.value), 0)).getUTCDate();
            if (Number(d.value) > last) return { ok: false, value: '' };
            return { ok: true, value: y.value + '-' + ('0' + m.value).slice(-2) + '-' + ('0' + d.value).slice(-2) };
          },
        };
      }

      var thisYear = new Date().getFullYear();

      /** 基本の項目（名前・表示順・入社日・生年月日） */
      function basicCtl(container, p) {
        var name = el('input', { type: 'text', id: p + '-name', maxlength: '60', autocomplete: 'off' });
        var order = el('input', { type: 'text', id: p + '-order', inputmode: 'numeric', maxlength: '4', autocomplete: 'off' });
        var join = dateCtl(p + '-join', '入社日', 1980, thisYear + 2, false);
        var birth = dateCtl(p + '-birth', '生年月日', 1940, thisYear, false);
        ui.clear(container);
        container.appendChild(field('名前', name.id, name, 'ログインの画面の一覧に出ます。同じ名前の人がいるときは「佐藤（工事）」のように区別してください（30文字まで）'));
        container.appendChild(field('表示順', order.id, order, '一覧に並ぶ順番です（1〜9999。小さいほうが上）'));
        container.appendChild(join.node);
        container.appendChild(birth.node);
        return {
          set: function (v) { name.value = v.name; order.value = v.order === null ? '' : v.order; join.set(v.joinDate); birth.set(v.birthDate); },
          get: function () {
            var ok = true;
            var n = name.value.trim();
            if (!n || n.length > 30) { ui.fieldError(name, '名前を1〜30文字で入れてください'); ok = false; }
            if (!/^\d+$/.test(order.value.trim()) || Number(order.value) < 1 || Number(order.value) > 9999) { ui.fieldError(order, '表示順を 1〜9999 の数字で入れてください'); ok = false; }
            var j = join.get(), b = birth.get();
            if (!j.ok) { ui.fieldError(join.row, '入社日を、年・月・日の3つとも正しく選んでください'); ok = false; }
            if (!b.ok) { ui.fieldError(birth.row, '生年月日を、年・月・日の3つとも正しく選んでください'); ok = false; }
            return ok ? { name: n, order: Number(order.value), joinDate: j.value, birthDate: b.value } : null;
          },
        };
      }

      /** 履歴の項目（適用開始日・権限・部署・閲覧部署・雇用区分・所定労働時間・休憩方式） */
      function histCtl(container, p) {
        var since = dateCtl(p + '-since', 'いつから（適用開始日）', 1980, thisYear + 2, true);
        var role = selectOf(p + '-role', '権限', data.options.roles);
        var dept = el('select', { id: p + '-dept' });
        var viewBox = el('div', { id: p + '-view' });
        var viewField = field('閲覧できる部署（部長だけ）', '', viewBox, '部長が日報などを見られる部署を、1つ以上選びます');
        var emp = selectOf(p + '-emp', '雇用区分', data.options.employmentTypes);
        var brk = selectOf(p + '-break', '休憩方式', data.options.breakTypes);
        var hours = el('input', { type: 'text', id: p + '-hours', inputmode: 'numeric', maxlength: '2', autocomplete: 'off', 'aria-label': '1日の所定労働時間（時間）' });
        var mins = el('input', { type: 'text', id: p + '-mins', inputmode: 'numeric', maxlength: '2', autocomplete: 'off', 'aria-label': '1日の所定労働時間（分）' });
        var timeRow = el('div', { class: 'row', id: p + '-time' }, [hours, mins]);
        ui.clear(container);
        container.appendChild(since.node);
        container.appendChild(field('権限', role.id, role));
        container.appendChild(field('部署', dept.id, dept));
        container.appendChild(viewField);
        container.appendChild(field('雇用区分', emp.id, emp));
        container.appendChild(field('1日の所定労働時間（左に時間、右に分）', '', timeRow, '例: 8時間なら「8」と「0」、7時間30分なら「7」と「30」'));
        container.appendChild(field('休憩方式', brk.id, brk));
        role.addEventListener('change', function () { viewField.hidden = role.value !== ROLE_MANAGER; });

        function fillDepts(h) {
          var keep = h ? [h.deptId].concat(h.viewDeptIds) : [];
          var usable = data.departments.filter(function (d) { return d.active || keep.indexOf(d.deptId) >= 0; });
          ui.clear(dept);
          dept.appendChild(el('option', { value: '', text: '選んでください' }));
          usable.forEach(function (d) { dept.appendChild(el('option', { value: d.deptId, text: d.name + (d.active ? '' : '（無効）') })); });
          ui.clear(viewBox);
          usable.filter(function (d) { return d.active || (h && h.viewDeptIds.indexOf(d.deptId) >= 0); }).forEach(function (d) {
            var id = p + '-view-' + d.deptId;
            viewBox.appendChild(el('label', { class: 'check', for: id }, [
              el('input', { type: 'checkbox', id: id, value: d.deptId, checked: !!h && h.viewDeptIds.indexOf(d.deptId) >= 0 }), d.name + (d.active ? '' : '（無効）')]));
          });
        }

        return {
          /** h … 元にする行（無ければ空）。sinceValue … 適用開始日の初期値 */
          set: function (h, sinceValue) {
            fillDepts(h);
            since.set(sinceValue);
            setSelect(role, h ? h.role : '');
            setSelect(dept, h && data.departments.some(function (d) { return d.deptId === h.deptId; }) ? h.deptId : '');
            setSelect(emp, h ? h.employmentType : '');
            setSelect(brk, h ? h.breakType : '');
            var n = h && h.dailyMinutes !== null ? h.dailyMinutes : 480;
            hours.value = Math.floor(n / 60); mins.value = n % 60;
            viewField.hidden = role.value !== ROLE_MANAGER;
          },
          sinceRow: since.row,
          get: function () {
            var ok = true;
            var s = since.get();
            if (!s.ok) { ui.fieldError(since.row, 'いつからかを、年・月・日の3つとも正しく選んでください'); ok = false; }
            if (!role.value) { ui.fieldError(role, '権限を選んでください'); ok = false; }
            if (!dept.value) { ui.fieldError(dept, '部署を選んでください（無ければ、先に「部署の管理」で作ります）'); ok = false; }
            if (!emp.value) { ui.fieldError(emp, '雇用区分を選んでください'); ok = false; }
            if (!brk.value) { ui.fieldError(brk, '休憩方式を選んでください'); ok = false; }
            var view = role.value === ROLE_MANAGER
              ? Array.prototype.filter.call(viewBox.querySelectorAll('input'), function (c) { return c.checked; }).map(function (c) { return c.value; }) : [];
            if (role.value === ROLE_MANAGER && !view.length) { ui.fieldError(viewBox, '閲覧できる部署を1つ以上選んでください'); ok = false; }
            var hv = hours.value.trim(), mv = mins.value.trim() || '0';
            var total = Number(hv) * 60 + Number(mv);
            if (!/^\d+$/.test(hv) || !/^\d+$/.test(mv) || Number(mv) > 59 || total < 1 || total > 1440) { ui.fieldError(timeRow, '所定労働時間を、時間（0〜24）と分（0〜59）の数字で入れてください'); ok = false; }
            return ok ? { since: s.value, role: role.value, deptId: dept.value, viewDeptIds: view, employmentType: emp.value, dailyMinutes: total, breakType: brk.value } : null;
          },
        };
      }

      var basic = basicCtl($('basic-fields'), 'b');
      var addBasic = basicCtl($('add-basic'), 'a');
      var hist, addHist; // 部署・選択肢を読み込んだ後に作る

      // ---------------- 一覧 ----------------

      function renderList() {
        var cards = ui.clear($('emp-cards')), rows = ui.clear($('emp-rows'));
        data.employees.forEach(function (e) {
          var h = effective(e), st = statusOf(e);
          var openBtn = function () { return el('button', { type: 'button', class: 'btn', text: '開く', on: { click: function () { openDetail(e.employeeId); } } }); };
          cards.appendChild(el('li', {}, [
            el('div', { class: 'item-title' }, [e.name + ' ', el('span', { class: 'tag ' + st[1], text: st[0] })]),
            el('div', { class: 'sub', text: (h ? deptName(h.deptId) + '・' + h.role : '—') }),
            el('div', { class: 'item-actions' }, [openBtn()]),
          ]));
          rows.appendChild(el('tr', {}, [
            el('td', { text: e.name }), el('td', { text: h ? deptName(h.deptId) : '—' }), el('td', { text: h ? h.role : '—' }),
            el('td', {}, [el('span', { class: 'tag ' + st[1], text: st[0] })]), el('td', {}, [openBtn()]),
          ]));
        });
      }

      function load() {
        return MP.api.call('master.admin.list', {}).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return false; }
          data = r.data;
          hist = histCtl($('hist-fields'), 'h');
          addHist = histCtl($('add-hist'), 'ah');
          renderList();
          return true;
        });
      }

      /** 読み込み直して、開いていた社員の詳しい画面（いなければ一覧）を出す */
      function reload(message, kind) {
        return load().then(function (ok) {
          if (!ok) return;
          if (currentId && findEmp(currentId)) renderDetail(); else { currentId = ''; show('list-view'); }
          if (message) ui.pageMessage(message, kind || 'ok');
        });
      }

      function conflict(lines) {
        return ui.notice('他の人が先に変更しました', '読み込み直します。\n\n入力していた内容:\n' + lines.join('\n')).then(function () { return reload(); });
      }

      // ---------------- 詳しい画面 ----------------

      function openDetail(id) { currentId = id; ui.pageMessage(''); renderDetail(); }

      function histLine(h) {
        var parts = [h.role || '—', deptName(h.deptId), h.employmentType || '—', minutesText(h.dailyMinutes), h.breakType || '—'];
        if (h.viewDeptIds.length) parts.push('閲覧: ' + h.viewDeptIds.map(deptName).join('・'));
        return parts.join(' ／ ');
      }

      function renderDetail() {
        var e = findEmp(currentId);
        var st = statusOf(e);
        ui.clearFieldErrors($('basic-form'));
        ui.clear($('detail-name')).appendChild(document.createTextNode(e.name + ' '));
        $('detail-name').appendChild(el('span', { class: 'tag ' + st[1], text: st[0] }));
        var note = !e.active && !e.suspendedOn ? '利用停止中です（追加の途中で止まった人です。社員履歴を確かめてから、利用を再開してください）。ログインできません'
          : !e.active ? '利用停止中です（' + ui.fmtDate(e.suspendedOn) + ' から）。ログインできません'
          : !e.history.length ? '権限などの履歴がまだありません。下の「変更を足す」から登録してください'
            : e.tempPassword && !e.tempValid ? 'まだログインできません。下の「招待リンクを出す」を押して、本人に送ってください'
              : e.tempPassword ? '仮パスワードのままです（' + ui.fmtDateTime(e.tempExpiresAt) + ' まで）' : '';
        $('detail-note').textContent = note + (e.inviteExpiresAt ? (note ? '。' : '') + '未使用の招待があります（' + ui.fmtDateTime(e.inviteExpiresAt) + ' まで）' : '');
        $('detail-note').hidden = !$('detail-note').textContent;
        basic.set(e);

        var cur = effective(e);
        var now = ui.clear($('current'));
        now.appendChild(cur ? el('p', { text: histLine(cur) }) : el('p', { class: 'sub', text: '今日の時点で有効な内容はありません' }));

        var list = ui.clear($('hist-list'));
        e.history.slice().reverse().forEach(function (h) {
          list.appendChild(el('li', {}, [
            el('div', { class: 'item-title' }, [ui.fmtDate(h.since) + ' から ',
              h.since > data.today ? el('span', { class: 'tag warn', text: 'これから' }) : h === cur ? el('span', { class: 'tag ok', text: '今' }) : null]),
            el('div', { text: histLine(h) }),
            el('div', { class: 'item-actions' }, [el('button', { type: 'button', class: 'btn', text: '直す', on: { click: function () { openHist(h); } } })]),
          ]));
        });
        if (!e.history.length) list.appendChild(el('li', { class: 'sub', text: '履歴はまだありません' }));

        var acts = ui.clear($('actions'));
        var button = function (text, fn, kind) { acts.appendChild(el('button', { type: 'button', class: 'btn block' + (kind ? ' ' + kind : ''), text: text, on: { click: fn } })); };
        if (e.active) {
          button('招待リンクを出す', function () { invite(e, e.tempPassword); }, 'primary');
          if (!e.tempPassword) button('パスワードを作り直す', function () { invite(e, true); });
          button('ログインをすべて取消', function () {
            act('ログインをすべて取消しますか？', e.name + ' さんは、すべての端末でログインし直しになります。', '取消す', 'auth.admin.revokeSessions', 'ログインを取消しました');
          });
          button('名前の一覧用の番号を作り直す', function () {
            act('番号を作り直しますか？', e.name + ' さんは、すべての端末でログインし直しになります。ログインの画面の名前の一覧に問題があるときだけ使ってください。', '作り直す', 'auth.admin.reissueLoginId', '作り直しました');
          });
          button('利用停止にする', function () {
            act('利用停止にしますか？', e.name + ' さんはログインできなくなり、名前の一覧にも出なくなります。日報などの記録は残ります。', '利用停止にする', 'auth.admin.suspend', '利用停止にしました');
          }, 'danger');
        } else {
          button('利用を再開する', function () {
            act('利用を再開しますか？', e.name + ' さんが、またログインできるようになります。', '再開する', 'auth.admin.reinstate', '利用を再開しました');
          });
        }
        show('detail-view');
      }

      /** 確認のあと、社員ID だけを渡す管理者の処理を呼ぶ */
      function act(title, text, okLabel, action, doneText) {
        ui.confirm(title, text, okLabel, action === 'auth.admin.suspend' ? 'danger' : 'primary').then(function (yes) {
          if (!yes) return;
          ui.pageMessage('');
          ui.run(function () {
            return save(action, { employeeId: currentId }).then(function (r) {
              if (!r.ok) { ui.pageMessage(r.code === 'NETWORK' ? 'できたか分かりません。もう一度同じボタンを押してください' : r.message, 'error'); return; }
              return reload(doneText);
            });
          });
        });
      }

      function invite(e, reset) {
        var text = reset
          ? (e.tempPassword
            ? '招待リンクと仮パスワードを新しく作ります。前に出した招待と仮パスワードは使えなくなります。'
            : 'パスワードを忘れたとき用です。仮パスワードと招待リンクを新しく作ります。' + e.name + ' さんは、すべての端末でログインし直しになります。')
          : '新しい端末を登録するための招待リンクを出します。パスワードはそのままです。前に出した未使用の招待は使えなくなります。';
        ui.confirm(reset && !e.tempPassword ? 'パスワードを作り直しますか？' : '招待リンクを出しますか？', text, '出す').then(function (yes) {
          if (!yes) return;
          ui.pageMessage('');
          ui.run(function () {
            return MP.api.call('auth.admin.issueInvite', { employeeId: e.employeeId, resetPassword: reset }).then(function (r) {
              if (!r.ok) {
                ui.pageMessage(r.code === 'NETWORK' ? '出せたか分かりません。もう一度押してください。前に出たものは使わないでください' : r.message, 'error');
                return;
              }
              return r.data;
            });
          }).then(function (d) {
            if (!d) return;
            var lines = ['名和電設ポータルの招待です。下のリンクを開いて、端末を登録してください。', d.url];
            if (d.tempPassword) lines.push('仮パスワード: ' + d.tempPassword);
            lines.push('期限: ' + ui.fmtDateTime(d.expiresAt) + ' まで');
            var urlBox = el('div', { class: 'secret-box', id: 'invite-url', text: d.url });
            var pwBox = d.tempPassword ? el('div', { class: 'secret-box', id: 'invite-temp', text: d.tempPassword }) : null;
            var copied = el('p', { class: 'sub', role: 'status' });
            var body = el('div', {}, [
              el('p', { class: 'msg warn', text: 'この画面を閉じると、招待リンクと仮パスワードは二度と出せません。閉じる前に、LINE などで本人に送ってください。' }),
              el('p', { class: 'sub', text: '招待リンク（' + ui.fmtDateTime(d.expiresAt) + ' まで）' }), urlBox,
              pwBox ? el('p', { class: 'sub', text: '仮パスワード' }) : null, pwBox,
              el('button', {
                type: 'button', class: 'btn block', id: 'invite-copy', text: 'まとめてコピーする',
                on: { click: function () {
                  var done = function (ok) { copied.textContent = ok ? 'コピーしました。LINE に貼り付けて送ってください' : 'コピーできませんでした。上の文字を長押しして、コピーしてください'; };
                  try { navigator.clipboard.writeText(lines.join('\n')).then(function () { done(true); }, function () { done(false); }); } catch (x) { done(false); }
                } },
              }), copied,
            ]);
            return ui.dialog({
              title: e.name + ' さんの招待', body: body, buttons: [{ label: '送ったので閉じる', value: true }],
              onClose: function () { urlBox.textContent = ''; if (pwBox) pwBox.textContent = ''; lines.length = 0; },
            }).then(function () { return reload(); });
          });
        });
      }

      // ---------------- 基本の保存 ----------------

      $('basic-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        ui.pageMessage('');
        ui.clearFieldErrors($('basic-form'));
        var e = findEmp(currentId);
        var next = basic.get();
        if (!next) return;
        var args = { employeeId: e.employeeId, base: { name: e.name, order: e.order, joinDate: e.joinDate, birthDate: e.birthDate }, next: next };
        ui.run(function () {
          return save('master.admin.updateEmployee', args).then(function (r) {
            if (r.ok) return reload('保存しました');
            if (r.code === 'CONFLICT') return conflict(['名前: ' + next.name, '表示順: ' + next.order, '入社日: ' + (next.joinDate || '—'), '生年月日: ' + (next.birthDate || '—')]);
            if (r.code === 'DUPLICATE_NAME') ui.fieldError($('b-name'), r.message);
            else ui.pageMessage(r.message, 'error');
          });
        });
      });

      // ---------------- 履歴の追加・修正 ----------------

      function openHist(h) {
        var e = findEmp(currentId);
        histBase = h;
        ui.pageMessage('');
        ui.clearFieldErrors($('hist-view'));
        $('hist-title').textContent = e.name + ' さん: ' + (h ? ui.fmtDate(h.since) + ' からの内容を直す' : '変更を足す');
        $('hist-lead').textContent = h
          ? 'まちがいを直すときに使います。これからの変更（異動・権限の変更など）は、戻って「変更を足す」を使ってください。'
          : '「いつから」の日付から、下の内容に変わります。今の内容を写してあるので、変わる所だけ直してください。';
        hist.set(h || effective(e) || e.history[e.history.length - 1] || null, h ? h.since : data.today);
        show('hist-view');
      }

      $('hist-add').addEventListener('click', function () { openHist(null); });
      $('hist-cancel').addEventListener('click', function () { ui.pageMessage(''); renderDetail(); });

      $('hist-view').addEventListener('submit', function (ev) {
        ev.preventDefault();
        ui.pageMessage('');
        ui.clearFieldErrors($('hist-view'));
        var e = findEmp(currentId);
        var next = hist.get();
        if (!next) return;
        if (e.history.some(function (h) { return h !== histBase && h.since === next.since; })) {
          ui.fieldError(hist.sinceRow, 'この日付からの内容は、もう登録されています。戻って、その行の「直す」から直してください');
          return;
        }
        var args = { employeeId: e.employeeId, baseSince: histBase ? histBase.since : null, base: histBase, next: next };
        ui.run(function () {
          return save('master.admin.saveHistory', args).then(function (r) {
            if (r.ok) return reload('保存しました');
            if (r.code === 'CONFLICT') return conflict([ui.fmtDate(next.since) + ' から', histLine(next)]);
            ui.pageMessage(r.message, 'error');
          });
        });
      });

      // ---------------- 社員の追加 ----------------

      $('add').addEventListener('click', function () {
        ui.pageMessage('');
        ui.clearFieldErrors($('add-view'));
        var max = data.employees.reduce(function (n, e) { return Math.max(n, e.order || 0); }, 0);
        addBasic.set({ name: '', order: Math.min(max + 1, 9999), joinDate: '', birthDate: '' });
        addHist.set(null, data.today);
        show('add-view');
      });
      $('add-cancel').addEventListener('click', function () { ui.pageMessage(''); show('list-view'); });

      $('add-view').addEventListener('submit', function (ev) {
        ev.preventDefault();
        ui.pageMessage('');
        ui.clearFieldErrors($('add-view'));
        var b = addBasic.get(), h = addHist.get();
        if (!b || !h) return;
        var args = { name: b.name, order: b.order, joinDate: b.joinDate, birthDate: b.birthDate, history: h };
        ui.run(function () {
          return save('master.admin.addEmployee', args).then(function (r) {
            if (r.ok) {
              currentId = r.data.employeeId;
              return reload('追加しました。まだログインできません。下の「招待リンクを出す」を押して、本人に送ってください', 'info');
            }
            if (r.code === 'DUPLICATE_NAME') ui.fieldError($('a-name'), r.message);
            else ui.pageMessage(r.message, 'error');
          });
        });
      });

      $('back').addEventListener('click', function () { currentId = ''; ui.pageMessage(''); show('list-view'); });

      return load().then(function (ok) { if (ok) { $('emp').hidden = false; show('list-view'); } });
    });
  });
})();
