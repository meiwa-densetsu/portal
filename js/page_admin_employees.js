/* 管理者: 社員の一覧・追加・基本の編集・履歴（権限・部署など）・招待リンク・利用停止（master.admin.* と auth.admin.*） */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    return MP.guard.enter({ admin: true, load: { action: 'master.admin.list' } }).then(function (entered) {
      var save = MP.api.saver();
      var data = { employees: [], departments: [], calendars: [], today: '', options: { roles: [], employmentTypes: [] } };
      var currentId = '';   // 詳しい画面で開いている社員
      var histBase = null;  // 直している履歴の行（新しい行なら null）
      var VIEWS = ['list-view', 'detail-view', 'hist-view', 'add-view'];
      var ROLE_MANAGER = '部長';
      var viewSave = MP.api.saver({ noViewAs: true }); // 社員の画面を見る（開始の記録。押し直しは同じ requestId）

      /** 社員の画面を見る（見るだけ。計画 stage1-viewas-plan.md 1-6）。本人・利用停止・管理者は出さない */
      function canView(e, h) { return e.active && h && h.role !== MP.guard.ROLE_ADMIN && e.employeeId !== entered.me.employeeId; }
      function viewAs(e) {
        ui.confirm(e.name + 'さんの画面を見る', e.name + 'さんがログインしたときの画面を、見るだけで開きます。保存・申請はできません。見始めたことは記録に残ります。終わるときは、上の帯の「終わる」を押してください。', '見る', 'primary').then(function (ok) {
          if (!ok) return;
          ui.run(function () {
            return viewSave('auth.admin.viewAsStart', { employeeId: e.employeeId }).then(function (res) {
              if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
              MP.store.setViewAs({ employeeId: res.data.employeeId, name: res.data.name });
              MP.go('home.html');
              return new Promise(function () {});
            });
          });
        });
      }

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

      // ---------------- 保険の番号・給与の固定の項目（計画 stage2-employee-fields-plan.md 3-1） ----------------
      // 項目はサーバーの答え（options.payItems・insuranceItems）から出す。payItems が無い答え（1 つ前のサーバー）なら、欄を出さず、送りもしない

      /** 給与の固定の項目の一覧（無ければ null） */
      function payItems() { return data.options && Array.isArray(data.options.payItems) ? data.options.payItems : null; }
      /** 保険の番号の一覧（給与の項目が無い答えでは出さない。無ければ null） */
      function insItems() { return payItems() && Array.isArray(data.options.insuranceItems) ? data.options.insuranceItems : null; }
      /** 確定拠出年金の上限（設定の値。無ければ null） */
      function dcLimit() { var n = data.options && data.options.dcLimitYen; return typeof n === 'number' && isFinite(n) ? n : null; }
      var INS_HINTS = {
        healthInsuranceNo: '保険証の記号と番号（例: 1234567-12）',
        pensionNo: '年金手帳・基礎年金番号通知書の 10 けた（ハイフンは無くてよい）',
        employmentInsuranceNo: '雇用保険被保険者証の 11 けた',
      };
      /** 3 けたごとにカンマ */
      function yen(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
      /** 給与の項目の 1 つの値を見せる文字（null は「—」・読めない値はそのまま添える） */
      function payText(item, v) {
        if (v === null || v === undefined) return '—';
        if (typeof v !== 'number') return '読めない値（' + String(v) + '）';
        return item.unit === 'minutes' ? minutesText(v) : yen(v) + ' 円';
      }
      /** 入れた値の数（読めない値も「入っている」に数える） */
      function payCount(h) {
        var items = payItems() || [];
        return items.filter(function (i) { return h.pay && h.pay[i.key] !== null && h.pay[i.key] !== undefined; }).length;
      }
      /** 全角を半角に（使えない端末では、そのまま） */
      function nfkc(s) { try { return String(s).normalize('NFKC'); } catch (x) { return String(s); } }
      /** サーバーの BAD_REQUEST の文が、どの項目のものか（文の頭が項目の名前） */
      function itemOfMessage(items, message) {
        return (items || []).filter(function (i) { return String(message || '').indexOf(i.label) === 0; })[0] || null;
      }

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

      /** 基本の項目（名前・表示順・入社日・生年月日。答えに insuranceItems があれば保険の番号 3 つも） */
      function basicCtl(container, p) {
        var name = el('input', { type: 'text', id: p + '-name', maxlength: '60', autocomplete: 'off' });
        var order = el('input', { type: 'text', id: p + '-order', inputmode: 'numeric', maxlength: '4', autocomplete: 'off' });
        var join = dateCtl(p + '-join', '入社日', 1980, thisYear + 2, false);
        var birth = dateCtl(p + '-birth', '生年月日', 1940, thisYear, false);
        var ins = insItems();
        var insInputs = {};
        ui.clear(container);
        container.appendChild(field('名前', name.id, name, 'ログインの画面の一覧に出ます。同じ名前の人がいるときは「佐藤（工事）」のように区別してください（30文字まで）'));
        container.appendChild(field('表示順', order.id, order, '一覧に並ぶ順番です（1〜9999。小さいほうが上）'));
        container.appendChild(join.node);
        container.appendChild(birth.node);
        // 保険の番号（管理者と本人だけが見ます）。年金・雇用保険は数字だけ打てば通る（iPhone の数字のキーにはハイフンが無い。ハイフンはサーバーが付ける）
        (ins || []).forEach(function (i) {
          var input = el('input', { type: 'text', id: p + '-ins-' + i.key, inputmode: i.key === 'healthInsuranceNo' ? 'text' : 'numeric', maxlength: '40', autocomplete: 'off' });
          insInputs[i.key] = input;
          container.appendChild(field(i.label, input.id, input, (INS_HINTS[i.key] || '') + '。空は「未登録」です'));
        });
        return {
          /** サーバーの誤りの文を、その番号の欄の下に出す（出せたら true） */
          showError: function (message) {
            var i = itemOfMessage(ins, message);
            if (!i) return false;
            ui.fieldError(insInputs[i.key], message);
            return true;
          },
          set: function (v) {
            name.value = v.name; order.value = v.order === null ? '' : v.order; join.set(v.joinDate); birth.set(v.birthDate);
            (ins || []).forEach(function (i) { insInputs[i.key].value = v.insurance && v.insurance[i.key] ? v.insurance[i.key] : ''; });
          },
          get: function () {
            var ok = true;
            var n = name.value.trim();
            if (!n || n.length > 30) { ui.fieldError(name, '名前を1〜30文字で入れてください'); ok = false; }
            if (!/^\d+$/.test(order.value.trim()) || Number(order.value) < 1 || Number(order.value) > 9999) { ui.fieldError(order, '表示順を 1〜9999 の数字で入れてください'); ok = false; }
            var j = join.get(), b = birth.get();
            if (!j.ok) { ui.fieldError(join.row, '入社日を、年・月・日の3つとも正しく選んでください'); ok = false; }
            if (!b.ok) { ui.fieldError(birth.row, '生年月日を、年・月・日の3つとも正しく選んでください'); ok = false; }
            if (!ok) return null;
            var out = { name: n, order: Number(order.value), joinDate: j.value, birthDate: b.value };
            // 番号の形はサーバーが確かめる（決まりを画面に写さない）。前後の空白だけ除く
            (ins || []).forEach(function (i) { out[i.key] = insInputs[i.key].value.trim(); });
            return out;
          },
        };
      }

      /**
       * 給与の固定の項目の囲み（答えに payItems があるときだけ）。
       * 金額は 1 つずつの欄（カンマ・全角で打っても読める。空 = 未入力）。含み残業時間は時間と分の 2 つの欄。
       * シートの値が読めない（「25万」など）項目は、その文字を欄に入れておき、触らなければ「今のまま」（{ keep: true }）で送る（計画 10-5）
       */
      function payCtl(container, p) {
        var items = payItems();
        if (!items) return null;
        var box = el('div', { class: 'subbox', id: p + '-pay' }, [el('h3', { text: '給与の固定の項目（管理者だけが見ます）' }),
          el('p', { class: 'sub', text: '給与明細と同じ金額を入れます。空は「未入力」です（0 円とは別）。' })]);
        var ctl = {}; // key → { input | hours, mins, note, raw }
        items.forEach(function (i) {
          var id = p + '-pay-' + i.key;
          var note = el('p', { class: 'hint pay-unreadable', id: id + '-note', hidden: true });
          if (i.unit === 'minutes') {
            var hours = el('input', { type: 'text', id: id + '-h', inputmode: 'numeric', autocomplete: 'off', 'aria-label': i.label + '（時間）' });
            var mins = el('input', { type: 'text', id: id + '-m', inputmode: 'numeric', maxlength: '2', autocomplete: 'off', 'aria-label': i.label + '（分）' });
            var row = el('div', { class: 'row', id: id }, [hours, mins]);
            ctl[i.key] = { hours: hours, mins: mins, row: row, note: note, raw: null };
            var f = field(i.label + '（左に時間、右に分）', '', row, '例: 30時間なら「30」と「0」。空は「未入力」');
            f.appendChild(note);
            box.appendChild(f);
            return;
          }
          var input = el('input', { type: 'text', id: id, inputmode: 'numeric', autocomplete: 'off' });
          ctl[i.key] = { input: input, note: note, raw: null };
          var hint = i.key === 'basePay' ? '日給制の人は日給を入れます' : '';
          if (i.key === 'lifePlanPrepay' && dcLimit() !== null) {
            hint = '確定拠出年金の上限 ' + yen(dcLimit()) + ' 円（設定の値）。超えると注意を出します（保存はできます）。設定を変えてから、効くまで数時間かかることがあります';
          }
          var fl = field(i.label + '（円）', id, input, hint);
          fl.appendChild(note);
          box.appendChild(fl);
        });
        container.appendChild(box);

        function setNote(c, raw) {
          c.raw = raw;
          c.note.textContent = raw === null ? '' : '読めない値: ' + raw + '（直すときは数字で入れてください）';
          c.note.hidden = raw === null;
        }
        return {
          /** h … 元にする行（無ければ空） */
          set: function (h) {
            items.forEach(function (i) {
              var v = h && h.pay ? h.pay[i.key] : null;
              if (v === undefined) v = null;
              var c = ctl[i.key];
              var raw = v !== null && typeof v !== 'number' ? String(v) : null;
              setNote(c, raw);
              if (i.unit === 'minutes') {
                c.hours.value = raw !== null ? raw : v === null ? '' : String(Math.floor(v / 60));
                c.mins.value = raw !== null || v === null ? '' : String(v % 60);
              } else {
                c.input.value = raw !== null ? raw : v === null ? '' : String(v);
              }
            });
          },
          /** サーバーの誤りの文を、その項目の欄の下に出す（出せたら true） */
          showError: function (message) {
            var i = itemOfMessage(items, message);
            if (!i) return false;
            ui.fieldError(ctl[i.key].input || ctl[i.key].row, message);
            return true;
          },
          /** { key: null | 整数 | { keep: true } }。形が違えば欄の下に出して null */
          get: function () {
            var ok = true, out = {};
            items.forEach(function (i) {
              var c = ctl[i.key];
              if (i.unit === 'minutes') {
                if (c.raw !== null && c.hours.value === c.raw && c.mins.value === '') { out[i.key] = { keep: true }; return; }
                var hv = nfkc(c.hours.value).trim(), mv = nfkc(c.mins.value).trim();
                if (hv === '' && mv === '') { out[i.key] = null; return; }
                if (hv === '') hv = '0';
                if (mv === '') mv = '0';
                if (!/^\d{1,4}$/.test(hv) || !/^\d{1,2}$/.test(mv) || Number(mv) > 59) {
                  ui.fieldError(c.row, i.label + 'を、時間と分（0〜59）の数字で入れてください');
                  ok = false;
                  return;
                }
                out[i.key] = Number(hv) * 60 + Number(mv);
                return;
              }
              if (c.raw !== null && c.input.value === c.raw) { out[i.key] = { keep: true }; return; }
              // カンマは 3 けたごとの位置だけ受け付ける（「250,00」「2,5」「,」を別の金額・空に変えない。Excel の読み込みの parseYen と同じ決まり）
              var s = nfkc(c.input.value).trim();
              if (s === '') { out[i.key] = null; return; }
              s = s.replace(/\s*円$/, '');
              if (!/^(\d+|\d{1,3}(,\d{3})+)$/.test(s)) s = 'x'; // 形が違えば、下で誤りにする
              s = s.replace(/,/g, '');
              if (!/^\d{1,9}$/.test(s)) {
                ui.fieldError(c.input, i.label + 'は 0 以上の整数（円）で入れてください');
                ok = false;
                return;
              }
              out[i.key] = Number(s);
            });
            return ok ? out : null;
          },
        };
      }

      /** 生涯設計前払金が確定拠出年金の上限を超えていたら、保存の前に確かめる（保存は止めない。計画 1-4・3-1）。進めてよければ true */
      function confirmDc(pay) {
        var v = pay ? pay.lifePlanPrepay : null;
        var lim = dcLimit();
        if (typeof v !== 'number' || lim === null || v <= lim) return Promise.resolve(true);
        return ui.confirm('生涯設計前払金が上限を超えています',
          '生涯設計前払金 ' + yen(v) + ' 円は、確定拠出年金の上限 ' + yen(lim) + ' 円（設定の値）を超えています。このまま保存しますか？', '保存する');
      }

      /** 同時に直したときの「入力していた内容」に並べる給与の行 */
      function payLines(pay) {
        if (!pay) return [];
        return (payItems() || []).filter(function (i) { return pay[i.key] !== null && !(pay[i.key] && pay[i.key].keep); })
          .map(function (i) { return i.label + ': ' + payText(i, pay[i.key]); });
      }

      /**
       * 履歴の項目（適用開始日・権限・部署・閲覧部署・雇用区分・所定労働時間）。
       * 休憩方式・会社カレンダーは部署で決まるので、ここでは選ばない・送らない（計画 stage1-break-types-plan.md 6-1）
       */
      function histCtl(container, p) {
        var since = dateCtl(p + '-since', 'いつから（適用開始日）', 1980, thisYear + 2, true);
        var role = selectOf(p + '-role', '権限', data.options.roles);
        var dept = el('select', { id: p + '-dept' });
        var viewBox = el('div', { id: p + '-view' });
        var viewField = field('閲覧できる部署（部長だけ）', '', viewBox, '部長が日報などを見られる部署を、1つ以上選びます');
        var emp = selectOf(p + '-emp', '雇用区分', data.options.employmentTypes);
        var hours = el('input', { type: 'text', id: p + '-hours', inputmode: 'numeric', maxlength: '2', autocomplete: 'off', 'aria-label': '1日の所定労働時間（時間）' });
        var mins = el('input', { type: 'text', id: p + '-mins', inputmode: 'numeric', maxlength: '2', autocomplete: 'off', 'aria-label': '1日の所定労働時間（分）' });
        var timeRow = el('div', { class: 'row', id: p + '-time' }, [hours, mins]);
        ui.clear(container);
        container.appendChild(since.node);
        container.appendChild(field('権限', role.id, role));
        container.appendChild(field('部署', dept.id, dept, '休憩方式と会社カレンダーは、部署で決まります（部署の管理で選びます）'));
        container.appendChild(viewField);
        container.appendChild(field('雇用区分', emp.id, emp));
        container.appendChild(field('1日の所定労働時間（左に時間、右に分）', '', timeRow, '例: 8時間なら「8」と「0」、7時間30分なら「7」と「30」'));
        var pay = payCtl(container, p); // 答えに payItems が無ければ null（囲みを出さない・送らない）
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
            var n = h && h.dailyMinutes !== null ? h.dailyMinutes : 480;
            hours.value = Math.floor(n / 60); mins.value = n % 60;
            viewField.hidden = role.value !== ROLE_MANAGER;
            if (pay) pay.set(h); // 「変更を足す」は今の内容の 13 個を写す。「直す」はその行の値
          },
          sinceRow: since.row,
          /** 給与の囲みがあるか */
          hasPay: !!pay,
          /** 給与の 13 個（囲みが無ければ null。形が違えば欄の下に出して false） */
          getPay: function () { if (!pay) return null; var v = pay.get(); return v || false; },
          showError: function (message) { return !!pay && pay.showError(message); },
          get: function () {
            var ok = true;
            var s = since.get();
            if (!s.ok) { ui.fieldError(since.row, 'いつからかを、年・月・日の3つとも正しく選んでください'); ok = false; }
            if (!role.value) { ui.fieldError(role, '権限を選んでください'); ok = false; }
            if (!dept.value) { ui.fieldError(dept, '部署を選んでください（無ければ、先に「部署の管理」で作ります）'); ok = false; }
            if (!emp.value) { ui.fieldError(emp, '雇用区分を選んでください'); ok = false; }
            var view = role.value === ROLE_MANAGER
              ? Array.prototype.filter.call(viewBox.querySelectorAll('input'), function (c) { return c.checked; }).map(function (c) { return c.value; }) : [];
            if (role.value === ROLE_MANAGER && !view.length) { ui.fieldError(viewBox, '閲覧できる部署を1つ以上選んでください'); ok = false; }
            var hv = hours.value.trim(), mv = mins.value.trim() || '0';
            var total = Number(hv) * 60 + Number(mv);
            if (!/^\d+$/.test(hv) || !/^\d+$/.test(mv) || Number(mv) > 59 || total < 1 || total > 1440) { ui.fieldError(timeRow, '所定労働時間を、時間（0〜24）と分（0〜59）の数字で入れてください'); ok = false; }
            return ok ? { since: s.value, role: role.value, deptId: dept.value, viewDeptIds: view, employmentType: emp.value, dailyMinutes: total } : null;
          },
        };
      }

      var basic, addBasic, hist, addHist; // 部署・選択肢（保険の番号・給与の項目も）を読み込んだ後に作る

      // ---------------- 一覧 ----------------

      function renderList() {
        var cards = ui.clear($('emp-cards')), rows = ui.clear($('emp-rows'));
        data.employees.forEach(function (e) {
          var h = effective(e), st = statusOf(e);
          var openBtn = function () { return el('button', { type: 'button', class: 'btn', text: '開く', on: { click: function () { openDetail(e.employeeId); } } }); };
          var viewBtn = function () { return canView(e, h) ? el('button', { type: 'button', class: 'btn', text: '画面を見る', on: { click: function () { viewAs(e); } } }) : null; };
          cards.appendChild(el('li', {}, [
            el('div', { class: 'item-title' }, [e.name + ' ', el('span', { class: 'tag ' + st[1], text: st[0] })]),
            el('div', { class: 'sub', text: (h ? deptName(h.deptId) + '・' + h.role : '—') }),
            el('div', { class: 'item-actions' }, [openBtn(), viewBtn()]),
          ]));
          rows.appendChild(el('tr', {}, [
            el('td', { text: e.name }), el('td', { text: h ? deptName(h.deptId) : '—' }), el('td', { text: h ? h.role : '—' }),
            el('td', {}, [el('span', { class: 'tag ' + st[1], text: st[0] })]), el('td', { class: 'item-actions' }, [openBtn(), viewBtn()]),
          ]));
        });
        // 休憩方式か会社カレンダーが決まっていない部署に、利用中の社員がいる（日報が計算できない・所定が出ないため）。
        // 部署の一覧の値から出す。1 つ前のサーバー（部署に 2 つの項目が無い）のときは出さない
        var names = [];
        var hasRules = !!(data.options && data.options.breakTypeNotes);
        data.employees.forEach(function (e) {
          var h = effective(e);
          if (!hasRules || !e.active || !h) return;
          var d = data.departments.filter(function (x) { return x.deptId === h.deptId; })[0];
          if (d && d.breakType && d.calendarId) return;
          var n = deptName(h.deptId);
          if (names.indexOf(n) < 0) names.push(n);
        });
        $('cal-note').textContent = names.length
          ? '休憩方式か会社カレンダーが決まっていない部署に、利用中の社員がいます（' + names.join('・') + '）。部署の管理で選んでください'
          : '';
        $('cal-note').hidden = !names.length;
      }

      function apply(r) {
        if (!r.ok) { ui.pageMessage(r.message, 'error'); return false; }
        data = r.data;
        basic = basicCtl($('basic-fields'), 'b');
        addBasic = basicCtl($('add-basic'), 'a');
        hist = histCtl($('hist-fields'), 'h');
        addHist = histCtl($('add-hist'), 'ah');
        renderList();
        return true;
      }

      function load() {
        return MP.api.call('master.admin.list', {}).then(apply);
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
        var parts = [h.role || '—', deptName(h.deptId), h.employmentType || '—', minutesText(h.dailyMinutes)];
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

        // 給与の固定の項目（今の内容）。今の「今の内容」（#current）の文は変えずに、別の囲みに出す
        var items = payItems();
        $('pay-card').hidden = !items;
        var payNow = ui.clear($('pay-current'));
        if (items && cur) {
          payNow.appendChild(el('dl', { class: 'kv' }, items.reduce(function (out, i) {
            var v = cur.pay ? cur.pay[i.key] : null;
            return out.concat([el('dt', { text: i.label }), el('dd', { text: payText(i, v), 'data-key': i.key })]);
          }, [])));
        } else if (items) {
          payNow.appendChild(el('p', { class: 'sub', text: '今日の時点で有効な内容はありません' }));
        }

        var list = ui.clear($('hist-list'));
        e.history.slice().reverse().forEach(function (h) {
          list.appendChild(el('li', {}, [
            el('div', { class: 'item-title' }, [ui.fmtDate(h.since) + ' から ',
              h.since > data.today ? el('span', { class: 'tag warn', text: 'これから' }) : h === cur ? el('span', { class: 'tag ok', text: '今' }) : null]),
            el('div', { text: histLine(h) }),
            items ? el('div', { class: 'sub pay-count', text: '給与の項目: ' + items.length + ' 中 ' + payCount(h) + ' 入力' }) : null,
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
          button('利用停止にする', function () { suspend(e); }, 'danger');
        } else {
          button('利用を再開する', function () {
            act('利用を再開しますか？', e.name + ' さんが、またログインできるようになります。', '再開する', 'auth.admin.reinstate', '利用を再開しました');
          });
        }
        show('detail-view');
      }

      /**
       * 利用停止（仕上げの計画 第2b章）。その人が登録した端末（私物のスマホなど）を一覧で出し、選んだものを一緒に取り消す。
       * 初めは全部に印（会社の端末など、次の人が使うものだけ外す）。管理者が今使っている端末は選べない。一覧を読めなかったら、利用停止をしない
       */
      function suspend(e) {
        var TEXT = e.name + ' さんはログインできなくなり、名前の一覧にも出なくなります。日報などの記録は残ります。';
        ui.pageMessage('');
        ui.run(function () {
          return MP.api.call('auth.admin.status', {}).then(function (st) {
            if (!st.ok) { ui.pageMessage('端末の一覧を読めなかったので、利用停止をしていません。もう一度押してください（' + st.message + '）', 'error'); if (MP.report) MP.report.attach(st); return; }
            var mine = st.data.devices.filter(function (d) { return d.registeredById === e.employeeId && !d.revokedAt; });
            var current = mine.filter(function (d) { return d.deviceRef === st.data.currentDeviceRef; })[0] || null;
            var boxes = [];
            var body = null;
            if (mine.length) {
              body = el('div', { id: 'suspend-devices' }, [
                el('p', { class: 'dialog-body', text: e.name + ' さんが登録した端末です。印を付けた端末は、利用停止と一緒に取り消します（その端末ではだれもログインできなくなります）。会社の端末など、次の人が使うものは印を外してください。' }),
                el('ul', { class: 'list' }, mine.map(function (d) {
                  var isCurrent = d === current;
                  var box = el('input', { type: 'checkbox', class: 'suspend-device', value: d.deviceRef, checked: !isCurrent, disabled: isCurrent });
                  if (!isCurrent) boxes.push(box);
                  return el('li', {}, [el('label', { class: 'check' }, [box, d.name]),
                    el('div', { class: 'sub', text: '登録 ' + ui.fmtDateTime(d.registeredAt) + (d.lastUser ? '・最後に使った人 ' + d.lastUser + '（' + ui.fmtDateTime(d.lastUsedAt) + '）' : '') + (isCurrent ? '・今使っている端末（取り消せません）' : '') })]);
                })),
                current ? el('p', { class: 'msg warn', text: '今使っているこの端末は、' + e.name + ' さんが登録した端末です。ここからは取り消せません。私物の端末なら、ほかの端末でログインして「端末とロックの管理」で取り消してください。' }) : null,
              ]);
            }
            return ui.dialog({
              title: '利用停止にしますか？', text: TEXT, body: body, dismiss: false,
              buttons: [{ label: '利用停止にする', value: true, kind: 'danger' }, { label: 'やめる', value: false }],
            }).then(function (yes) {
              if (!yes) return;
              var refs = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
              return save('auth.admin.suspend', { employeeId: currentId, revokeDevices: refs }).then(function (r) {
                if (!r.ok) { ui.pageMessage(r.code === 'NETWORK' ? 'できたか分かりません。もう一度同じボタンを押してください' : r.message, 'error'); if (MP.report) MP.report.attach(r); return; }
                var n = r.data && typeof r.data.revokedDevices === 'number' ? r.data.revokedDevices : 0; // 実際に取り消した数（先にほかの管理者が取り消していれば減る）
                var done = '利用停止にしました' + (n ? '（端末 ' + n + ' 台を取り消しました）' : '');
                if (r.data && r.data.keptCurrentDevice) {
                  done += '。今使っているこの端末は、' + e.name + ' さんが登録した端末で、取り消していません。私物の端末なら、ほかの端末でログインして「端末とロックの管理」で取り消してください';
                }
                return reload(done);
              });
            });
          });
        });
      }

      /** 確認のあと、社員ID だけを渡す管理者の処理を呼ぶ */
      function act(title, text, okLabel, action, doneText) {
        ui.confirm(title, text, okLabel, action === 'auth.admin.suspend' ? 'danger' : 'primary').then(function (yes) {
          if (!yes) return;
          ui.pageMessage('');
          ui.run(function () {
            return save(action, { employeeId: currentId }).then(function (r) {
              if (!r.ok) { ui.pageMessage(r.code === 'NETWORK' ? 'できたか分かりません。もう一度同じボタンを押してください' : r.message, 'error'); if (MP.report) MP.report.attach(r); return; }
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
                if (MP.report) MP.report.attach(r);
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
        var base = { name: e.name, order: e.order, joinDate: e.joinDate, birthDate: e.birthDate };
        // 保険の番号: base に今の 3 つ、next に入れた 3 つ（答えに番号が無ければ、どちらにも入れない＝サーバーはその列に触らない）
        var ins = insItems() && e.insurance ? insItems() : null;
        if (ins) ins.forEach(function (i) { base[i.key] = e.insurance[i.key] || ''; });
        else (insItems() || []).forEach(function (i) { delete next[i.key]; });
        var args = { employeeId: e.employeeId, base: base, next: next };
        ui.run(function () {
          return save('master.admin.updateEmployee', args).then(function (r) {
            if (r.ok) return reload('保存しました');
            if (r.code === 'CONFLICT') {
              return conflict(['名前: ' + next.name, '表示順: ' + next.order, '入社日: ' + (next.joinDate || '—'), '生年月日: ' + (next.birthDate || '—')]
                .concat((ins || []).map(function (i) { return i.label + ': ' + (next[i.key] || '—'); })));
            }
            if (r.code === 'DUPLICATE_NAME') ui.fieldError($('b-name'), r.message);
            else if (r.code === 'BAD_REQUEST' && basic.showError(r.message)) return;
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
          ? 'まちがいを直すときに使います。これからの変更（異動・権限の変更など）は、戻って「変更を足す」を使ってください。' +
            (payItems() ? 'この行だけが変わります（後の行の金額は変わりません）。' : '')
          : '「いつから」の日付から、下の内容に変わります。今の内容を写してあるので、変わる所だけ直してください。' +
            (payItems() ? '給与の金額も今の内容を写してあります。' : '');
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
        var pay = hist.getPay();
        if (!next || pay === false) return;
        if (e.history.some(function (h) { return h !== histBase && h.since === next.since; })) {
          ui.fieldError(hist.sinceRow, 'この日付からの内容は、もう登録されています。戻って、その行の「直す」から直してください');
          return;
        }
        // 直す行に給与の値が無い（答えの形が違う）ときは、給与を送らない（base と next の片方だけにならないように）
        if (histBase && !histBase.pay) pay = null;
        // base は一覧の行から、休憩方式・カレンダー（部署の値。社員の保存では使わない）と、給与の見せる形（pay）を除いて送る。
        // 給与は平らな鍵で、一覧で受け取った値をそのまま（読めない値の文字も。照合が合うように）
        var base = null;
        if (histBase) {
          base = {};
          Object.keys(histBase).forEach(function (k) { if (k !== 'breakType' && k !== 'calendarId' && k !== 'pay') base[k] = histBase[k]; });
          if (pay) payItems().forEach(function (i) { var v = histBase.pay[i.key]; base[i.key] = v === undefined ? null : v; });
        }
        if (pay) Object.keys(pay).forEach(function (k) { next[k] = pay[k]; });
        var args = { employeeId: e.employeeId, baseSince: histBase ? histBase.since : null, base: base, next: next };
        confirmDc(pay).then(function (go) {
          if (!go) return;
          ui.run(function () {
            return save('master.admin.saveHistory', args).then(function (r) {
              if (r.ok) return reload('保存しました');
              if (r.code === 'CONFLICT') return conflict([ui.fmtDate(next.since) + ' から', histLine(next)].concat(payLines(pay)));
              if (r.code === 'BAD_REQUEST' && hist.showError(r.message)) return;
              ui.pageMessage(r.message, 'error');
            });
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
        var b = addBasic.get(), h = addHist.get(), pay = addHist.getPay();
        if (!b || !h || pay === false) return;
        if (pay) Object.keys(pay).forEach(function (k) { h[k] = pay[k]; }); // 新しい人には前の行が無い（「今のまま」は出ない）
        // 保険の番号は答えに insuranceItems があるときだけ b に入っている（3 つそろえて送る）
        var args = Object.assign({}, b, { history: h });
        confirmDc(pay).then(function (go) {
          if (!go) return;
          ui.run(function () {
            return save('master.admin.addEmployee', args).then(function (r) {
              if (r.ok) {
                currentId = r.data.employeeId;
                return reload('追加しました。まだログインできません。下の「招待リンクを出す」を押して、本人に送ってください', 'info');
              }
              if (r.code === 'DUPLICATE_NAME') ui.fieldError($('a-name'), r.message);
              else if (r.code === 'BAD_REQUEST' && (addBasic.showError(r.message) || addHist.showError(r.message))) return;
              else ui.pageMessage(r.message, 'error');
            });
          });
        });
      });

      $('back').addEventListener('click', function () { currentId = ''; ui.pageMessage(''); show('list-view'); });

      // 開いたときは、入口の問い合わせの答えをそのまま使う（問い合わせ1回）
      if (apply(entered.res)) { $('emp').hidden = false; show('list-view'); }
    });
  });
})();
