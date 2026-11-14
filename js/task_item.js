/*
 * タスクリストの「1件の行」と「知らせの1件」を作る共通の部品（計画 docs/plans/stage2-tasklist-v2-plan.md 2-8・2-10）。
 * スマホの一覧（page_tasks.js）・知らせの欄（page_tasks.js）・依頼したものの一覧（page_task_requests.js）が同じ形で出す。
 * 何を出すか（締め切りの印・行の印の文字）の計算は task_view.js。ここは要素を作るだけで、押したときの処理は呼んだ側から受け取る。
 * 値はすべて MP.ui.el（textContent）で入れる
 *
 *   MP.taskItem.due(it, data)     … 締め切りの印（無ければ null）。data は { nowDate, nowMin, rules: { dueSoonDays } }
 *   MP.taskItem.tags(it, data)    … 行の印（依頼:名前・新・相談・🔒・↻3）をまとめた要素（無ければ null）
 *   MP.taskItem.row(e, data, o)   … 1件の行 <li>。[番号] [□] [急ぎ 内容 … 印] [〆]
 *        e: { kind: 'task' | 'mark', it, no }
 *        o: { canCheck（□ を押せるか）, disabled, onCheck(it, done), onOpen(it, no) }
 *   MP.taskItem.notice(n, o)      … 知らせの1件 <li>。o: { canDismiss, disabled, onDismiss(n) }
 */
(function () {
  'use strict';

  function shortName(name) { return String(name || '').split(/[ 　]/)[0]; }
  function md(d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)); }

  function due(it, data) {
    var d = MP.taskView.due(it, data);
    return d ? MP.ui.el('span', { class: 'due due-' + d.level, text: d.text }) : null;
  }

  function tags(it, data) {
    var ui = MP.ui;
    var warn = data.rules && typeof data.rules.deferWarn === 'number' ? data.rules.deferWarn : 3;
    var open = it.state === '未完了';
    var list = [];
    if (it.requester) list.push(ui.el('span', { class: 'tk-tag', text: '依頼:' + shortName(it.requesterName) }));
    if (it.fresh) list.push(ui.el('span', { class: 'tk-tag new', text: '新' }));
    if (it.consult) list.push(ui.el('span', { class: 'tk-tag', text: '相談' }));
    if (it.hidden) list.push(ui.el('span', { class: 'tk-tag', text: '🔒' }));
    if (it.deferCount >= warn && open) list.push(ui.el('span', { class: 'tk-tag warn', text: '↻' + it.deferCount }));
    return list.length ? ui.el('span', { class: 'tk-tags' }, list) : null;
  }

  function row(e, data, o) {
    var ui = MP.ui, CT = window.CalcTask;
    var it = e.it;
    if (e.kind === 'mark') {
      return ui.el('li', { class: 'tk-row tk-mark' }, [ui.el('span', { class: 'tk-no' }), ui.el('span', { class: 'tk-box-ro', text: '→' }),
        ui.el('span', { class: 'tk-main-ro' }, [ui.el('span', { class: 'tk-text', text: md(it.to) + 'へ先送り ' + it.content + (it.hidden ? ' 🔒' : '') })])]);
    }
    var done = it.state === '完了', cancelled = it.state === '取りやめ';
    var box = o.canCheck
      ? ui.el('button', { type: 'button', class: 'tk-check' + (done ? ' on' : ''), 'aria-label': (done ? '未完了に戻す: ' : '完了にする: ') + it.content, disabled: o.disabled,
        on: { click: function () { o.onCheck(it, done); } } }, [ui.el('span', { class: 'tk-box', text: done ? '✓' : '' })])
      : ui.el('span', { class: 'tk-box-ro', text: done ? '✓' : cancelled ? '—' : '・' });
    var u = CT.urgencyMark(it.urgency);
    var main = ui.el('button', { type: 'button', class: 'tk-main', 'aria-label': 'くわしく: ' + it.content, disabled: o.disabled, on: { click: function () { o.onOpen(it, e.no); } } }, [
      ui.el('span', { class: 'tk-text' }, [u ? ui.el('span', { class: 'tk-urg', text: u + ' ' }) : null, it.content, it.note && done ? '（' + it.note + '）' : '']),
      tags(it, data),
      due(it, data),
    ]);
    return ui.el('li', { class: 'tk-row ' + MP.taskView.cls(e) }, [ui.el('span', { class: 'tk-no', text: String(e.no) }), box, main]);
  }

  function notice(n, o) {
    var ui = MP.ui;
    var text = n.kind === 'done'
      ? n.ownerName + 'さんが「' + n.content + '」を完了しました' + (n.text ? '（一言: ' + n.text + '）' : '')
      : n.ownerName + 'さんから相談があります:「' + n.text + '」（タスク: ' + n.content + '）';
    var kids = [ui.el('div', { class: 'notice-text', text: text }), ui.el('div', { class: 'sub', text: ui.fmtDateTime(n.at) })];
    if (o.canDismiss) {
      kids.push(ui.el('div', { class: 'item-actions' }, [ui.el('button', { type: 'button', class: 'btn', text: '✕ 確かめた', 'aria-label': '知らせを消す: ' + n.content,
        disabled: o.disabled, on: { click: function () { o.onDismiss(n); } } })]));
    }
    return ui.el('li', { class: 'notice-item notice-' + n.kind }, kids);
  }

  MP.taskItem = { due: due, tags: tags, row: row, notice: notice, shortName: shortName };
})();
