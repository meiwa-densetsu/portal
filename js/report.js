/*
 * 端末のエラーを管理者に知らせるボタン（計画 stage2-error-report-plan.md 第2章・第8章）
 *
 *   MP.report.noteFailure(action, res) … api.js が呼ぶ。ボタンを出すエラー（下の CODES）なら「最近の失敗」に足し、res.failure に付ける
 *   MP.report.screenFailure(text)      … boot.js が呼ぶ（画面の表示中の問題。例外の中身は受け取らない）
 *   MP.report.onMessage(box, text, kind) … ui.pageMessage が呼ぶ。#msg と文が同じ最近の失敗があれば、#msg のすぐ後ろにボタンを付ける
 *   MP.report.attach(resOrFailure)     … 画面が文を書き換えて出したとき、その画面のコードが pageMessage の後に呼ぶ（#msg にボタンを付ける）
 *   MP.report.button(failure)          … タスクの「送れなかった窓」など、#msg の外に置くボタン（要素を返す）
 *   MP.report.recent()                 … 最近の失敗（試験で確かめるため。新しいものが後ろ）
 *
 * 送る中身は 2-2 の項目だけ（token・端末の鍵・処理の args・入力の中身・答えのページの文字・住所の ? の後・userAgent の全文は入れない）。
 * 送れなかったときは端末に控え（MP.store の mp.report.pending。3 件・3 日まで）、次に開いたとき 5 秒後に送り直す（2-4）
 * 画面に出す文字はすべて textContent（MP.ui.el）
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};

  // ボタンを出すエラー（Q1 が A。2-1 の表）。RELOAD は api.js の共通の扱いが 2 回目に返したものだけが届く
  var CODES = { NETWORK: true, BUSY: true, INTERNAL: true, DATA_BROKEN: true, SHEET_TIMEZONE: true, UNKNOWN_ACTION: true, RELOAD: true, SCREEN: true };
  // system.report の答えで、控えから外すもの（同じ中身を送り直しても通らない。2-3 の 4.）。LIMIT と成功も外す。ほかのどの code も控えに残す
  var DROP = { BAD_REQUEST: true, UNKNOWN_ACTION: true, FORBIDDEN: true, PASSWORD_CHANGE_REQUIRED: true, VIEW_ONLY: true };
  var RECENT_MAX = 5;          // 最近の失敗を覚える数
  var RECENT_MS = 30000;       // ボタンを付けられる長さ（失敗から 30 秒）
  var RESEND_WAIT_MS = 5000;   // 画面を開いてから送り直すまでの待ち
  var MESSAGE_MAX = 120, UA_MAX = 60;

  var BUTTON_TEXT = '管理者に知らせる';
  var SENDING_TEXT = '送っています…';
  var DONE = { label: '知らせました', text: '管理者に知らせました' };
  var KEPT = { label: '控えました', text: 'この端末に控えました。次にログインしたときに送ります' };
  var LATER = { label: '控えました', text: '今は送れませんでした。次に開いたときにもう一度送ります' };
  var FAIL = { label: '送れませんでした', text: '送れませんでした。急ぎのときは管理者に電話してください' };

  var PAGE = /^[a-z0-9_]{1,40}\.html$/;
  var ACTION = /^[a-z][a-zA-Z0-9_.]{0,59}$/;
  var CODE = /^[A-Z_]{1,30}$/;
  // 「詳しく」の控えから写す値（第8章の表。決まった値だけ）
  var KIND = { fetch: 'fetch', timeout: 'timeout', notJson: 'notjson', badShape: 'shape' };
  var PAGE_KIND = { googleError: 'gas_error', googleLogin: 'google_login', html: 'html_other', empty: 'empty', text: 'other' };
  var HOSTS = ['script.google.com', 'script.googleusercontent.com', 'accounts.google.com'];
  var DETAIL_ALLOWED = {
    kind: ['fetch', 'notjson', 'shape', 'timeout'],
    host: HOSTS.concat(['other']),
    page: ['gas_error', 'google_login', 'html_other', 'empty', 'other'],
  };

  var recent = [];   // 最近の失敗（新しいものが後ろ）
  var seq = 0;       // ページの中の通し番号
  var shown = null;  // #msg の後ろにボタンを付けている失敗

  /** コードポイントで数えて max 字まで（サロゲートの途中で切らない） */
  function cut(s, max) { return Array.from(String(s || '')).slice(0, max).join(''); }
  function int(v, lo, hi) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= lo && v <= hi; }

  /** 「詳しく」の控え（api.js の remember の 1 件）から、第8章の表の値だけを写す。無ければ null */
  function copyDetail(rec) {
    if (!rec || !Array.isArray(rec.tries) || !rec.tries.length) return null;
    var t = rec.tries[rec.tries.length - 1] || {};
    var redirected = t.redirected === true;
    var host = '';
    if (redirected && t.host) host = HOSTS.indexOf(t.host) >= 0 ? t.host : 'other'; // ホスト名そのものは送らない（Q4 が A）
    return {
      status: int(t.status, 0, 599) ? t.status : 0,
      kind: KIND[t.kind] || '',
      host: host,
      redirected: redirected,
      page: PAGE_KIND[t.page] || '', // 答えのページの文字は送らない。api.js が決まった言葉で分類した鍵を写すだけ
      retried: rec.retried === true,
    };
  }

  /** detail を決まった値だけに直す（控えを読み直したときも通す）。形が違えば null */
  function cleanDetail(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    var pick = function (k) { return DETAIL_ALLOWED[k].indexOf(d[k]) >= 0 ? d[k] : ''; };
    return { status: int(d.status, 0, 599) ? d.status : 0, kind: pick('kind'), host: pick('host'), redirected: d.redirected === true, page: pick('page'), retried: d.retried === true };
  }

  /** 2-2 の形に直す（知らない項目は捨てる）。code の形が違えば null */
  function cleanReport(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.code !== 'string' || !CODE.test(r.code)) return null;
    return {
      at: int(r.at, 0, 8.64e15) ? r.at : 0,
      failedAt: int(r.failedAt, 0, 8.64e15) ? r.failedAt : 0,
      page: typeof r.page === 'string' && PAGE.test(r.page) ? r.page : '?',
      action: typeof r.action === 'string' && ACTION.test(r.action) ? r.action : '',
      code: r.code,
      message: cut(typeof r.message === 'string' ? r.message : '', MESSAGE_MAX),
      detail: cleanDetail(r.detail),
      ua: cut(typeof r.ua === 'string' ? r.ua : '', UA_MAX),
      appVersion: int(r.appVersion, 0, 1e9) ? r.appVersion : 0,
      beforeLogin: r.beforeLogin === true,
      viewing: r.viewing === true,
    };
  }

  /** 画面の住所のファイル名だけ（? の後・# の後は入れない）。形が違えば ? */
  function pageName() {
    var p = String(window.location.pathname || '');
    var name = p.slice(p.lastIndexOf('/') + 1);
    if (name === '') name = 'index.html';
    return PAGE.test(name) ? name : '?';
  }

  /** 押したときの中身（その時点の値を写す） */
  function build(f) {
    var ver = Number(MP.config && MP.config.APP_VERSION);
    return cleanReport({
      at: Date.now(), failedAt: f.at, page: pageName(), action: f.action, code: f.code, message: f.message, detail: f.detail,
      ua: MP.ui && MP.ui.deviceSummary ? MP.ui.deviceSummary() : '', appVersion: isFinite(ver) ? Math.floor(ver) : 0,
      beforeLogin: !MP.store.token(), viewing: !!MP.store.viewAs(),
    });
  }

  /** 30 秒たった失敗を捨てる（ボタンを付けた失敗は used が真で、もう付けない。ほかの処理の成功では消さない） */
  function prune() {
    var now = Date.now();
    recent = recent.filter(function (f) { return now - f.at <= RECENT_MS; }).slice(-RECENT_MAX);
  }

  function add(action, code, message, detail) {
    prune();
    var f = { seq: ++seq, at: Date.now(), action: String(action || ''), code: code, message: String(message || ''), detail: detail, used: false, state: '', views: [] };
    recent.push(f);
    if (recent.length > RECENT_MAX) recent = recent.slice(-RECENT_MAX);
    return f;
  }

  function noteFailure(action, res) {
    if (!res || res.ok || !CODES[res.code] || res.code === 'SCREEN') return null;
    var f = add(action, res.code, res.message, copyDetail(res.netRecord));
    try { Object.defineProperty(res, 'failure', { value: f, configurable: true, writable: true }); } catch (e) { /* 付けられなくても続ける */ }
    return f;
  }

  function screenFailure(text) {
    try { return add('', 'SCREEN', text, null); } catch (e) { return null; }
  }

  /** 今の文と同じ・30 秒以内・まだボタンを付けていない失敗のうち、一番新しいもの */
  function find(text) {
    prune();
    for (var i = recent.length - 1; i >= 0; i--) if (!recent[i].used && recent[i].message === text) return recent[i];
    return null;
  }

  function el(tag, props, children) { return MP.ui.el(tag, props, children); }

  function paint(wrap, f) {
    MP.ui.clear(wrap);
    var label = f.state === 'sending' ? SENDING_TEXT : f.state === 'done' ? f.result.label : BUTTON_TEXT;
    wrap.appendChild(el('button', { type: 'button', class: 'btn report-btn', text: label, disabled: !!f.state,
      on: { click: function () { press(f); } } }));
    if (f.state === 'done') wrap.appendChild(el('p', { class: 'report-note', role: 'status', text: f.result.text }));
  }

  function repaint(f) {
    f.views = f.views.filter(function (w) { return document.documentElement.contains(w); });
    f.views.forEach(function (w) { paint(w, f); });
  }

  /** ボタンの要素（同じ失敗のボタンは、どこに出ても同じ状態） */
  function button(f) {
    f.used = true;
    var wrap = el('div', { class: 'report-view' });
    f.views.push(wrap);
    paint(wrap, f);
    return wrap;
  }

  function removeBox() {
    var b = document.getElementById('report-box');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  function showAt(box, f) {
    removeBox();
    shown = f;
    if (!box.parentNode) return;
    box.parentNode.insertBefore(el('div', { id: 'report-box', class: 'report-box' }, [button(f)]), box.nextSibling);
  }

  var lastText = ''; // #msg に今出しているエラーの文（attach が、送る中身の message をこの文にする）

  function onMessage(box, text, kind) {
    var prev = shown;
    removeBox();
    shown = null;
    lastText = '';
    if (!text || kind !== 'error' || box.hidden) return;
    var s = String(text);
    lastText = s;
    // 同じ文を出し直したときは、前に付けたボタン（押した後の状態）をそのまま出す
    var f = find(s) || (prev && prev.message === s ? prev : null);
    if (f) showAt(box, f);
  }

  function attach(x) {
    var f = x && x.failure ? x.failure : x && typeof x.seq === 'number' && x.views ? x : null;
    var box = document.getElementById('msg');
    if (!f || !box || box.hidden || !/\berror\b/.test(box.className)) return;
    if (f.used && shown !== f) return; // ほかの所にもう付けた
    if (lastText && !f.state) f.message = lastText; // 送る中身は「画面に出た文」（2-2）
    showAt(box, f);
  }

  /** 今のログインの社員ID（このページで覚えたもの、無ければ自分の情報の控え）。分からなければ null */
  function currentMe() {
    var seen = MP.api && MP.api.seenMe ? MP.api.seenMe() : null;
    if (seen) return seen;
    var me = MP.store.me();
    return me ? { id: me.employeeId, temp: false } : null;
  }

  /** system.report を 1 回送る。答えから、控えを外すか（drop）と出す文を返す（失敗しない） */
  function sendOnce(rid, report) {
    var done = function (res) {
      if (res && res.ok) return { drop: true, result: DONE };
      var code = res && res.code;
      if (code === 'LIMIT') return { drop: true, result: { label: FAIL.label, text: String(res.message || FAIL.text) } };
      if (DROP[code]) return { drop: true, result: FAIL };
      return { drop: false, result: null }; // そのほかのどの code も控えに残す
    };
    // raw … ログインの画面へ移る・読み込み直すなどの共通の扱いをしない。noViewAs … 本人として送る（見ている社員の ID を送らない）
    return MP.api.call('system.report', { report: report }, { requestId: rid, raw: true, noViewAs: true }).then(done, function () { return done(null); });
  }

  function submit(f) {
    var report = build(f);
    var rid = MP.api.newRequestId();
    if (!report) return Promise.resolve(FAIL);
    var item = { rid: rid, id: '', at: report.at, report: report };
    if (!MP.store.token()) {
      // ログインの前（Q2 が A）: 送らずに端末に控え、次にこの端末でログインした人の名前で送る
      if (MP.store.addReportPending(item, false)) return Promise.resolve(KEPT);
    }
    var stored = false;
    var me = MP.store.token() && !MP.store.viewAs() ? currentMe() : null;
    if (me && me.id) {
      item.id = me.id;
      stored = MP.store.addReportPending(item, MP.store.tokenShared()); // 先に控えてから送る（書けなければ控えずに送る）
    }
    return sendOnce(rid, report).then(function (r) {
      if (r.drop) { MP.store.removeReportPending(rid); return r.result; }
      return stored ? LATER : FAIL;
    });
  }

  function press(f) {
    if (f.state) return; // 1 つの失敗につき 1 回だけ
    f.state = 'sending';
    f.used = true;
    repaint(f);
    submit(f).then(null, function () { return FAIL; }).then(function (result) {
      f.state = 'done';
      f.result = result || FAIL;
      repaint(f);
    });
  }

  /** 控えを古い順に 1 件ずつ送る（ログイン中・社員の画面を見ていないときだけ。送り直しは同じ requestId） */
  function resendNext(list) {
    if (!list.length || !MP.store.token() || MP.store.viewAs()) return;
    var x = list.shift();
    var me = currentMe();
    if (!me) { resendNext(list); return; }                                               // 今の社員が分からない（仮パスワードかもしれない）: 残しておく
    if (x.id !== '') {
      if (x.id !== me.id) { MP.store.removeReportPending(x.rid); resendNext(list); return; } // ほかの人の名前で記録しない: 捨てる
    }
    var report = cleanReport(x.report);
    if (!report) { MP.store.removeReportPending(x.rid); resendNext(list); return; }
    sendOnce(x.rid, report).then(function (r) {
      if (!r.drop) return; // 今は送れない: 次に開いたときにもう一度
      MP.store.removeReportPending(x.rid);
      resendNext(list);
    });
  }

  function resend() {
    try {
      if ((MP.boot && MP.boot.framed) || !MP.store || !MP.store.available() || !MP.store.token() || MP.store.viewAs()) return;
      var me = currentMe();
      if (me && me.temp) return; // 仮パスワードのまま（送っても PASSWORD_CHANGE_REQUIRED で通らない）
      resendNext(MP.store.reportPending());
    } catch (e) { /* 送り直しの失敗で画面を止めない */ }
  }

  window.setTimeout(resend, RESEND_WAIT_MS);

  MP.report = {
    noteFailure: noteFailure,
    screenFailure: screenFailure,
    onMessage: onMessage,
    attach: attach,
    button: button,
    recent: function () { prune(); return recent.slice(); },
  };
})();
