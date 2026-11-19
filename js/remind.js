/*
 * リマインダー（計画 docs/plans/stage2-tasklist-v3-plan.md 3-4）。ログインを通った全画面で動く（guard.js が MP.remind.start(me) を呼ぶ）。
 * 時刻が来たら、画面の上の帯と、ブラウザの通知（許可済みのパソコンだけ）で知らせる。ポータルを開いている間だけ。
 *
 *   元にする一覧 … task.reminders（自分の・未完了の・暦の今日の前後 1 日）。控えは MP.store.remind()（今のログインのものだけ返す）
 *   今の時刻     … 端末の今 ＋ offset（サーバーの今との差）。日本時間への直し方は CalcTask（端末のタイムゾーンは使わない）
 *   知らせ済み   … MP.store.remindDone()（localStorage。内容は入れない）。同じ知らせを、読み込み直し・別のタブで 2 回出さない
 *   出す直前     … task.reminders を 1 回読み直し、まだ対象のものだけ出す。読めない（NETWORK・BUSY）ときは控えのまま出す。
 *                   それ以外の答え（UNAUTHORIZED など）は、控えを消して止める（ログインが切れた・画面が古いときは、止めたことを帯で 1 回知らせる）
 *   裏の読み直しでは、画面の移動・読み込み直し・ログインの記憶の消去をしない（MP.api.call の raw。入力の途中の画面を壊さない）
 *
 *   MP.remind.start(me)   … 始める（見ている間・仮パスワードの間は始めない）
 *   MP.remind.touch()     … タスクを操作した後に呼ぶ。少し待ってから一覧を読み直す
 *   MP.remind.check()     … 今すぐ時刻を確かめる（決まった間隔の確かめと同じ）
 *   MP.remind.permission()… 通知の状態: granted・denied・default・none（この端末では使えない）
 *   MP.remind.ask()       … 通知の許可を聞く（ボタンを押したときにだけ呼ぶ）→ Promise<状態>
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  var MIN = 60000;
  var LOCK_NAME = 'mp.remind';
  var SOFT_WAIT_MS = 60000;   // 一時的に読めなかった後、次に読みに行くまで
  var FRESH_MS = 15000;       // これより新しい答えがあれば、出す直前の確かめで読み直さない
  var BAR_MAX = 3;            // 帯に並べる数（超えたら「ほか ◯ 件」）

  var meId = '';
  var timer = null, touchTimer = null;
  var inflight = null;
  var stopped = true;
  var lastFetch = 0, waitUntil = 0;
  var shown = {};             // このページで帯に出した鍵（保存領域が使えなくても 2 回出さない）
  var handled = {};           // ほかのタブの印で、もう確かめた鍵（控えに無くて出さなかったものも入る）
  var bars = [];              // 帯に出している知らせ [{ key, text }]
  var moreNote = false;
  var stopNote = false;       // 止めたことを、もう帯で知らせた

  function cfg() { return MP.config.REMIND; }
  function CT() { return window.CalcTask; }
  // タスクの今日の切り替わり（6:00）より前の時刻は、次の日の時刻として読む（仕上げの計画 第4章）。
  // 時刻・鍵・今知らせるものは、必ず下の 4 つを通す（切り替わりを渡し忘れると、鍵が食い違って 2 回出る・出ない）
  function startMin() { return MP.config.TASK_DAY_START_MIN; }
  function atOf(it) { return CT().remindAt(it, startMin()); }
  function keyOf(it, kind) { return CT().remindKey(it, kind, startMin()); }
  function dueOf(items, nowMs, done) { return CT().remindDue(items, nowMs, done, cfg().LATE_MAX_MIN, startMin()); }
  function hm(time) { return CT().remindClock(time, startMin()); }

  function stop() {
    stopped = true;
    if (timer) { window.clearInterval(timer); timer = null; }
    if (touchTimer) { window.clearTimeout(touchTimer); touchTimer = null; }
  }

  /** 控え（今のログインのものだけ）。使えなければ止める */
  function cache() {
    if (!MP.store.token()) { stop(); return null; }
    return MP.store.remind(meId);
  }

  /** 一覧を読み直す。返す値: 'ok'・'soft'（一時的に読めない）・'stop'（止めた） */
  function fetch() {
    if (inflight) return inflight;
    if (stopped || !MP.store.token()) return Promise.resolve('stop');
    inflight = MP.api.call('task.reminders', {}, { raw: true, noViewAs: true }).then(function (res) {
      inflight = null;
      if (stopped) return 'stop';
      if (res.ok && res.data && Array.isArray(res.data.items) && typeof res.data.nowMs === 'number') {
        lastFetch = Date.now();
        MP.store.setRemind(meId, { at: lastFetch, offset: res.data.nowMs - lastFetch, items: res.data.items, more: res.data.more === true });
        // 安否確認の印（計画 stage4-board-plan.md 11-5）。古いサーバーの答えには無い（知らない項目は読まない）・読めなければ null（帯は前のまま）
        if (Object.prototype.hasOwnProperty.call(res.data, 'safety') && res.data.safety) safetyUpdate(res.data.safety, res.sentMark);
        return 'ok';
      }
      if (!res.ok && (res.code === 'NETWORK' || res.code === 'BUSY')) { waitUntil = Date.now() + SOFT_WAIT_MS; return 'soft'; }
      // ログインが切れた・見るだけ・画面が古い など: 控えを消して止める（画面は動かさない。次のふつうの操作が今までどおり扱う）。
      // ログインが切れた・画面が古いときだけ、止めたことを帯で 1 回知らせる（開いたままの画面で、知らせが出ないことに気づけるように。仕上げの計画 第3章 C4）
      MP.store.clearRemind();
      stop();
      if (res && res.code === 'UNAUTHORIZED') showStopped('ログインが切れたため、リマインダーを止めました。ログインし直してください');
      else if (res && res.code === 'RELOAD') showStopped('画面が古くなったため、リマインダーを止めました。画面を読み込み直してください');
      return 'stop';
    }, function () { inflight = null; waitUntil = Date.now() + SOFT_WAIT_MS; return 'soft'; });
    return inflight;
  }

  function due(c) {
    return dueOf(c.items, Date.now() + c.offset, Object.assign({}, MP.store.remindDone(), shown));
  }

  /**
   * 日報の 4 画面が「読み込み直す」だけになった後か（MP.ui.stopped）。そのタブでは、リマインダーは何もしない（帯を出さず、共有の「知らせた」印も書かない）。
   * 知らせるのは、ほかのタブか、読み込み直した後に任せる
   */
  function halted() { return !!(MP.ui && MP.ui.stopped && MP.ui.stopped()); }

  /** 印を「読む → 無ければ書く」を、タブ 1 つずつで行う（使えるブラウザだけ）。返す値: 自分が書けた鍵 */
  function claim(keys) {
    var run = function () {
      if (halted()) return []; // 壊れたタブは印を書かない（書く直前にも確かめる）
      var done = MP.store.remindDone();
      var mine = keys.filter(function (k) { return !done[k]; });
      if (mine.length) MP.store.addRemindDone(mine);
      return mine;
    };
    try {
      if (navigator.locks && navigator.locks.request) return navigator.locks.request(LOCK_NAME, run).then(function (v) { return v; }, function () { return run(); });
    } catch (e) { /* 使えないブラウザはそのまま */ }
    return Promise.resolve(run());
  }

  function textOf(f) {
    var it = f.item;
    if (f.kind === CT().REMIND_KIND.EARLY) return '⏰ あと ' + f.left + ' 分（' + hm(it.time) + '）: ' + it.content;
    return '⏰ ' + hm(it.time) + ' のリマインダー' + (f.late >= 1 ? '（過ぎています）' : '') + ': ' + it.content;
  }

  function renderBar() {
    var ui = MP.ui;
    var bar = document.getElementById('remind-bar');
    // 日報の 4 画面が「読み込み直す」だけになった後は出さない（帯のリンク・ボタンを残さない）
    if (ui && ui.stopped && ui.stopped()) { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); return; }
    if (!bars.length && !moreNote) { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); return; }
    if (!bar) {
      // ページの先頭に入れる（上に重ねない。上の帯のログアウトなどを隠さず、内容を下へ押し下げる）
      bar = ui.el('div', { id: 'remind-bar', class: 'remind-bar', role: 'alert' });
      document.body.insertBefore(bar, document.body.firstChild);
    }
    ui.clear(bar);
    bars.slice(0, BAR_MAX).forEach(function (b) {
      bar.appendChild(ui.el('div', { class: 'remind-item' }, [
        ui.el('span', { class: 'remind-text', text: b.text }),
        b.plain ? null : ui.el('a', { class: 'btn', href: 'tasks.html', text: 'タスクリストを開く' }),
        ui.el('button', { type: 'button', class: 'btn', text: '閉じる', on: { click: function () { bars = bars.filter(function (x) { return x !== b; }); renderBar(); } } }),
      ]));
    });
    if (bars.length > BAR_MAX) bar.appendChild(ui.el('p', { class: 'remind-more', text: 'ほか ' + (bars.length - BAR_MAX) + ' 件のリマインダーがあります' }));
    if (moreNote) bar.appendChild(ui.el('p', { class: 'remind-more', text: 'ほかにもリマインダーがあります。タスクリストで確かめてください' }));
  }

  /** 止めたことの知らせ（1 回だけ。タスクリストへのボタンは付けない） */
  function showStopped(text) {
    if (stopNote) return;
    stopNote = true;
    bars.unshift({ key: 'stopped', text: text, plain: true }); // 先頭に（並べる数の限りで隠れないように）
    renderBar();
  }

  function showBar(f) {
    if (shown[f.key]) return;
    shown[f.key] = true;
    bars.push({ key: f.key, text: textOf(f) });
    renderBar();
  }

  /** ブラウザの通知（許可済みのときだけ）。隠す（🔒）のタスクは内容を出さない。作れなくても帯は出ている */
  function notify(f) {
    try {
      if (permission() !== 'granted') return;
      var it = f.item;
      var title = f.kind === CT().REMIND_KIND.EARLY ? 'あと ' + f.left + ' 分: ' + hm(it.time) : 'タスクのリマインダー ' + hm(it.time);
      var n = new window.Notification(title, { body: it.hidden ? '内容はタスクリストで確かめてください' : it.content, tag: f.key });
      n.onclick = function () { try { window.focus(); } catch (e) { /* 前に出せなくてもよい */ } MP.go('tasks.html'); };
    } catch (e) { /* 通知を作れない端末は、帯だけ */ }
  }

  /**
   * 出す直前の確かめをして、出す。onlyKeys があれば、その鍵のものだけを帯に出す（ほかのタブが印を書いたとき。通知は出さない）
   */
  function confirmAndFire(onlyKeys) {
    if (halted()) return Promise.resolve();
    var fresh = Date.now() - lastFetch < FRESH_MS ? Promise.resolve('ok') : fetch();
    return fresh.then(function (how) {
      if (how === 'stop' || stopped || halted()) return;
      var c = cache(); // soft（読めなかった）のときは、前の控えのまま
      if (!c) return;
      if (onlyKeys) {
        // ほかのタブが出した知らせ: 確かめた後の控えにある項目だけ、帯を出す。控えに無かった鍵も「扱った」ことにする（印が変わるたびに読み直さない）
        onlyKeys.forEach(function (k) { handled[k] = true; });
        var now = Date.now() + c.offset;
        c.items.forEach(function (it) {
          var at = atOf(it);
          if (!at) return;
          [CT().REMIND_KIND.EARLY, CT().REMIND_KIND.MAIN].forEach(function (kind) {
            var key = keyOf(it, kind);
            if (onlyKeys.indexOf(key) < 0) return;
            var base = kind === CT().REMIND_KIND.EARLY ? at.early : at.main;
            if (base === null) return;
            showBar({ key: key, kind: kind, item: it, late: Math.max(0, Math.floor((now - base) / MIN)), left: Math.max(0, Math.ceil((at.main - now) / MIN)) });
          });
        });
        return;
      }
      var r = due(c);
      if (r.expire.length) MP.store.addRemindDone(r.expire, true);
      moreNote = c.more === true && r.fire.length > 0 ? true : moreNote;
      if (!r.fire.length) { renderBar(); return; }
      return claim(r.fire.map(function (f) { return f.key; })).then(function (mine) {
        if (stopped || !cache()) return; // 待つ間にログアウトした
        r.fire.forEach(function (f) {
          if (mine.indexOf(f.key) < 0) return; // ほかのタブが先に書いた（帯は storage の出来事で出る）
          showBar(f);
          notify(f);
        });
      });
    });
  }

  function tick() {
    if (stopped || halted()) return; // 壊れたタブは何もしない
    var c = cache();
    if (stopped) return;
    var now = Date.now();
    // 控えが無い・古いときに読み直す。控えを書けない端末でも、読むのは決まった間隔まで（20 秒ごとに呼ばない）
    if ((!c || now - c.at > cfg().REFRESH_MIN * MIN) && now >= waitUntil && (!lastFetch || now - lastFetch > cfg().REFRESH_MIN * MIN)) {
      fetch().then(function (how) { if (how !== 'stop') evaluate(); });
      return;
    }
    evaluate();
  }

  function evaluate() {
    if (stopped || halted()) return; // 壊れたタブは何もしない（出さないことにした印も書かない）
    var c = cache();
    if (!c) return;
    var r = due(c);
    if (r.expire.length) MP.store.addRemindDone(r.expire, true);
    if (r.fire.length) confirmAndFire(null);
  }

  /** ほかのタブが印を書いた: 増えた鍵のうち、まだこのページで出していないものを、確かめてから帯に出す */
  function onStorage(ev) {
    if (halted()) return; // 壊れたタブは何もしない
    if (!stopped && ev.key === 'mp.safety.active') { safetyRender(); return; } // ほかのタブが安否確認の控えを変えた
    if (stopped || ev.key !== MP.store.REMIND_DONE_KEY) return;
    var done = MP.store.remindDone();
    var keys = Object.keys(done).filter(function (k) { return done[k] > 0 && !shown[k] && !handled[k]; }); // 正 = ほかのタブが知らせた（負 = 出さないことにした印は帯にしない）
    if (keys.length) confirmAndFire(keys);
  }

  /*
   * 安否確認の帯（計画 stage4-board-plan.md 第5章・11-5）: 動いている確認にまだ答えていなければ、どの画面でも上に赤い帯を出す。
   * 元にするのは端末の控え mp.safety.active（task.reminders・portal.home・safety.get の答えから、本人のログインのときだけ書く）。安否の画面では出さない
   */
  function safetyRender() {
    var ui = MP.ui;
    var bar = document.getElementById('safety-bar');
    var s = meId ? MP.store.safetyActive(meId) : null;
    var here = /safety\.html$/.test(window.location.pathname);
    var halted = ui && ui.stopped && ui.stopped(); // 日報の 4 画面が「読み込み直す」だけになった後は出さない（読み込み直せば出る）
    if (!s || s.answered || here || stopped || halted) { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); return; }
    if (!bar) {
      bar = ui.el('div', { id: 'safety-bar', class: 'safety-bar', role: 'alert' });
      document.body.insertBefore(bar, document.body.firstChild);
    }
    ui.clear(bar);
    bar.appendChild(ui.el('span', { class: 'safety-bar-text', text: (s.training ? '【訓練】' : '') + '安否確認: 答えてください（' + s.title + '）' }));
    bar.appendChild(ui.el('a', { class: 'btn danger', href: 'safety.html', text: '答える' }));
  }
  function safetyUpdate(safety, sentMark) {
    if (!meId) return;
    MP.store.setSafetyActive(meId, safety, sentMark);
    safetyRender();
  }

  function permission() {
    try { return typeof window.Notification === 'function' ? window.Notification.permission : 'none'; } catch (e) { return 'none'; }
  }

  MP.remind = {
    start: function (me) {
      if (!me || me.viewAs || me.mustChangePassword || MP.store.viewAs() || !CT() || !cfg()) return;
      if (!stopped && meId === me.employeeId) return;
      // 別の人で始め直す・始め直す: 前の繰り返しを止め、前の人の帯・印の覚えを消す
      stop();
      bars = []; shown = {}; handled = {}; moreNote = false; stopNote = false; lastFetch = 0; waitUntil = 0;
      renderBar();
      meId = me.employeeId;
      stopped = false;
      // そのページを開いたときにもう印のある知らせは、ほかのタブの出来事としては扱わない
      Object.keys(MP.store.remindDone()).forEach(function (k) { shown[k] = true; });
      timer = window.setInterval(tick, cfg().CHECK_SEC * 1000);
      window.setTimeout(tick, 0); // 画面の表示を待たせない
      safetyRender(); // 安否確認の帯（端末の控えから。計画 stage4-board-plan.md 11-5）
    },
    /** 安否確認の印を、ほかの答え（portal.home・safety.get）からも受け取る（本人のログインのときだけ控える） */
    safety: function (safety, sentMark) { if (!stopped && safety) safetyUpdate(safety, sentMark); },
    touch: function () {
      if (stopped) return;
      if (touchTimer) window.clearTimeout(touchTimer);
      touchTimer = window.setTimeout(function () {
        touchTimer = null;
        fetch().then(function (how) { if (how !== 'stop') evaluate(); });
      }, cfg().AFTER_OP_SEC * 1000);
    },
    check: function () { tick(); },
    /** 止める（ログインが変わって画面を閉じたとき。計画 stage4-board-plan.md 20-2）。帯も消す */
    stop: function () { stop(); bars = []; moreNote = false; renderBar(); var s = document.getElementById('safety-bar'); if (s && s.parentNode) s.parentNode.removeChild(s); },
    permission: permission,
    ask: function () {
      try {
        if (permission() === 'none') return Promise.resolve('none');
        var p = window.Notification.requestPermission();
        return p && p.then ? p.then(function () { return permission(); }, function () { return permission(); }) : Promise.resolve(permission());
      } catch (e) { return Promise.resolve(permission()); }
    },
  };

  window.addEventListener('storage', onStorage);
  window.addEventListener('pagehide', function () { if (timer) { window.clearInterval(timer); timer = null; } });
  window.addEventListener('pageshow', function (ev) {
    if (ev.persisted && !stopped && !timer) { timer = window.setInterval(tick, cfg().CHECK_SEC * 1000); tick(); }
  });
})();
