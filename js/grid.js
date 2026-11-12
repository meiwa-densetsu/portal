/*
 * 表（Excel 風）の部品（手順7の計画 docs/plans/stage1-step7-plan.md 2-4）。画面の中身は知らない。
 *
 *   var g = MP.grid.create(箱の要素, {
 *     columns: [{ key, label, group?, kind: 'text' | 'time' | 'select' | 'calc', options?: [{ value, text }] }],
 *     rowCount,
 *     rowHead(r) → { text, label, cls }   … 左の固定の列（日付）
 *     value(r, c) → 文字                  … セルの中身（編集の元）
 *     display(r, c) → 文字                … 見せる文字（無ければ value）
 *     editable(r, c) → 真偽
 *     cellState(r, c) → { cls, title }    … 誤りなどの見た目（色だけにせず、title と状態の列で文字でも出す）
 *     change(list)                         … [{ r, c, value }] をまとめて入れる（呼んだ側がそろえて、g.refresh() する）
 *     notify(text, kind)                   … 貼り付けで飛ばした数などの知らせ
 *   });
 *   g.refresh() / g.selection() → { r1, c1, r2, c2 } / g.selectedRows() → [r…] / g.focus() / g.setLocked(真偽)
 *
 * 操作: クリック・Shift+クリック、矢印・Tab・Enter、打って置き換え・F2・ダブルクリック・Esc、Delete、
 *       Ctrl+C・Ctrl+V（ブラウザの copy・paste の出来事。クリップボードの許可は要らない）、右下の四角のドラッグ・Ctrl+D
 * 指で押す端末: タップで選び、選んであるセルをもう一度タップで編集
 */
(function () {
  'use strict';

  function create(box, o) {
    var ui = MP.ui;
    var GC = MP.gridCore;
    var cols = o.columns;
    var sel = { r1: 0, c1: 0, r2: 0, c2: 0 };   // r1・c1 が起点（Shift で広げる元）、r2・c2 が今のセル
    var editing = null;                          // { r, c, input }
    var locked = false;
    var drag = null;                             // 下へ広げるドラッグ { to }
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

    var table = ui.el('table', { class: 'report-grid', role: 'grid', 'aria-rowcount': String(o.rowCount + 2), 'aria-colcount': String(cols.length + 1) });
    // 文字を受ける見えない欄。選んでいるときのキーはここに入る（日本語入力〔IME〕で打った文字も受けられるように）
    var sink = ui.el('textarea', { class: 'grid-sink', rows: '1', autocomplete: 'off', spellcheck: 'false', 'aria-label': '日報の表（矢印で移動、Enter で下へ。打つとセルに入ります）' });
    var wrap = ui.el('div', { class: 'grid-scroll' }, [sink, table]);
    var handle = ui.el('div', { class: 'grid-handle', 'aria-hidden': 'true', title: '下へ引っぱると写します' });
    ui.clear(box).appendChild(wrap);

    function lo(a, b) { return Math.min(a, b); }
    function hi(a, b) { return Math.max(a, b); }
    function rect() { return { r1: lo(sel.r1, sel.r2), c1: lo(sel.c1, sel.c2), r2: hi(sel.r1, sel.r2), c2: hi(sel.c1, sel.c2) }; }
    function inSel(r, c) { var s = rect(); return r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2; }
    function canEdit(r, c) { return !locked && cols[c].kind !== 'calc' && o.editable(r, c); }
    function cellEl(r, c) { return table.tBodies[0].rows[r].cells[c + 1]; }

    // ------------------------------------------------------------------ 描く

    function build() {
      var groups = [], labels = [];
      groups.push(ui.el('th', { scope: 'col', rowspan: '2', class: 'grid-corner', text: '日付' }));
      for (var c = 0; c < cols.length; c++) {
        var g = cols[c].group || '';
        var span = 1;
        while (c + span < cols.length && (cols[c + span].group || '') === g && g) span++;
        if (g) {
          groups.push(ui.el('th', { scope: 'colgroup', colspan: String(span), class: 'grid-group', text: g }));
          for (var k = 0; k < span; k++) labels.push(ui.el('th', { scope: 'col', class: 'grid-col-' + cols[c + k].kind, text: cols[c + k].label }));
          c += span - 1;
        } else {
          groups.push(ui.el('th', { scope: 'col', rowspan: '2', class: 'grid-col-' + cols[c].kind, text: cols[c].label }));
        }
      }
      var head = ui.el('thead', {}, [ui.el('tr', {}, groups), ui.el('tr', {}, labels)]);
      var body = ui.el('tbody');
      for (var r = 0; r < o.rowCount; r++) {
        var tr = ui.el('tr', {}, [ui.el('th', { scope: 'row', class: 'grid-head' })]);
        for (var c2 = 0; c2 < cols.length; c2++) {
          tr.appendChild(ui.el('td', { class: 'grid-cell grid-col-' + cols[c2].kind, 'data-r': String(r), 'data-c': String(c2), role: 'gridcell' }));
        }
        body.appendChild(tr);
      }
      ui.clear(table);
      table.appendChild(head);
      table.appendChild(body);
    }

    function paintCell(r, c) {
      var td = cellEl(r, c);
      if (editing && editing.r === r && editing.c === c) return;
      var v = o.display ? o.display(r, c) : o.value(r, c);
      var st = o.cellState ? o.cellState(r, c) || {} : {};
      td.textContent = v === null || v === undefined ? '' : String(v);
      td.className = 'grid-cell grid-col-' + cols[c].kind + (st.cls ? ' ' + st.cls : '') + (canEdit(r, c) ? '' : ' readonly') +
        (inSel(r, c) ? ' in-sel' : '') + (r === sel.r2 && c === sel.c2 ? ' cur' : '');
      if (st.title) td.title = st.title; else td.removeAttribute('title');
      td.setAttribute('aria-selected', inSel(r, c) ? 'true' : 'false');
      if (st.cls && /\berr\b/.test(st.cls)) td.setAttribute('aria-invalid', 'true'); else td.removeAttribute('aria-invalid');
    }

    function refresh() {
      for (var r = 0; r < o.rowCount; r++) {
        var h = o.rowHead(r);
        var th = table.tBodies[0].rows[r].cells[0];
        th.textContent = h.text;
        th.className = 'grid-head' + (h.cls ? ' ' + h.cls : '');
        if (h.label) th.setAttribute('aria-label', h.label);
        for (var c = 0; c < cols.length; c++) paintCell(r, c);
      }
      placeHandle();
    }

    function placeHandle() {
      if (handle.parentNode) handle.parentNode.removeChild(handle);
      if (locked || editing) return;
      var s = rect();
      cellEl(s.r2, s.c2).appendChild(handle);
    }

    // ------------------------------------------------------------------ 選ぶ・動く

    function select(r, c, extend) {
      r = Math.max(0, Math.min(o.rowCount - 1, r));
      c = Math.max(0, Math.min(cols.length - 1, c));
      if (!extend) { sel.r1 = r; sel.c1 = c; }
      sel.r2 = r; sel.c2 = c;
      refresh();
      var td = cellEl(r, c);
      if (td.scrollIntoView) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function move(dr, dc, extend) {
      if (dc && !dr) {
        var c = sel.c2 + dc, r = sel.r2;
        if (!extend && c >= cols.length) { c = 0; r++; }
        if (!extend && c < 0) { c = cols.length - 1; r--; }
        select(r, c, extend);
      } else select(sel.r2 + dr, sel.c2 + dc, extend);
    }

    // ------------------------------------------------------------------ 入れる

    function startEdit(replaceWith) {
      if (editing) return;
      var r = sel.r2, c = sel.c2;
      if (!canEdit(r, c)) { if (o.notify) o.notify('このセルは直せません', 'warn'); return; }
      sel.r1 = r; sel.c1 = c;
      var col = cols[c];
      var td = cellEl(r, c);
      var input;
      if (col.kind === 'select') {
        input = ui.el('select', { class: 'grid-input', 'aria-label': col.label });
        col.options.forEach(function (op) { input.appendChild(ui.el('option', { value: op.value, text: op.text, selected: op.value === o.value(r, c) })); });
        input.addEventListener('change', function () { commit(0, 0); });
      } else {
        input = ui.el('input', { type: 'text', class: 'grid-input', autocomplete: 'off', 'aria-label': col.label, inputmode: col.kind === 'time' ? 'numeric' : 'text' });
        input.value = replaceWith !== undefined ? replaceWith : o.value(r, c);
      }
      input.addEventListener('keydown', onEditKey);
      input.addEventListener('blur', function () { if (editing && editing.input === input) commit(0, 0, true); });
      editing = { r: r, c: c, input: input };
      if (handle.parentNode) handle.parentNode.removeChild(handle);
      ui.clear(td).appendChild(input);
      input.focus();
      if (input.setSelectionRange && replaceWith === undefined) input.setSelectionRange(input.value.length, input.value.length);
    }

    function commit(dr, dc, fromBlur) {
      if (!editing) return;
      var e = editing;
      editing = null;
      var value = e.input.value;
      if (value !== o.value(e.r, e.c)) o.change([{ r: e.r, c: e.c, value: value }]);
      paintCell(e.r, e.c);
      if (!fromBlur) {
        sink.focus({ preventScroll: true });
        if (dr || dc) move(dr, dc, false); else refresh();
      } else refresh();
    }

    function cancel() {
      if (!editing) return;
      var e = editing;
      editing = null;
      paintCell(e.r, e.c);
      sink.focus({ preventScroll: true });
      refresh();
    }

    function onEditKey(ev) {
      if (ev.isComposing || ev.keyCode === 229) return; // 日本語入力の途中（確定の Enter を含む）は入力の欄に任せる
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); return; }
      if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); commit(ev.shiftKey ? -1 : 1, 0); return; }
      if (ev.key === 'Tab') { ev.preventDefault(); ev.stopPropagation(); commit(0, ev.shiftKey ? -1 : 1); return; }
      if (cols[editing.c].kind !== 'select' && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
        ev.preventDefault(); ev.stopPropagation(); commit(ev.key === 'ArrowUp' ? -1 : 1, 0);
      }
    }

    function apply(list, what) {
      if (!list.cells.length) {
        if (list.skipped && o.notify) o.notify('直せるセルがありません（' + list.skipped + ' 個は直せないセルです）', 'warn');
        return;
      }
      o.change(list.cells);
      refresh();
      var notes = [];
      if (list.skipped) notes.push('直せないセル ' + list.skipped + ' 個は飛ばしました');
      if (list.cutRows) notes.push('表の外の ' + list.cutRows + ' 行は捨てました');
      if (list.cutCols) notes.push('表の外の ' + list.cutCols + ' 列は捨てました');
      if (o.notify) o.notify(what + (notes.length ? '（' + notes.join('・') + '）' : ''), notes.length ? 'warn' : 'ok');
    }

    function clearSel() {
      var s = rect(), cells = [], skipped = 0;
      for (var r = s.r1; r <= s.r2; r++) for (var c = s.c1; c <= s.c2; c++) {
        if (canEdit(r, c)) cells.push({ r: r, c: c, value: '' }); else if (cols[c].kind !== 'calc') skipped++;
      }
      apply({ cells: cells, skipped: skipped }, cells.length + ' 個のセルを空にしました');
    }

    function fillTo(to) {
      var p = GC.planFill({ sel: rect(), to: to, value: o.value, editable: canEdit });
      apply(p, '下へ写しました');
    }

    // ------------------------------------------------------------------ 出来事

    wrap.addEventListener('keydown', function (ev) {
      if (editing || ev.isComposing || ev.key === 'Process' || ev.keyCode === 229) return; // 編集中のキーは入力の欄が受ける。日本語入力の途中は sink が受ける（保存中は移動だけできる。直す操作は canEdit で止まる）
      var k = ev.key, ctrl = ev.ctrlKey || ev.metaKey;
      if (k === 'ArrowUp') { ev.preventDefault(); move(-1, 0, ev.shiftKey); }
      else if (k === 'ArrowDown') { ev.preventDefault(); move(1, 0, ev.shiftKey); }
      else if (k === 'ArrowLeft') { ev.preventDefault(); move(0, -1, ev.shiftKey); }
      else if (k === 'ArrowRight') { ev.preventDefault(); move(0, 1, ev.shiftKey); }
      else if (k === 'Tab') { ev.preventDefault(); move(0, ev.shiftKey ? -1 : 1, false); }
      else if (k === 'Enter') { ev.preventDefault(); move(ev.shiftKey ? -1 : 1, 0, false); }
      else if (k === 'F2') { ev.preventDefault(); startEdit(); }
      else if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); clearSel(); }
      else if (ctrl && (k === 'd' || k === 'D')) { ev.preventDefault(); fillTo(rect().r2); }
      else if (!ctrl && !ev.altKey && k.length === 1) {
        ev.preventDefault();
        if (cols[sel.c2].kind === 'select') startEdit(); else startEdit(k);
      }
    });

    // 日本語入力（IME）で打った文字・キーの出来事を伴わない入力は、決まってから編集の欄に移す
    var composing = false;
    sink.addEventListener('compositionstart', function () { composing = true; });
    sink.addEventListener('compositionend', function () { composing = false; takeSink(); });
    sink.addEventListener('input', function () { if (!composing) takeSink(); });
    function takeSink() {
      var v = sink.value;
      sink.value = '';
      if (!v || editing) return;
      if (cols[sel.c2].kind === 'select') startEdit(); else startEdit(v);
    }

    document.addEventListener('copy', function (ev) {
      if (document.activeElement !== sink || editing) return;
      var s = rect(), m = [];
      for (var r = s.r1; r <= s.r2; r++) {
        var row = [];
        for (var c = s.c1; c <= s.c2; c++) row.push(o.value(r, c));
        m.push(row);
      }
      ev.clipboardData.setData('text/plain', GC.toClip(m));
      ev.preventDefault();
      if (o.notify) o.notify(m.length + ' 行をコピーしました', 'ok');
    });

    document.addEventListener('paste', function (ev) {
      if (document.activeElement !== sink || editing || locked) return;
      ev.preventDefault();
      var text = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
      if (!text) { if (o.notify) o.notify('貼り付ける文字がありません', 'warn'); return; }
      var p = GC.planPaste({ block: GC.parseClip(text), sel: rect(), rows: o.rowCount, cols: cols.length, editable: canEdit });
      apply(p, '貼り付けました');
    });

    function cellOf(target) {
      var td = target && target.closest ? target.closest('td.grid-cell') : null;
      return td && table.contains(td) ? { r: Number(td.getAttribute('data-r')), c: Number(td.getAttribute('data-c')) } : null;
    }

    table.addEventListener('mousedown', function (ev) {
      if (ev.target === handle) return;
      var p = cellOf(ev.target);
      if (!p || (editing && editing.r === p.r && editing.c === p.c)) return;
      if (editing) commit(0, 0, true);
      ev.preventDefault();
      var again = !ev.shiftKey && p.r === sel.r2 && p.c === sel.c2 && sel.r1 === sel.r2 && sel.c1 === sel.c2;
      sink.focus({ preventScroll: true });
      select(p.r, p.c, ev.shiftKey);
      if (coarse && again && !locked) startEdit();
    });
    table.addEventListener('dblclick', function (ev) {
      var p = cellOf(ev.target);
      if (p && !editing) { select(p.r, p.c, false); startEdit(); }
    });

    // 下へ広げる（右下の小さな四角を下へ引っぱる）
    handle.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      drag = { to: rect().r2 };
      if (handle.setPointerCapture) handle.setPointerCapture(ev.pointerId);
    });
    handle.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      var under = document.elementFromPoint(ev.clientX, ev.clientY);
      var p = cellOf(under);
      if (p && p.r !== drag.to) {
        drag.to = p.r;
        var s = rect();
        for (var r = 0; r < o.rowCount; r++) table.tBodies[0].rows[r].classList.toggle('fill-to', r > s.r2 && r <= drag.to);
      }
    });
    handle.addEventListener('pointerup', function () {
      if (!drag) return;
      var to = drag.to;
      drag = null;
      for (var r = 0; r < o.rowCount; r++) table.tBodies[0].rows[r].classList.remove('fill-to');
      if (to > rect().r2) fillTo(to);
    });

    build();
    refresh();

    return {
      refresh: refresh,
      selection: rect,
      selectedRows: function () { var s = rect(), out = []; for (var r = s.r1; r <= s.r2; r++) out.push(r); return out; },
      select: function (r, c) { select(r, c || 0, false); },
      focus: function () { sink.focus({ preventScroll: true }); },
      setLocked: function (v) { if (v && editing) commit(0, 0, true); locked = !!v; wrap.setAttribute('aria-disabled', locked ? 'true' : 'false'); refresh(); },
      isEditing: function () { return !!editing; },
      commitEdit: function () { if (editing) commit(0, 0, true); },
    };
  }

  MP.grid = { create: create };
})();
