/*
 * タスクリストの取り込み（計画 docs/plans/stage2-tasklist-v3-plan.md 第4章）。
 * Excel・Google スプレッドシートの 1 列（1 人分）を貼り付けて、1 行 1 件のタスクにする。
 *
 * 読み方の部分は、画面の部品を使わない純粋な JS（Node のテストでも読み込む）。
 * 貼り付けた HTML は**文字として読むだけ**で、画面の DOM には入れない（HTML として解釈させない。スクリプトは動かず、画像なども読み込まれない）。
 * 取り込む内容の正本は文字（text/plain）。HTML は文字の色（赤 = 完了らしい）を知るためだけに使う。
 *
 *   MP.taskImport.parseText(text)        … 貼り付けた文字 → マスの表 [[文字]]（タブで列・改行で行。"…" で囲んだマスの中の改行は 1 つのマス）
 *   MP.taskImport.parseHtml(html)        … 貼り付けた HTML の最初の表 → [[{ text, color: {r,g,b} | null }]]（読めなければ null）
 *   MP.taskImport.colors(grid, htmlGrid) … 行・列の数と全部のマスの文字が合うときだけ、マスごとの色 [[color | null]]（合わなければ null）
 *   MP.taskImport.isRed(color)           … 赤（完了らしい）か
 *   MP.taskImport.lines(grid, col, colors, o) … その列の、取り込む候補 [{ text, checked, red, dup, tooLong, length }]。o: { max, contentMax, existing: [内容] }
 *   MP.taskImport.columns(grid)          … 列の見出し（最初の空でないマスの文字）
 *   MP.taskImport.open(o)                … 取り込みのダイアログ（画面だけ）。→ { ownerId, date, contents: [内容] } / null
 */
(function (root) {
  'use strict';

  // 決め打ちの値（計画 第4章）
  var HTML_MAX_CHARS = 500000;  // これより大きい HTML は色に使わない
  var TEXT_MAX_CHARS = 200000;  // これより大きい文字は読まない（110 件 × 60 字の何十倍もある。画面を固まらせない柵）
  var TAG_MAX = 2000;           // タグ 1 つの長さの限り（閉じていないタグを延々と探さない）
  var CELLS_MAX = 5000;         // マスがこれより多い表は色に使わない
  var RED = { rMin: 180, gMax: 90, bMax: 90 }; // 赤の判断: 赤が強く、緑・青が弱い
  var NAMED = { red: [255, 0, 0], green: [0, 128, 0], lime: [0, 255, 0], blue: [0, 0, 255], black: [0, 0, 0], white: [255, 255, 255],
    maroon: [128, 0, 0], crimson: [220, 20, 60], darkred: [139, 0, 0], firebrick: [178, 34, 34], gray: [128, 128, 128], grey: [128, 128, 128],
    orange: [255, 165, 0], yellow: [255, 255, 0], purple: [128, 0, 128], navy: [0, 0, 128], teal: [0, 128, 128] };

  /** 前後の空白（全角を含む）を取り、マスの中の改行を空白にし、目に見えない文字（サーバーが断るもの）を取る */
  /** 前後の空白（半角・全角・改行など）を取る。正規表現を使わない（長い空白の並びで遅くならないように） */
  function trimAll(s) {
    var a = 0, b = s.length;
    var sp = function (c) { return c === 32 || c === 0x3000 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0xFEFF || c === 0x2028 || c === 0x2029; };
    while (a < b && sp(s.charCodeAt(a))) a++;
    while (b > a && sp(s.charCodeAt(b - 1))) b--;
    return s.slice(a, b);
  }

  function clean(v) {
    var s = String(v === null || v === undefined ? '' : v).replace(/\r\n?|\n/g, ' ');
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 9) { out += ' '; continue; }
      if (c <= 31 || c === 127 || (c >= 0x200B && c <= 0x200F) || (c >= 0x202A && c <= 0x202E) || c === 0x2028 || c === 0x2029 || (c >= 0x2066 && c <= 0x2069) || c === 0xFEFF) continue;
      out += s.charAt(i);
    }
    return trimAll(out);
  }

  /** 見た目の 1 文字で数えた長さ（サーバーの CalcReport.textLength と同じ数え方） */
  function textLength(t) { return Array.from(String(t)).length; }

  /** 比べるための形（空白の並びを 1 つに） */
  function norm(t) { return clean(t).replace(/[\s　]+/g, ' '); }

  /**
   * 貼り付けた文字 → マスの表。タブで列、改行で行。" で始まるマスは、次の "（"" は " 1 文字）まで（Excel は、改行のあるマスをこの形でコピーする）。
   * 終わりの空の行は捨てる。列の数は、いちばん長い行に合わせる
   */
  function parseText(text) {
    var s = String(text === null || text === undefined ? '' : text);
    if (s.length > TEXT_MAX_CHARS) return [];
    var rows = [], row = [], cell = '', i = 0, n = s.length;
    var endCell = function () { row.push(cell); cell = ''; };
    var endRow = function () { endCell(); rows.push(row); row = []; };
    while (i < n) {
      var ch = s.charAt(i);
      if (ch === '"' && cell === '') {
        // 囲んだマス。閉じる " の次がタブ・改行・終わりでなければ、囲みではない（そのままの文字として読む）
        var j = i + 1, buf = '', closed = false;
        while (j < n) {
          var c2 = s.charAt(j);
          if (c2 === '"') {
            if (s.charAt(j + 1) === '"') { buf += '"'; j += 2; continue; }
            closed = true; j++; break;
          }
          buf += c2; j++;
        }
        var after = j < n ? s.charAt(j) : '';
        if (closed && (after === '' || after === '\t' || after === '\n' || after === '\r')) { cell = buf; i = j; continue; }
        cell += ch; i++; continue;
      }
      if (ch === '\t') { endCell(); i++; continue; }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && s.charAt(i + 1) === '\n') i++;
        endRow(); i++; continue;
      }
      cell += ch; i++;
    }
    if (cell !== '' || row.length) endRow();
    while (rows.length && rows[rows.length - 1].every(function (c) { return clean(c) === ''; })) rows.pop();
    var width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    rows.forEach(function (r) { while (r.length < width) r.push(''); });
    return rows;
  }

  // ------------------------------------------------------------------ 色

  /** 色の文字 → { r, g, b }。分からない形は null */
  function parseColor(v) {
    var s = String(v || '').replace(/!important/i, '').trim().toLowerCase();
    var m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) return { r: parseInt(m[1].charAt(0) + m[1].charAt(0), 16), g: parseInt(m[1].charAt(1) + m[1].charAt(1), 16), b: parseInt(m[1].charAt(2) + m[1].charAt(2), 16) };
    m = /^#([0-9a-f]{6})$/.exec(s);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
    m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(s);
    if (m && Number(m[1]) <= 255 && Number(m[2]) <= 255 && Number(m[3]) <= 255) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    if (Object.prototype.hasOwnProperty.call(NAMED, s)) return { r: NAMED[s][0], g: NAMED[s][1], b: NAMED[s][2] };
    return null;
  }

  function isRed(c) { return !!c && c.r >= RED.rMin && c.g <= RED.gMax && c.b <= RED.bMax; }

  /** style の中身（"color: red; font-size: …"）から文字の色。background-color などは見ない */
  function colorInStyle(style) {
    var parts = String(style || '').split(';');
    var found = null;
    for (var i = 0; i < parts.length; i++) {
      var at = parts[i].indexOf(':');
      if (at < 0 || trimAll(parts[i].slice(0, at)).toLowerCase() !== 'color') continue;
      found = parseColor(trimAll(parts[i].slice(at + 1))) || found;
    }
    return found;
  }

  /** タグの文字（<td class=x style="…">）から属性を読む */
  function attr(tag, name) {
    var m = new RegExp('[\\s"\']' + name + '\\s{0,20}=\\s{0,20}(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
    return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : '';
  }

  /** <style> の中の「.名前 { … color: … }」「td.名前 { … }」だけを読む（url(・@import・expression のある決まりは読まない） */
  function classColors(html) {
    var map = {};
    // <style …> 〜 </style> を、文字の場所を探して取り出す（正規表現で後戻りさせない）
    var low = html.toLowerCase(), pos = 0;
    while (pos < html.length) {
      var s0 = low.indexOf('<style', pos);
      if (s0 < 0) break;
      var s1 = low.indexOf('>', s0);
      if (s1 < 0) break;
      var s2 = low.indexOf('</style', s1);
      if (s2 < 0) break;
      pos = s2 + 7;
      var css = html.slice(s1 + 1, s2).replace(/<!--|-->/g, '');
      // 決まり 1 つ = 「選ぶもの { 中身 }」。選ぶものは , で分け、「.名前」「td.名前」の形のものだけにその色を当てる
      var at = 0;
      while (at < css.length) {
        var open = css.indexOf('{', at);
        if (open < 0) break;
        var close = css.indexOf('}', open);
        if (close < 0) break;
        var sel = css.slice(at, open), bodyText = css.slice(open + 1, close);
        at = close + 1;
        if (/url\s{0,5}\(|@import|expression/i.test(bodyText)) continue;
        var c = colorInStyle(bodyText);
        if (!c) continue;
        sel.split(',').forEach(function (one) {
          var mm = /^(?:td|th|span|font|p|div)?\.([A-Za-z_][\w-]{0,80})$/.exec(trimAll(one));
          if (mm) map[mm[1]] = c;
        });
      }
    }
    return map;
  }

  /** タグ 1 つの色: style → color 属性（<font color>）→ class */
  function tagColor(tag, classes) {
    var c = colorInStyle(attr(tag, 'style'));
    if (c) return c;
    if (/^<font\b/i.test(tag)) { c = parseColor(attr(tag, 'color')); if (c) return c; }
    var names = attr(tag, 'class').split(/\s+/);
    for (var i = 0; i < names.length; i++) if (names[i] && classes[names[i]]) return classes[names[i]];
    return null;
  }

  function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (all, e) {
      var k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return '\'';
      if (k === 'nbsp') return ' ';
      if (k.charAt(0) === '#') {
        var code = k.charAt(1) === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '';
      }
      return all;
    });
  }

  /**
   * マスの中身（HTML の文字）→ { text, color }。色は「最初に文字を持つ所で開いているタグを、内側から外へたどって最初に見つかる色」。
   * 見つからなければマス自身（td）の色
   */
  function cellOf(tdTag, inner, classes) {
    var text = '', color = null, decided = false;
    var stack = []; // 開いているタグの色（無ければ null）
    var re = new RegExp('<(\\/?)([a-zA-Z][\\w:-]{0,40})\\b[^<>]{0,' + TAG_MAX + '}>|([^<]+)', 'g'), m;
    while ((m = re.exec(inner))) {
      if (m[3] !== undefined) {
        var t = decode(m[3]);
        if (!decided && t.replace(/[\s　]/g, '') !== '') {
          for (var i = stack.length - 1; i >= 0 && !color; i--) color = stack[i];
          decided = true;
        }
        text += t;
        continue;
      }
      var name = m[2].toLowerCase();
      if (name === 'br') { text += ' '; continue; }
      if (name === 'img' || name === 'input' || name === 'hr' || name === 'meta' || name === 'link') continue;
      if (m[1]) { if (stack.length) stack.pop(); } else if (!/\/>$/.test(m[0])) stack.push(tagColor(m[0], classes));
    }
    return { text: text, color: color || tagColor(tdTag, classes) };
  }

  /** 注釈（<!-- … -->。Excel の StartFragment など）を取り除く。閉じていない注釈は、そこから後ろを捨てる */
  function stripComments(text) {
    var out = '', at = 0;
    while (at < text.length) {
      var open = text.indexOf('<!--', at);
      if (open < 0) { out += text.slice(at); break; }
      out += text.slice(at, open);
      var close = text.indexOf('-->', open + 4);
      if (close < 0) break;
      at = close + 3;
    }
    return out;
  }

  /**
   * 貼り付けた HTML の最初の表 → [[{ text, color }]]。大きすぎる・表が無い・表の中に表がある・colspan／rowspan がある・マスが多すぎる・
   * 閉じていないタグがあるときは null。行・マスの始まり（<tr・<td・<th）の位置を先に全部拾ってから切り出す（後戻りする探し方をしない）
   */
  function parseHtml(html) {
    var s = String(html === null || html === undefined ? '' : html);
    if (!s || s.length > HTML_MAX_CHARS) return null;
    var open = new RegExp('<table\\b[^<>]{0,' + TAG_MAX + '}>', 'i').exec(s);
    if (!open) return null;
    var from = open.index + open[0].length;
    var end = s.toLowerCase().indexOf('</table', from);
    var body = stripComments(end < 0 ? s.slice(from) : s.slice(from, end));
    if (/<table(?=[\s>\/])/i.test(body)) return null;
    var classes = classColors(s);
    // 行・マスの始まりと、行の終わり（</tr）の位置
    var marks = [], re = /<(\/tr|tr|td|th)(?=[\s>\/])/gi, m;
    while ((m = re.exec(body))) marks.push({ at: m.index, kind: m[1].toLowerCase() });
    var rows = [], cells = null, count = 0;
    for (var i = 0; i < marks.length; i++) {
      var k = marks[i].kind;
      if (k === 'tr') { cells = []; rows.push(cells); continue; }
      if (k === '/tr') { cells = null; continue; }
      if (!cells) { cells = []; rows.push(cells); } // <tr> の無い表（行の始まりを省いた形）
      var stop = i + 1 < marks.length ? marks[i + 1].at : body.length;
      var gt = body.indexOf('>', marks[i].at);
      if (gt < 0 || gt >= stop || gt - marks[i].at > TAG_MAX) return null;
      var tag = body.slice(marks[i].at, gt + 1);
      if (/\s(?:colspan|rowspan)\s{0,20}=\s{0,20}["']?\s{0,20}(?:[2-9]|\d\d)/i.test(tag)) return null;
      if (++count > CELLS_MAX) return null;
      var inner = body.slice(gt + 1, stop);
      var low = inner.toLowerCase();
      var c1 = low.indexOf('</td'), c2 = low.indexOf('</th');
      var cut = c1 < 0 ? c2 : c2 < 0 ? c1 : Math.min(c1, c2);
      cells.push(cellOf(tag, cut < 0 ? inner : inner.slice(0, cut), classes));
    }
    return rows.length ? rows : null;
  }

  /** 文字の表と HTML の表が、行・列の数も全部のマスの文字も同じときだけ、マスごとの色を返す（1 つでも違えば null） */
  function colors(grid, htmlGrid) {
    if (!grid || !htmlGrid) return null;
    // HTML の終わりの空の行は、文字の側と同じく捨てて比べる
    var h = htmlGrid.slice();
    while (h.length && h[h.length - 1].every(function (c) { return norm(c.text) === ''; })) h.pop();
    if (h.length !== grid.length) return null;
    var out = [];
    for (var r = 0; r < grid.length; r++) {
      var hr = h[r].slice();
      while (hr.length < grid[r].length) hr.push({ text: '', color: null });
      if (hr.length !== grid[r].length) return null;
      var line = [];
      for (var c = 0; c < grid[r].length; c++) {
        if (norm(grid[r][c]) !== norm(hr[c].text)) return null;
        line.push(hr[c].color);
      }
      out.push(line);
    }
    return out;
  }

  /** 列の見出し（その列の最初の空でないマス。長ければ切る） */
  function columns(grid) {
    var width = grid.length ? grid[0].length : 0;
    var out = [];
    for (var c = 0; c < width; c++) {
      var name = '';
      for (var r = 0; r < grid.length && !name; r++) name = clean(grid[r][c]);
      var chars = Array.from(name);
      out.push((c + 1) + ' 列目' + (name ? '（' + (chars.length > 12 ? chars.slice(0, 12).join('') + '…' : name) + '）' : '（空）'));
    }
    return out;
  }

  /**
   * その列の、取り込む候補。空のマスは捨てる。
   * o: { max（候補の数の上限）, contentMax（1 件の字数）, existing（その人・その日にもうある内容） }
   * 返す値: { items: [{ text, checked, red, dup, tooLong, length }], over（上限で捨てた数） }
   *   赤（完了らしい）・もうある内容は、初めはチェックを外す。同じ貼り付けの中の同じ内容は、2 つ目からチェックを外す
   */
  function lines(grid, col, colorGrid, o) {
    var opt = o || {};
    var seen = {};
    (opt.existing || []).forEach(function (t) { seen[norm(t)] = true; });
    var items = [], over = 0;
    for (var r = 0; r < grid.length; r++) {
      var text = clean(grid[r][col]);
      if (text === '') continue;
      if (opt.max && items.length >= opt.max) { over++; continue; }
      var red = !!colorGrid && isRed(colorGrid[r][col]);
      var key = norm(text);
      var dup = !!seen[key];
      seen[key] = true;
      var len = textLength(text);
      items.push({ text: text, checked: !red && !dup, red: red, dup: dup, tooLong: !!opt.contentMax && len > opt.contentMax, length: len });
    }
    return { items: items, over: over };
  }

  // ------------------------------------------------------------------ 画面（ダイアログ）

  /**
   * 取り込みのダイアログ。o: { people: [{ employeeId, name, active }], meId, isAdmin, date, rules: { contentMax, perDayMax }, existing(ownerId, date) → [内容] }
   * 返す値: { ownerId, date, contents: [内容] }（やめたら null）
   */
  function open(o) {
    var ui = root.MP.ui;
    var CT = root.CalcTask;
    var grid = [], colorGrid = null, col = 0, rows = [];
    var owner = ui.el('select', { id: 'imp-owner' });
    o.people.filter(function (p) { return p.active; }).sort(function (a, b) { return (a.employeeId === o.meId ? 0 : 1) - (b.employeeId === o.meId ? 0 : 1); }).forEach(function (p) {
      var mine = p.employeeId === o.meId;
      owner.appendChild(ui.el('option', { value: p.employeeId, text: p.name + (mine ? '（自分）' : o.isAdmin ? '' : '（依頼になります）') }));
    });
    owner.value = o.meId;
    var date = ui.el('input', { type: 'date', id: 'imp-date', value: o.date });
    var paste = ui.el('textarea', { id: 'imp-paste', rows: '4', placeholder: 'Excel の 1 列（1 人分）をコピーして、ここに貼り付けます' });
    var colSel = ui.el('select', { id: 'imp-col' });
    var colBox = ui.el('div', { class: 'field', hidden: true }, [ui.el('label', { for: 'imp-col', text: '取り込む列' }), colSel]);
    var info = ui.el('p', { class: 'sub', id: 'imp-info', role: 'status' });
    var list = ui.el('ul', { class: 'list import-list', id: 'imp-list' });
    var err = ui.el('p', { class: 'field-error', role: 'alert', hidden: true });

    function rowEl(it) {
      var cb = ui.el('input', { type: 'checkbox', checked: it.checked, 'aria-label': '取り込む' });
      var input = ui.el('input', { type: 'text', value: it.text, autocomplete: 'off', 'aria-label': '内容' });
      var note = ui.el('span', { class: 'sub import-note' });
      var li = ui.el('li', { class: 'import-row' }, [cb, input, note]);
      var row = { cb: cb, input: input };
      var show = function () {
        var len = textLength(clean(input.value));
        var notes = [];
        if (it.red) notes.push('赤字（完了らしい）');
        if (it.dup) notes.push('同じ内容がもうあります');
        if (len > o.rules.contentMax) notes.push(len + ' 字（' + o.rules.contentMax + ' 字までに直してください）');
        note.textContent = notes.join('・');
        li.classList.toggle('import-bad', cb.checked && len > o.rules.contentMax);
      };
      input.addEventListener('input', show);
      cb.addEventListener('change', show);
      show();
      rows.push(row);
      return li;
    }

    function build() {
      rows = [];
      ui.clear(list);
      var width = grid.length ? grid[0].length : 0;
      colBox.hidden = width <= 1;
      if (col >= width) col = 0;
      if (width > 1) {
        ui.clear(colSel);
        columns(grid).forEach(function (name, i) { colSel.appendChild(ui.el('option', { value: String(i), text: name })); });
        colSel.value = String(col);
      }
      if (!width) { info.textContent = ''; return; }
      var existing = CT.isDate(date.value) ? o.existing(owner.value, date.value) : [];
      var r = lines(grid, col, colorGrid, { max: o.rules.perDayMax, contentMax: o.rules.contentMax, existing: existing });
      r.items.forEach(function (it) { list.appendChild(rowEl(it)); });
      var parts = [r.items.length + ' 件を読みました'];
      parts.push(colorGrid ? '赤字はチェックを外してあります' : '色は読めませんでした（全部にチェックを入れてあります）');
      if (r.over) parts.push('多すぎるので、後ろの ' + r.over + ' 件は出していません（1 回に ' + o.rules.perDayMax + ' 件まで）');
      info.textContent = parts.join('。');
    }

    function read(text, html) {
      grid = parseText(text);
      colorGrid = html ? colors(grid, parseHtml(html)) : null;
      col = 0;
      build();
    }

    paste.addEventListener('paste', function (ev) {
      var cd = ev.clipboardData;
      if (!cd) return; // 読めないブラウザは、貼り付けた後の input の出来事で文字だけ読む
      ev.preventDefault();
      var text = cd.getData('text/plain') || '';
      var html = '';
      try { html = cd.getData('text/html') || ''; } catch (e) { html = ''; }
      paste.value = text;
      read(text, html);
    });
    paste.addEventListener('input', function () { read(paste.value, ''); });
    colSel.addEventListener('change', function () { col = Number(colSel.value) || 0; build(); });
    owner.addEventListener('change', build);
    date.addEventListener('change', build);

    var field = function (label, input) { return ui.el('div', { class: 'field' }, [ui.el('label', { for: input.id, text: label }), input]); };
    var body = ui.el('div', { class: 'import-box' }, [
      field('だれの欄に入れるか', owner),
      field('入れる日', date),
      field('貼り付ける所', paste),
      colBox, info, list, err,
    ]);

    var loop = function () {
      return ui.dialog({ title: 'まとめて取り込む', body: body, buttons: [{ label: '取り込む', value: 'ok', kind: 'primary' }, { label: 'やめる', value: null }] }).then(function (v) {
        if (v !== 'ok') return null;
        var fail = function (text) { err.textContent = text; err.hidden = false; return loop(); };
        if (!CT.isDate(date.value)) return fail('入れる日を選んでください');
        var picked = rows.filter(function (r) { return r.cb.checked; }).map(function (r) { return clean(r.input.value); }).filter(function (t) { return t !== ''; });
        if (!picked.length) return fail('取り込むものがありません。表を貼り付けて、取り込む行にチェックを入れてください');
        var long = picked.filter(function (t) { return textLength(t) > o.rules.contentMax; });
        if (long.length) return fail(o.rules.contentMax + ' 字を超える行が ' + long.length + ' 件あります。短く直すか、チェックを外してください');
        return { ownerId: owner.value, date: date.value, contents: picked };
      });
    };
    return loop();
  }

  var api = { parseText: parseText, parseHtml: parseHtml, parseColor: parseColor, colors: colors, isRed: isRed, lines: lines, columns: columns, clean: clean, textLength: textLength, open: open };
  if (root && root.MP) root.MP.taskImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
