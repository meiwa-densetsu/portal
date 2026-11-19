/* 安否確認に答える（safety.get・safety.answer。計画 stage4-board-plan.md 第5章・11-1・13-1・第20章・第24章。Q3）
 * ユーザーの答え（2026-11-18）: 画面で作り込まず、控えがあれば送り、サーバーが断ったら控えを消して知らせる
 * - 大きなボタン 3 つ（無事・けがあり・助けが必要）→ 出社できるか → 一言（任意）→「この内容で送る」。答え直しもできる
 * - 押したらすぐ端末に控え（MP.safetyPending。1 回の送信ごとの鍵）。開いたとき・押したとき・online・30 秒ごとに、
 *   今の社員の確認ごとのいちばん新しい控えを、同じ requestId で送る（前の確認の控えも送り、断られたら消して知らせる。21-2）
 * - 返事で消すのは、その返事の rid の鍵だけ。送る前と返事を扱う前に、ログイン・社員・見ている間でないことを確かめる（13-1）
 * - 基準の版は、同じ確認の返事から大きいほうだけ覚える（21-3）
 * - 「動いている安否確認」の控え（mp.safety.active）は答えの返事では変えない。成功の後は safety.get を読み直して、その答えで決める（21-1）
 * - 控えを書けない・前の控えを消せないときは、その画面の中だけで前の答えを送らない（24-4・24-5）。その場で 1 回だけ送った答えの返事は画面にだけ出す（24-9）
 * - 社員の画面を見ている間は、控えを読まない・送らない（ボタンも出さない）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, $ = ui.$, el = ui.el;
    var C = MP.config.SAFETY || { RESEND_SEC: 30 };
    var me = null, check = null, box = null;
    var options = { statuses: ['無事', 'けがあり', '助けが必要'], canWork: ['できる', 'できない', '分からない'], noteMax: 100 };
    var choice = { status: '', canWork: '' };
    var known = {};      // 確認ID → サーバーで知った自分の行の recordVersion（大きいほうだけ）
    var shown = null;    // 今の確認で、サーバーで知った自分の答え（表示用）
    var inflight = {};   // このタブで送っている rid
    var blocked = {};    // この画面では送らない rid（消せなかった前の控え。24-4・24-5）
    var notes = {};      // 確認ID → { text, kind }（その確認の最後の知らせ）
    var latestRid = {};  // 確認ID → この画面で最後に押して送った答えの rid（控えに書けたかに関係なく。表示はこの rid の返事だけで決める）
    var timer = null, ended = false;
    var leftNote = ''; // 前の控えを消せなかったときの知らせ（その画面の間ずっと出す。24-6）
    var heardAns = {};  // 確認ID → サーバーで知った自分の答え { v（recordVersion）, status, canWork, note, full }（版の大きいほうだけ。書きかけかを決める相手）
    var seenAns = {};   // 確認ID → 最後に画面に出した答え（開いたときの答え・自分で送って届いた答え・合わせた答え）。入力がこれと同じなら「変えていない」
    var apiLeaving = false; // 共通の扱いが画面を移している途中（離れる確認を出さない。タスクの画面と同じ）
    // 一言は端末の控えに残さない（セキュリティ監査 Low-1・2026-11-19 ユーザー決定）。この画面を開いている間だけメモリで持ち、
    // 自動の送り直しにも付ける。画面を閉じたら消える（開き直した後に控えから送るときは一言なし）
    var noteMem = {}; // rid → 押したときの一言（メモリだけ）

    function areaFor() {
      try { return MP.store.tokenShared() ? window.sessionStorage : window.localStorage; } catch (e) { return null; }
    }
    function timeText(ms) {
      if (typeof ms !== 'number') return '';
      var d = new Date(ms + 9 * 3600000);
      return d.getUTCHours() + ':' + ('0' + d.getUTCMinutes()).slice(-2);
    }
    function learn(checkId, v) { if (typeof v === 'number' && (!(checkId in known) || v > known[checkId])) known[checkId] = v; }

    function buttons() {
      var sb = ui.clear($('status-buttons'));
      options.statuses.forEach(function (s) {
        sb.appendChild(el('button', { type: 'button', class: 'btn' + (s === '助けが必要' ? ' help' : ''), 'data-value': s, 'aria-pressed': choice.status === s ? 'true' : 'false', text: s,
          on: { click: function () { choice.status = s; buttons(); catchUp(); } } }));
      });
      var wb = ui.clear($('work-buttons'));
      options.canWork.forEach(function (s) {
        wb.appendChild(el('button', { type: 'button', class: 'btn', 'data-value': s, 'aria-pressed': choice.canWork === s ? 'true' : 'false', text: s,
          on: { click: function () { choice.canWork = s; buttons(); catchUp(); } } }));
      });
    }

    /** 今の確認の、いちばん新しい控え（無ければ null） */
    function pendingOf(checkId) {
      if (!box) return null;
      return box.newest().filter(function (x) { return x.checkId === checkId; })[0] || null;
    }

    function render() {
      // 前の確認（今の確認でないもの）の知らせ
      var old = ui.clear($('old-notes'));
      if (leftNote) old.appendChild(el('p', { class: 'msg warn', id: 'left-note', text: leftNote }));
      Object.keys(notes).forEach(function (cid) {
        if (check && cid === check.checkId) return;
        old.appendChild(el('p', { class: 'msg ' + (notes[cid].kind === 'ok' ? 'ok' : 'warn'), text: notes[cid].text }));
      });
      if (!check) return;
      var p = $('send-state');
      var cur = pendingOf(check.checkId);
      var n = notes[check.checkId];
      var text = '', kind = '';
      if (cur && !blocked[cur.rid]) {
        if (inflight[cur.rid]) { text = '送っています…（' + cur.answer.status + '）'; kind = 'wait'; }
        else {
          // 一言は控えに残さないので、自動で送り直すときは付かない（その場の 1 回目で届かなかった一言は届いていない）
          var lost = !cur.hadNote ? '' : Object.prototype.hasOwnProperty.call(noteMem, cur.rid)
            ? '。一言は、この画面を開いている間だけ一緒に送ります（閉じると一言は届きません）'
            : '。一言は届きません（画面を閉じたため。届いた後に、必要なら書き直して送ってください）';
          text = (n && n.kind === 'wait' ? n.text : 'まだ届いていません。電波が戻ったら自動で送ります') + '（' + cur.answer.status + '）' + lost;
          kind = 'wait';
        }
      } else if (n) { text = n.text; kind = n.kind; }
      else if (shown && shown.status) {
        text = '届いている答え: ' + shown.status + '・出社 ' + shown.canWork + (shown.acceptedAt ? '（' + timeText(shown.acceptedAt) + '）' : '') + (shown.proxy ? '・' + shown.enteredByName + 'さんが入れました' : '');
        kind = 'ok';
      }
      p.textContent = text;
      p.className = 'send-state' + (kind ? ' ' + kind : '');
    }

    function noteText() { return $('note').value.replace(/^[\s　]+|[\s　]+$/g, ''); }
    /** サーバーで知った自分の答えを覚える（届いた答え・ぶつかった相手の答え・読み直した答え。版の大きいほうだけ） */
    function heard(checkId, a) { keep(heardAns, checkId, a); }
    /** 答えを覚える（版の大きいほうだけ） */
    function keep(map, checkId, a) {
      if (!a) return;
      var v = typeof a.recordVersion === 'number' ? a.recordVersion : 0;
      if (map[checkId] && v < map[checkId].v) return;
      map[checkId] = { v: v, status: a.status || '', canWork: a.canWork || '', note: a.note || '', full: a };
    }
    /** 今の選び・一言が、その答えと同じか（答えが無ければ、何も選んでいないのと同じか） */
    function sameAs(a) {
      a = a || {};
      return choice.status === (a.status || '') && choice.canWork === (a.canWork || '') && noteText() === (a.note || '');
    }
    /**
     * 読み直し・ぶつかった返事で、最後に画面に出した答えより新しい答えを知っていて、入力が画面に出した答えのまま（変えていない・変えて戻した）なら、
     * 新しい答えを画面に出す（表示・入力・次に送るときの版）。送る控えがあるときは、控えの答えを出しているので何もしない
     */
    function catchUp() {
      if (!check || ended) return;
      var cur = pendingOf(check.checkId);
      if (cur && !blocked[cur.rid]) return;
      var h = heardAns[check.checkId], sn = seenAns[check.checkId];
      if (h && h.full && h.status && (!sn || h.v > sn.v) && sameAs(sn)) adopt(check.checkId, h.full);
    }
    /**
     * 送っていない書きかけがあるか。比べる相手は、そのたびに「端末に残っている控え（この画面で送らないと決めたものは除く）」、
     * 無ければ「サーバーに届いている答え」から求める（閉じても残る答えと、今の選び・一言が違えば書きかけ）
     * 同じログインの別のタブが控えを送って消した場合、このタブは返事を知らないので書きかけと出ることがある（余計に止めるだけ）。
     * タブどうしの食い違いは、分かっている限界として受け入れる（2026-11-18 ユーザー決定）
     */
    function unsent() {
      if (!check || ended) return false;
      var cur = pendingOf(check.checkId);
      var pend = cur && !blocked[cur.rid];
      var base = pend ? cur.answer : heardAns[check.checkId];
      base = base || {};
      // 控えには一言が無い: この画面で押した控えなら押したときの一言、開き直した後の控えなら空と比べる
      var note = pend ? (noteMem[cur.rid] || '') : (base.note || '');
      return choice.status !== (base.status || '') || choice.canWork !== (base.canWork || '') || noteText() !== note;
    }

    function stopInput() {
      ended = true;
      $('send').hidden = true;
      ['status-buttons', 'work-buttons'].forEach(function (id) { $(id).hidden = true; });
      $('note').disabled = true;
    }

    /** 送ってよいか（13-1: 今のログインの社員が同じ・見ている間でない） */
    function sameMe() {
      var now = MP.store.me();
      return !!me && !!now && now.employeeId === me.employeeId && !MP.guard.viewing();
    }

    /** 返事を扱ってよいか（13-1: 送ったときと同じログイン・同じ社員・見ている間でない） */
    function sameLogin(r, sentId) {
      var now = MP.store.me();
      return r.sentMark === MP.store.tokenMark() && !!now && now.employeeId === sentId && !MP.guard.viewing();
    }

    function argsOf(item) {
      // 一言は、この画面で押した答えだけ（メモリ）。開き直した後に控えから送るときは空
      var note = Object.prototype.hasOwnProperty.call(noteMem, item.rid) ? noteMem[item.rid] : '';
      return { checkId: item.checkId, status: item.answer.status, canWork: item.answer.canWork, note: note, baseVersion: item.base, replaces: item.replaces, pressedAt: item.pressedAt };
    }

    /** 返事から版だけを覚える（同じログイン・社員・確認の返事なら、最後に押した答えの返事でなくても覚える。21-3） */
    function learnFrom(item, r) {
      if (r.ok && r.data && r.data.saved && r.data.answer) { heard(item.checkId, r.data.answer); keep(seenAns, item.checkId, r.data.answer); }
      if (r.ok && r.data && r.data.saved === false && r.data.conflict) heard(item.checkId, r.data.conflict);
      if (r.ok && r.data && r.data.saved && r.data.answer) learn(item.checkId, r.data.answer.recordVersion);
      if (r.ok && r.data && r.data.saved === false && r.data.conflict) learn(item.checkId, r.data.conflict.recordVersion);
    }

    /** 返事 → { text, kind, drop }（drop … その鍵を消すか） */
    function judge(item, r) {
      if (r.ok && r.data && r.data.saved) {
        if (check && item.checkId === check.checkId && (!latestRid[item.checkId] || latestRid[item.checkId] === item.rid)) shown = r.data.answer;
        // 一言があった答えなのに、届いた答えの一言が違う（開き直した後に一言なしで送った等）なら、そう知らせる（Codex 納品前 2 回目 low）
        var want = Object.prototype.hasOwnProperty.call(noteMem, item.rid) ? noteMem[item.rid] : null;
        var got = r.data.answer.note || '';
        var lost = want !== null ? (want !== '' && got !== want) : (!!item.hadNote && !got);
        return { text: '届きました ' + timeText(r.data.answer.acceptedAt) + (lost ? '（一言は届いていません。必要なら書き直して送ってください）' : ''), kind: lost ? 'wait' : 'ok', drop: true, ok: true };
      }
      if (r.ok && r.data && r.data.saved === false) {
        var c = r.data.conflict || {};
        var who = c.proxy ? c.enteredByName + 'さんが' : 'ほかの端末で';
        return { text: who + '「' + (c.status || '（なし）') + '」と入れています' + (c.acceptedAt ? '（' + timeText(c.acceptedAt) + '）' : '') + '。直すときは、もう一度押してください', kind: 'bad', drop: true };
      }
      if (r.code === 'SAFETY_ENDED' || r.code === 'NOT_FOUND') {
        var title = item.title ? '「' + item.title + '」' : '';
        return { text: '安否確認' + title + 'は終わっています。答え（' + item.answer.status + '）は届いていません。電話か LINE で知らせてください', kind: 'bad', drop: true, ended: true };
      }
      if (r.code === 'INVALID' || r.code === 'BAD_REQUEST' || r.code === 'FORBIDDEN') return { text: r.message + '。もう一度押してください', kind: 'bad', drop: true };
      if (r.code === 'UNAUTHORIZED') return { text: 'ログインが切れています。ログインし直すと送ります', kind: 'wait', drop: false };
      if (r.code === 'RELOAD') return { text: '画面が古くなっています。しばらくしてから開き直してください', kind: 'wait', drop: false, reload: true };
      return { text: 'まだ届いていません。電波が戻ったら自動で送ります', kind: 'wait', drop: false };
    }

    /** 返事を当てる。oneShotReply … その場で 1 回だけ送った答えの返事（保存領域に触らない・読み直しも読み込み直しもしない。24-9） */
    function apply(item, j, oneShotReply) {
      // 表示（知らせ）は、その確認で最後に押した答えの返事だけで決める（前に押した答えの遅れた返事で上書きしない）。
      // 開いたときに控えから送るもの（この画面で押していない確認）は、その返事で決める
      if (!latestRid[item.checkId] || latestRid[item.checkId] === item.rid) notes[item.checkId] = { text: j.text, kind: j.kind };
      // その rid の鍵だけを消す。消せなかったら、この画面からは送らない（届いた答え・断られた答えを送り続けない）
      if (j.drop && !oneShotReply && !box.remove(item.checkId, item.rid)) blocked[item.rid] = true;
      if (j.ended && check && item.checkId === check.checkId) stopInput();
      if (oneShotReply) return;
      if (j.reload && MP.store.reloaded() !== window.location.pathname) { MP.store.setReloaded(window.location.pathname); window.location.reload(); }
      if (j.ok || j.ended) reread();
    }

    function send(item) {
      if (inflight[item.rid] || blocked[item.rid] || !sameMe()) return;
      inflight[item.rid] = true;
      var sentId = me.employeeId;
      render();
      MP.api.call('safety.answer', argsOf(item), { raw: true, requestId: item.rid, noViewAs: true, leaveOnUnauthorized: true }).then(function (r) {
        delete inflight[item.rid];
        if (!sameLogin(r, sentId)) return; // 13-1: 違えば控えにも画面にも何もしない
        learnFrom(item, r);
        apply(item, judge(item, r), false);
        render();
      });
    }

    /** 控えを送る（今の社員の、確認ごとのいちばん新しい控え） */
    function sendAll() {
      if (!box || !sameMe()) return;
      box.newest().forEach(function (item) { if (!blocked[item.rid]) send(item); });
    }

    /** 成功・終わった の後に、サーバーの今の様子を読み直す（「動いている安否確認」の控えは読み取りの答えからだけ書く。21-1） */
    function reread() {
      MP.api.call('safety.get', {}, { raw: true, leaveOnUnauthorized: true }).then(function (r) {
        if (!r.ok || !sameLogin(r, me.employeeId)) return;
        var d = r.data;
        if (d.check && d.answer) {
          heard(d.check.checkId, d.answer);
          // 別の端末・代わりの入力で新しい答えになっていた: 入力を変えていなければ、表示・入力・次に送るときの版を新しい答えに合わせる。
          // 入力を変えている途中なら、入力も版も変えない（送ったときに、今の競合の扱いどおり「ほかの端末で〜と入れています」と知らせる。
          // 途中で、画面に出していた答えに入力を戻したら、そのときに合わせる）
          if (check && d.check.checkId === check.checkId) catchUp();
        }
        MP.store.setSafetyActive(me.employeeId, d.check && d.check.active ? { active: true, checkId: d.check.checkId, title: d.check.title, training: d.check.training,
          answered: !!(d.answer && d.answer.status) } : { active: false }, r.sentMark);
        if (d.check && d.check.active && (!check || d.check.checkId !== check.checkId)) switchTo(d.check, d.answer); // 読み直した新しい確認を、今の画面にも出す（21-1・24-17）
      });
    }

    /** 読み直しで知った新しい答えを、入力・表示・次に送るときの版に合わせる（入力を変えていないときだけ呼ぶ） */
    function adopt(checkId, a) {
      learn(checkId, a.recordVersion);
      keep(seenAns, checkId, a);
      shown = a;
      choice.status = a.status;
      choice.canWork = a.canWork;
      $('note').value = a.note || '';
      delete notes[checkId]; // 前の「届きました」より、今届いている答えを出す
      buttons();
      render();
    }

    /** 今の画面の確認が終わって新しい確認が動いている → 新しい確認の入力に切り替える。前の確認には「終わっています。新しい確認に答えてください」 */
    function switchTo(c, answer) {
      if (check && ended) {
        notes[check.checkId] = { text: '安否確認' + (check.title ? '「' + check.title + '」' : '') + 'は終わっています（答えは届いていません）。新しい安否確認' + (c.title ? '「' + c.title + '」' : '') + 'に答えてください', kind: 'bad' };
      }
      ended = false;
      shown = null;
      choice = { status: '', canWork: '' };
      $('send').hidden = false;
      ['status-buttons', 'work-buttons'].forEach(function (id) { $(id).hidden = false; });
      $('note').disabled = false;
      $('note').value = '';
      $('no-check').hidden = true;
      startCheck(c, answer);
      render();
    }

    function startCheck(c, answer) {
      check = c;
      $('check').hidden = false;
      $('check-title').textContent = (c.training ? '【訓練】' : '') + c.title;
      if (answer) { learn(c.checkId, answer.recordVersion || 0); if (answer.status) { shown = answer; choice.status = answer.status; choice.canWork = answer.canWork; $('note').value = answer.note || ''; } }
      var cur = pendingOf(c.checkId);
      if (cur) { choice.status = cur.answer.status; choice.canWork = cur.answer.canWork; $('note').value = cur.answer.note || ''; }
      if (answer) { heard(c.checkId, answer); keep(seenAns, c.checkId, answer); }
      buttons();
    }

    $('send').addEventListener('click', function () {
      if (!box || !check || ended || !sameMe()) return;
      if (!choice.status) { ui.pageMessage('今の状態を選んでください', 'error'); return; }
      if (!choice.canWork) { ui.pageMessage('出社できるかを選んでください', 'error'); return; }
      var text = $('note').value.replace(/^[\s　]+|[\s　]+$/g, '');
      if (/[\r\n]/.test(text) || text.length > options.noteMax) { ui.pageMessage('一言は ' + options.noteMax + ' 字までです', 'error'); return; }
      ui.pageMessage('');
      var base = check.checkId in known ? known[check.checkId] : 0;
      var res = box.press(check, { status: choice.status, canWork: choice.canWork, note: text }, base);
      latestRid[check.checkId] = res.item.rid;
      noteMem[res.item.rid] = text;
      res.left.forEach(function (rid) { blocked[rid] = true; }); // 消せなかった前の控えは、この画面からは送らない
      if (res.stuck) blocked[res.stuck] = true; // 書けたか分からない新しい鍵も、この画面からは送らない（その場の 1 回だけ）
      var prev = res.leftStatus && res.leftStatus.filter(Boolean).length ? '（' + res.leftStatus.filter(Boolean).join('・') + '）' : '';
      if (res.wrote) {
        if (res.left.length) leftNote = '前の答え' + prev + 'を端末から消せませんでした。この画面からは送りませんが、開き直すと前の答えが送られることがあります。違うときは電話か LINE で知らせてください';
        delete notes[check.checkId];
        render();
        sendAll();
        return;
      }
      // 控えを書けなかった
      if (res.left.length) { // 前の控えも消せなかった: 送らない
        notes[check.checkId] = { text: 'この端末では答えを控えられませんでした。電話か LINE で今の様子を知らせてください。（ほかの画面・開き直した画面からは、前の答え' + prev + 'が自動で送られることがあります）', kind: 'bad' };
        render();
        return;
      }
      // その場で 1 回だけ送る（鍵が無いので、返事は画面にだけ出す。24-9）
      var item = res.item;
      var sentId = me.employeeId;
      notes[check.checkId] = { text: '送っています…（この端末には控えられませんでした）', kind: 'wait' };
      render();
      MP.api.call('safety.answer', argsOf(item), { raw: true, requestId: item.rid, noViewAs: true, leaveOnUnauthorized: true }).then(function (r) {
        // 送ったときのログイン・社員と同じで、その確認でいちばん新しく 1 回だけ送った答えの返事のときだけ、画面に出す（24-9）
        if (!sameLogin(r, sentId)) return;
        learnFrom(item, r); // 版は、古い 1 回だけの送信の返事からも覚える
        if (latestRid[item.checkId] !== item.rid) return; // 表示は最後に押した答えの返事だけ
        var j = judge(item, r);
        if (!j.drop) j = { text: 'この端末に控えられませんでした。届いていません。電話か LINE で知らせてください', kind: 'bad' };
        apply(item, j, true);
        render();
      });
    });
    window.addEventListener('online', sendAll);
    $('note').addEventListener('input', catchUp);
    // 書きかけ（選んだ・書いたが「この内容で送る」を押していない）のまま閉じようとしたら止める（日報の画面と同じ）。
    // ログインが変わって開き直すときは boot.js が止めない
    MP.api.onLeave(function () { apiLeaving = true; });
    window.addEventListener('beforeunload', function (ev) { if (!apiLeaving && unsent()) { ev.preventDefault(); ev.returnValue = ''; } });

    function ready(c, answer) {
      var area = areaFor();
      MP.safetyPending.gc(area);
      box = MP.safetyPending.open(area, me.employeeId);
      if (c) startCheck(c, answer);
      render();
      sendAll();
      if (!timer && MP.boot.onClose) MP.boot.onClose(function () { if (timer) { window.clearInterval(timer); timer = null; } }); // 閉じたらすぐ止める
      if (!timer) timer = window.setInterval(function () {
        if (MP.boot.closed && MP.boot.closed()) { window.clearInterval(timer); timer = null; return; } // ログインが変わって閉じたら止める
        sendAll(); render();
      }, (C.RESEND_SEC || 30) * 1000);
    }

    return MP.guard.enter({ load: { action: 'safety.get' }, retryable: true }).then(function (entered) {
      $('safety').hidden = false;
      if (entered.me) {
        me = entered.me;
        var d = entered.res.data;
        if (d.options) options = d.options;
        if (!me.viewAs) MP.store.setSafetyActive(me.employeeId, d.check && d.check.active ? { active: true, checkId: d.check.checkId, title: d.check.title, training: d.check.training,
          answered: !!(d.answer && d.answer.status) } : { active: false }, entered.res.sentMark);
        if (me.viewAs) { // 見ている間: 答えを見せるだけ（控えを読まない・送らない）
          if (!d.check || !d.check.active) { $('no-check').hidden = false; return; }
          $('check').hidden = false;
          $('check-title').textContent = (d.check.training ? '【訓練】' : '') + d.check.title;
          stopInput();
          $('send-state').textContent = d.answer && d.answer.status ? '答え: ' + d.answer.status + '・出社 ' + d.answer.canWork : 'まだ答えていません';
          return;
        }
        if (!d.check || !d.check.active) $('no-check').hidden = false;
        ready(d.check && d.check.active ? d.check : null, d.answer); // 動いている確認が無くても、前の確認の控えは送って片付ける（21-2）
        return;
      }
      // 電波が無い: 本人のログインのときに控えた「動いている安否確認」があれば、ボタンを出して控えられる（確認ID が分からないまま送らない）
      me = MP.store.me();
      $('offline-note').hidden = false;
      if (!me) return;
      var a = MP.store.safetyActive(me.employeeId);
      ready(a ? { checkId: a.checkId, title: a.title, training: a.training, active: true } : null, null);
    });
  });
})();
