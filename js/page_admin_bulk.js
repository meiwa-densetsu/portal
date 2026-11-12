/*
 * 管理者: Excel から貼り付けて部署・社員をまとめて登録（計画 docs/plans/stage1-bulk-plan.md）
 * 計算は bulk.js。保存は今ある処理（master.admin.saveDepartment・addEmployee・updateEmployee・saveHistory）を1件ずつ呼ぶ
 *
 * 送り残しの記録: 保存1件を送る前に localStorage に「action・args・requestId」を書き、結果がはっきりしたら消す。
 * 1件ごとに別のキー（PREFIX + requestId）。残っていれば、普通の流れより先に同じ requestId で送り直して結果をはっきりさせる
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var UNKNOWN = ['NETWORK', 'INTERNAL', 'BUSY'];
    var ACTIONS = ['master.admin.saveDepartment', 'master.admin.addEmployee', 'master.admin.updateEmployee', 'master.admin.saveHistory'];
    var ui = MP.ui, $ = ui.$, el = ui.el, bulk = MP.bulk;
    return MP.guard.enter({ admin: true, load: { action: 'master.admin.list' } }).then(function (entered) {
      var me = entered.me;
      var data = entered.res.data;
      var mode = 'dept';
      var plan = null;      // 確かめた結果（planDepartments / planEmployees の答え）
      var planKey = '';     // 確かめた保存の一覧（action と args）の文字
      var running = false;
      // 送り残しの記録は、管理者の社員ID ごとに分ける（名前は変わることがあるので使わない）
      if (typeof me.employeeId !== 'string' || !/^E\d{4,}$/.test(me.employeeId)) {
        ui.pageMessage('画面が古くなっています。画面を読み込み直してください', 'error');
        return;
      }
      var PREFIX = 'mp_bulk_pending:' + me.employeeId + ':';
      $('bulk').hidden = false;

      // ------------------------------------------------ 送り残しの記録
      function storageOk() {
        try {
          var k = 'mp_bulk_storage_check'; // 送り残しのキー（PREFIX）とは別の名前で試す（記録を上書きしない）
          window.localStorage.setItem(k, '1');
          window.localStorage.removeItem(k);
          return true;
        } catch (e) { return false; }
      }
      function listPending() {
        var out = [];
        var bad = false;
        for (var i = 0; i < window.localStorage.length; i++) {
          var k = window.localStorage.key(i);
          if (!k || k.indexOf(PREFIX) !== 0) continue;
          try {
            var v = JSON.parse(window.localStorage.getItem(k));
            // キーの末尾と中の requestId が同じ・決まった保存の処理・args がオブジェクト、でなければ「読めない記録」（消さずに止める）
            if (!v || typeof v.requestId !== 'string' || k !== PREFIX + v.requestId || ACTIONS.indexOf(v.action) < 0 ||
              !v.args || typeof v.args !== 'object' || Array.isArray(v.args) || typeof v.at !== 'number') throw new Error('形');
            out.push(v);
          } catch (e) { bad = true; }
        }
        out.sort(function (a, b) { return a.at - b.at; });
        return { items: out, bad: bad };
      }
      function putPending(op) {
        window.localStorage.setItem(PREFIX + op.requestId, JSON.stringify({ action: op.action, args: op.args, requestId: op.requestId, label: op.label, at: Date.now() }));
      }
      function dropPending(rid) {
        try { window.localStorage.removeItem(PREFIX + rid); } catch (e) { /* 次に開いたときに送り直して消す */ }
      }

      if (!storageOk()) {
        $('main').hidden = true;
        ui.pageMessage('この端末では途中の記録を残せないため、まとめて登録を使えません。社員の管理の画面で1件ずつ登録してください', 'error');
        return;
      }

      function onLeave(ev) { if (running) { ev.preventDefault(); ev.returnValue = ''; } }
      window.addEventListener('beforeunload', onLeave);

      // ------------------------------------------------ 保存1件
      /** 1件を送る。結果が分からなければ同じ requestId で1回だけ送り直す。返り値: { state: 'ok' | 'denied' | 'unknown', message } */
      function sendOne(op) {
        var attempt = function () { return MP.api.call(op.action, op.args, { requestId: op.requestId }); };
        return attempt().then(function (r) {
          if (!r.ok && UNKNOWN.indexOf(r.code) >= 0) return attempt();
          return r;
        }).then(function (r) {
          if (r.ok) return { state: 'ok', message: '保存しました' };
          if (UNKNOWN.indexOf(r.code) >= 0) return { state: 'unknown', message: '保存できたか分かりません（' + r.message + '）' };
          return { state: 'denied', message: '保存できませんでした: ' + r.message };
        });
      }

      function resultLine(label, res) {
        return el('li', {}, [
          el('div', { class: 'item-title' }, [label + ' ', el('span', { class: 'tag ' + (res.state === 'ok' ? 'ok' : res.state === 'skip' ? 'warn' : 'off'), text: res.state === 'ok' ? '保存しました' : res.state === 'skip' ? '送っていません' : res.state === 'unknown' ? '分かりません' : 'できませんでした' })]),
          res.state === 'ok' ? null : el('p', { class: 'bulk-err', text: res.message }),
        ]);
      }

      /** ops を1件ずつ送る（送る前に記録・はっきりしたら消す）。結果の分からない件で止まる。返り値: 止まったか */
      function runOps(ops, list) {
        var failedGroups = {};
        var i = 0;
        running = true;
        function next() {
          if (i >= ops.length) return Promise.resolve(false);
          var op = ops[i++];
          $('progress').textContent = i + ' / ' + ops.length + ' 件目を保存しています';
          if (op.part === 'history' && failedGroups[op.group]) {
            list.appendChild(resultLine(op.label, { state: 'skip', message: '基本が保存できなかったので、履歴は送っていません' }));
            return next();
          }
          try { putPending(op); } catch (e) {
            list.appendChild(resultLine(op.label, { state: 'unknown', message: '途中の記録を残せないため、ここで止めました（まだ送っていません）' }));
            return Promise.resolve(true);
          }
          return sendOne(op).then(function (res) {
            list.appendChild(resultLine(op.label, res));
            if (res.state === 'unknown') return true; // 記録は残す（次に開いたとき・確かめるときに送り直す）
            dropPending(op.requestId);
            if (res.state === 'denied') failedGroups[op.group] = true;
            return next();
          });
        }
        return next().then(function (stopped) { running = false; return stopped; }, function (e) { running = false; throw e; });
      }

      // ------------------------------------------------ 前回の続き
      function showPending() {
        var p = listPending();
        if (p.bad) {
          $('pending').hidden = false; $('main').hidden = true; $('resume').hidden = true;
          $('pending-text').textContent = '読めない途中の記録があります。管理者に連絡してください';
          return true;
        }
        if (!p.items.length) { $('pending').hidden = true; $('main').hidden = false; return false; }
        $('pending').hidden = false; $('main').hidden = true; $('resume').hidden = false;
        $('pending-text').textContent = '前回、結果が分からない保存が ' + p.items.length + ' 件あります。先に「前回の続きを確かめる」を押してください（同じ保存として送り直すので、二重にはなりません）';
        var list = ui.clear($('pending-list'));
        p.items.forEach(function (x) { list.appendChild(el('li', { text: x.label || x.action })); });
        return true;
      }

      $('resume').addEventListener('click', function () {
        ui.run(function () {
          var items = listPending().items;
          var list = ui.clear($('result-list'));
          ui.clear($('followup'));
          $('result').hidden = false;
          $('pending').hidden = true;
          $('main').hidden = false;
          var ops = items.map(function (x) { return { action: x.action, args: x.args, requestId: x.requestId, label: x.label || x.action, group: x.requestId }; });
          return runOps(ops, list).then(function (stopped) {
            $('progress').textContent = stopped ? '結果の分からない保存があります。電波の良いところで、もう一度開いてください' : '前回の続きを確かめました。もう一度「確かめる」を押すと、残りが出ます';
            return reloadData();
          }).then(function () { showPending(); });
        });
      });

      // ------------------------------------------------ 書き出し・確かめ・登録
      function setMode(m) {
        mode = m;
        $('tab-dept').setAttribute('aria-selected', String(m === 'dept'));
        $('tab-emp').setAttribute('aria-selected', String(m === 'emp'));
        $('export-hint').textContent = m === 'dept'
          ? '今の部署を、Excel にそのまま貼れる形でコピーします。部署ID が空の行は新しい部署になります'
          : '今の社員を、Excel にそのまま貼れる形でコピーします。部署の名前を変えた・足したときは、部署を登録してから書き出し直してください';
        $('paste-hint').textContent = m === 'dept'
          ? '「使っている」は はい／いいえ。表で部署を消すことはできません'
          : '社員ID が空の行は新しい人です。適用開始日（権限〜休憩方式を変える日）は 2026/4/1 の形で。空なら今日からです。カレンダーの列は、カレンダーの名前で入れます（空なら未設定。列ごと消した表ではカレンダーを変えません）。1人につき最大2件（基本と履歴）の保存になり、途中で止まると一部だけ反映されます';
        $('export-fallback').hidden = true;
        $('paste').value = '';
        $('preview').hidden = true;
        $('result').hidden = true;
        plan = null; planKey = '';
      }
      $('tab-dept').addEventListener('click', function () { if (!running) setMode('dept'); });
      $('tab-emp').addEventListener('click', function () { if (!running) setMode('emp'); });

      function reloadData() {
        return MP.api.call('master.admin.list', {}).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return false; }
          data = r.data;
          return true;
        });
      }

      $('export').addEventListener('click', function () {
        ui.run(function () {
          return reloadData().then(function (ok) {
            if (!ok) return;
            var text = mode === 'dept' ? bulk.exportDepartments(data) : bulk.exportEmployees(data);
            var fallback = function () {
              $('export-fallback').hidden = false;
              $('export-text').value = text;
              $('export-text').focus();
              $('export-text').select();
            };
            try {
              return navigator.clipboard.writeText(text).then(function () {
                $('export-fallback').hidden = true;
                ui.pageMessage('コピーしました。Excel の新しいシートの A1 に貼り付けてください', 'ok');
              }, fallback);
            } catch (e) { fallback(); }
          });
        });
      });

      function computePlan() {
        var text = $('paste').value;
        var p = mode === 'dept' ? bulk.planDepartments(text, data) : bulk.planEmployees(text, data);
        var key = p.fatal ? '' : JSON.stringify(p.ops.map(function (o) { return [o.action, o.args]; }));
        return { plan: p, key: key };
      }

      function renderPlan() {
        var list = ui.clear($('preview-list'));
        $('preview').hidden = false;
        $('result').hidden = true;
        var btn = $('register');
        if (plan.fatal) {
          $('preview-summary').textContent = plan.fatal;
          btn.hidden = true;
          return;
        }
        plan.rows.forEach(function (r) {
          if (!r.errors.length && !r.ops.length) return;
          list.appendChild(el('li', {}, [
            el('div', { class: 'item-title', text: r.line + '行目: ' + r.label }),
          ].concat(r.ops.map(function (o) { return el('p', { class: 'bulk-op', text: '・' + o.label }); }))
            .concat(r.notes.map(function (n) { return el('p', { class: 'bulk-note', text: n }); }))
            .concat(r.errors.map(function (e) { return el('p', { class: 'bulk-err', text: '誤り: ' + e }); }))));
        });
        var summary = '変わらない行 ' + plan.unchanged + ' 件。';
        if (plan.errorCount) {
          summary += '誤りが ' + plan.errorCount + ' か所あります。直してから、もう一度貼り付けて「確かめる」を押してください（誤りがあると登録できません）';
          btn.hidden = true;
        } else if (!plan.ops.length) {
          summary += '登録する変更はありません';
          btn.hidden = true;
        } else {
          summary += '保存は ' + plan.ops.length + ' 件です（1件 2〜5秒ほどかかります）';
          btn.hidden = false;
          btn.textContent = 'この内容で登録する（' + plan.ops.length + ' 件）';
        }
        $('preview-summary').textContent = summary;
      }

      $('check').addEventListener('click', function () {
        if (showPending()) return;
        if (!$('paste').value.trim()) { ui.pageMessage('Excel の表を貼り付けてください', 'error'); return; }
        ui.run(function () {
          return reloadData().then(function (ok) {
            if (!ok) return;
            ui.pageMessage('');
            var c = computePlan();
            plan = c.plan; planKey = c.key;
            // 件ごとの requestId は、確かめた時点で作って持たせる（送り直しは必ず同じ requestId）
            if (!plan.fatal) plan.ops.forEach(function (o) { o.requestId = MP.api.newRequestId(); });
            renderPlan();
          });
        });
      });

      $('register').addEventListener('click', function () {
        if (!plan || plan.fatal || !plan.ops.length) return;
        if (showPending()) return;
        ui.run(function () {
          return reloadData().then(function (ok) {
            if (!ok) return;
            var c = computePlan();
            if (c.key !== planKey) {
              // 確かめた後に、日付が変わった・他の人が直した、など。登録せずに確かめ直してもらう
              plan = c.plan; planKey = c.key;
              if (!plan.fatal) plan.ops.forEach(function (o) { o.requestId = MP.api.newRequestId(); });
              renderPlan();
              ui.pageMessage('確かめた後に内容が変わりました（日付が変わった・他の人が直した、など）。一覧を確かめ直してから、もう一度押してください', 'error');
              return;
            }
            ui.pageMessage('');
            $('preview').hidden = true;
            $('result').hidden = false;
            var list = ui.clear($('result-list'));
            ui.clear($('followup'));
            $('to-employees').hidden = true;
            return runOps(plan.ops, list).then(function (stopped) {
              plan = null; planKey = '';
              $('progress').textContent = stopped
                ? '結果の分からない保存があるため、ここで止めました。電波の良いところで「確かめる」を押すと、続きを確かめられます'
                : '終わりました。保存できなかった件があれば、直してからもう一度「確かめる」を押すと、残りだけが出ます';
              return reloadData();
            }).then(function () { followup(); });
          });
        });
      });

      /** 招待がまだの人・利用停止中・作成中の人の案内 */
      function followup() {
        if (mode !== 'emp') return;
        var list = ui.clear($('followup'));
        var any = false;
        data.employees.forEach(function (e) {
          var why = !e.active ? (e.suspendedOn ? '利用停止中です' : '作成中です（利用の再開が要ります）') : (e.tempPassword && !e.inviteExpiresAt ? '招待がまだです' : '');
          if (!why) return;
          any = true;
          list.appendChild(el('li', { text: e.name + ': ' + why }));
        });
        $('to-employees').hidden = !any;
      }

      setMode('dept');
      showPending();
    });
  });
})();
