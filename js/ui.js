/*
 * 共通の部品: 要素を作る・確認とお知らせのダイアログ・送信中の表示・欄の下のエラー・日時の表示
 * 画面に出す文字は、すべて textContent で入れる（値を HTML として解釈させない）
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  var running = false;

  function $(id) { return document.getElementById(id); }

  /** 要素を作る。props: { class, text, id, type, href, value, for, ...属性 }。children: 要素か文字の配列 */
  function el(tag, props, children) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = String(v);
      else if (k === 'value') e.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') e[k] = !!v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { e.addEventListener(ev, v[ev]); });
      else e.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  /** 画面の上のお知らせ（#msg）。text が空なら消す。kind: error / info / warn / ok */
  function pageMessage(text, kind) {
    var box = $('msg');
    if (!box) return;
    box.textContent = text || '';
    box.className = 'msg ' + (kind || 'error');
    box.hidden = !text;
    if (text && box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
  }

  /** 前の画面から渡された文を1回だけ出す */
  function showFlash() {
    var text = MP.store.takeFlash();
    if (text) pageMessage(text, 'info');
  }

  /** 欄のすぐ下にエラーを出す（直すまで出したまま）。text が空なら消す */
  function fieldError(input, text) {
    var id = input.id + '-error';
    var p = $(id);
    if (!text) {
      if (p) p.parentNode.removeChild(p);
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
      return;
    }
    if (!p) {
      p = el('p', { id: id, class: 'field-error', role: 'alert' });
      input.parentNode.insertBefore(p, input.nextSibling);
    }
    p.textContent = text;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', id);
  }

  function clearFieldErrors(root) {
    Array.prototype.slice.call((root || document).querySelectorAll('[aria-invalid="true"]')).forEach(function (i) { fieldError(i, ''); });
  }

  /**
   * 送信の間、画面のボタンをすべて押せなくし、「送信中…」を出す（連打で2回送らない）。
   * すでに送信中なら何もしない（undefined を返す）。fn は Promise を返す
   */
  function run(fn) {
    if (running) return Promise.resolve(undefined);
    running = true;
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (b) { return !b.disabled; });
    buttons.forEach(function (b) { b.disabled = true; });
    var bar = el('div', { class: 'busy', role: 'status', text: '送信中…' });
    document.body.appendChild(bar);
    var done = function () {
      running = false;
      buttons.forEach(function (b) { b.disabled = false; });
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    };
    var p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    return p.then(function (v) { done(); return v; }, function (e) { done(); throw e; });
  }

  /**
   * ダイアログ。o: { title, text（文字。改行はそのまま出る）, body（要素。text の代わり・追加）, buttons: [{ label, value, kind }], dismiss }
   * 押されたボタンの value を返す。Esc で閉じたときは o.dismiss（無ければ null）
   */
  function dialog(o) {
    return new Promise(function (resolve) {
      var d = el('dialog', { 'aria-labelledby': 'dlg-title' });
      var result = o.dismiss === undefined ? null : o.dismiss;
      d.appendChild(el('h2', { id: 'dlg-title', text: o.title }));
      if (o.text) d.appendChild(el('p', { class: 'dialog-body', text: o.text }));
      if (o.body) d.appendChild(o.body);
      var box = el('div', { class: 'dialog-buttons' });
      (o.buttons || [{ label: '閉じる', value: true, kind: 'primary' }]).forEach(function (b) {
        box.appendChild(el('button', {
          type: 'button', class: 'btn' + (b.kind ? ' ' + b.kind : ''), text: b.label,
          on: { click: function () { result = b.value; d.close(); } },
        }));
      });
      d.appendChild(box);
      // Tab でダイアログの外（後ろの画面・ブラウザの欄）に出ないよう、端で反対の端へ回す
      d.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Tab') return;
        var f = Array.prototype.slice.call(d.querySelectorAll('button, a[href], input, select, textarea')).filter(function (x) { return !x.disabled; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1], now = document.activeElement;
        if (ev.shiftKey && (now === first || !d.contains(now))) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && (now === last || !d.contains(now))) { ev.preventDefault(); first.focus(); }
      });
      d.addEventListener('close', function () {
        if (d.parentNode) d.parentNode.removeChild(d);
        if (o.onClose) o.onClose();
        resolve(result);
      });
      // 送信の結果をダイアログで知らせるときは、「送信中…」の表示を消す（後ろのボタンは、ダイアログを閉じて処理が終わるまで押せないまま）
      var busy = document.querySelector('.busy');
      if (busy) busy.hidden = true;
      document.body.appendChild(d);
      d.showModal();
    });
  }

  function confirm(title, text, okLabel, kind) {
    return dialog({
      title: title, text: text, dismiss: false,
      buttons: [{ label: okLabel || 'はい', value: true, kind: kind || 'primary' }, { label: 'やめる', value: false }],
    });
  }

  function notice(title, text) {
    return dialog({ title: title, text: text });
  }

  /** サーバーの日時 'yyyy-MM-dd HH:mm' → '11月11日 9:05'。形が違えばそのまま */
  function fmtDateTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(s || ''));
    return m ? Number(m[2]) + '月' + Number(m[3]) + '日 ' + Number(m[4]) + ':' + m[5] : String(s || '');
  }
  function fmtTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(s || ''));
    return m ? Number(m[4]) + '時' + m[5] + '分' : String(s || '');
  }
  /** 'yyyy-MM-dd' → '2026年11月11日' */
  function fmtDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? m[1] + '年' + Number(m[2]) + '月' + Number(m[3]) + '日' : String(s || '');
  }

  /** 端末の名前の初期値（例「iPhone・Safari」）。分からなければ空 */
  function guessDeviceName() {
    var ua = navigator.userAgent || '';
    var os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'Mac' : '';
    var br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
    return os && br ? os + '・' + br : os || br;
  }

  /** iPhone・iPad の Safari で、ホーム画面のアイコンから開いていないとき */
  function iosNotStandalone() {
    var ua = navigator.userAgent || '';
    var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    return ios && navigator.standalone !== true;
  }

  MP.ui = {
    $: $, el: el, clear: clear, pageMessage: pageMessage, showFlash: showFlash, fieldError: fieldError, clearFieldErrors: clearFieldErrors,
    run: run, dialog: dialog, confirm: confirm, notice: notice, fmtDateTime: fmtDateTime, fmtTime: fmtTime, fmtDate: fmtDate,
    guessDeviceName: guessDeviceName, iosNotStandalone: iosNotStandalone,
  };
})();
