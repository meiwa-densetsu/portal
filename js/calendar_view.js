/*
 * 会社カレンダーの12か月の表（admin_calendars.html と admin_employee_calendar.html で使う部品）
 *
 *   var v = MP.calView.render(container, {
 *     period: { from, to, days }, rules,                     // rules は サーバーの cal_rules_（WEEK_START_DOW など）
 *     cell: function (i, date, dow) → { type: 'W'|'H'|'P'|null, disabled, changed, swap, note },
 *     onClick: function (i) { … }                          // 押された日の番号（期間の初めから 0, 1, …）
 *   });
 *   v.refresh(i)  … その日のマスと、その月の出勤日数だけを描き直す（押した後もフォーカスが残る）
 *
 * 色だけで区分を分けない（「出」「休」「推」の字も出す）。マスは「11月21日 土曜 出勤」のように読み上げられる名前を持つ
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  var TYPE_TEXT = { W: '出勤', H: '休み', P: '有給推奨' };
  var TYPE_MARK = { W: '出', H: '休', P: '推' };
  var DOW = ['日', '月', '火', '水', '木', '金', '土'];

  function render(container, o) {
    var ui = MP.ui, el = ui.el;
    var C = window.CalcCalendar;
    var start = C.dayNumber(o.period.from);
    var weekStart = typeof o.rules.WEEK_START_DOW === 'number' ? o.rules.WEEK_START_DOW : 1;
    var buttons = [];
    var months = []; // { first, last, countEl }
    ui.clear(container);
    var wrap = el('div', { class: 'cal-months' });
    var i = 0;
    while (i < o.period.days) {
      var date = C.dateOf(start + i);
      var y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
      var countEl = el('span', { class: 'sub' });
      var box = el('section', { class: 'cal-month', 'aria-label': y + '年' + m + '月' }, [el('h3', {}, [y + '年' + m + '月', countEl])]);
      var grid = el('div', { class: 'cal-grid' });
      for (var k = 0; k < 7; k++) grid.appendChild(el('div', { class: 'cal-head', 'aria-hidden': 'true', text: DOW[(weekStart + k) % 7] }));
      var firstDow = C.dowOf(start + i);
      for (var b = 0; b < (firstDow - weekStart + 7) % 7; b++) grid.appendChild(el('div', { class: 'cal-blank', 'aria-hidden': 'true' }));
      var month = { first: i, last: i, countEl: countEl };
      while (i < o.period.days && C.dateOf(start + i).slice(0, 7) === date.slice(0, 7)) {
        var btn = el('button', { type: 'button', 'data-i': String(i) });
        btn.addEventListener('click', (function (n) { return function () { o.onClick(n); }; })(i));
        buttons[i] = btn;
        grid.appendChild(btn);
        month.last = i;
        months[i] = month;
        i++;
      }
      box.appendChild(grid);
      wrap.appendChild(box);
    }
    container.appendChild(wrap);

    function paint(n) {
      var date = C.dateOf(start + n);
      var dow = C.dowOf(start + n);
      var c = o.cell(n, date, dow) || {};
      var btn = buttons[n];
      var mark = c.type ? TYPE_MARK[c.type] : '—';
      btn.className = 'cal-day ' + (c.type || 'none') + (c.changed ? ' changed' : '') + (c.swap ? ' swap' : '');
      ui.clear(btn);
      btn.appendChild(el('span', { text: String(Number(date.slice(8, 10))) }));
      btn.appendChild(el('span', { class: 't', text: mark }));
      btn.disabled = !!c.disabled;
      var label = Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日 ' + DOW[dow] + '曜 ' + (c.type ? TYPE_TEXT[c.type] : '決まっていません');
      if (c.note) label += '（' + c.note + '）';
      if (c.changed) label += '（まだ保存していません）';
      btn.setAttribute('aria-label', label);
      btn.title = label;
      return c.type === 'W' || c.type === 'P';
    }
    function paintMonth(month) {
      var n = 0;
      for (var k = month.first; k <= month.last; k++) if (paint(k)) n++;
      month.countEl.textContent = '出勤 ' + n + '日';
    }
    var seen = [];
    months.forEach(function (mo) { if (seen.indexOf(mo) < 0) { seen.push(mo); paintMonth(mo); } });

    return {
      refresh: function (n) { paintMonth(months[n]); },
      refreshAll: function () { seen.forEach(paintMonth); },
      button: function (n) { return buttons[n]; },
    };
  }

  /** 区分の説明（凡例）。色だけでなく字でも分ける */
  function legend(extra) {
    var el = MP.ui.el;
    var items = [['W', '出勤'], ['H', '休み'], ['P', '有給推奨（出勤日に数える）']].map(function (t) {
      return el('span', {}, [el('span', { class: 'cal-day ' + t[0], 'aria-hidden': 'true' }, [el('span', { class: 't', text: TYPE_MARK[t[0]] })]), t[1]]);
    });
    (extra || []).forEach(function (x) { items.push(el('span', {}, [el('span', { class: 'cal-day ' + x[0], 'aria-hidden': 'true' }, [el('span', { class: 't', text: x[1] })]), x[2]])); });
    return el('div', { class: 'cal-legend' }, items);
  }

  /** 'yyyy-MM-dd' → '11/21' */
  function md(date) { return Number(date.slice(5, 7)) + '/' + Number(date.slice(8, 10)); }

  /** 期間の名前（例「2026年度（2026/5/1〜2027/4/30）」） */
  function periodName(p) {
    var f = p.from.split('-'), t = p.to.split('-');
    return f[0] + '年度（' + Number(f[0]) + '/' + Number(f[1]) + '/' + Number(f[2]) + '〜' + Number(t[0]) + '/' + Number(t[1]) + '/' + Number(t[2]) + '）';
  }

  MP.calView = { render: render, legend: legend, md: md, periodName: periodName, TYPE_TEXT: TYPE_TEXT, TYPE_MARK: TYPE_MARK, DOW: DOW };
})();
