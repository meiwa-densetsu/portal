/*
 * 給与の目安（管理者だけ）。段階3。計画 docs/plans/stage3-pay-estimate-plan.md 第5章・13-8・14-1
 *
 * 締めの期間 1 つの、全社員の「合計の目安」（固定の 11 項目 ＋ 夜勤手当）と、合計に入れない
 * 「参考: 法律で数えた残業代の目安」（① 時間で引いた額・② 金額で比べた額・法定休日・深夜）と「振替に貯めた時間」。
 * 計算はサーバーだけ（この画面は出すだけ）。答えは端末に残さない（localStorage などに入れない）。
 * 「計算できません」を 0 円と出さない。正式な給与計算ではない（いつも上に出す）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui;
    var CW = window.CalcWorktime;
    var CP = window.CalcPay;
    var data = null;
    var LABELS = {
      basePay: '基本給', evalPay: '査定給', incentive: '奨励金', lifePlanPrepay: '生涯設計前払金', officerAllowance: '役員手当',
      positionAllowance: '役職手当', licenseAllowance: '免許手当', housingMealAllowance: '住宅食事手当', fixedOvertimePay: '見込み残業手当',
      familyAllowance: '家族手当', commute: '交通費', fixedOvertimeMinutes: '含み残業時間', nightShiftPay: '夜勤1日あたりの金額',
      dailyMin: '1日の所定労働時間', employmentType: '雇用区分',
    };
    var CODES = { NO_CALENDAR: 'カレンダーが確定していません', NO_TYPE: '雇用区分が分かりません', RATE_ORDER: '割増率の設定の順が正しくありません' };
    var REASONS = {
      MISSING: '未入力の日があります', NOT_YET: '年度の途中です', BOUNDARY_WEEK: '割り当ての境目の週があります',
      SCHEDULE_UNKNOWN: 'カレンダーが未設定・下書きの期間があります（その間の時間外は数えていません）', SUMMARY_STALE: '集計がずれています（法律上の時間外の目安の画面で作り直してください）',
      NO_SCHEDULE: 'カレンダーが確定していない日があり、日報の無い日を見つけられません',
      MIXED_WEEK: '変形と、ふつうの決まりが切り替わる週があります', VARIANT_UNKNOWN: 'カレンダーの協定の印が読めません',
    };
    var CAL = { UNASSIGNED: 'カレンダーが未設定です', NO_PERIOD: 'その年度のカレンダーがありません', DRAFT: 'カレンダーが確定していません' };
    // 固定の 11 項目（合計の目安に入れるもの）。CalcPay の 13 項目から含み残業時間・夜勤の金額を除いた並び
    var FIXED = CP.PAY_KEYS.filter(function (k) { return k !== CP.KEY.FIXED_OT_MIN && k !== CP.KEY.NIGHT_PAY; });

    function comma(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    function hm(min) { return min === null || min === undefined ? '—' : CW.formatHm(min); }
    function md(d) { return Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日'; }
    function labelOf(k) { return LABELS[k] || k; }

    /** 欄の文字。計算できないときは理由（0 円と出さない） */
    function cellText(c) {
      if (!c) return '—';
      if (c.yen !== null) return comma(c.yen) + '円';
      var why = [];
      if (c.missing && c.missing.length) why.push('未入力: ' + c.missing.map(labelOf).join('・'));
      if (c.unreadable && c.unreadable.length) why.push('読めない値: ' + c.unreadable.map(labelOf).join('・'));
      (c.codes || []).forEach(function (k) { why.push(CODES[k] || k); });
      return '計算できません（' + why.join('／') + '）';
    }

    function totalText(t) {
      if (t.status === 'ok') return comma(t.yen) + '円';
      if (t.status === 'unreadable') return '出せません（読めない値: ' + t.unreadable.map(labelOf).join('・') + '）';
      return '未確定（未入力 ' + t.missing.length + ' 項目: ' + t.missing.map(labelOf).join('・') + '）';
    }

    function rateText(p) { return (p / 1000).toString().replace(/0+$/, '').replace(/\.$/, ''); }

    /** 注意の一覧（文字の配列） */
    function notesOf(e) {
      var m = e.estimate, n = e.notes, out = [];
      if (n.NO_HISTORY) out.push('その期間の社員履歴がありません');
      if (n.CALENDAR) out.push((CAL[n.CALENDAR] || n.CALENDAR) + '（単価を出せません）');
      if (n.YEAR_ESTIMATED) out.push('年の総枠を超えた分は推計です（境目の週・日報の抜けがあると、多くも少なくも出ます）');
      if (n.YEAR_PENDING) out.push('年の総枠の時間外はまだ決まっていません');
      if (e.changedDates.length) out.push('期間の途中で変わっています（' + e.changedDates.map(md).join('・') + '）。期間の最後の日の内容で計算しています');
      if (m.total.status === 'incomplete') out.push('未入力 ' + m.total.missing.length + ' 項目');
      if (m.total.status === 'unreadable') out.push('読めない値があります（' + m.total.unreadable.map(labelOf).join('・') + '）');
      if (n.SHORTFALL) out.push('見込み残業手当が含み残業時間分（' + comma(m.ref.fixedOtValue.yen) + '円）より ' + comma(m.ref.shortfall.yen) + '円少ない');
      if (n.DC_OVER) out.push('生涯設計前払金が上限（' + comma(data.dcLimitYen) + '円）を超えています');
      if (n.RETIRED) out.push('利用停止の人です。退職した人の年の清算は数えていません');
      if (n.FURIKAE_UNKNOWN) out.push('カレンダーが分からない日があり、振替に貯めた時間は一部だけです');
      // 年度の途中・境目の週は、ほぼ毎回付く（5/1 が月曜でない年）。金額への効き目は「年の総枠は推計です／まだ決まっていません」で出すので、ここでは出さない
      e.legalReasons.forEach(function (k) { if (k !== 'NOT_YET' && k !== 'BOUNDARY_WEEK') out.push(REASONS[k] || k); });
      return out;
    }

    /** 参考の列（月収制は ①・② を分ける。日給制は時間外の欄 1 つ） */
    function refCols(e) {
      var r = e.estimate.ref;
      if (e.type === 'daily') {
        return { byTime: cellText(r.overtime), byAmount: '—（日給制）', sumByTime: cellText(r.sum), sumByAmount: '—（日給制）' };
      }
      return { byTime: cellText(r.byTime), byAmount: cellText(r.byAmount), sumByTime: cellText(r.sumByTime), sumByAmount: cellText(r.sumByAmount) };
    }

    function typeText(e) {
      return e.employmentType ? e.employmentType : '雇用区分なし';
    }

    function load(date, first) {
      var args = { date: date };
      var p = first ? MP.guard.enter({ admin: true, load: { action: 'pay.admin.estimate', args: args } })
        : MP.api.call('pay.admin.estimate', args).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return false; } // サーバーの断り・通信の失敗は、ほかの画面と同じく返事の文を出す
        data = r.res.data;
        ui.$('view').hidden = false;
        render();
        return true;
      });
    }

    function render() {
      ui.$('period-label').textContent = data.period.label;
      ui.$('next').disabled = !data.nextDate;
      ui.$('closed-state').textContent = data.closed === true ? 'この期間は締めてあります'
        : data.closed === false ? 'まだ締めていません（日報が変わると目安も変わります）' : '締めの状態が読めません';
      var rt = data.rates;
      ui.$('rates').textContent = '今の設定の割増率で計算しています（時間外 ' + rateText(rt.OVERTIME) + ' 倍・月45時間を超えた分 ' + rateText(rt.OVER_45) +
        ' 倍・月60時間を超えた分 ' + rateText(rt.OVER_60) + ' 倍・法定休日 ' + rateText(rt.LEGAL_HOLIDAY) + ' 倍・深夜 ' + rateText(rt.DEEP_NIGHT) + '）。' +
        data.asOf.slice(5).replace('-', '/') + ' までの日報で計算しています';
      ui.$('rates-bad').hidden = data.ratesInOrder;
      renderCards();
      renderTable();
    }

    function renderCards() {
      var ul = ui.clear(ui.$('cards'));
      if (!data.employees.length) { ul.appendChild(ui.el('li', { text: 'この期間に在籍した社員がいません' })); return; }
      data.employees.forEach(function (e) {
        var m = e.estimate, rc = refCols(e);
        var detail = ui.el('div', { class: 'pay-detail', hidden: true });
        var notes = notesOf(e);
        var li = ui.el('li', { 'data-emp': e.employeeId }, [
          ui.el('div', { class: 'item-title', text: e.name + (e.active ? '' : '（利用停止）') }),
          ui.el('p', { class: 'sub', text: (e.department || '部署なし') + '・' + typeText(e) }),
          ui.el('p', { class: 'pay-total' }, ['合計の目安: ', ui.el('strong', { text: totalText(m.total) })]),
          m.total.status === 'incomplete' ? ui.el('p', { class: 'sub', text: '入っている項目だけの合計 ' + comma(m.total.partial) + '円（合計の目安ではありません）' }) : null,
          ui.el('p', { class: 'pay-ref-line' }, [e.type === 'daily'
            ? '参考（合計には入っていません）: ' + rc.sumByTime
            : '参考（合計には入っていません）: ① の形 ' + rc.sumByTime + '／② の形 ' + rc.sumByAmount]),
          notes.length ? ui.el('p', { class: 'sub pay-notes', text: '注意: ' + notes.join('・') }) : null,
          ui.el('div', { class: 'item-actions' }, [ui.el('button', { type: 'button', class: 'btn', text: '内訳を見る', on: { click: function (ev) {
            detail.hidden = !detail.hidden;
            ev.currentTarget.textContent = detail.hidden ? '内訳を見る' : '内訳を閉じる';
          } } })]),
          detail,
        ]);
        detail.appendChild(detailList(e));
        ul.appendChild(li);
      });
    }

    function kv(dl, k, v) {
      dl.appendChild(ui.el('dt', { text: k }));
      dl.appendChild(ui.el('dd', { text: v }));
    }

    function detailList(e) {
      var m = e.estimate, r = m.ref, rc = refCols(e);
      var box = ui.el('div', {});
      var dl = ui.el('dl', { class: 'kv' });
      FIXED.forEach(function (k) { kv(dl, k === 'basePay' && e.type === 'daily' ? '基本給（日給 × ' + m.workDays + '日）' : labelOf(k), cellText(m.fixed[k])); });
      kv(dl, '夜勤手当（' + m.nightCount + '回）', cellText(m.nightAllowance));
      kv(dl, '合計の目安', totalText(m.total));
      box.appendChild(dl);
      box.appendChild(ui.el('h3', { text: '参考: 法律で数えた残業代の目安（合計には入っていません）' }));
      var dr = ui.el('dl', { class: 'kv pay-ref' });
      kv(dr, '時間外（法律）', hm(m.minutes.overtime));
      if (e.type !== 'daily') kv(dr, '含み残業時間', m.minutes.fixedOvertime === null ? cellText({ yen: null, missing: ['fixedOvertimeMinutes'], unreadable: [], codes: [] }) : hm(m.minutes.fixedOvertime));
      kv(dr, '1時間あたりの単価', m.unit.yen !== null && m.unit.yen !== undefined ? comma(m.unit.yen) + '円' : cellText(m.unit));
      kv(dr, e.type === 'daily' ? '時間外の欄' : '① 時間で引いた額', rc.byTime);
      if (e.type !== 'daily') {
        kv(dr, '② 金額で比べた額', rc.byAmount);
        kv(dr, '含み残業時間分の額', cellText(r.fixedOtValue));
      }
      kv(dr, '法定休日（' + hm(m.minutes.legalHoliday) + '）', cellText(r.holiday));
      kv(dr, '深夜（' + hm(m.minutes.deepNight) + '）', cellText(r.deepNight));
      kv(dr, e.type === 'daily' ? '参考額の計' : '参考額の計（① の形）', rc.sumByTime);
      if (e.type !== 'daily') kv(dr, '参考額の計（② の形）', rc.sumByAmount);
      kv(dr, '振替に貯めた時間（参考）', hm(e.furikae));
      box.appendChild(dr);
      return box;
    }

    function renderTable() {
      var head = ui.clear(ui.$('pay-head'));
      var cols1 = [ui.el('th', { rowspan: 2, text: '社員' }), ui.el('th', { colspan: FIXED.length + 2, text: '合計の目安（会社が払う形）' }),
        ui.el('th', { colspan: 7, class: 'pay-ref', text: '参考: 法律で数えた残業代の目安（合計には入っていません）' }),
        ui.el('th', { rowspan: 2, text: '振替に貯めた時間' }), ui.el('th', { rowspan: 2, text: '注意' })];
      head.appendChild(ui.el('tr', {}, cols1));
      var cols2 = FIXED.map(function (k) { return ui.el('th', { text: labelOf(k) }); })
        .concat([ui.el('th', { text: '夜勤手当' }), ui.el('th', { text: '合計の目安' })])
        .concat(['時間外', '含み残業時間', '① 時間で引いた額', '② 金額で比べた額', '法定休日', '深夜', '参考額の計（①／②）']
          .map(function (t) { return ui.el('th', { class: 'pay-ref', text: t }); }));
      head.appendChild(ui.el('tr', {}, cols2));
      var body = ui.clear(ui.$('pay-rows'));
      data.employees.forEach(function (e) {
        var m = e.estimate, r = m.ref, rc = refCols(e);
        var tds = [ui.el('td', {}, [ui.el('div', { text: e.name + (e.active ? '' : '（利用停止）') }), ui.el('div', { class: 'sub', text: typeText(e) })])];
        // 固定の項目の欄は、項目の名前が見出しにあるので短く（「未入力」「読めない値」。0 円とは出さない）
        FIXED.forEach(function (k) {
          var c = m.fixed[k];
          var text = c.yen !== null ? comma(c.yen) + '円' : (c.unreadable.length ? '読めない値' : '未入力');
          tds.push(ui.el('td', { class: 'num', 'data-key': k, text: text }));
        });
        tds.push(ui.el('td', { class: 'num', 'data-key': 'nightAllowance', text: cellText(m.nightAllowance) }));
        tds.push(ui.el('td', { class: 'num pay-sum', 'data-key': 'total' }, [totalText(m.total),
          m.total.status === 'incomplete' ? ui.el('div', { class: 'sub', text: '入っている項目だけ ' + comma(m.total.partial) + '円' }) : null]));
        [[hm(m.minutes.overtime), 'overtime'],
          [e.type === 'daily' ? '—（日給制）' : (m.minutes.fixedOvertime === null ? '未入力' : hm(m.minutes.fixedOvertime)), 'fixedOvertime'],
          [rc.byTime, 'byTime'], [rc.byAmount, 'byAmount'], [cellText(r.holiday), 'holiday'], [cellText(r.deepNight), 'deepNight'],
          [e.type === 'daily' ? rc.sumByTime : rc.sumByTime + '／' + rc.sumByAmount, 'refSum']]
          .forEach(function (x) { tds.push(ui.el('td', { class: 'num pay-ref', 'data-key': x[1], text: x[0] })); });
        tds.push(ui.el('td', { class: 'num', 'data-key': 'furikae', text: hm(e.furikae) }));
        var notes = notesOf(e);
        tds.push(ui.el('td', { class: 'pay-notes', text: notes.length ? notes.join('・') : '' }));
        body.appendChild(ui.el('tr', { 'data-emp': e.employeeId }, tds));
      });
    }

    /** 期間を移る。ui.run は終わるとボタンを押せる形に戻すので、「次の期間」は終わった後に決め直す */
    function move(date) {
      var before = data;
      var opened = Array.prototype.slice.call(ui.$('cards').querySelectorAll('li[data-emp]')) // 内訳を開いていた社員（失敗したら、開いたまま戻す）
        .filter(function (li) { var d = li.querySelector('.pay-detail'); return d && !d.hidden; })
        .map(function (li) { return li.getAttribute('data-emp'); });
      var p = ui.run(function () { return load(date); });
      // 移れたら前の知らせを消す。返事が断り・通信の失敗なら load が返事の文を出し、表示は移る前のまま。
      // 表示の途中の問題（例外）は飲み込まず、ほかの画面と同じ一言で知らせる。ボタンは ui.run が押せる形に戻す。
      // 表示は移る前のもの（開いていた内訳も）に戻し、前後のボタンも移る前の期間から決める（途中まで描いた表示を残さない）
      if (p) p.then(function (moved) {
        ui.$('next').disabled = !data.nextDate;
        if (moved) ui.pageMessage('');
      }, function () {
        data = before;
        try {
          render();
          opened.forEach(function (id) {
            var li = ui.$('cards').querySelector('li[data-emp="' + id + '"]');
            var d = li && li.querySelector('.pay-detail');
            var btn = li && li.querySelector('.item-actions button');
            if (d) d.hidden = false;
            if (btn) btn.textContent = '内訳を閉じる';
          });
        } catch (e) { /* 戻せなくても、知らせは出す */ }
        ui.$('next').disabled = !data.nextDate;
        ui.pageMessage('読み込めませんでした。もう一度お試しください', 'error');
      });
    }
    ui.$('prev').addEventListener('click', function () { move(data.prevDate); });
    ui.$('next').addEventListener('click', function () { if (data.nextDate) move(data.nextDate); });

    var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // 開く期間を決めるだけ
    return load(today, true);
  });
})();
