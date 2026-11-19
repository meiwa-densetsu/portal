/*
 * GAS の呼び出し（計画 stage1-step2b-3-plan.md 2-3）
 *
 *   MP.api.call(action, args, opts) → Promise<{ ok: true, data } | { ok: false, code, message }>
 *     opts.requestId … 送り直すときに同じものを使う保存（社員マスタ）で渡す。無ければ毎回新しく作る
 *     opts.raw       … 共通の扱い（下の表）をせず、結果をそのまま返す（ログアウト用）
 *     opts.leaveOnUnauthorized … raw でも、UNAUTHORIZED のときだけは、ログインの記憶を消し・本文を消し・ログインの画面へ移す（安否の送信・読み直し。計画 stage4-board-plan.md 24-15）
 *     opts.keep      … ['FORBIDDEN'] など。その code だけ共通の扱いをせず返す（タスクの列。ほかの code は今どおり）
 *   答えに serverMs（サーバーの中の処理時間・ミリ秒）があれば res.serverMs に入れる。serverPhases（区切りごとの時間）は決まった鍵だけ res.serverPhases に
 *   res.sentMark … 送ったときのログインの目印（MP.store.tokenMark()）。控えを書く前に、今のログインと同じかを確かめるため
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
  // 区切りごとの時間の鍵（計画 stage2-task-open-speed-plan.md 2-3）。これ以外は捨てる
  var PHASE_KEYS = ['names', 'read', 'parse', 'auth', 'fallback', 'check', 'maintain', 'view', 'me', 'other', 'rows',
    // サーバーの中の細かい内訳（計画 stage2-task-open-measure-plan.md 第1・2章。どれも上の区間の内数。ミリ秒、または回数）
    'touch', 'lockWait', 'lockBody', 'flush', 'epoch', 'open', 'single', 'singleN', 'exists', 'dropLock', 'dropEpoch'];
  // 名前 → 数の入れ物（rowsBy … 表ごとの行の数・singleBy … 表ごとの 1 枚ずつ読んだ回数。どちらも管理者の答えにだけある）
  var BY_KEYS = ['rowsBy', 'singleBy'];
  var ROWS_NAME = /^[぀-ヿ一-鿿（）]{1,20}$/; // 表の種類の名前（かな・漢字・全角のかっこだけ。サーバーが決まった名前に替えたもの）
  function okInt(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v && v <= SERVER_MS_MAX * 100; }
  /** 名前 → 数の入れ物から、名前の形が正しく値が整数のものだけ（30 個まで）。何も無ければ null */
  function cleanBy(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    var by = {}, n = 0;
    Object.keys(o).forEach(function (k) { if (n < 30 && ROWS_NAME.test(k) && okInt(o[k])) { by[k] = o[k]; n++; } });
    return n ? by : null;
  }
  /** 答えの serverPhases から、決まった鍵の 0 以上の整数だけを取り出す。rowsBy・singleBy は cleanBy を通したものだけ。何も無ければ null */
  function cleanPhases(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    var out = {}, any = false;
    PHASE_KEYS.forEach(function (k) { if (okInt(p[k])) { out[k] = p[k]; any = true; } });
    BY_KEYS.forEach(function (k) { var by = cleanBy(p[k]); if (by) { out[k] = by; any = true; } });
    return any ? out : null;
  }
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
  // 段階4（計画 stage4-board-plan.md）: 読むだけの処理。board.get は「読んだ」を書くが 1 人 1 行で、何度届いても結果は同じなので入れる
  ['portal.home', 'board.list', 'board.get', 'board.readers', 'board.admin.list', 'links.admin.list', 'form.get', 'form.result', 'form.admin.list',
    'safety.get', 'safety.list'].forEach(function (a) { READ_ONLY[a] = true; });

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
    var phases = cleanPhases(o.serverPhases);
    var withMs = function (r) { if (ms !== null) r.serverMs = ms; if (phases) r.serverPhases = phases; return r; };
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
  function send(action, args, requestId, viewAs, timeoutMs, token) {
    var ctrl = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, timeoutMs);
    var t0 = Date.now();
    // token … 呼んだ側が確かめた token（確かめた後に保存領域を読み直さない。計画 stage4-board-plan.md 22-2）
    var env = { action: action, apiVersion: MP.config.API_VERSION, token: token, requestId: requestId, args: args || {} };
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
        try { Object.defineProperty(out.fail, 'res', { value: out.res }); } catch (e) { /* 付けられなくても続ける */ } // この試しの答え（remember が控えを付ける先）
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
  function remember(action, fails, retried, sentMark) {
    // ログインが変わった後（閉じた画面）の通信の失敗は、保存領域に控えない（計画 stage4-board-plan.md 21-6）
    if (sentMark !== undefined && (MP.store.tokenMark() !== sentMark || (MP.boot && MP.boot.closed && MP.boot.closed()))) return null;
    var rec = {
      at: Date.now(), action: String(action), retried: !!retried,
      tries: fails.map(function (f) {
        return { kind: f.kind, ms: Math.round(f.ms || 0), status: Number(f.status) || 0, host: String(f.host || ''), redirected: !!f.redirected,
          page: PAGE_KIND[f.page] ? f.page : '' };
      }),
    };
    MP.store.addNetLog(rec);
    // 最後の試しの答え（呼んだ側へ返る答え）に、この控えを付ける
    var last = fails[fails.length - 1];
    if (last && last.res) withRecord(last.res, rec);
    return rec;
  }

  /** 答えに、その失敗の「詳しく」の控えを付ける（画面には出ない項目。report.js が決まった値だけを写す。計画 stage2-error-report-plan.md 第8章） */
  function withRecord(res, rec) {
    if (res && typeof res === 'object') { try { Object.defineProperty(res, 'netRecord', { value: rec, configurable: true, writable: true }); } catch (e) { /* 付けられなくても続ける */ } }
    return res;
  }

  /**
   * 送る。読むだけの処理は、決まった失敗のときだけ、少し待って同じ requestId で 1 回だけ送り直す。
   * 待つ長さは、最初の送信からの全体で 60 秒（送り直しは残りだけ待つ。残りが RETRY_MIN_LEFT_MS より少なければ送り直さない）
   */
  function sendWithRetry(action, args, requestId, viewAs, sentMark, token) {
    var deadline = Date.now() + TIMEOUT_MS;
    return send(action, args, requestId, viewAs, TIMEOUT_MS, token).then(function (first) {
      if (!first.fail) return first.res;
      if (!retryable(action, first.fail) || deadline - Date.now() - RETRY_WAIT_MS < RETRY_MIN_LEFT_MS) {
        remember(action, [first.fail], false, sentMark);
        return first.res;
      }
      return new Promise(function (resolve) { setTimeout(resolve, RETRY_WAIT_MS); }).then(function () {
        // 待つ間にほかのタブでログインが替わったら送り直さない（新しいログインの答えに、古いログインの目印が付くのを防ぐ。版 19 の内部レビュー low）
        if (MP.store.tokenMark() !== sentMark) return null;
        if (MP.boot && MP.boot.loginOk && !MP.boot.loginOk()) return { closed: true }; // ログインが変わって閉じた画面からは送り直さない（計画 stage4-board-plan.md 22-2）
        if (halted(action)) { dropped[action] = (dropped[action] || 0) + 1; return { closed: true }; } // 日報の 4 画面が「読み込み直す」だけになった後は送り直さない（1 回目の返事は渡さなかった数に入れる）
        return send(action, args, requestId, viewAs, Math.max(0, deadline - Date.now()), token); // 1 回目と同じ、確かめた token で送る
      }).then(function (second) {
        if (second && second.closed) return never();
        if (!second) { remember(action, [first.fail], false, sentMark); return first.res; }
        if (second.fail) remember(action, [first.fail, second.fail], true, sentMark);
        return second.res;
      });
    });
  }

  var never = function () { return new Promise(function () {}); };
  /** 日報の 4 画面が「読み込み直す」だけになった後か（MP.ui.stopped。ほかの画面では常に false） */
  // 管理者に知らせる送信（system.report）だけは止めない（最初の表示の問題の知らせのボタンは、壊れた後も押せるため）
  var halted = function (action) { return action !== 'system.report' && !!(MP.ui && MP.ui.stopped && MP.ui.stopped()); };
  var dropped = {}; // 止めた後に届いて、渡さなかった返事の数（処理の名前ごと。試験で、その返事が届いたことを確かめるため）

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

  /*
   * 管理者に知らせる（計画 stage2-error-report-plan.md 2-1・2-3）のための控え。
   *   meSeen … このページで成功した答えの me の社員ID（見ている間の答えは覚えない）。押した人を決めるのに使う（認証・認可には使わない）
   *   失敗 … ボタンを出すエラーなら report.js の「最近の失敗」に足す（system.report そのもの・raw の RELOAD は足さない）
   */
  var meSeen = null; // { id, mark, temp }
  function track(action, res, raw) {
    if (!res || typeof res !== 'object') return res;
    if (res.ok) {
      var me = res.me;
      if (me && typeof me === 'object' && !me.viewAs && typeof me.employeeId === 'string' && /^E\d{4}$/.test(me.employeeId) &&
        res.sentMark && res.sentMark === MP.store.tokenMark()) {
        meSeen = { id: me.employeeId, mark: res.sentMark, temp: me.mustChangePassword === true };
      }
      return res;
    }
    if (action === 'system.report' || (raw && res.code === 'RELOAD')) return res;
    if (MP.report && MP.report.noteFailure) { try { MP.report.noteFailure(action, res); } catch (e) { /* 知らせの準備の失敗で画面を止めない */ } }
    return res;
  }
  /** このページで覚えた自分の社員ID（今のログインのものだけ）。temp … 仮パスワードのまま */
  function seenMe() {
    return meSeen && meSeen.mark === MP.store.tokenMark() ? { id: meSeen.id, temp: meSeen.temp } : null;
  }

  var leaveFns = []; // 共通の扱いが画面を移す直前に呼ぶ関数（MP.api.onLeave）
  function leaving() { leaveFns.forEach(function (fn) { try { fn(); } catch (e) { /* 移るのを止めない */ } }); }

  /** ログインが切れた: ①ログインの記憶を消す ②移る前に本文を消す ③ログインの画面へ移す（24-14・24-15。共通の扱いと leaveOnUnauthorized の raw の 1 か所） */
  function loginExpired() {
    // 共有のログインの安否の控えは、ログインが切れても消す（21-5。次に使う人が前の人の答えを送らない）。消える答えがあれば知らせる（24-15）
    var lost = MP.store.sharedSafetyPending ? MP.store.sharedSafetyPending() : 0;
    MP.store.clearToken();
    if (MP.boot && MP.boot.clearForLogout) MP.boot.clearForLogout();
    MP.store.setFlash(lost ? 'もう一度ログインしてください。送れなかった安否確認の答えがありました。ログインした後に、もう一度答えてください' : 'もう一度ログインしてください');
    leaving();
    MP.go('login.html');
    return never();
  }

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
        return loginExpired();
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
        if (!res.ok && res.failure) res.failure.message = res.message; // 管理者に知らせる「最近の失敗」も、画面に出す文に合わせる
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
    seenMe: seenMe,
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
      // sentMark … 送ったときのログインの目印（認証・認可には使わない）。控えを書くときに、今のログインと同じかを確かめる（計画 stage2-task-open-speed-plan.md 1-2）
      // token は 1 回だけ読み、その token で確かめて、その token を送る（確かめと送るの間に読み直さない。計画 stage4-board-plan.md 22-2）
      var token = MP.store.token();
      var sentMark = MP.store.markOf(token);
      // ログインが変わって閉じた画面（または閉じるべき画面）からは送らない。返事も、扱う最初に確かめる（raw も。計画 stage4-board-plan.md 21-6・22-2）
      var watched = !!(MP.boot && MP.boot.loginOk);
      if (watched && !MP.boot.loginOk(sentMark)) return never();
      // 日報の 4 画面が「読み込み直す」だけになった後は送らない。届いた返事も渡さない（後の処理を起こさない。解決も拒否もしない）
      if (halted(action)) return never();
      var p = sendWithRetry(action, args, o.requestId || newRequestId(), sentAs, sentMark, token).then(function (res) {
        if (halted(action)) { dropped[action] = (dropped[action] || 0) + 1; return never(); }
        if (watched && !MP.boot.loginOk()) return never();
        return checkViewAs(res, sentAs);
      })
        .then(function (res) { if (res && typeof res === 'object') res.sentMark = sentMark; return res; });
      if (o.raw) return p.then(function (res) {
        // 送ったときと同じログインのまま UNAUTHORIZED（ログインが切れた）なら、共通の扱いと同じく移る（安否の送り直しを繰り返さない。24-15）
        if (o.leaveOnUnauthorized && token && res && res.code === 'UNAUTHORIZED' && sentMark === MP.store.tokenMark()) { track(action, res, true); return loginExpired(); }
        return track(action, res, true);
      });
      return p.then(function (res) {
        // 送ってから答えが届くまでに、ほかのタブでログインが替わった（ログインし直し・ログアウト）→ その答えは前のログインのもの。
        // 画面に出さず、共通の扱い（UNAUTHORIZED で今のログインを消すなど）もせず、今のログインで開き直す（版 19 の Codex 実装レビュー 1 回目 high・medium）
        if (sentMark !== MP.store.tokenMark()) { leaving(); window.location.reload(); return never(); }
        // keep … その code だけは共通の扱い（画面を移る）をせず、答えをそのまま返す（タスクの列の FORBIDDEN。計画 stage2-task-speed-plan.md 3-6）
        return !res.ok && Array.isArray(o.keep) && o.keep.indexOf(res.code) >= 0 ? res : common(res);
      }).then(function (res) { return track(action, res, false); });
    },
    /** 共通の扱いが画面を移す直前に呼ぶ関数を足す（送り残しの「離れますか」を止めるため。計画 第5章） */
    onLeave: function (fn) { leaveFns.push(fn); },
    /** 「読み込み直す」だけになった後に届いて、渡さなかった返事の数（action を渡すとその処理だけ。渡さないと全部） */
    droppedCount: function (action) {
      if (action) return dropped[action] || 0;
      return Object.keys(dropped).reduce(function (n, k) { return n + dropped[k]; }, 0);
    },
  };
})();
