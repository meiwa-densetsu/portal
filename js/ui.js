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

  /** 会社のロゴ（光が流れる）と一言。読み込み中・送信中に出す（見た目は style.css の .ll。ロゴは飾りなので読み上げない） */
  function loadingLogo(text) {
    return el('span', { class: 'll' }, [el('span', { class: 'll-img', 'aria-hidden': 'true' }), el('span', { class: 'll-text', text: text })]);
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  /** 画面の上のお知らせ（#msg）。text が空なら消す。kind: error / info / warn / ok */
  function pageMessage(text, kind) {
    if (brokenNow && !brokenMsgOk) return; // 「読み込み直す」だけにした後は、遅れて届いた知らせで画面を戻さない（boot.js の知らせは brokenMessage で出す）
    var box = $('msg');
    if (!box) return;
    box.textContent = text || '';
    box.className = 'msg ' + (kind || 'error');
    box.hidden = !text;
    addNetDetail(box, text);
    // 管理者に知らせるボタン（#msg のすぐ後ろ。「詳しく」の後ろ。文が同じ最近の失敗があるときだけ。計画 stage2-error-report-plan.md 2-1）
    if (MP.report && MP.report.onMessage) { try { MP.report.onMessage(box, text, kind || 'error'); } catch (e) { /* ボタンが出せなくても文は出す */ } }
    if (text && box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
  }

  /** 通信の失敗の一言のときだけ、その下に「詳しく」を付ける（控えがあるときだけ。押すと控えを文字で出す。写真で送れる形） */
  function addNetDetail(box, text) {
    var api = MP.api;
    if (!text || !api || !api.netLogText) return;
    var s = String(text);
    if (s.indexOf(api.NETWORK_TEXT) < 0 && s.indexOf(api.SAVE_UNKNOWN_TEXT) < 0) return;
    if (!api.netLogText()) return;
    box.appendChild(el('div', { class: 'msg-detail' }, [el('button', {
      type: 'button', class: 'btn', id: 'net-detail', text: '詳しく',
      on: { click: function () {
        var detail = api.netLogText();
        dialog({ title: '通信の詳しい記録', body: el('div', {}, [
          el('p', { class: 'dialog-body', text: 'この画面を写真に撮って、管理者に送ってください（パスワードや入力の中身は入っていません）' }),
          el('pre', { class: 'net-detail-text', id: 'net-detail-text', text: detail || '記録はありません' }),
        ]) });
      } },
    })]));
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
    var bar = el('div', { class: 'busy', role: 'status' }, [loadingLogo('送信中…')]);
    document.body.appendChild(bar);
    var done = function () {
      running = false;
      buttons.forEach(function (b) { b.disabled = false; });
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    };
    var p;
    if (strict) fn = drawing(fn); // watchBroken を呼んだ画面では、送信の中で出た例外（文字列も）で「読み込み直す」だけにする
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    return p.then(function (v) { done(); return v; }, function (e) { done(); throw e; });
  }

  /**
   * ダイアログ。o: { title, text（文字。改行はそのまま出る）, body（要素。text の代わり・追加）, buttons: [{ label, value, kind }], dismiss }
   * 押されたボタンの value を返す。Esc で閉じたときは o.dismiss（無ければ null）
   */
  var DIALOG_ROW_MAX = 3; // パソコンの幅で、横 1 列に並べるボタンの数の限り（超えたら何段かに分ける）

  function dialog(o) {
    // 「読み込み直す」だけにした後は窓を開かない（遅れて届いた返事が窓を出し、押せる物を戻さない）。答えは返さず、窓の後の処理も動かさない
    if (brokenNow) return new Promise(function () {});
    return new Promise(function (resolve) {
      var d = el('dialog', { 'aria-labelledby': 'dlg-title' });
      var result = o.dismiss === undefined ? null : o.dismiss;
      d.appendChild(el('h2', { id: 'dlg-title', text: o.title }));
      if (o.text) d.appendChild(el('p', { class: 'dialog-body', text: o.text }));
      if (o.body) d.appendChild(o.body);
      var list = o.buttons || [{ label: '閉じる', value: true, kind: 'primary' }];
      // ボタンが多いとき（タスクのメニューなど）は、横 1 列に詰めずに何段かに分ける（細くなって文字が縦に並ぶのを防ぐ）
      var box = el('div', { class: 'dialog-buttons' + (list.length > DIALOG_ROW_MAX ? ' many' : '') });
      list.forEach(function (b) {
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
        if (brokenNow) return; // showBroken が閉じたとき: 答えを返さず、窓の後の処理（読み直しなど）を起こさない
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

  /**
   * 端末の種類の要約（管理者に知らせる中身。例「iPhone iOS 18.7・Safari・ホーム画面」）。userAgent の全文は返さない。60 字まで
   * guessDeviceName の名前に、OS の版の数字と、ホーム画面のアイコンから開いたかを足す
   */
  function deviceSummary() {
    var ua = navigator.userAgent || '';
    var m, ver = '';
    if ((m = /(?:iPhone|iPad|iPod)[^)]*? OS (\d{1,2})_(\d{1,2})/.exec(ua))) ver = 'iOS ' + m[1] + '.' + m[2];
    else if ((m = /Android (\d{1,2}(?:\.\d{1,2})?)/.exec(ua))) ver = m[1];
    else if ((m = /Windows NT (\d{1,2}\.\d)/.exec(ua))) ver = 'NT ' + m[1];
    else if ((m = /Mac OS X (\d{1,2})[_.](\d{1,2})/.exec(ua))) ver = 'macOS ' + m[1] + '.' + m[2];
    var name = guessDeviceName();
    var parts = name ? name.split('・') : [];
    // 機種の名前が分かるときだけ版を足す（名前が分からない端末は、版の数字だけを送らない）
    var head = parts.length && /^(iPhone|iPad|Android|Windows|Mac)$/.test(parts[0]) ? parts[0] + (ver ? ' ' + ver : '') : (parts[0] || '');
    var standalone = navigator.standalone === true;
    try { standalone = standalone || (!!window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); } catch (e) { /* 分からなければ偽 */ }
    var out = [head].concat(parts.slice(1)).filter(Boolean).join('・') + (standalone ? '・ホーム画面' : '');
    return Array.from(out || '不明').slice(0, 60).join('');
  }

  /** iPhone・iPad の Safari で、ホーム画面のアイコンから開いていないとき */
  function iosNotStandalone() {
    var ua = navigator.userAgent || '';
    var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    return ios && navigator.standalone !== true;
  }

  var brokenNow = false;   // showBroken の後（描画と知らせを止める印）
  var brokenMsgOk = false; // brokenMessage の間だけ、pageMessage を通す

  /**
   * 描画が例外で止まったとき: 画面の中身（#view）を隠して触れなくし、「画面を表示できませんでした」と
   * 「読み込み直す」（ページを読み込み直す）だけを出す。前の社員・期間の表示や、押せるボタン・リンクを残さない。
   * お知らせ（#msg。通信の失敗の「詳しく」も中にある）と、管理者に知らせるボタン（.report-box）も隠す。
   * この後は pageMessage を止める（isBroken で、遅れて届いた返事が画面を戻さないようにする）。どこで止まっても出せるよう、1 つずつ try で囲む
   */
  function showBroken() {
    brokenNow = true;
    try { document.body.hidden = false; } catch (e) { /* 次へ */ }
    try { var v = $('view'); if (v) { v.hidden = true; v.inert = true; } } catch (e) { /* 次へ */ }
    try { var m = $('msg'); if (m) m.hidden = true; } catch (e) { /* 次へ */ }
    try { var ln = $('loading-note'); if (ln && ln.parentNode) ln.parentNode.removeChild(ln); } catch (e) { /* 次へ（最初の読み込みを待つ間の「読み込み中…」。#msg の外） */ }
    try { Array.prototype.forEach.call(document.querySelectorAll('.report-box'), function (x) { if (x.parentNode) x.parentNode.removeChild(x); }); } catch (e) { /* 次へ */ }
    // リマインダーと安否確認の帯（#view の外。リンク・ボタンがある）も消す。この後は remind.js が stopped を見て出さない。読み込み直せば出る
    // 上の帯（#topbar）のボタン（ログアウト・社員の画面を見るのを終わる）も隠す（送信も窓も止まっていて、押しても何も起きないため）。ふつうのリンク（ホーム）は残す
    try { Array.prototype.forEach.call(document.querySelectorAll('#topbar button'), function (x) { x.hidden = true; }); } catch (e) { /* 次へ */ }
    try { ['remind-bar', 'safety-bar'].forEach(function (id) { var x = $(id); if (x && x.parentNode) x.parentNode.removeChild(x); }); } catch (e) { /* 次へ */ }
    try { Array.prototype.forEach.call(document.querySelectorAll('dialog[open]'), function (d) { d.close(); }); } catch (e) { /* 次へ */ }
    try { var busy = document.querySelector('.busy'); if (busy && busy.parentNode) busy.parentNode.removeChild(busy); } catch (e) { /* 次へ */ }
    if ($('broken-box')) return;
    var box = el('div', { id: 'broken-box', class: 'msg error', role: 'alert' }, [
      el('p', { text: '画面を表示できませんでした' }),
      el('button', { type: 'button', id: 'broken-reload', class: 'btn primary block', text: '読み込み直す', on: { click: function () { window.location.reload(); } } }),
    ]);
    var main = document.querySelector('main') || document.body;
    main.insertBefore(box, main.firstChild);
  }

  /** showBroken の後か（遅れて届いた返事は、画面を描き直さずに終える） */
  function isBroken() { return brokenNow; }

  /**
   * 日報の 4 画面（watchBroken を呼んだ画面）で、showBroken の後か。MP.api.call（送らない・届いた返事を渡さない）と
   * MP.go（画面を移らない）がこれを見て止まる。「読み込み直す」は location.reload なので止まらない
   */
  function stopped() { return strict && brokenNow; }

  /** showBroken の後でも出すお知らせ（boot.js が最初の読み込みで出す「画面の表示中に問題が起きました」と、管理者に知らせるボタンだけ） */
  function brokenMessage(text, kind) {
    brokenMsgOk = true;
    try { pageMessage(text, kind); } finally { brokenMsgOk = false; }
  }

  /**
   * 日付・社員を切り替えて描く処理を包む。この中で例外が出たら（文字列を投げたときも、返した Promise が拒否されたときも）showBroken にしてから、そのまま投げる。
   * 使い方: ui.drawing(function () { ... })（包んだ関数を返す。呼ぶと中身を動かす）
   */
  function drawing(fn) {
    return function () {
      var r;
      try { r = fn.apply(this, arguments); } catch (e) { showBroken(); throw e; }
      if (r && typeof r.then === 'function') return r.then(null, function (e) { showBroken(); throw e; });
      return r;
    };
  }

  /** 決めた画面のファイル（例 'page_report.js'）の、読み込んだ住所（? の前） */
  function scriptBases(names) {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('script[src]'), function (sc) {
      var src = String(sc.src || '').split('?')[0];
      names.forEach(function (n) { if (src.slice(-('/js/' + n).length) === '/js/' + n) out.push(src); });
    });
    return out;
  }

  /**
   * 保険の見張り: この画面にいる間、names の画面のファイル（例 ['page_report.js']）から出て誰も拾わなかった例外
   * （window の error・unhandledrejection）で showBroken にする。スタックか、出た所のファイル名が、その住所を含むときだけ（ほかの部品・外のコードの例外では隠さない）。
   * 拾った例外は止めない（ブラウザの開発者の画面には今までどおり出る）。主な守りは drawing と load の中の try
   */
  var strict = false; // watchBroken を呼んだ画面（日報の 4 画面）。ui.run の中を drawing で包む
  function watchBroken(names) {
    strict = true;
    var bases = scriptBases(names || []);
    var mine = function (err, filename) {
      var where = String((err && err.stack) || '') + ' ' + String(filename || '');
      return bases.some(function (b) { return where.indexOf(b) >= 0; });
    };
    window.addEventListener('error', function (ev) { if (ev && mine(ev.error, ev.filename)) showBroken(); });
    window.addEventListener('unhandledrejection', function (ev) { if (ev && mine(ev.reason, '')) showBroken(); });
  }

  MP.ui = {
    showBroken: showBroken, watchBroken: watchBroken, isBroken: isBroken, stopped: stopped, brokenMessage: brokenMessage, drawing: drawing,
    $: $, el: el, clear: clear, pageMessage: pageMessage, showFlash: showFlash, fieldError: fieldError, clearFieldErrors: clearFieldErrors,
    run: run, loadingLogo: loadingLogo, dialog: dialog, confirm: confirm, notice: notice, fmtDateTime: fmtDateTime, fmtTime: fmtTime, fmtDate: fmtDate,
    guessDeviceName: guessDeviceName, deviceSummary: deviceSummary, iosNotStandalone: iosNotStandalone,
  };
})();
