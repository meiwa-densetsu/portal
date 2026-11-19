/*
 * 日報（1日ずつ入力）。手順6。計画 docs/plans/stage1-step6-plan.md 第4章
 *
 * 締めの期間の日の一覧 → 1日を開いて勤務（出社・開始・終了・退社・直行直帰・作業場所・施工内容）と備考を入れる（施工内容は勤務ごと。手順10b）。
 * 日勤か夜勤かは社員が選ばず、共有の計算（CalcReport）が時刻から決める。入れるたびに、休憩・実働・所定との差をその場で出す。
 * 保存のときはサーバーがすべて計算し直す（画面の計算の結果は送らない）。管理者は社員を選んで、その人の日報を見る・直す
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    ui.watchBroken(['page_report.js']); // このファイルから出て誰も拾わなかった例外が出たら「読み込み直す」だけにする（保険）
    var CR = window.CalcReport;
    var CW = window.CalcWorktime;
    var save = MP.api.saver();
    var DOW = ['日', '月', '火', '水', '木', '金', '土'];
    var FIELDS = ['arrive', 'start', 'end', 'leave'];
    var LABEL = { arrive: '出社', start: '開始', end: '終了', leave: '退社' };
    var MESSAGES = MP.reportText.MESSAGES; // 表の画面と同じ言葉（report_text.js）
    var WITH = MP.reportText.WITH;
    var VIEW_KEY = 'mp_report_view';        // この端末で最後に使った方（'day' か 'grid'。手順7 2-6）

    var me = null;
    var data = null;          // report.period の答え
    var target = null;        // 見ている社員（null = 自分）
    var busy = 0;
    var broken = false;       // 読み込んだ後の描画が例外で止まった（出ている表示と data の社員が食い違うかもしれない）。描画が終わるまで、社員に関わる操作をしない

    /**
     * ui.run と同じ。ui.run が止めるのはボタンだけなので、社員の選択も止める（読み込みの途中に選び直すと、出ている日報と保存先の社員が食い違うため）。
     * ui.run は終わるとボタンを押せる形に戻すので、「次」と開いている日の入力の欄・「保存」は終わった後に決め直す
     * （この呼び出しで実際に動いたときだけ。保存の後に読み直して締めた期間になったときなど。給与の目安・法律の時間外の画面と同じ）
     */
    function run(fn) {
      var sel = ui.$('emp-select');
      var started = false;
      busy++;
      sel.disabled = true;
      var end = function () {
        if (--busy !== 0) return;
        sel.disabled = false;
        if (!started || !data) return;
        ui.$('next').disabled = !data.nextDate;
        if (current && !ui.$('form-pane').hidden) lockForm();
        ui.$('recalc').disabled = broken; // 描画が止まった後は押せない。描画が終われば戻す（ほかに止める所は無い）
        lockBroken();
      };
      return ui.run(function () { started = true; return fn(); }).then(ui.drawing(function (v) { end(); return v; }), ui.drawing(function (e) { end(); throw e; })); // ui.run の後の決め直しも包む
    }
    var current = null;       // 開いている日（days の1つ）
    var entries = [];         // 入力中の勤務 [{ arrive, start, end, leave, direct, place }]
    var dirty = false;

    function remember(v) { try { window.localStorage.setItem(VIEW_KEY, v); } catch (e) { /* 覚えられなくても動く */ } }
    function fmt(min) { return min === null || min === undefined || min === '' ? '—' : CW.formatHm(min); }
    function dateLabel(d) { return Number(d.date.slice(5, 7)) + '月' + Number(d.date.slice(8, 10)) + '日（' + DOW[d.dow] + '）'; }
    function emptyEntry() { return { arrive: '', start: '', end: '', leave: '', direct: '', place: '', content: '' }; }
    function input() { return { entries: entries, note: ui.$('note').value }; }

    // ------------------------------------------------------------------ 読み込み

    function load(date, first) {
      var args = { employeeId: target, date: date };
      var p = first ? MP.guard.enter({ load: { action: 'report.period', args: args } })
        : MP.api.call('report.period', args).then(function (res) { return { me: me, res: res }; });
      return p.then(function (r) {
        if (ui.isBroken()) return; // 「読み込み直す」だけにした後に届いた返事では、画面を描き直さない
        me = r.me;
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        data = r.res.data;
        broken = true; // 描画が最後まで終わったら外す
        try {
          ui.$('view').hidden = false;
          renderAdmin();
          renderList();
        } catch (e) {
          ui.showBroken(); // 描画が止まったら、画面の中身を隠して「読み込み直す」だけを出す（前の社員・期間の表示や押せる物を残さない）
          throw e;
        }
        broken = false;
      });
    }

    /** 描画が止まった後は、計算し直し・保存など社員に関わるボタンを押せなくする（ui.run が戻した後に呼ぶ） */
    function lockBroken() {
      if (!broken) return;
      ['recalc', 'save', 'copy-prev', 'use-pattern', 'make-pattern', 'add-entry'].forEach(function (id) { ui.$(id).disabled = true; });
    }

    function renderAdmin() {
      var admin = MP.guard.isAdmin(me);
      ui.$('admin-bar').hidden = !admin;
      if (!admin) return;
      // 選択肢は全部作れてから置き換える（作る途中で止まっても、前の選択肢が残り、社員を選び直せる）
      var opts = (data.employees || []).map(function (e) {
        return ui.el('option', { value: e.employeeId, text: e.name + (e.active ? '' : '（利用停止）'), selected: e.employeeId === data.employee.employeeId });
      });
      var sel = ui.clear(ui.$('emp-select'));
      opts.forEach(function (o) { sel.appendChild(o); });
      var other = data.employee.employeeId !== me.employeeId;
      ui.$('other-note').hidden = !other;
      ui.$('other-note').textContent = other ? data.employee.name + 'さんの日報を見ています。直すと修正履歴に残ります。' : '';
      ui.$('recalc-note').hidden = !data.recalcDays;
      ui.$('recalc-note').textContent = data.recalcDays ? '計算の決まりや休憩方式が変わったため、計算し直しが要る日が ' + data.recalcDays + ' 日あります。' : '';
      ui.$('recalc').hidden = !data.recalcDays;
      ui.$('stale-note').hidden = !data.summaryStaleDays;
      ui.$('stale-note').textContent = data.summaryStaleDays ? '集計のずれが ' + data.summaryStaleDays + ' 日あります。「法律上の時間外の目安」の画面で「集計を作り直す」を押してください。' : '';
    }

    /** 締めた期間の知らせ（手順8 2-4。直せるかはサーバーが editable で決める） */
    function renderClosed() {
      var closed = !!(data.closing && data.closing.closed);
      var note = !closed ? '' : data.editable ? '締めた期間です。直すと修正履歴に残ります。' : 'この期間は締めました。直すときは管理者に頼んでください。';
      ui.$('closed-note').hidden = !note;
      ui.$('closed-note').textContent = note;
    }

    function renderList() {
      renderClosed();
      // 部長が部署の人を見るときは「見るだけ」（手順9 1-3。サーバーの viewOnly）
      ui.$('title').textContent = data.employee.employeeId === (me && me.employeeId) ? '日報' : data.employee.name + 'さんの日報' + (data.viewOnly ? '（見るだけ）' : '');
      ui.$('period-label').textContent = data.period.label;
      ui.$('next').disabled = !data.nextDate;
      var t = data.totals;
      var dl = ui.clear(ui.$('totals'));
      [['実働', fmt(t.work)], ['所定を超えた時間', fmt(t.furikae)], ['足りない時間', fmt(t.shortage)], ['未入力の出勤日', t.missing + '日']]
        .forEach(function (kv) { dl.appendChild(ui.el('dt', { text: kv[0] })); dl.appendChild(ui.el('dd', { text: kv[1] })); });
      leaveTotals(dl);
      var ul = ui.clear(ui.$('days'));
      data.days.forEach(function (d) {
        var out = d.state === 'out'; // 部長の範囲外の日（中身は返らない。開けない）
        var kind = out ? '範囲外' : d.companyScheduled === null ? '所定不明' : d.companyType === 'H' ? '休み' : '出勤';
        var state = out ? '' : d.state === 'work' ? '実働 ' + fmt(d.row['実働']) : d.state === 'workless' ? '勤務なし' : d.leaveDay ? '休み' : (d.date > data.today ? '' : '未入力');
        var cls = 'day-item' + (d.dow === 0 ? ' sun' : d.dow === 6 ? ' sat' : '') + (current && current.date === d.date ? ' selected' : '');
        var btn = ui.el('button', {
          type: 'button', class: cls, disabled: d.date > data.today || out,
          'aria-label': dateLabel(d) + ' ' + kind + ' ' + state,
          on: { click: ui.drawing(function () { openDay(d); }) },
        }, [
          ui.el('span', { class: 'day-date', text: dateLabel(d) }),
          ui.el('span', { class: 'day-kind', text: kind }),
          ui.el('span', { class: 'day-state' + (state === '未入力' ? ' missing' : ''), text: state }),
          d.needsRecalc ? ui.el('span', { class: 'tag warn', text: '計算し直し' }) : null,
          Array.isArray(d.leave) && d.leave.length ? ui.el('span', { class: 'tag', text: d.leave.map(LV.label).join('・') }) : null,
          d.leave && !Array.isArray(d.leave) && d.leave.label ? ui.el('span', { class: 'tag', text: d.leave.label + ' ' + LV.hm(d.leave.minutes) }) : null, // 部長が見るとき
          d.leaveAuto ? ui.el('span', { class: 'tag', text: '足りない時間 ' + LV.allocText(d.leaveAuto, 'leave') }) : null,
          Array.isArray(d.leave) && d.leave.some(function (l) { return l.conflict; }) ? ui.el('span', { class: 'tag warn', text: '休みと勤務が重なっています' }) : null,
        ]);
        ul.appendChild(ui.el('li', {}, [btn]));
      });
    }

    // ------------------------------------------------------------------ 1日の入力

    function confirmLeave() {
      if (!dirty) return Promise.resolve(true);
      return ui.confirm('保存していない入力があります', '入れた内容を捨てて移りますか？', '捨てて移る', 'danger');
    }

    function openDay(d) {
      confirmLeave().then(ui.drawing(function (ok) { // 日を切り替えて描く。途中で止まったら「読み込み直す」だけにする
        if (!ok) return;
        current = d;
        var back = CR.fromSlots(d.row || {});
        entries = back.entries.length ? back.entries : [emptyEntry()];
        ui.$('note').value = back.note;
        dirty = false;
        var filled = fillFromTasks();
        renderForm();
        if (filled) ui.pageMessage('完了したタスクから施工内容を入れました' + (filled.cut ? '（長いため一部だけ）' : '') + '。確かめて保存してください', 'info');
        renderList();
        ui.$('form-pane').hidden = false;
        ui.$('form-pane').scrollIntoView({ block: 'start' });
      }));
    }

    /**
     * 完了したタスクを施工内容に入れる（タスクリストの計画 2-9）。入れる先は1つ: 日勤の勤務があれば日勤、無くて夜勤があれば夜勤、勤務が無ければ勤務1。
     * その施工内容が空のときだけ（別の勤務には回さない）。画面の上だけで、保存は本人が押す。
     * サーバーは本人が本人の日報を開いたときだけ completedTasks を返す。締めた期間・計算できない日・社員の画面を見ているときは入れない。
     * 入れるのは、施工内容の字数に入る分だけ（CalcTask.reportFill。仕上げの計画 第1章）。返す値: 入れなければ null、入れたら { cut: 入れなかった・切ったものがあるか }
     */
    function fillFromTasks() {
      var texts = data.completedTasks ? data.completedTasks[current.date] : null;
      if (!texts || !texts.length || !data.editable || !current.canCalc || MP.guard.viewing()) return null;
      if (data.closing && data.closing.closed) return null; // 締めた期間は入れない（管理者本人でも。Codex 実装1回目 medium）
      var target = -1;
      ['day', 'night'].some(function (kind) {
        for (var i = 0; i < entries.length; i++) {
          if (CR.classifyShift(entries[i], CW, data.rules).kind === kind) { target = i; return true; }
        }
        return false;
      });
      if (target < 0) {
        var hasTimes = entries.some(function (e) { return e.arrive || e.start || e.end || e.leave; });
        if (hasTimes) return null; // 時刻はあるが日勤・夜勤に分けられない（入力の途中）ときは入れない
        target = 0;
      }
      var e = entries[target];
      if (String(e.content || '').trim() !== '') return null;
      var fill = window.CalcTask.reportFill(texts, data.rules.REPORT.CONTENT_MAX, CR.textLength);
      if (fill.text === '') return null;
      e.content = fill.text;
      dirty = true;
      return { cut: fill.cut };
    }

    function renderForm() {
      var d = current;
      ui.$('form-title').textContent = dateLabel(d) + ' の日報';
      var sched = d.companyScheduled === null ? '所定が分かりません（管理者に連絡してください）'
        : d.companyType === 'H' ? '休みの日（所定 0:00）' : '出勤日（所定 ' + fmt(d.companyScheduled) + '）';
      ui.$('form-sched').textContent = sched + (d.department ? '・' + d.department : '');
      var note = !d.canCalc ? 'この日の部署の休憩方式が決まっていません。管理者に連絡してください'
        : d.needsRecalc ? '計算の決まりが変わりました。管理者が計算し直します（今の数字は前の決まりのものです）' : '';
      ui.$('form-note').hidden = !note;
      ui.$('form-note').textContent = note;
      leaveForm(d);
      var editable = data.editable && d.canCalc;
      ui.$('save').disabled = !editable || MP.guard.viewing(); // 社員の画面を見ている間は保存しない（計画 stage1-viewas-plan.md 1-6）
      var own = !!data.patterns;
      ui.$('use-pattern').hidden = !own;
      ui.$('make-pattern').hidden = !own || MP.guard.viewing();
      renderEntries();
      update();
      lockForm();
    }

    // ------------------------------------------------------------------ 休暇（段階2。計画 stage2-leave-plan.md 第9章）

    var LV = MP.leaveView;

    /** 合計の欄に、休暇の残り（本人と管理者だけ。サーバーが返したときだけ）と期間の休み */
    function leaveTotals(dl) {
      var add = function (k, v) { dl.appendChild(ui.el('dt', { text: k })); dl.appendChild(ui.el('dd', { text: v })); };
      var b = data.leaveBalance;
      if (b) {
        add('有給の残り', LV.dh(b.paid, b.dayMin || 480) + (b.paidReserved ? '（先の申請を引くと ' + LV.dh(b.paid - b.paidReserved, b.dayMin || 480) + '）' : ''));
        add('振替残高', LV.hm(b.furikae) + '（振替出勤 ' + LV.hm(b.earned) + '・振替休日 ' + LV.hm(b.used) + '）');
      }
      var lt = data.totals.leave;
      if (lt && (lt.paid || lt.furikae || lt.absent || lt.carePaid || lt.careUnpaid)) add('この期間の休み', LV.allocText(lt, 'leave'));
    }

    /** 1日の入力の欄に、その日の休み（自動の文は本人の備考とは別の行。直せない・30字に数えない）と「休みを申請する」 */
    function leaveForm(d) {
      var box = ui.clear(ui.$('form-leave'));
      var leaves = Array.isArray(d.leave) ? d.leave : [];
      var show = data.leaveReady && !data.viewOnly;
      box.hidden = !show;
      if (!show) return;
      box.appendChild(ui.el('h3', { text: 'この日の休み' }));
      if (!leaves.length && !d.leaveAuto) box.appendChild(ui.el('p', { class: 'sub', text: 'この日の休みはありません' }));
      leaves.forEach(function (l) {
        box.appendChild(ui.el('p', { class: 'leave-auto', text: '自動: ' + LV.label(l) }));
        if (l.conflict) box.appendChild(ui.el('p', { class: 'msg warn', text: l.conflict === 'WORKED_DAY' ? '1日の休みと勤務が両方あります。休みを直してください' : '休みと勤務の時刻が重なっています。休みを直してください' }));
      });
      if (d.leaveAuto) box.appendChild(ui.el('p', { class: 'leave-auto', text: '自動: 足りない時間 ' + LV.allocText(d.leaveAuto, 'leave') }));
      if (d.state === 'workless' && !leaves.length && d.companyScheduled) box.appendChild(ui.el('p', { class: 'msg info', text: '休んだ日は、休暇の画面から休みを申請してください（日報に「有給」と書くだけでは有給になりません）' }));
      if (d.shortage && d.leaveMinutes) box.appendChild(ui.el('p', { class: 'sub', text: '休みで埋めた分を引いた足りない時間 ' + fmt(Math.max(0, d.shortage - d.leaveMinutes)) }));
      var href = 'leave.html?date=' + encodeURIComponent(d.date) + (data.employee.employeeId !== (me && me.employeeId) ? '&employeeId=' + encodeURIComponent(data.employee.employeeId) : '');
      if (!MP.guard.viewing()) box.appendChild(ui.el('a', { class: 'btn', href: href, text: '休みを申請する' }));
    }

    /** 分を「1時間」「1時間30分」「45分」の形に */
    function minutesText(min) {
      var h = Math.floor(min / 60), m = min % 60;
      return (h ? h + '時間' : '') + (m || !h ? m + '分' : '');
    }

    /** 分の選択肢（RULES.WORK.TIME_STEP_MIN ごと。'00'・'30' など） */
    function minuteOptions() {
      var out = [];
      for (var x = 0; x < 60; x += data.rules.TIME_STEP_MIN) out.push((x < 10 ? '0' : '') + x);
      return out;
    }

    function timeSelect(id, label, value, onChange) {
      var m = /^(\d{1,2}):(\d{2})$/.exec(value || '');
      var h = ui.el('select', { id: id + '-h', 'aria-label': label + '（時）', on: { change: onChange } }, [ui.el('option', { value: '', text: '—' })]);
      for (var i = 0; i < 24; i++) h.appendChild(ui.el('option', { value: String(i), text: String(i), selected: m && Number(m[1]) === i }));
      var mi = ui.el('select', { id: id + '-m', 'aria-label': label + '（分）', on: { change: onChange } }, [ui.el('option', { value: '', text: '—' })]);
      minuteOptions().forEach(function (x) { mi.appendChild(ui.el('option', { value: x, text: x, selected: m && m[2] === x })); });
      // 欄の中は数字だけ（幅 390px でも切れないように）。時と分の間に「:」
      return ui.el('div', { class: 'field time-field' }, [ui.el('span', { class: 'label', id: id + '-label', text: label }),
        ui.el('div', { class: 'time-pick', role: 'group', 'aria-labelledby': id + '-label' }, [h, ui.el('span', { class: 'time-colon', text: ':', 'aria-hidden': 'true' }), mi])]);
    }

    function readTime(id) {
      var h = ui.$(id + '-h'), m = ui.$(id + '-m');
      if (h.value === '') return '';
      if (m.value === '') m.value = '00'; // 時だけ選んだら 00分
      return h.value + ':' + m.value;
    }

    function renderEntries() {
      var box = ui.clear(ui.$('entries'));
      entries.forEach(function (e, i) {
        var id = 'e' + i;
        var onChange = ui.drawing(function () {
          FIELDS.forEach(function (f) { entries[i][f] = readTime(id + '-' + f); });
          entries[i].direct = ui.$(id + '-direct').value;
          entries[i].place = ui.$(id + '-place').value;
          entries[i].content = ui.$(id + '-content').value;
          dirty = true;
          update();
        });
        var direct = ui.el('select', { id: id + '-direct', on: { change: onChange } });
        CR.DIRECT_VALUES.forEach(function (v) { direct.appendChild(ui.el('option', { value: v, text: v === '' ? 'なし' : v, selected: e.direct === v })); });
        var card = ui.el('fieldset', { class: 'entry', id: id }, [
          ui.el('legend', { text: '勤務 ' + (i + 1) }),
          ui.el('p', { class: 'entry-kind', id: id + '-kind', 'aria-live': 'polite' }),
          ui.el('div', { class: 'time-grid' }, FIELDS.map(function (f) { return timeSelect(id + '-' + f, LABEL[f], e[f], onChange); })),
          ui.el('p', { class: 'hint', id: id + '-next', hidden: true }),
          ui.el('div', { class: 'row' }, [
            ui.el('div', { class: 'field' }, [ui.el('label', { for: id + '-direct', text: '直行直帰' }), direct]),
            ui.el('div', { class: 'field' }, [ui.el('label', { for: id + '-place', text: '作業場所' }),
              ui.el('input', { type: 'text', id: id + '-place', value: e.place, autocomplete: 'off', on: { input: onChange } })]),
          ]),
          // 施工内容は勤務ごと（手順10b 2-5）。時刻を入れない日（有給など）は、勤務 1 の施工内容だけを書く
          ui.el('div', { class: 'field' }, [ui.el('label', { for: id + '-content', text: '施工内容' }),
            ui.el('input', { type: 'text', id: id + '-content', value: e.content || '', autocomplete: 'off', on: { input: onChange } }),
            ui.el('p', { class: 'hint', id: id + '-content-count' })]),
          ui.el('p', { class: 'field-error', id: id + '-error', role: 'alert', hidden: true }),
          entries.length > 1 || e.arrive || e.content ? ui.el('button', { type: 'button', class: 'btn danger', text: 'この勤務を消す', on: { click: ui.drawing(function () {
            entries.splice(i, 1);
            if (!entries.length) entries.push(emptyEntry());
            dirty = true;
            renderEntries();
            update();
          }) } }) : null,
        ]);
        box.appendChild(card);
      });
      ui.$('add-entry').hidden = entries.length >= data.rules.REPORT.ENTRY_MAX;
      lockForm();
    }

    /** 直せない日（締めた期間など。サーバーの editable と、その日の canCalc）は、入力の欄とボタンを止める（「一覧へ戻る」だけ押せる） */
    function lockForm() {
      if (!current) return;
      var editable = data.editable && current.canCalc;
      Array.prototype.forEach.call(ui.$('form-pane').querySelectorAll('input, select, textarea, button'), function (el) {
        if (el.id === 'close-form') return;
        // 直せる日を開き直したら戻す。ただし社員の画面を見ている間は、保存は押せないまま（計画 stage1-viewas-plan.md 1-6）
        el.disabled = !editable || (el.id === 'save' && MP.guard.viewing());
      });
      lockBroken();
    }

    function counter(id, max) {
      var left = max - CR.textLength(ui.$(id).value.trim());
      var p = ui.$(id + '-count');
      p.textContent = left >= 0 ? 'あと ' + left + ' 字' : left * -1 + ' 字多すぎます（' + max + ' 字まで）';
      p.className = left >= 0 ? 'hint' : 'field-error';
    }

    function neighborRow(offset) {
      var i = -1;
      data.days.forEach(function (d, k) { if (d.date === current.date) i = k; });
      if (i < 0) return null;
      i += offset;
      if (i >= 0 && i < data.days.length) return data.days[i].row;
      if (!data.neighbors) return null; // 部長が見るだけのときは、隣の日は返らない
      var n = offset < 0 ? data.neighbors.before : data.neighbors.after;
      return n.input;
    }

    /** 入力のたびに、その場で確かめて計算する（サーバーと同じ CalcReport） */
    function update() {
      var R = data.rules;
      counter('note', R.REPORT.NOTE_MAX);
      entries.forEach(function (e, i) {
        var id = 'e' + i;
        counter(id + '-content', R.REPORT.CONTENT_MAX);
        var c = CR.classifyShift(e, CW, R);
        var filled = e.arrive || e.start || e.end || e.leave;
        var onlyContent = !filled && !e.direct && !e.place && !!(e.content || '').trim();
        ui.$(id + '-kind').textContent = c.kind === 'night' ? '夜勤として計算します（休憩' + minutesText(R.NIGHT_BREAK) + '）' : c.kind === 'day' ? '日勤として計算します'
          : onlyContent ? '時刻の無い日（有給など）の施工内容として保存します' : '';
        var nx = ui.$(id + '-next');
        var cross = c.kind === 'night' && CW.parseHm(e.leave) !== null && CW.parseHm(e.leave) < CW.parseHm(e.arrive);
        nx.hidden = !cross;
        nx.textContent = cross ? '退社は翌日の ' + e.leave + ' として計算します' : '';
        var err = ui.$(id + '-error');
        err.hidden = true;
        FIELDS.forEach(function (f) { ui.$(id + '-' + f + '-h').removeAttribute('aria-invalid'); });
        if (filled && !c.kind && c.errors.length) showEntryError(i, c.errors[0]);
      });
      var res = ui.clear(ui.$('result'));
      var norm = CR.normalizeDay(input(), R);
      var slots = CR.toSlots(norm, CW, R);
      // 誤りの勤務の番号は、空の勤務を捨てた後の番号。画面の勤務の番号に直してから出す（Codex 手順10b 実装1回目 low）
      var uiIndex = [];
      entries.forEach(function (e, i) { if (!CR.normalizeDay({ entries: [e], note: '' }, R).entries.length) return; uiIndex.push(i); });
      var toUi = function (k) { return uiIndex[k] === undefined ? k : uiIndex[k]; };
      if (!slots.ok) {
        slots.errors.forEach(function (e) {
          if (e.entry === null) { var p = ui.$(e.field + '-count'); p.textContent = MESSAGES[e.code]; p.className = 'field-error'; }
          else if (e.field === 'content') { var q = ui.$('e' + toUi(e.entry) + '-content-count'); if (q) { q.textContent = MESSAGES[e.code]; q.className = 'field-error'; } }
          else if (e.field === 'place' || e.field === 'direct' || !e.field) showEntryError(toUi(e.entry), e);
        });
        res.appendChild(ui.el('p', { class: 'sub', text: '入力を直すと、実働などを計算します' }));
        return null;
      }
      if (!current.canCalc) return null;
      // 勤務の中の休みは実働から引く（休暇 第17章。サーバーと同じ共有の計算）
      var calc = CR.calcDay(slots.row, { date: current.date, breakType: current.breakType, leaves: MP.leaveView.reportLeavesFor(data, current.date) }, CW, R);
      if (!calc.ok) { res.appendChild(ui.el('p', { class: 'field-error', text: MESSAGES[calc.errors[0].code] || '計算できません' })); return null; }
      var ov = CR.checkOverlap(neighborRow(-1), slots.row, neighborRow(1), CW, R);
      if (ov.errors.length) {
        var o = ov.errors[0];
        var idx = slots.slotOf[o.slot];
        showEntryError(idx === undefined ? 0 : toUi(idx), { field: o.field, code: 'OVERLAP', with: o.with });
        return null;
      }
      var hasNight = !!calc.slots.night;
      var bal = CR.balance(calc.work, current.companyScheduled, hasNight, CW, R);
      var dl = ui.el('dl', { class: 'kv' });
      ['day', 'night'].forEach(function (s) {
        var x = calc.slots[s];
        if (!x) return;
        var name = s === 'day' ? '日勤' : '夜勤';
        dl.appendChild(ui.el('dt', { text: name + 'の休憩' })); dl.appendChild(ui.el('dd', { text: fmt(x.calc.baseBreak + x.calc.extraBreak) }));
        dl.appendChild(ui.el('dt', { text: name + 'の実働' })); dl.appendChild(ui.el('dd', { text: fmt(x.calc.work) }));
      });
      dl.appendChild(ui.el('dt', { text: '実働（合計）' })); dl.appendChild(ui.el('dd', { text: fmt(calc.work) }));
      dl.appendChild(ui.el('dt', { text: '所定を超えた時間' })); dl.appendChild(ui.el('dd', { text: fmt(bal.furikae) }));
      dl.appendChild(ui.el('dt', { text: '足りない時間' })); dl.appendChild(ui.el('dd', { text: fmt(bal.shortage) }));
      res.appendChild(dl);
      if (calc.warnings.indexOf('LEGAL_BREAK_SHORT') >= 0) res.appendChild(ui.el('p', { class: 'msg warn', text: 'この時間の働き方では、会社の決まりの休憩が法律の休憩より短くなります。休憩を取ってください' }));
      if (calc.warnings.indexOf('NO_WORK') >= 0) res.appendChild(ui.el('p', { class: 'msg warn', text: '休憩を引くと実働がありません' }));
      ov.warnings.forEach(function (w) { res.appendChild(ui.el('p', { class: 'sub', text: WITH[w.with] + 'は、今の決まりでは確かめられませんでした' })); });
      return slots;
    }

    function showEntryError(i, e) {
      var err = ui.$('e' + i + '-error');
      if (!err) return;
      var where = e.field && LABEL[e.field] ? LABEL[e.field] + ': ' : e.field === 'place' ? '作業場所: ' : e.field === 'direct' ? '直行直帰: ' : '';
      err.textContent = where + (MESSAGES[e.code] || '入力を確かめてください') + (e.with ? '（' + WITH[e.with] + '）' : '');
      err.hidden = false;
      if (e.field && LABEL[e.field]) ui.$('e' + i + '-' + e.field + '-h').setAttribute('aria-invalid', 'true');
    }

    // ------------------------------------------------------------------ 保存

    function applyResult(r) {
      current.row = r.row;
      current.recordVersion = r.recordVersion;
      current.state = r.state;
      current.needsRecalc = false;
      var work = r.state === 'work' ? r.row['実働'] : 0;
      var bal = r.state === 'missing' ? { furikae: null, shortage: null }
        : CR.balance(work, current.companyScheduled, r.state === 'work' && r.row['夜_出社'] !== '', CW, data.rules);
      current.furikae = bal.furikae;
      current.shortage = bal.shortage;
      var t = { work: 0, furikae: 0, shortage: 0, missing: 0, unknown: data.totals.unknown };
      data.days.forEach(function (d) {
        if (d.state === 'work') t.work += d.row['実働'] || 0;
        if (d.furikae) t.furikae += d.furikae;
        if (d.shortage) t.shortage += d.shortage;
        if (d.state === 'missing' && d.companyScheduled && d.date <= data.today && !d.leaveDay) t.missing++;
      });
      if (data.totals.leave) t.leave = data.totals.leave;
      data.totals = t;
    }

    function doSave() {
      if (broken) return; // 描画が止まった後（出ている社員と食い違うかもしれない）
      if (!update()) {
        ui.pageMessage('入力を確かめてください（赤い文字のところ）', 'error');
        return;
      }
      var args = { employeeId: target, date: current.date, baseVersion: current.recordVersion, entries: entries.filter(function (e) {
        return e.arrive || e.start || e.end || e.leave || e.direct || e.place || e.content;
      }), note: ui.$('note').value };
      var sent = JSON.stringify(input()); // 送ったときの入力（送っている間に直した分は、保存できたことにしない）
      run(function () {
        return save('report.save', args).then(ui.drawing(function (res) { // 保存の後の描き直し。途中で止まったら「読み込み直す」だけにする
          if (ui.isBroken()) return; // 「読み込み直す」だけにした後に届いた返事では、描き直さない・窓を出さない
          if (res.ok) {
            applyResult(res.data);
            dirty = JSON.stringify(input()) !== sent; // 送っている間に直していれば、まだ保存していない入力として残す（別の日へ移るときに確かめる）
            var savedText = dateLabel(current) + ' の日報を保存しました' + (res.data.leaveStale ? '（休暇の残りは次に開いたときに直ります）' : '');
            if (data.leaveReady) {
              // 休暇の残り（振替出勤など）が変わるので、期間を読み直して同じ日を開き直す
              var keepDate = current.date;
              return load(keepDate).then(function () {
                if (ui.isBroken()) return; // 読み直しの間に「読み込み直す」だけになった
                current = data.days.filter(function (x) { return x.date === keepDate; })[0] || current;
                renderList();
                renderForm();
                ui.pageMessage(savedText, 'ok');
              });
            }
            ui.pageMessage(savedText, 'ok');
            renderList();
            renderForm();
            return;
          }
          if (res.code === 'CONFLICT') {
            var keep = { date: current.date };
            return ui.notice('他の画面で更新されています', '最新の内容を読み込みます。あなたが入れた内容は画面に残すので、見比べてから保存し直してください。').then(function () {
              return load(current.date).then(function () {
                if (ui.isBroken()) return; // 読み直しの間に「読み込み直す」だけになった
                current = data.days.filter(function (d) { return d.date === keep.date; })[0];
                // 入力（勤務の欄 entries・備考の欄）は、読み直しの間に直した分も含めて今のまま使う（読み込みは入力の欄に触れない。前に控えた中身で上書きしない）
                dirty = true;
                renderForm();
              });
            });
          }
          ui.pageMessage(res.message, 'error');
        }));
      });
    }

    // ------------------------------------------------------------------ 前日と同じ・定型パターン

    function fill(back) {
      entries = back.entries.length ? back.entries.map(function (e) { return Object.assign(emptyEntry(), e); }) : [emptyEntry()];
      if (back.note !== undefined) ui.$('note').value = back.note; // 前日と同じ: 備考も写す（定型パターンには備考が無いので変えない）
      dirty = true;
      renderEntries();
      update();
    }

    function copyPrev() {
      var row = neighborRow(-1);
      if (!row || CR.dayState(row) === 'missing') { ui.notice('前日と同じ', '前の日の日報がありません'); return; }
      fill(CR.fromSlots(row));
    }

    function usePattern() {
      var list = data.patterns || [];
      if (!list.length) { ui.notice('定型パターン', 'まだ定型パターンがありません。入力した後に「定型パターンにする」で登録できます'); return; }
      var body = ui.el('ul', { class: 'list' });
      var dlgPromise;
      list.forEach(function (p) {
        var desc = p.entries.map(function (e) { return (e.arrive ? e.arrive + '〜' + e.leave : '') + (e.place ? ' ' + e.place : '') + (e.content ? '・' + e.content : ''); }).join(' / ');
        body.appendChild(ui.el('li', {}, [
          ui.el('div', { class: 'item-title', text: p.name }), ui.el('div', { class: 'sub', text: desc }),
          ui.el('div', { class: 'item-actions' }, [
            ui.el('button', { type: 'button', class: 'btn primary', text: '使う', on: { click: ui.drawing(function (ev) {
              fill({ entries: p.entries });
              ev.target.closest('dialog').close();
            }) } }),
            MP.guard.viewing() ? null : ui.el('button', { type: 'button', class: 'btn danger', text: '消す', on: { click: ui.drawing(function (ev) {
              var dlg = ev.target.closest('dialog');
              dlg.close();
              ui.confirm('定型パターンを消す', '「' + p.name + '」を消しますか？', '消す', 'danger').then(ui.drawing(function (ok) {
                if (!ok) return;
                run(function () {
                  return MP.api.call('report.pattern.delete', { patternId: p.patternId }).then(function (res) {
                    if (res.ok) { data.patterns = res.data.patterns; ui.pageMessage('定型パターンを消しました', 'ok'); }
                    else ui.pageMessage(res.message, 'error');
                  });
                });
              }));
            }) } }),
          ]),
        ]));
      });
      dlgPromise = ui.dialog({ title: '定型パターンから', body: body, buttons: [{ label: '閉じる', value: null }] });
      return dlgPromise;
    }

    function makePattern() {
      if (broken) return; // 描画が止まった後（出ている社員と食い違うかもしれない）
      var slots = CR.toSlots(CR.normalizeDay(input(), data.rules), CW, data.rules);
      if (!slots.ok) { ui.notice('定型パターンにする', '入力を直してから登録してください'); return; }
      var back = CR.fromSlots(slots.row);
      if (!back.entries.length) { ui.notice('定型パターンにする', '登録する中身がありません'); return; }
      var name = ui.el('input', { type: 'text', id: 'pattern-name', autocomplete: 'off', maxlength: String(data.rules.REPORT.PATTERN_NAME_MAX) });
      var body = ui.el('div', { class: 'field' }, [ui.el('label', { for: 'pattern-name', text: '名前（例: 事務所のふつうの日）' }), name]);
      var rid = MP.api.newRequestId();
      ui.dialog({ title: '定型パターンにする', body: body, dismiss: false, buttons: [{ label: '登録する', value: true, kind: 'primary' }, { label: 'やめる', value: false }] })
        .then(ui.drawing(function (ok) {
          if (!ok) return;
          run(function () {
            return MP.api.call('report.pattern.save', { name: name.value, entries: back.entries }, { requestId: rid }).then(function (res) {
              if (res.ok) { data.patterns = res.data.patterns; ui.pageMessage('定型パターン「' + name.value.trim() + '」を登録しました', 'ok'); }
              else ui.pageMessage(res.message, 'error');
            });
          });
        }));
    }

    // ------------------------------------------------------------------ 管理者: 計算し直し

    function recalcAll() {
      if (broken) return; // 描画が止まった後（出ている社員と食い違うかもしれない）
      confirmLeave().then(ui.drawing(function (ok) { if (ok) recalcRun(); }));
    }

    function recalcRun() {
      // 計算し直すと版が上がるので、開いている日は閉じる（古い版のまま保存しない）
      dirty = false;
      current = null;
      ui.$('form-pane').hidden = true;
      var list = data.days.filter(function (d) { return d.needsRecalc; });
      run(function () {
        var n = 0;
        var step = function (i) {
          if (i >= list.length) return Promise.resolve();
          ui.pageMessage('計算し直しています… ' + (i + 1) + '/' + list.length + ' 日', 'info');
          return MP.api.call('report.admin.recalc', { employeeId: data.employee.employeeId, date: list[i].date, recordVersion: list[i].recordVersion }).then(function (res) {
            if (res.ok) n++;
            return step(i + 1);
          });
        };
        return step(0).then(function () {
          return load(data.days[0].date).then(function () { ui.pageMessage(n + ' 日を計算し直しました' + (n < list.length ? '（' + (list.length - n) + ' 日はできませんでした）' : ''), n < list.length ? 'warn' : 'ok'); });
        });
      });
    }

    // ------------------------------------------------------------------ つなぐ

    ui.$('prev').addEventListener('click', ui.drawing(function () { confirmLeave().then(ui.drawing(function (ok) { if (ok) { dirty = false; current = null; ui.$('form-pane').hidden = true; run(function () { return load(data.prevDate); }); } })); }));
    ui.$('next').addEventListener('click', ui.drawing(function () { confirmLeave().then(ui.drawing(function (ok) { if (ok && data.nextDate) { dirty = false; current = null; ui.$('form-pane').hidden = true; run(function () { return load(data.nextDate); }); } })); }));
    ui.$('emp-select').addEventListener('change', ui.drawing(function (ev) {
      var v = ev.target.value;
      confirmLeave().then(ui.drawing(function (ok) {
        if (!ok) { ev.target.value = data.employee.employeeId; return; }
        dirty = false; current = null; ui.$('form-pane').hidden = true;
        // 保存先の社員（target）は、出ている日報の社員に合わせる。読めなかった・動かなかったときは前の社員のまま（選択も戻す）
        var shown = function () {
          target = data.employee.employeeId === me.employeeId ? null : data.employee.employeeId;
          ev.target.value = data.employee.employeeId;
        };
        return run(function () { target = v === me.employeeId ? null : v; return load(data.days[0].date); }).then(ui.drawing(shown), ui.drawing(function (e) {
          // 描画の途中で止まったときは、前の社員の日が一覧に残っていることがあるので、一覧を消して開けなくする（保存先の社員と食い違わない）
          ui.clear(ui.$('days'));
          shown();
          throw e;
        }));
      }));
    }));
    // 押した・入れたときの処理は、すべて ui.drawing で包む（途中で止まったら「読み込み直す」だけにする）
    ui.$('add-entry').addEventListener('click', ui.drawing(function () { entries.push(emptyEntry()); renderEntries(); update(); }));
    ui.$('note').addEventListener('input', ui.drawing(function () { dirty = true; update(); }));
    ui.$('save').addEventListener('click', ui.drawing(doSave));
    ui.$('copy-prev').addEventListener('click', ui.drawing(copyPrev));
    ui.$('use-pattern').addEventListener('click', ui.drawing(usePattern));
    ui.$('make-pattern').addEventListener('click', ui.drawing(makePattern));
    ui.$('recalc').addEventListener('click', ui.drawing(recalcAll));
    ui.$('close-form').addEventListener('click', ui.drawing(function () {
      confirmLeave().then(ui.drawing(function (ok) { if (ok) { dirty = false; current = null; ui.$('form-pane').hidden = true; renderList(); } }));
    }));
    window.addEventListener('beforeunload', function (ev) { if (dirty) { ev.preventDefault(); ev.returnValue = ''; } });

    // 表で入力（手順7 2-6）: 同じ期間・同じ社員で開く
    ui.$('to-grid').addEventListener('click', ui.drawing(function (ev) {
      ev.preventDefault();
      confirmLeave().then(ui.drawing(function (ok) {
        if (!ok || ui.isBroken()) return;
        dirty = false;
        remember('grid');
        window.location.href = 'report_grid.html?date=' + encodeURIComponent(data ? data.days[0].date : '') + (target ? '&employee=' + encodeURIComponent(target) : '');
      }));
    }));

    // 開く画面: ?view=day なら1日ずつ（覚える）。それ以外は、この端末で最後に使った方。覚えていなければ、広い画面でマウスなどの端末は表
    var q = new URLSearchParams(window.location.search);
    if (q.get('view') === 'day') remember('day');
    else {
      var last = null;
      try { last = window.localStorage.getItem(VIEW_KEY); } catch (e) { last = null; }
      var wide = !!(window.matchMedia && window.matchMedia('(min-width: 1024px) and (pointer: fine)').matches);
      if (last === 'grid' || (last !== 'day' && wide)) {
        window.location.replace('report_grid.html' + window.location.search);
        return new Promise(function () {});
      }
    }
    var date = q.get('date');
    var employee = q.get('employee');
    if (employee && /^E\d{4}$/.test(employee)) target = employee;
    var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // 開く期間を決めるだけ（日付の確かめはサーバー）
    return load(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today, true);
  });
})();
