/*
 * 表（Excel 風）の計算（手順7の計画 docs/plans/stage1-step7-plan.md 第2章）。画面の部品を使わない純粋な JS（Node のテストでも読み込む）
 *
 *   MP.gridCore.parseLooseTime(text) … 時刻のゆるい読み方 → { ok, value }（value は 'H:MM'。読めなければ ok: false で value は元の文字）
 *   MP.gridCore.parseClip(text)      … 貼り付けの文字（Excel のタブ区切り）→ セルの2次元の配列
 *   MP.gridCore.toClip(matrix)       … セルの2次元の配列 → Excel に貼れるタブ区切りの文字
 *   MP.gridCore.planPaste(o)         … 貼り付けで、どのセルに何を入れるか
 *   MP.gridCore.planFill(o)          … 下へ広げるで、どのセルに何を入れるか
 *
 * タブ区切りの読み書きは、まとめて登録（bulk.js）と同じものを使う
 */
(function (root) {
  'use strict';

  var bulk = root && root.MP && root.MP.bulk ? root.MP.bulk : (typeof require === 'function' ? require('./bulk.js') : null);

  /** 全角の数字・コロンを半角に、前後の空白を消す */
  function half(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[：]/g, ':').replace(/^[\s　]+|[\s　]+$/g, '');
  }

  /**
   * 時刻のゆるい読み方（計画 2-3）。'9:00'・'09:00'・'9'・'930'・'0930'・全角 → '9:00' などの 'H:MM'（1日ずつの画面と同じ形）。
   * 空は { ok: true, value: '' }。時は 0〜23、分は 0〜59。読めないものは { ok: false, value: 元の文字（前後の空白だけ消す） }。
   * 30分単位かどうかは見ない（共有の計算 CalcReport が STEP として知らせる。勝手に丸めない）
   */
  function parseLooseTime(text) {
    var s = half(text);
    if (s === '') return { ok: true, value: '' };
    var h = null, m = null, x;
    if ((x = /^(\d{1,2}):(\d{2})$/.exec(s))) { h = Number(x[1]); m = Number(x[2]); }
    else if ((x = /^(\d{1,2})$/.exec(s))) { h = Number(x[1]); m = 0; }
    else if ((x = /^(\d{1,2})(\d{2})$/.exec(s))) { h = Number(x[1]); m = Number(x[2]); }
    if (h === null || h > 23 || m > 59) return { ok: false, value: s };
    return { ok: true, value: h + ':' + (m < 10 ? '0' : '') + m };
  }

  /** 貼り付けの文字 → セルの2次元の配列（最後の改行は行にしない。行ごとに列の数が違ってもよい） */
  function parseClip(text) {
    return bulk.splitTsv(String(text === null || text === undefined ? '' : text)).map(function (r) { return r.cells; });
  }

  /** セルの2次元の配列 → タブ区切りの文字（Excel と同じに、行の終わりは \r\n） */
  function toClip(matrix) {
    return matrix.map(function (r) { return r.map(bulk.cellOut).join('\t'); }).join('\r\n') + '\r\n';
  }

  /**
   * 貼り付けの計画（計画 2-4）。
   * o: { block: 2次元の配列, sel: { r1, c1, r2, c2 }（選んだ範囲。左上から貼る）, rows, cols（表の大きさ）, editable(r, c) }
   * 1つの値を範囲に貼ったときは、範囲の全部に入れる（Excel と同じ）。
   * 返す値: { cells: [{ r, c, value }], skipped（編集できないので飛ばしたセルの数）, cutRows, cutCols（表の外にはみ出して捨てた行・列の数） }
   */
  function planPaste(o) {
    var block = o.block || [];
    var cells = [], skipped = 0, cutRows = 0, cutCols = 0;
    if (!block.length) return { cells: cells, skipped: 0, cutRows: 0, cutCols: 0 };
    var r0 = Math.min(o.sel.r1, o.sel.r2), c0 = Math.min(o.sel.c1, o.sel.c2);
    var single = block.length === 1 && block[0].length === 1;
    var put = function (r, c, v) {
      if (o.editable(r, c)) cells.push({ r: r, c: c, value: v });
      else skipped++;
    };
    if (single) {
      var r1 = Math.max(o.sel.r1, o.sel.r2), c1 = Math.max(o.sel.c1, o.sel.c2);
      for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) put(r, c, block[0][0]);
      return { cells: cells, skipped: skipped, cutRows: 0, cutCols: 0 };
    }
    var widest = 0;
    for (var i = 0; i < block.length; i++) {
      if (r0 + i >= o.rows) { cutRows++; continue; }
      widest = Math.max(widest, block[i].length);
      for (var j = 0; j < block[i].length; j++) {
        if (c0 + j >= o.cols) continue;
        put(r0 + i, c0 + j, block[i][j]);
      }
    }
    cutCols = Math.max(0, c0 + widest - o.cols);
    return { cells: cells, skipped: skipped, cutRows: cutRows, cutCols: cutCols };
  }

  /**
   * 下へ広げるの計画（計画 2-4。時刻を増やすなどはしない。選んだ行をくり返して写す）。
   * o: { sel: { r1, c1, r2, c2 }, to（広げる最後の行）, value(r, c), editable(r, c) }
   * to が選んだ範囲の中なら、選んだ範囲の最初の行を下の行に写す（Ctrl+D と同じ）。
   * 返す値: { cells: [{ r, c, value }], skipped }
   */
  function planFill(o) {
    var r0 = Math.min(o.sel.r1, o.sel.r2), r1 = Math.max(o.sel.r1, o.sel.r2);
    var c0 = Math.min(o.sel.c1, o.sel.c2), c1 = Math.max(o.sel.c1, o.sel.c2);
    var src, from, to, base = r0;
    if (o.to > r1) { src = r1 - r0 + 1; from = r1 + 1; to = o.to; }
    else if (r1 > r0) { src = 1; from = r0 + 1; to = r1; } // Ctrl+D: 範囲の1行目を下へ
    else { if (r0 === 0) return { cells: [], skipped: 0 }; src = 1; base = r0 - 1; from = r0; to = r0; } // Ctrl+D で1行だけ: 上の行を写す
    var cells = [], skipped = 0;
    for (var r = from; r <= to; r++) {
      var sr = base + ((r - base) % src);
      for (var c = c0; c <= c1; c++) {
        if (o.editable(r, c)) cells.push({ r: r, c: c, value: o.value(sr, c) });
        else skipped++;
      }
    }
    return { cells: cells, skipped: skipped };
  }

  var api = { parseLooseTime: parseLooseTime, parseClip: parseClip, toClip: toClip, planPaste: planPaste, planFill: planFill };
  if (root) { root.MP = root.MP || {}; root.MP.gridCore = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
