/*
 * 部署の日報の一覧（部長・管理者。手順9。計画 docs/plans/stage1-step9-plan.md 1-2）
 *
 * 社員×日付の表（出退勤・実働・所定を超えた時間）。名前を押すと、その人の日報を見るだけで開く（部長は直せない）。
 * 範囲外の日（その日に見られる部署にいない）は「－」
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, el = ui.el, CW = window.CalcWorktime;
    ui.watchBroken(['page_manager.js']); // このファイルから出て誰も拾わなかった例外が出たら「読み込み直す」だけにする（保険）
    var DOW = ['日', '月', '火', '水', '木', '金', '土'];
    var data = null, deptId = null;
    var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

    function fmt(min) { return min === null || min === undefined ? '' : CW.formatHm(min); }

    function load(date, first) {
      var args = { date: date, deptId: deptId };
      var p = first ? MP.guard.enter({ load: { action: 'report.manager.list', args: args } })
        : MP.api.call('report.manager.list', args).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (ui.isBroken()) return false; // 「読み込み直す」だけにした後に届いた返事では、画面を描き直さない
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return false; }
        data = r.res.data;
        try {
          ui.$('view').hidden = false;
          render();
        } catch (e) {
          ui.showBroken(); // 描画が止まったら、画面の中身を隠して「読み込み直す」だけを出す（前の期間・部署の表示やリンクを残さない）
          throw e;
        }
        return true;
      });
    }

    function cellOf(d) {
      if (d.state === 'out') return { text: '－', title: '見られる部署にいない日', cls: 'out' };
      var due = d.companyType && d.companyType !== 'H' && d.date <= data.today; // 会社の出勤日で今日まで
      // 休暇（段階2・Q19）: 有給・振替・欠勤の名前（看護・介護は「休暇」）
      if (d.leave && d.leave.label && d.state === 'missing') return { text: d.leave.label.charAt(0), title: d.leave.label + ' ' + fmt(d.leave.minutes), cls: '' };
      if (d.state === 'missing') return { text: due ? '未' : '', title: '未入力', cls: due ? 'missing' : '' };
      if (d.leave && d.leave.label && d.state === 'workless') return { text: d.leave.label.charAt(0), title: d.leave.label + ' ' + fmt(d.leave.minutes) + '（時刻の無い日報）', cls: '' };
      if (d.state === 'workless') return { text: '0:00', title: '勤務なし', cls: '' };
      var t = [d['昼_出社'] ? d['昼_出社'] + '〜' + d['昼_退社'] : '', d['夜_出社'] ? '夜 ' + d['夜_出社'] + '〜' + d['夜_退社'] : ''].filter(Boolean).join(' ');
      var lv = d.leave && d.leave.label ? '（' + d.leave.label + ' ' + fmt(d.leave.minutes) + '）' : '';
      return { text: fmt(d['実働']) + (d.furikae ? '+' : '') + (lv ? '・' + d.leave.label.charAt(0) : ''), title: t + (d.furikae ? '（所定を超えた ' + fmt(d.furikae) + '）' : '') + lv, cls: d.furikae ? 'over' : '' };
    }

    function render() {
      ui.$('period-label').textContent = data.period.label;
      ui.$('next').disabled = !data.nextDate;
      var sel = ui.clear(ui.$('dept'));
      sel.appendChild(el('option', { value: '', text: '見られる部署すべて', selected: !deptId }));
      data.departments.forEach(function (d) { sel.appendChild(el('option', { value: d.deptId, text: d.name, selected: d.deptId === deptId })); });
      ui.$('empty').hidden = data.people.length > 0;
      var days = data.people.length ? data.people[0].days : [];
      var head = el('tr', {}, [el('th', { text: '名前' })].concat(days.map(function (d) {
        var n = CW.dayNumber(d.date);
        return el('th', { class: 'num', text: Number(d.date.slice(8, 10)) + '\n' + DOW[new Date(n * 86400000).getUTCDay()] });
      })).concat([el('th', { text: '実働の合計' }), el('th', { text: '所定を超えた' })]));
      var body = el('tbody', {}, data.people.map(function (p) {
        var work = 0, over = 0;
        p.days.forEach(function (d) { if (d.state === 'work' && typeof d['実働'] === 'number') work += d['実働']; if (d.furikae) over += d.furikae; });
        var href = 'report.html?view=day&employee=' + encodeURIComponent(p.employeeId) + '&date=' + encodeURIComponent(data.period.from);
        return el('tr', {}, [el('th', { class: 'name' }, [el('a', { href: href, text: p.name + (p.active ? '' : '（利用停止）') })])]
          .concat(p.days.map(function (d) { var c = cellOf(d); return el('td', { class: 'num ' + c.cls, title: c.title, text: c.text }); }))
          .concat([el('td', { class: 'num', text: fmt(work) }), el('td', { class: 'num', text: fmt(over) })]));
      }));
      ui.clear(ui.$('table')).appendChild(el('thead', {}, [head]));
      ui.$('table').appendChild(body);
    }

    /**
     * 読み込み直す。ui.run は終わるとボタンを押せる形に戻すので、「次」は終わった後に決め直す（給与の目安・法律の時間外の画面と同じ）。
     * ui.run が止めるのはボタンだけなので、部署の選択も止める。読めなかった・動かなかったときは、部署の選択を出ている一覧の部署に戻す
     */
    function reload(date, nextDept) {
      var sel = ui.$('dept'), before = deptId, started = false;
      var end = function (loaded) {
        if (!started) { sel.value = deptId || ''; return; } // ほかの送信の途中で動かなかった
        sel.disabled = false;
        if (loaded !== true) { deptId = before; sel.value = before || ''; }
        if (data) ui.$('next').disabled = !data.nextDate;
      };
      ui.run(function () { started = true; sel.disabled = true; deptId = nextDept; return load(date); }).then(ui.drawing(end), ui.drawing(function (e) { end(false); throw e; })); // ui.run の後の決め直しも包む
    }
    // 押した・選んだときの処理は、すべて ui.drawing で包む（途中で止まったら「読み込み直す」だけにする）
    ui.$('prev').addEventListener('click', ui.drawing(function () { reload(data.prevDate, deptId); }));
    ui.$('next').addEventListener('click', ui.drawing(function () { if (data.nextDate) reload(data.nextDate, deptId); }));
    ui.$('dept').addEventListener('change', ui.drawing(function (ev) { reload(data.period.from, ev.target.value || null); }));
    return load(today, true);
  });
})();
