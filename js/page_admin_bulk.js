/*
 * 管理者: Excel のファイルで部署・社員をまとめて登録（計画 docs/plans/stage1-bulk-excel-plan.md 2-3）
 * 計算は bulk.js、ファイルの形と読み書きは bulk_book.js。保存は今ある処理（master.admin.saveDepartment・addEmployee・updateEmployee・saveHistory）を1件ずつ呼ぶ
 *
 * 流れ: 書き出す（ファイルを作って保存）→ 書き足したファイルを選ぶ → 部署と社員を1回で確かめる → 登録（部署が全部保存できたときだけ、社員へ進む）
 * ファイルの中身はどこにも送らない（送るのは保存の1件ずつだけ）。読み込んだファイル・計画は、ページを離れると消える
 *
 * 途中の記録（計画 docs/plans/stage2-employee-fields-plan.md 10-4・10-7〜10-9。端末に番号・金額・名前・planKey の文字を残さない）:
 *   mp_bulk_pending:<社員ID>:<requestId> … 結果の分からない保存 1 件。{ action, requestId, at } だけ。送る前に書き、結果がはっきりしたら消す
 *   mp_bulk_import:<社員ID>             … 1 回の取り込みの全部の操作（成功した分も）。{ at, count, items: [{ requestId, action }] } だけ。
 *                                          「取り込みを終える」を押すか、次の取り込み（「登録する」）を始めたときだけ消す（ログアウト・別の人のログインでも消す。store.js）
 *   結果の分からない保存の続きは、元の引数を作り直さずに、サーバー（master.admin.settleRequests）に requestId で結果を確定してもらう。
 *   登録されていない分は、Excel を読み込み直して、新しい requestId で送る
 *   settleRequests が返す「足せていた社員の名前 → 社員ID」の対応は、この画面を開いている間だけメモリに持ち、読み込み直しで使う（端末に残さない）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var UNKNOWN = ['NETWORK', 'INTERNAL', 'BUSY'];
    var ACTIONS = ['master.admin.saveDepartment', 'master.admin.addEmployee', 'master.admin.updateEmployee', 'master.admin.saveHistory'];
    var ui = MP.ui, $ = ui.$, el = ui.el, bulk = MP.bulk, book = MP.bulkBook;
    return MP.guard.enter({ admin: true, load: { action: 'master.admin.list' } }).then(function (entered) {
      var me = entered.me;
      var data = entered.res.data;
      var fileRows = null;  // 読み込んだファイルの行（{ departments, employees }）。ページを離れると消える
      var checked = null;   // 確かめた結果（analyze の答え。確かめたときの目印を持つ）
      var running = false;
      // 送り残しの記録は、管理者の社員ID ごとに分ける（名前は変わることがあるので使わない）
      if (typeof me.employeeId !== 'string' || !/^E\d{4,}$/.test(me.employeeId)) {
        ui.pageMessage('画面が古くなっています。画面を読み込み直してください', 'error');
        return;
      }
      var PREFIX = 'mp_bulk_pending:' + me.employeeId + ':';
      var IMPORT_KEY = 'mp_bulk_import:' + me.employeeId;
      var RID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      var ACTION_NAMES = { 'master.admin.saveDepartment': '部署の保存', 'master.admin.addEmployee': '社員を足す', 'master.admin.updateEmployee': '社員の基本の保存', 'master.admin.saveHistory': '社員の履歴の保存' };
      var knownIds = {}; // 前の取り込みで足せていた社員の 名前の鍵 → 社員ID（この画面を開いている間だけ。計画 10-8・10-9）
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
            // キーの末尾と中の requestId が同じ・requestId の形・決まった保存の処理・日時、でなければ「読めない記録」（消さずに止める）。
            // 前の版の記録（送る中身 args を持つ）も読める。中身は使わず、requestId だけで結果を確定して消す
            if (!v || typeof v.requestId !== 'string' || !RID.test(v.requestId) || k !== PREFIX + v.requestId || ACTIONS.indexOf(v.action) < 0 || typeof v.at !== 'number') throw new Error('形');
            out.push({ requestId: v.requestId, action: v.action, at: v.at });
          } catch (e) { bad = true; }
        }
        out.sort(function (a, b) { return a.at - b.at; });
        return { items: out, bad: bad };
      }
      function putPending(op) {
        window.localStorage.setItem(PREFIX + op.requestId, JSON.stringify({ action: op.action, requestId: op.requestId, at: Date.now() }));
      }
      function dropPending(rid) {
        try { window.localStorage.removeItem(PREFIX + rid); } catch (e) { /* 次に開いたときに確定して消す */ }
      }

      // 1 回の取り込みの記録（全部の操作の requestId と処理の名前だけ。計画 10-9）
      /** 返り値: null（無い）・{ bad: true }（読めない）・{ at, count, items } */
      function readImport() {
        var raw;
        try { raw = window.localStorage.getItem(IMPORT_KEY); } catch (e) { return null; }
        if (raw === null || raw === '') return null;
        try {
          var v = JSON.parse(raw);
          if (!v || typeof v.at !== 'number' || typeof v.count !== 'number' || !Array.isArray(v.items) ||
            !v.items.every(function (x) { return x && typeof x.requestId === 'string' && RID.test(x.requestId) && ACTIONS.indexOf(x.action) >= 0; })) throw new Error('形');
          return { at: v.at, count: v.count, items: v.items.map(function (x) { return { requestId: x.requestId, action: x.action }; }) };
        } catch (e) { return { bad: true }; }
      }
      /** 取り込みを始める（前の取り込みの記録を消して、空の記録を書く）。書けなければ例外 */
      function startImport(count) {
        window.localStorage.setItem(IMPORT_KEY, JSON.stringify({ at: Date.now(), count: count, items: [] }));
      }
      /** 送る前に、操作を取り込みの記録に足す。書けなければ例外 */
      function addToImport(op) {
        var cur = readImport();
        if (!cur || cur.bad) throw new Error('取り込みの記録');
        cur.items.push({ requestId: op.requestId, action: op.action });
        window.localStorage.setItem(IMPORT_KEY, JSON.stringify(cur));
      }
      function dropImport() {
        try { window.localStorage.removeItem(IMPORT_KEY); } catch (e) { /* 消せないときは、次に開いたときにまた出る */ }
      }

      if (!storageOk()) {
        $('main').hidden = true;
        ui.pageMessage('この端末では途中の記録を残せないため、まとめて登録を使えません。社員の管理の画面で1件ずつ登録してください', 'error');
        return;
      }
      // 「他の人も使う」のログインでは使わない。途中の記録（requestId と処理の名前だけ。番号・金額・名前は入れない）は、共有の端末に残すと次の人が続きを確かめられてしまうため。
      // 読み込んだファイル（保険の番号・給与の金額を含む）も、共有の端末では扱わない
      if (MP.store.tokenShared()) {
        $('main').hidden = true;
        $('pending').hidden = true;
        ui.pageMessage('「他の人も使う」でログインしているため、まとめて登録を使えません（途中の記録が端末に残り、ファイルには個人情報〔保険の番号・給与の金額を含む〕が入るため）。自分の端末でログインし直してください', 'error');
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
          if (r.ok) return { state: 'ok', message: '保存しました', data: r.data };
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

      /**
       * ops を1件ずつ送る（送る前に記録・はっきりしたら消す）。結果の分からない件で止まる。
       * 返り値: { stopped: 止まったか, ok, denied, unknown, skipped }（件数。skipped は「基本が断られたので送らなかった履歴」）
       */
      function runOps(ops, list, what) {
        var failedGroups = {};
        var i = 0;
        var count = { stopped: false, ok: 0, denied: 0, unknown: 0, skipped: 0 };
        running = true;
        function next() {
          if (i >= ops.length) return Promise.resolve(count);
          var op = ops[i++];
          $('progress').textContent = (what || '') + i + ' / ' + ops.length + ' 件目を保存しています';
          if (op.part === 'history' && failedGroups[op.group]) {
            list.appendChild(resultLine(op.label, { state: 'skip', message: '基本が保存できなかったので、履歴は送っていません' }));
            count.skipped++;
            return next();
          }
          try { addToImport(op); putPending(op); } catch (e) {
            list.appendChild(resultLine(op.label, { state: 'unknown', message: '途中の記録を残せないため、ここで止めました（まだ送っていません）' }));
            count.stopped = true; count.unknown++;
            return Promise.resolve(count);
          }
          return sendOne(op).then(function (res) {
            list.appendChild(resultLine(op.label, res));
            if (res.state === 'unknown') { count.stopped = true; count.unknown++; return count; } // 記録は残す（次に開いたとき・読み込むときに送り直す）
            dropPending(op.requestId);
            if (res.state === 'denied') { failedGroups[op.group] = true; count.denied++; } else count.ok++;
            // 足せた社員の 名前 → 社員ID を、この画面を開いている間だけ覚える（読み込み直しで、同じ人を二重に足さない。計画 10-8）
            if (res.state === 'ok' && op.action === 'master.admin.addEmployee' && res.data && typeof res.data.employeeId === 'string' && res.data.employeeId) {
              knownIds[bulk.nameKey(op.args.name)] = res.data.employeeId;
            }
            return next();
          });
        }
        return next().then(function (c) { running = false; return c; }, function (e) { running = false; throw e; });
      }

      // ------------------------------------------------ 前回の続き
      /** 前回の続きの案内を出す。結果の分からない保存・読めない記録があれば true（普通の流れに進ませない） */
      function showPending() {
        var p = listPending();
        var imp = readImport();
        if (p.bad || (imp && imp.bad)) {
          $('pending').hidden = false; $('main').hidden = true; $('resume').hidden = true; $('import').hidden = true;
          $('pending-text').textContent = '読めない途中の記録があります。管理者に連絡してください';
          return true;
        }
        if (!p.items.length) { $('pending').hidden = true; $('main').hidden = false; return false; }
        $('pending').hidden = false; $('main').hidden = true; $('resume').hidden = false; $('import').hidden = true;
        $('pending-text').textContent = '前回、結果が分からない保存が ' + p.items.length + ' 件あります。先に「前回の続きを確かめる」を押してください（サーバーに結果を問い合わせるだけなので、二重にはなりません）';
        var list = ui.clear($('pending-list'));
        p.items.forEach(function (x) { list.appendChild(el('li', { text: ACTION_NAMES[x.action] || x.action })); });
        return true;
      }

      /** 1 回の取り込みの記録の案内（結果の分からない保存が無いとき）。text … 確かめた結果の文 */
      function showImport(text) {
        var imp = readImport();
        if (!imp || imp.bad || listPending().items.length) { $('import').hidden = true; return; }
        $('import').hidden = false;
        $('import-text').textContent = '前回の取り込み（' + ui.fmtDateTime(fmtAt(imp.at)) + '・' + imp.items.length + ' 件）の記録があります。' + (text || '') +
          '同じファイルを読み込み直すと、登録できていた人は足さずに確かめます。終わったら「取り込みを終える」を押してください。';
      }

      function fmtAt(ms) {
        var d = new Date(ms);
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      }

      /**
       * 取り込みの記録と結果の分からない保存の requestId を、サーバーに確定してもらう（計画 10-7〜10-9。元の引数は送らない）。
       * 返り値: { ok: false, message } か { ok: true, done, notDone, added: [{ name, employeeId }] }。
       * 足せていた社員の 名前 → 社員ID を覚え直し、答えのあった requestId の「結果の分からない保存」の記録を消す
       */
      function settle() {
        var imp = readImport();
        var seen = {}, ids = [];
        var add = function (rid) { if (!seen[rid]) { seen[rid] = true; ids.push(rid); } };
        ((imp && !imp.bad) ? imp.items : []).forEach(function (x) { add(x.requestId); });
        listPending().items.forEach(function (x) { add(x.requestId); });
        if (!ids.length) return Promise.resolve({ ok: true, done: 0, notDone: 0, added: [] });
        return MP.api.call('master.admin.settleRequests', { requestIds: ids }).then(function (r) {
          if (!r.ok) return { ok: false, message: r.message };
          var items = r.data && Array.isArray(r.data.items) ? r.data.items : [];
          var out = { ok: true, done: 0, notDone: 0, added: [] };
          items.forEach(function (x) {
            if (!x || typeof x.requestId !== 'string' || !seen[x.requestId]) return;
            if (x.status === 'done') {
              out.done++;
              if (typeof x.employeeId === 'string' && x.employeeId && typeof x.name === 'string' && x.name) {
                knownIds[bulk.nameKey(x.name)] = x.employeeId;
                out.added.push({ name: x.name, employeeId: x.employeeId });
              }
            } else out.notDone++;
            dropPending(x.requestId); // 結果がはっきりした（反映済み・失敗・届いていない〔受付を締めた〕）
          });
          return out;
        });
      }

      function settleText(s) {
        return s.done + ' 件は登録できていました・' + s.notDone + ' 件は登録されていません。';
      }

      $('resume').addEventListener('click', function () {
        $('file').disabled = true; // ファイルを選ぶ欄は ui.run では止まらないので、自分で止める
        var unlock = function () { $('file').disabled = false; };
        ui.run(function () {
          var list = ui.clear($('result-list'));
          ui.clear($('followup'));
          return settle().then(function (s) {
            if (!s.ok) { ui.pageMessage('前回の続きを確かめられませんでした（' + s.message + '）。電波の良いところで、もう一度押してください', 'error'); return; }
            $('result').hidden = false;
            $('pending').hidden = true;
            $('main').hidden = false;
            s.added.forEach(function (a) { list.appendChild(el('li', { text: '新しい社員 ' + a.name + '（' + a.employeeId + '）は登録できていました' })); });
            $('progress').textContent = '前回の続きを確かめました（' + settleText(s) + '）もう一度ファイルを読み込むと、残りが出ます';
            return reloadData().then(function () { if (!showPending()) showImport(settleText(s)); });
          });
        }).then(unlock, unlock);
      });

      $('finish-import').addEventListener('click', endImport);
      $('finish-import2').addEventListener('click', endImport);
      /** 取り込みを終える: 取り込みの記録と、名前 → 社員ID の対応を消す（結果の分からない保存が残っているときは消さない） */
      function endImport() {
        if (running || listPending().items.length) return;
        dropImport();
        knownIds = {};
        $('import').hidden = true;
        $('finish-import2').hidden = true;
        ui.pageMessage('');
        $('progress').textContent = $('result').hidden ? '' : '取り込みを終えました';
        if ($('result').hidden) ui.pageMessage('取り込みを終えました', 'info');
      }

      // ------------------------------------------------ 読み直し
      function reloadData() {
        return MP.api.call('master.admin.list', {}).then(function (r) {
          if (!r.ok) { ui.pageMessage(r.message, 'error'); return false; }
          data = r.data;
          return true;
        });
      }

      /** ファイルを選ぶ欄は、ボタンと違って ui.run では止まらないので、自分で止める */
      function lockFile(on) { $('file').disabled = on; }

      // ------------------------------------------------ 書き出し
      $('export').addEventListener('click', function () {
        if (running || $('export').disabled) return;
        // 保険の番号・給与の金額を入れるとき（初めは入れる）は、書き出す前に 1 回だけ確かめる（計画 4-3）
        var omit = $('omit-pay').checked;
        var ask = bulk.hasPay(data) && !omit
          ? ui.dialog({
            title: '書き出す前に確かめてください', dismiss: false,
            text: 'このファイルには、全員の保険の番号と給与の金額が入ります。共有のフォルダ・メールに置かないでください。要らなくなったら消してください。',
            buttons: [{ label: '書き出す', value: true, kind: 'primary' }, { label: 'やめる', value: false }],
          })
          : Promise.resolve(true);
        ask.then(function (yes) { if (yes) doExport(omit); });
      });

      function doExport(omit) {
        lockFile(true);
        var p = ui.run(function () {
          $('exported').hidden = true;
          return reloadData().then(function (ok) {
            if (!ok) return;
            ui.pageMessage('');
            var name = book.fileName(data);
            return book.toBlob(book.build(window.ExcelJS, data, { omitPay: omit })).then(function (blob) {
              // 保存のしかたは出勤簿の Excel（page_admin_export.js）と同じ
              var url = URL.createObjectURL(blob);
              var a = el('a', { href: url, download: name, hidden: true });
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
              $('exported').textContent = 'ファイルを作りました（' + name + '）。部署 ' + data.departments.length + ' 件・社員 ' + data.employees.length + ' 人' +
                (bulk.hasPay(data) ? (omit ? '（保険の番号・給与の金額は入れていません）' : '（保険の番号・給与の金額が入っています）') : '');
              $('exported').hidden = false;
            }, function () {
              ui.pageMessage('Excel のファイルを作れませんでした。もう一度お試しください', 'error');
            });
          });
        });
        if (p) p.then(function () { lockFile(false); }, function () { lockFile(false); });
      }

      // ------------------------------------------------ 確かめる（部署と社員を、同じ1つのファイルから1回で計画する）
      function stateOf(plan) { return plan.fatal ? 'fatal' : plan.errorCount ? 'errors' : 'ok'; }

      /**
       * 今の data とファイルの行から、部署と社員の計画を立てる。
       * 社員は、部署の計画を当てはめた後の data で計画する（まだ保存していない新しい部署は仮の ID）。部署に誤りがあるときは、社員は計画しない（emp: null）
       * mark … 確かめた中身の目印。計画の目印（planKey）だけでなく、誤りの有無（state）も入れる（誤りのある計画は目印が「変わる所なし」と同じになるため）
       */
      function analyze() {
        var dept = bulk.planDepartments(fileRows.departments, data);
        var out = { dept: dept, emp: null, deptKey: bulk.planKey(dept, data), empKey: '', deptState: stateOf(dept), empState: 'none' };
        if (out.deptState === 'ok') {
          var after = bulk.afterDepartments(data, dept);
          out.emp = bulk.planEmployees(fileRows.employees, after, { knownIds: knownIds });
          out.empKey = bulk.planKey(out.emp, after);
          out.empState = stateOf(out.emp);
        }
        out.ready = out.deptState === 'ok' && out.empState === 'ok';
        out.count = out.ready ? dept.ops.length + out.emp.ops.length : 0;
        out.mark = JSON.stringify([out.deptState, out.deptKey, out.empState, out.empKey]);
        return out;
      }

      function countText(plan, isDept) {
        var add = 0, fixGroups = {};
        plan.rows.forEach(function (r) {
          if (r.errors.length) return;
          r.ops.forEach(function (o) {
            if (o.action === 'master.admin.addEmployee' || (isDept && o.args.deptId === null)) add++;
            else fixGroups[o.group] = true;
          });
        });
        return '変わらない ' + plan.unchanged + ' 件・足す ' + add + ' 件・直す ' + Object.keys(fixGroups).length + ' 件・誤り ' + plan.errorCount + ' か所';
      }

      function renderRows(list, plan) {
        plan.rows.forEach(function (r) {
          if (!r.errors.length && !r.ops.length) return;
          list.appendChild(el('li', {}, [
            el('div', { class: 'item-title', text: r.line + '行目: ' + r.label }),
          ].concat(r.ops.map(function (o) { return el('p', { class: 'bulk-op', text: '・' + o.label }); }))
            .concat(r.notes.map(function (n) { return el('p', { class: 'bulk-note', text: n }); }))
            .concat(r.errors.map(function (e) { return el('p', { class: 'bulk-err', text: '誤り: ' + e }); }))));
        });
      }

      function renderPlan() {
        var deptList = ui.clear($('dept-list')), empList = ui.clear($('emp-list'));
        $('preview').hidden = false;
        $('result').hidden = true;
        var c = checked, btn = $('register');
        $('dept-summary').textContent = c.dept.fatal ? c.dept.fatal : countText(c.dept, true);
        if (!c.dept.fatal) renderRows(deptList, c.dept);
        if (!c.emp) $('emp-summary').textContent = '部署の誤りを直してから確かめます';
        else {
          $('emp-summary').textContent = c.emp.fatal ? c.emp.fatal : countText(c.emp, false);
          if (!c.emp.fatal) renderRows(empList, c.emp);
        }
        // 前に書き出した社員の表に残っている 休憩方式・カレンダーの列は読み飛ばす（部署で決まる）。そのことを 1 行出す
        // 無い列（保険の番号・給与）は今のまま、ということも 1 行出す（計画 4-2）
        var note = c.emp && !c.emp.fatal ? [c.emp.note, c.emp.missingNote].filter(Boolean).join(' ') : '';
        $('emp-note').textContent = note;
        $('emp-note').hidden = !note;
        btn.hidden = true;
        var summary;
        if (!c.ready) {
          var n = (c.dept.errorCount || 0) + (c.emp && c.emp.errorCount ? c.emp.errorCount : 0);
          summary = (n ? '誤りが ' + n + ' か所あります。' : '読めない所があります。') + 'ファイルを直して保存し、もう一度読み込んでください（誤りがあると登録できません）';
        } else if (!c.count) {
          summary = '変わる所はありません';
        } else {
          summary = '保存は ' + c.count + ' 件です（部署 ' + c.dept.ops.length + ' 件・社員 ' + c.emp.ops.length + ' 件。1件 2〜5秒ほどかかります）';
          btn.hidden = false;
          btn.textContent = 'この内容で登録する（' + c.count + ' 件）';
        }
        $('preview-summary').textContent = summary;
      }

      function fileStatus(text) {
        $('file-status').textContent = text;
        $('file-status').hidden = !text;
      }

      $('file').addEventListener('change', function () {
        var input = $('file');
        var f = input.files && input.files[0];
        if (!f) return; // 選ぶ窓を閉じた
        if (running) { input.value = ''; return; }
        if (showPending()) { input.value = ''; return; }
        // 前の確かめは、新しいファイルを選んだ時点で捨てる（読めなかったときに、前のファイルの計画で登録させない）
        fileRows = null; checked = null;
        $('preview').hidden = true;
        $('result').hidden = true;
        ui.pageMessage('');
        var name = String(f.name);
        var fail = function (text) { fileStatus(''); ui.pageMessage(text, 'error'); };
        if (!/\.xlsx$/i.test(name)) { input.value = ''; fail('Excel のファイル（.xlsx）を選んでください'); return; }
        if (f.size > book.BULK_BOOK.FILE_MAX_BYTES) { input.value = ''; fail('ファイルが大きすぎます（2MB まで）'); return; }
        lockFile(true);
        var p = ui.run(function () {
          fileStatus('読み込んでいます…');
          return f.arrayBuffer().then(function (buf) {
            return book.read(window.ExcelJS, buf);
          }, function () {
            return { error: 'Excel のファイルとして読めませんでした' };
          }).then(function (r) {
            if (r.error) { fail(r.error); return; }
            return reloadData().then(function (ok) {
              if (!ok) { fileStatus(''); return; }
              fileRows = { departments: r.departments, employees: r.employees };
              checked = analyze();
              fileStatus('読み込みました: ' + name);
              renderPlan();
            });
          }, function () { fail('Excel のファイルとして読めませんでした'); });
        });
        // 同じ名前のファイルを選び直しても読めるように、欄を空に戻す
        var done = function () { input.value = ''; lockFile(false); };
        if (p) p.then(done, done); else done();
      });

      // ------------------------------------------------ 登録
      function finish(text, sentEmployees) {
        checked = null; // 確かめ直すまで、もう一度は登録できない
        $('progress').textContent = text;
        // 結果の分からない保存が無ければ、「取り込みを終える」を出す（全部が正常に終わったときは目立たせる。計画 10-9）
        var clean = !listPending().items.length;
        $('finish-import2').hidden = !clean;
        $('finish-import2').className = 'btn block' + (clean && /^終わりました/.test(text) ? ' primary' : '');
        return reloadData().then(function () { if (sentEmployees) followup(); });
      }

      $('register').addEventListener('click', function () {
        if (!checked || !checked.ready || !checked.count || !fileRows) return;
        if (showPending()) return;
        lockFile(true);
        var p = ui.run(function () {
          return reloadData().then(function (ok) {
            if (!ok) return;
            // 1. 読み直して、部署も社員ももう一度計画する。確かめたときと目印が違えば、1件も送らない
            var now = analyze();
            if (now.mark !== checked.mark) {
              checked = now;
              renderPlan();
              ui.pageMessage('確かめた後に内容が変わりました（日付が変わった・他の人が直した、など）。一覧を確かめ直してから、もう一度押してください', 'error');
              return;
            }
            if (!now.ready || !now.count) return;
            var empKey = now.empKey; // 確かめたときの社員の目印（部署の保存の後で、本物の ID で立てた計画と比べる）
            ui.pageMessage('');
            $('preview').hidden = true;
            $('result').hidden = false;
            var list = ui.clear($('result-list'));
            ui.clear($('followup'));
            $('to-employees').hidden = true;
            $('finish-import2').hidden = true;
            // 次の取り込みを始める: 前の取り込みの記録を消して、新しい記録を書く（計画 10-9）。書けなければ 1 件も送らない
            try { startImport(now.count); } catch (e) {
              $('progress').textContent = '途中の記録を残せないため、送っていません';
              return;
            }
            $('import').hidden = true;
            // 前の取り込みの「名前 → 社員ID」の対応は、この取り込みの計画（確かめたもの・部署の後に立て直すもの）にだけ使い、ここで外す。
            // この後に足せた人だけを、新しい取り込みの対応として覚える（開き直したときに作り直せる分と同じにする。Codex 実装 1 回目 medium 2）
            var planIds = knownIds;
            knownIds = {};
            // 2. 部署を送る（送るのは、目印が合った計画の op だけ。requestId はここで付ける。送り直しは同じ requestId）
            var deptOps = now.dept.ops;
            deptOps.forEach(function (o) { o.requestId = MP.api.newRequestId(); });
            return runOps(deptOps, list, '部署: ').then(function (dc) {
              // 3. 部署が全部保存できたときだけ、社員へ進む
              if (dc.stopped) return finish('結果の分からない保存があるため、ここで止めました。社員は送っていません。電波の良いところで、もう一度ファイルを読み込むと、続きを確かめられます', false);
              if (dc.denied || dc.unknown || dc.skipped) return finish('部署の保存が終わっていないので、社員は送っていません。直してから、もう一度読み込んでください', false);
              // 4. 部署を保存したら読み直して、本物の部署ID で社員をもう一度計画する（部署の保存が0件なら、1. で読み直した data のまま）
              return (deptOps.length ? reloadData() : Promise.resolve(true)).then(function (ok2) {
                var redo = '部署は保存しました。社員は、もう一度読み込んで確かめてください';
                if (!ok2) return finish(redo, false);
                var emp = bulk.planEmployees(fileRows.employees, data, { knownIds: planIds });
                if (stateOf(emp) !== 'ok' || bulk.planKey(emp, data) !== empKey || bulk.hasTempId(emp.ops)) return finish(redo, false);
                // 5. 社員を送る
                emp.ops.forEach(function (o) { o.requestId = MP.api.newRequestId(); });
                return runOps(emp.ops, list, '社員: ').then(function (ec) {
                  return finish(ec.stopped
                    ? '結果の分からない保存があるため、ここで止めました。電波の良いところで、もう一度ファイルを読み込むと、続きを確かめられます'
                    : '終わりました。保存できなかった件があれば、ファイルを直してからもう一度読み込むと、残りだけが出ます', emp.ops.length > 0);
                });
              });
            });
          });
        });
        if (p) p.then(function () { lockFile(false); }, function () { lockFile(false); });
      });

      /** 招待がまだの人・利用停止中・作成中の人の案内 */
      function followup() {
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

      // 開いたとき: 結果の分からない保存があれば、先に「前回の続きを確かめる」。無くて取り込みの記録があれば、サーバーに結果を確かめて
      // 名前 → 社員ID の対応を作り直す（何度呼んでも同じ答え。計画 10-9）
      if (!showPending()) {
        var imp0 = readImport();
        if (imp0 && !imp0.bad && imp0.items.length) {
          lockFile(true);
          var p0 = ui.run(function () {
            return settle().then(function (s) {
              if (!s.ok) { ui.pageMessage('前回の取り込みの結果を確かめられませんでした（' + s.message + '）。画面を開き直してください', 'error'); return; }
              if (!showPending()) showImport('サーバーで確かめた結果: ' + settleText(s));
            });
          });
          if (p0) p0.then(function () { lockFile(false); }, function () { lockFile(false); });
        } else if (imp0 && !imp0.bad) showImport('');
      }
    });
  });
})();
