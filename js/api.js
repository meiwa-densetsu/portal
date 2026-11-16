/*
 * GAS の呼び出し（計画 stage1-step2b-3-plan.md 2-3）
 *
 *   MP.api.call(action, args, opts) → Promise<{ ok: true, data } | { ok: false, code, message }>
 *     opts.requestId … 送り直すときに同じものを使う保存（社員マスタ）で渡す。無ければ毎回新しく作る
 *     opts.raw       … 共通の扱い（下の表）をせず、結果をそのまま返す（ログアウト用）
 *     opts.keep      … ['FORBIDDEN'] など。その code だけ共通の扱いをせず返す（タスクの列。ほかの code は今どおり）
 *   答えに serverMs（サーバーの中の処理時間・ミリ秒）があれば res.serverMs に入れる
 *   MP.api.onLeave(fn) … 共通の扱いが画面を移す直前に fn を呼ぶ（送り残しの「離れますか」を止めるため）
 *
 * 通信の失敗・時間切れ（60秒）・JSON でない応答・形の違う応答は、すべて code: 'NETWORK'（結果が分からない）
 *   読むだけの処理（READ_ONLY）は、JSON でない・形が違う・すぐの通信の失敗のときだけ、黙って 1 回送り直す（同じ requestId）。
 *   時間切れの 60 秒は送り直しも含めた全体で数える（送り直しは残りだけ待つ。残りが少なければ送り直さない）。
 *   駄目だったときは、そのときの様子（token・args・入力の中身・答えの本文の文字は入れない）を MP.store.addNetLog に控え、画面の「詳しく」で出す
 * どの処理にも共通の扱い:
 *   RELOAD → 読み込み直す（続けて2回目は読み込み直さずに文を返す）／UNAUTHORIZED → ログインの記憶を消して login へ／
 *   PASSWORD_CHANGE_REQUIRED → password へ／INVALID_DEVICE → 端末の情報を消して register へ／FORBIDDEN → home へ
 *   画面を移るときは、返す Promise を終わらせない（呼んだ側は何もしなくてよい。送信中の表示のまま移る）
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  var TIMEOUT_MS = 60000;
  var NETWORK_TEXT = '通信できませんでした。電波の良いところでもう一度お試しください';

  function newRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  var SERVER_MS_MAX = 600000; // サーバーの処理時間として取り込む上限（GAS の 1 回の上限 6 分）
  var SAVE_UNKNOWN_TEXT ='保存できたか分かりません。もう一度同じボタンを押してください';
  var RETRY_WAIT_MS = 800;      // 読むだけの処理を黙って送り直すまでの間
  var RETRY_FAST_MS = 10000;    // 通信の失敗を「すぐの失敗」とみなす長さ（これより後の失敗・時間切れは送り直さない）
  /*
   * 送り直しに要る残り時間（全体の 60 秒のうち、待つ 0.8 秒を引いた残り）。これより少なければ送り直さない。
   * 15 秒にした理由: 本物の GAS の答えは 1〜3 秒だが、混み合い・起き上がり（しばらく使われていなかった後）では 10 秒前後かかることがある。
   * 残りがそれより短いと、送り直しても時間切れになりやすく、待たせるだけになる
   */
  var RETRY_MIN_LEFT_MS = 15000;

  /*
   * 読むだけの処理（書き込みをしない。同じ requestId で 2 回届いても結果が変わらない）。
   * 答えが JSON でない・形が違う・すぐ（10 秒以内）通信に失敗したときだけ、黙って 1 回だけ送り直す。
   *   task.month・task.reminders は裏で自動の先送り・定型の作成をするが、シートの状態で「要るか」を決めて、済めば何もしない
   *   （requestId に関係なく、何度呼んでも同じ結果になる）ので入れる。
   *   task.requests は「完了の知らせ済み」を書き、2 回目の答えから知らせが消えるので入れない
   */
  var READ_ONLY = {};
  ['system.ping', 'auth.me', 'auth.names', 'auth.inviteInfo', 'auth.deviceCodeInfo', 'auth.myDeviceCodes', 'auth.admin.status',
    'master.admin.list', 'calendar.admin.list', 'calendar.admin.get', 'calendar.admin.employee',
    'report.period', 'report.admin.legal', 'report.admin.closingList', 'report.admin.closingCheck', 'report.admin.changes', 'report.admin.export',
    'report.manager.list', 'task.month', 'task.reminders', 'task.recurring.list', 'task.admin.export',
    'share.mine', 'share.received', 'share.view'].forEach(function (a) { READ_ONLY[a] = true; });

  function network() { return { ok: false, code: 'NETWORK', message: NETWORK_TEXT }; }

  /**
   * 応答の文字を、決まった形に直す。形が違えば NETWORK。
   * 返すもの: { res, kind }（kind … 'ok' 決まった形／'notJson' JSON でない／'badShape' JSON だが形が違う）
   */
  function normalize(text) {
    var o;
    try { o = JSON.parse(text); } catch (e) { return { res: network(), kind: 'notJson' }; }
    if (!o || typeof o !== 'object') return { res: network(), kind: 'badShape' };
    // serverMs … サーバーの中の処理時間（ミリ秒）。有限の 0 以上の整数のときだけ取り込む（古いサーバーには無い。計画 stage2-task-speed-plan.md 第6章）
    var ms = typeof o.serverMs === 'number' && isFinite(o.serverMs) && o.serverMs >= 0 && Math.floor(o.serverMs) === o.serverMs && o.serverMs <= SERVER_MS_MAX ? o.serverMs : null;
    var withMs = function (r) { if (ms !== null) r.serverMs = ms; return r; };
    if (o.ok === true && Object.prototype.hasOwnProperty.call(o, 'data')) {
      // me … ログインが要る処理の答えに付く「自分の情報」（auth.me と同じ中身。画面を開くときに使う）
      return { res: withMs(o.me && typeof o.me === 'object' ? { ok: true, data: o.data, me: o.me } : { ok: true, data: o.data }), kind: 'ok' };
    }
    if (o.ok === false && o.error && typeof o.error.code === 'string' && o.error.code && typeof o.error.message === 'string') {
      return { res: withMs({ ok: false, code: o.error.code, message: o.error.message }), kind: 'ok' };
    }
    return { res: network(), kind: 'badShape' };
  }

  /** 住所のホスト名だけ（パス・問い合わせの文字は残さない）。分からなければ空 */
  function hostOf(url) {
    try { return url ? new URL(url).hostname : ''; } catch (e) { return ''; }
  }

  /*
   * JSON でない答えの分類（控えには決まった言葉の分類だけを入れ、本文の文字は入れない。転送先のページに個人の情報が入りうるため）。
   * 判定はホスト名・タグの有無・決まった目印だけで行う
   */
  var PAGE_KIND = { googleLogin: 'Google のログインのページ', googleError: 'Google のエラーのページ', html: 'そのほかの HTML', text: 'HTML でない文字', empty: '空' };
  function isGoogleHost(host) { return /(^|\.)(google\.com|googleusercontent\.com)$/.test(host); }
  function pageKind(text, host) {
    var s = String(text || '');
    if (!s.trim()) return 'empty';
    // タグの形（<名前 …> ・</名前>・<!doctype>）が 1 つでもあれば HTML（span・form などの決まっていないタグも。Codex 2 回目 low）
    var html = /<\s*(!doctype\b|\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>)/i.test(s);
    if (host === 'accounts.google.com' || /accounts\.google\.com\/|ServiceLogin/.test(s)) return 'googleLogin';
    if (html && (isGoogleHost(host) || /<title>\s*Google (Drive|ドライブ)|unable to open the file|ファイルを開くことができません/i.test(s))) return 'googleError';
    return html ? 'html' : 'text';
  }

  /**
   * 1 回送る。返すもの: { res, fail }。fail は通信の失敗・JSON でない・形が違うときだけ
   *   { kind: 'fetch' | 'timeout' | 'notJson' | 'badShape', ms, status, host, redirected, page }（token・args・入力の中身・本文の文字は入れない）
   * timeoutMs … この送信で待つ長さ（送り直しは、全体の 60 秒の残りだけ）
   */
  function send(action, args, requestId, viewAs, timeoutMs) {
    var ctrl = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, timeoutMs);
    var t0 = Date.now();
    var env = { action: action, apiVersion: MP.config.API_VERSION, token: MP.store.token(), requestId: requestId, args: args || {} };
    if (viewAs) env.viewAs = viewAs.employeeId; // 社員の画面を見ているときだけ（計画 stage1-viewas-plan.md 1-1）
    var body = JSON.stringify(env);
    var info = { status: 0, host: '', redirected: false };
    return fetch(MP.config.EXEC_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body,
      redirect: 'follow', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctrl.signal,
    }).then(function (r) {
      info.status = r.status;
      info.host = hostOf(r.url);
      info.redirected = r.redirected === true;
      return r.text().then(function (text) {
        var n = normalize(text);
        if (n.kind === 'ok') return { res: n.res, fail: null };
        return { res: n.res, fail: { kind: n.kind, page: n.kind === 'notJson' ? pageKind(text, info.host) : '' } };
      });
    }).then(null, function () {
      return { res: network(), fail: { kind: timedOut ? 'timeout' : 'fetch', page: '' } };
    }).then(function (out) {
      clearTimeout(timer);
      var ms = Date.now() - t0;
      MP.store.addTiming(action, ms);
      if (out.fail) {
        out.fail.ms = ms;
        out.fail.status = info.status;
        out.fail.host = info.host;
        out.fail.redirected = info.redirected;
      }
      return out;
    });
  }

  /** 送り直してよい失敗か（読むだけの処理で、JSON でない・形が違う・すぐの通信の失敗。時間切れは送り直さない） */
  function retryable(action, fail) {
    if (!READ_ONLY[action] || !fail) return false;
    if (fail.kind === 'notJson' || fail.kind === 'badShape') return true;
    return fail.kind === 'fetch' && fail.ms < RETRY_FAST_MS;
  }

  /** 2 回とも駄目（または送り直さない処理で駄目）だったときの控えを残す（「詳しく」で出す） */
  function remember(action, fails, retried) {
    MP.store.addNetLog({
      at: Date.now(), action: String(action), retried: !!retried,
      tries: fails.map(function (f) {
        return { kind: f.kind, ms: Math.round(f.ms || 0), status: Number(f.status) || 0, host: String(f.host || ''), redirected: !!f.redirected,
          page: PAGE_KIND[f.page] ? f.page : '' };
      }),
    });
  }

  /**
   * 送る。読むだけの処理は、決まった失敗のときだけ、少し待って同じ requestId で 1 回だけ送り直す。
   * 待つ長さは、最初の送信からの全体で 60 秒（送り直しは残りだけ待つ。残りが RETRY_MIN_LEFT_MS より少なければ送り直さない）
   */
  function sendWithRetry(action, args, requestId, viewAs) {
    var deadline = Date.now() + TIMEOUT_MS;
    return send(action, args, requestId, viewAs, TIMEOUT_MS).then(function (first) {
      if (!first.fail) return first.res;
      if (!retryable(action, first.fail) || deadline - Date.now() - RETRY_WAIT_MS < RETRY_MIN_LEFT_MS) {
        remember(action, [first.fail], false);
        return first.res;
      }
      return new Promise(function (resolve) { setTimeout(resolve, RETRY_WAIT_MS); }).then(function () {
        return send(action, args, requestId, viewAs, Math.max(0, deadline - Date.now()));
      }).then(function (second) {
        if (second.fail) remember(action, [first.fail, second.fail], true);
        return second.res;
      });
    });
  }

  var never = function () { return new Promise(function () {}); };

  /**
   * 社員の画面を見ているときの答えの確かめ（計画 stage1-viewas-plan.md 1-6。今までの共通の扱い common より前）。
   *   成功で me.viewAs が頼んだ社員 → そのまま／成功でそれ以外 → 渡さずに終える（ホームへ）
   *   VIEW_ONLY・NETWORK・BUSY・INTERNAL → 続ける／それ以外の誤り → 先に見るのをやめてから common へ
   */
  function checkViewAs(res, sentAs) {
    if (!sentAs) return res;
    if (res.ok) {
      if (res.me && res.me.viewAs && res.me.viewAs.employeeId === sentAs.employeeId) return res;
      MP.store.clearViewAs();
      MP.store.setFlash('社員の画面の表示を終えました');
      MP.go('home.html');
      return never();
    }
    if (['VIEW_ONLY', 'NETWORK', 'BUSY', 'INTERNAL'].indexOf(res.code) >= 0) return res;
    MP.store.clearViewAs();
    return res;
  }

  var leaveFns = []; // 共通の扱いが画面を移す直前に呼ぶ関数（MP.api.onLeave）
  function leaving() { leaveFns.forEach(function (fn) { try { fn(); } catch (e) { /* 移るのを止めない */ } }); }

  function common(res) {
    if (res.ok) { MP.store.setReloaded(''); return res; }
    var here = window.location.pathname;
    switch (res.code) {
      case 'RELOAD':
        if (MP.store.reloaded() === here) {
          return { ok: false, code: 'RELOAD', message: '画面が古くなっています。しばらくしてから開き直してください' };
        }
        MP.store.setReloaded(here);
        leaving();
        window.location.reload();
        return never();
      case 'UNAUTHORIZED':
        MP.store.clearToken();
        MP.store.setFlash('もう一度ログインしてください');
        leaving();
        MP.go('login.html');
        return never();
      case 'PASSWORD_CHANGE_REQUIRED':
        leaving();
        MP.go('password.html');
        return never();
      case 'INVALID_DEVICE':
        MP.store.clearDevice();
        MP.store.setFlash('この端末の登録が無効になりました。もう一度登録してください');
        leaving();
        MP.go('register.html');
        return never();
      case 'FORBIDDEN':
        MP.store.setFlash('この操作はできません');
        leaving();
        MP.go('home.html');
        return never();
      default:
        return res;
    }
  }

  /**
   * 保存用の呼び出しを作る（社員マスタなど）。「1回の保存の操作」ごとに requestId を1つ作り、
   * 結果が分からない（NETWORK）・途中で止まった（INTERNAL）・混雑（BUSY）の後に同じ内容で送り直すときは、同じ requestId を使う。
   * 内容を変えたとき・結果がはっきりした後（成功・断られた）は、新しく作る
   */
  function saver(opts) {
    var last = null; // { key, requestId }
    var extra = opts || {};
    return function (action, args) {
      var key = action + '\n' + JSON.stringify(args);
      if (!last || last.key !== key) last = { key: key, requestId: newRequestId() };
      var mine = last;
      return MP.api.call(action, args, { requestId: mine.requestId, noViewAs: !!extra.noViewAs }).then(function (res) {
        var unknown = !res.ok && (res.code === 'NETWORK' || res.code === 'INTERNAL' || res.code === 'BUSY');
        if (!unknown && last === mine) last = null;
        if (!res.ok && res.code === 'NETWORK') res.message = SAVE_UNKNOWN_TEXT;
        return res;
      });
    };
  }

  MP.api = {
    saver: saver,
    newRequestId: newRequestId,
    NETWORK_TEXT: NETWORK_TEXT,
    pageKind: pageKind, // 答えのページの分類（試験で表の例を流すため。決まった言葉の鍵だけを返す）
    SAVE_UNKNOWN_TEXT: SAVE_UNKNOWN_TEXT,
    /** 「詳しく」で出す文（控えが無ければ空）。新しい順に、最近の 3 回まで */
    netLogText: function () {
      var list = MP.store.netLog().slice(-3).reverse();
      var KIND = { fetch: '通信の失敗（つながらない・途中で切れた）', timeout: '時間切れ（全体で60秒）', notJson: '答えが JSON でない（ページが返った）', badShape: '答えの形が違う' };
      var two = function (n) { return (n < 10 ? '0' : '') + n; };
      return list.map(function (x) {
        var d = new Date(x.at);
        var lines = [
          '時刻: ' + d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()),
          '処理: ' + x.action,
          '送り直し: ' + (x.retried ? 'した（2回とも駄目）' : 'しない'),
        ];
        x.tries.forEach(function (t, i) {
          lines.push((i + 1) + '回目: ' + (KIND[t.kind] || t.kind) + '・' + t.ms + 'ms・番号 ' + t.status + '・転送 ' + (t.redirected ? 'あり' : 'なし') + (t.host ? '・' + t.host : ''));
          if (t.page && PAGE_KIND[t.page]) lines.push('　答えのページ: ' + PAGE_KIND[t.page]);
        });
        return lines.join('\n');
      }).join('\n\n');
    },
    call: function (action, args, opts) {
      var o = opts || {};
      // noViewAs … 社員の画面を見る開始・終了（本人の管理者として送る）
      var sentAs = o.noViewAs ? null : MP.store.viewAs();
      var p = sendWithRetry(action, args, o.requestId || newRequestId(), sentAs).then(function (res) { return checkViewAs(res, sentAs); });
      if (o.raw) return p;
      // keep … その code だけは共通の扱い（画面を移る）をせず、答えをそのまま返す（タスクの列の FORBIDDEN。計画 stage2-task-speed-plan.md 3-6）
      return p.then(function (res) { return !res.ok && Array.isArray(o.keep) && o.keep.indexOf(res.code) >= 0 ? res : common(res); });
    },
    /** 共通の扱いが画面を移す直前に呼ぶ関数を足す（送り残しの「離れますか」を止めるため。計画 第5章） */
    onLeave: function (fn) { leaveFns.push(fn); },
  };
})();
