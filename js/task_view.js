/*
 * タスクリストの表示の計算（計画 docs/plans/stage2-tasklist-v2-plan.md 2-2〜2-4・2-10・2-11）。
 * 画面の部品を使わない純粋な JS（Node のテストでも読み込む）。並び・締め切りの正本は CalcTask（gen/calc_task.js）
 *
 *   MP.taskView.entries(data, owner, date)   … その人・その日の並び: [{ kind: 'task' | 'mark', it, no }]（タスクは CalcTask.sortDay の順・番号つき。先送りの印は最後）
 *   MP.taskView.counts(list)                 … { open, total }（見出しの「残り◯／全◯件」。先送りの印は数えない）
 *   MP.taskView.due(it, data)                … 締め切りの印 { text, level }（無ければ null）
 *   MP.taskView.tags(it, data)               … 行に付ける印の文字の並び（依頼: 名前・新・🔒・↻3）
 *   MP.taskView.cellText(e, data)            … 月の表のマスに出す文字（番号以外をつないだもの）
 *   MP.taskView.fullText(e, data)            … 全文（選んだマスの帯・行のメニューに出す）
 *   MP.taskView.cls(e)                       … 状態の見た目の印（tk-done・tk-cancel・tk-mark・tk-urgent）
 *   MP.taskView.people(data, deptId, meId)   … その部署に出す人（自分を先に。deptId が '' なら全員）
 *   MP.taskView.handovers(data, deptId, date)… その日・その部署に出す申し送り（新しい申し送り → 前のメモ）
 *   MP.taskView.summary(data, deptId, date)  … 部署のまとめ [{ employeeId, name, open, over, deferred }]
 *   MP.taskView.moveArgs(data, it, dir)      … 上へ・下へで送る中身（同じ群の中でだけ。動かせなければ null）
 */
(function (root) {
  'use strict';
  // 画面では window.CalcTask。Node のテストでは globalThis.CalcTask に入れてから読み込む
  function ct() { return (root && root.CalcTask) || globalThis.CalcTask; }
  var ALL = '全員';

  function md(d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)); }

  function entries(data, owner, date) {
    var tasks = ct().sortDay(data.items.filter(function (i) { return i.owner === owner && i.date === date; }));
    var list = tasks.map(function (i, k) { return { kind: 'task', it: i, no: k + 1 }; });
    data.marks.filter(function (m) { return m.owner === owner && m.date === date; })
      .forEach(function (m) { list.push({ kind: 'mark', it: m, no: 0 }); });
    return list;
  }

  function counts(list) {
    var tasks = list.filter(function (e) { return e.kind === 'task'; });
    return { open: tasks.filter(function (e) { return e.it.state === '未完了'; }).length, total: tasks.length };
  }

  function due(it, data) {
    var soon = data.rules && typeof data.rules.dueSoonDays === 'number' ? data.rules.dueSoonDays : 2;
    var level = ct().dueLevel(it, data.nowDate, data.nowMin, soon);
    if (!level) return null;
    return { text: ct().dueLabel(it, data.nowDate, data.nowMin, soon), level: level };
  }

  function tags(it, data) {
    var out = [];
    var warn = data.rules && typeof data.rules.deferWarn === 'number' ? data.rules.deferWarn : 3;
    if (it.requester) out.push('依頼: ' + it.requesterName);
    if (it.fresh) out.push('新');
    if (it.hidden) out.push('🔒');
    if (it.deferCount >= warn && it.state === '未完了') out.push('↻' + it.deferCount);
    return out;
  }

  function stateText(it) { return it.state === '完了' ? ' ✓完了' : it.state === '取りやめ' ? '（取りやめ）' : ''; }

  function cellText(e, data) {
    var it = e.it;
    if (e.kind === 'mark') return '→' + md(it.to) + 'へ先送り ' + it.content + (it.hidden ? ' 🔒' : '');
    var u = ct().urgencyMark(it.urgency);
    var d = due(it, data);
    var t = tags(it, data);
    return (u ? u + ' ' : '') + it.content + (t.length ? '（' + t.join('・') + '）' : '') + stateText(it) + (d ? ' ' + d.text : '');
  }

  function fullText(e, data) {
    var it = e.it;
    if (e.kind === 'mark') return cellText(e, data) + '（先送りの印）';
    var parts = [it.state];
    var d = due(it, data);
    if (it.due) parts.push('締め切り ' + md(it.due) + (it.dueTime ? ' ' + Number(it.dueTime.slice(0, 2)) + ':' + it.dueTime.slice(3, 5) : '') + (d && d.level === 'over' ? '（過ぎています）' : ''));
    if (it.requester) parts.push('依頼: ' + it.requesterName);
    if (it.deferCount) parts.push('先送り ' + it.deferCount + ' 回');
    if (it.note) parts.push('一言: ' + it.note);
    if (it.consult) parts.push('相談: ' + it.consult.text);
    var u = ct().urgencyMark(it.urgency);
    return (e.no ? e.no + '. ' : '') + (u ? u + ' ' : '') + it.content + (it.hidden ? ' 🔒' : '') + '（' + parts.join('・') + '）';
  }

  function cls(e) {
    if (e.kind === 'mark') return 'tk-mark';
    return (e.it.state === '完了' ? 'tk-done' : e.it.state === '取りやめ' ? 'tk-cancel' : '') + (e.it.urgency !== '通常' && e.it.state === '未完了' ? ' tk-urgent' : '');
  }

  /** その部署に出す人。自分がいれば先に。deptId が ''（全員）なら全員。部署に入っていない人は全員でだけ出る */
  function people(data, deptId, meId) {
    var list = data.people.filter(function (p) { return !deptId || p.deptId === deptId; });
    var mine = list.filter(function (p) { return p.employeeId === meId; });
    return mine.concat(list.filter(function (p) { return p.employeeId !== meId; }));
  }

  /** その日・その部署に出す申し送り。新しい申し送り（その部署のものと「全員」。全員を見ているときは全部）→ 前のメモ（その日だけ・全員向け） */
  function handovers(data, deptId, date) {
    var out = (data.handovers || []).filter(function (h) {
      return h.from <= date && date <= h.to && (!deptId || h.deptId === deptId || h.deptId === ALL);
    }).map(function (h) { return { kind: 'handover', h: h }; });
    (data.memos || []).filter(function (m) { return m.date === date && m.content; })
      .forEach(function (m) { out.push({ kind: 'memo', h: { content: m.content, deptName: ALL, authorName: m.updatedBy || '', from: m.date, to: m.date } }); });
    return out;
  }

  /** 部署のまとめ: 人ごとの 残り・締め切り過ぎ・先送りが多い（その人に見えるタスクだけ） */
  function summary(data, deptId, date) {
    var warn = data.rules && typeof data.rules.deferWarn === 'number' ? data.rules.deferWarn : 3;
    return people(data, deptId, '').map(function (p) {
      var open = data.items.filter(function (i) { return i.owner === p.employeeId && i.date === date && i.state === '未完了'; });
      return {
        employeeId: p.employeeId, name: p.name, open: open.length,
        over: open.filter(function (i) { var d = due(i, data); return d && d.level === 'over'; }).length,
        deferred: open.filter(function (i) { return i.deferCount >= warn; }).length,
      };
    });
  }

  /**
   * 上へ（dir = -1）・下へ（dir = 1）で送る中身。動かす相手が同じ群（状態の組・急ぎ・締め切り）でなければ null。
   * 件数が上限（rules.moveMax）を超える日も null。返す値: { ownerId, date, order, versions }
   */
  function moveArgs(data, it, dir) {
    var list = ct().sortDay(data.items.filter(function (i) { return i.owner === it.owner && i.date === it.date; }));
    var max = data.rules && typeof data.rules.moveMax === 'number' ? data.rules.moveMax : 500;
    if (list.length > max) return null;
    var order = list.map(function (i) { return i.taskId; });
    var k = order.indexOf(it.taskId), j = k + dir;
    if (k < 0 || j < 0 || j >= order.length) return null;
    if (ct().groupKey(list[k]) !== ct().groupKey(list[j])) return null;
    order[k] = order[j]; order[j] = it.taskId;
    var versions = {};
    list.forEach(function (i) { versions[i.taskId] = i.recordVersion; });
    return { ownerId: it.owner, date: it.date, order: order, versions: versions };
  }

  var api = { ALL: ALL, md: md, entries: entries, counts: counts, due: due, tags: tags, cellText: cellText, fullText: fullText, cls: cls,
    people: people, handovers: handovers, summary: summary, moveArgs: moveArgs };
  if (root) { root.MP = root.MP || {}; root.MP.taskView = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
