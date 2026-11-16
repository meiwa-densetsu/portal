/*
 * タスクリストの「押したらすぐ変わる」の姿を作る（計画 docs/plans/stage2-task-speed-plan.md 第3章 3-1・3-2）。
 * 画面の部品を使わない純粋な JS（Node のテストでも読み込む）。
 *
 *   MP.taskOpt.view(base, opts, canOf) → 描くための姿
 *     canOf … （無くてよい）状態を変えたタスクの「できること」を作り直す関数 (item) → can。
 *            完了にすると直す・消す・リマインダー・相談ができなくなる（サーバーと同じ CalcTask.canAll で作る。Codex 実装 1 回目 medium の調べ）
 *     base … サーバーの姿（task.month の答え・操作の返事で入った姿。月の表で打った仮のタスクも入る）。書き換えない
 *     opts … まだ届いていない操作の配列（かける順）。1 件は
 *              { kind: 'state', taskId, to: '完了' | '未完了' } … そのタスクの状態を変える（版は変えない。できること can は canOf があれば作り直す）
 *              { kind: 'delete', taskId }                     … items から外し、marks（先送りの印）・notices（知らせ）の同じ taskId も外す
 *            対象が無ければ何もしない
 *   写しは浅い: 姿の入れ物と items・marks・notices の配列は新しく作る。状態を変えるタスクだけ写し、ほかのタスク（仮のタスクを含む）は base と同じものを指す
 */
(function (root) {
  'use strict';

  function view(base, opts, canOf) {
    if (!base) return base;
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    out.items = (base.items || []).slice();
    out.marks = (base.marks || []).slice();
    out.notices = (base.notices || []).slice();
    var copied = {}; // この回で写したタスク（同じタスクに続けてかけるとき、写しを使い回す）
    (opts || []).forEach(function (o) {
      if (!o || typeof o.taskId !== 'string') return;
      if (o.kind === 'state') {
        for (var i = 0; i < out.items.length; i++) {
          var it = out.items[i];
          if (it.taskId !== o.taskId) continue;
          if (!copied[o.taskId]) { it = Object.assign({}, it); out.items[i] = it; copied[o.taskId] = true; }
          it.state = o.to;
          if (canOf) it.can = canOf(it);
          break;
        }
      } else if (o.kind === 'delete') {
        var id = o.taskId;
        out.items = out.items.filter(function (x) { return x.taskId !== id; });
        out.marks = out.marks.filter(function (x) { return x.taskId !== id; });
        out.notices = out.notices.filter(function (x) { return x.taskId !== id; });
      }
    });
    return out;
  }

  var api = { view: view };
  if (root) { root.MP = root.MP || {}; root.MP.taskOpt = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
