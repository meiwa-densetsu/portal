/*
 * 送れていない安否の答えの控え（計画 stage4-board-plan.md 第20章・第22章 22-1・第24章。ユーザーの答え: 画面で作り込まず、サーバーに断らせる）
 *
 *   var box = MP.safetyPending.open(area, employeeId)   … area は保存領域（通常 localStorage・共有のログインは sessionStorage）
 *
 * 鍵は 1 回の送信ごと: mp.safety.p:<社員ID>:<確認ID>:<rid> = { checkId, title, base, replaces, answer: { status, canWork }, pressedAt, savedAt }
 *   - 端末に残すのは送るのに要る最小限だけ。一言（note）は控えに書かない（画面を開いている間だけ画面のメモリで持つ。前の版で控えた一言は
 *     読むときに捨てる。セキュリティ監査 Low-1・2026-11-19 ユーザー決定）。一言があったかの印（hadNote: true）だけを残す
 *     （開き直した後に一言なしで届いたとき、「一言は届いていません」と知らせるため。中身は残さない）
 *   - 押したら新しい鍵を書いてから、同じ社員・同じ確認の古い鍵を消す（上書きしない）
 *   - 送るのは、同じ社員・同じ確認の鍵のうち いちばん新しいもの（savedAt、同じなら rid の大きいほう）だけ
 *   - 返事で消すのは、その返事の rid の鍵だけ（→ 新しい確認・新しい答えの鍵を、古い返事で消したり書き換えたりしない）
 *   - 済みの印・CONFLICT の鍵・メモリの控えは作らない（第20章。まれなタブの取り合いは 24-1 で許す）
 *
 *   box.newest()                         … 確認ごとのいちばん新しい鍵の一覧（[item]）
 *   box.press(check, answer, base)       … 押した → { item, wrote, left, leftStatus, stuck }（item.answer も状態・出社できるかだけ。一言は画面が持つ /
 *                                          wrote … 新しい鍵を書けたか / left … 消せなかった古い鍵の rid /
 *                                          leftStatus … その答えの状態 / stuck … 書けなかったのに鍵が残っているかもしれない新しい鍵の rid〔その画面では送らない〕）
 *   box.remove(checkId, rid)             … その鍵だけを消す
 *   MP.safetyPending.gc(area)            … 3 日より古い鍵を捨て、鍵を持つ社員を 5 人までにする（いちばん古い社員の鍵から）
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  var P = 'mp.safety.p:';

  function cfg() { return (MP.config && MP.config.SAFETY) || { KEEP_DAYS: 3, PEOPLE_MAX: 5, REPLACES_MAX: 10 }; }
  function parse(t) { try { var o = JSON.parse(t); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; } }
  function keysOf(area) {
    var out = [];
    if (!area) return out;
    try { for (var i = 0; i < area.length; i++) { var k = area.key(i); if (k && k.indexOf(P) === 0) out.push(k); } } catch (e) { /* 読めなければ無し */ }
    return out;
  }
  function getA(area, k) { if (!area) return null; try { var v = area.getItem(k); return typeof v === 'string' && v ? v : null; } catch (e) { return null; } }
  function setA(area, k, v) { if (!area) return false; try { area.setItem(k, v); return area.getItem(k) === v; } catch (e) { return false; } }
  /** 消す。消せたか（消した後に残っていないか）を返す */
  function delA(area, k) {
    if (!area) return false;
    try { area.removeItem(k); } catch (e) { /* 下で確かめる */ }
    // 読み取りに失敗したときは「消せなかった」とみなす（消せたと思って後で送り直さない）
    try { return area.getItem(k) === null; } catch (e) { return false; }
  }
  /** (savedAt, rid) の順で比べる */
  function cmp(a, b) { return a.savedAt !== b.savedAt ? (a.savedAt < b.savedAt ? -1 : 1) : (a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : 0); }
  /** 控えに残す答え（状態・出社できるかだけ。一言などほかの項目は捨てる） */
  function slim(a) { return { status: a && a.status ? String(a.status) : '', canWork: a && a.canWork ? String(a.canWork) : '' }; }

  function open(area, id) {
    var pre = P + id + ':';
    function items(checkId) {
      return keysOf(area).filter(function (k) { return k.indexOf(pre) === 0; }).map(function (k) {
        var rest = k.slice(pre.length), i = rest.indexOf(':');
        if (i < 0) return null;
        var v = parse(getA(area, k));
        var c = rest.slice(0, i), rid = rest.slice(i + 1);
        if (!v || v.checkId !== c || typeof v.savedAt !== 'number' || !v.answer) return null;
        return { checkId: c, rid: rid, title: String(v.title || ''), base: typeof v.base === 'number' ? v.base : 0, replaces: Array.isArray(v.replaces) ? v.replaces : [],
          answer: slim(v.answer), hadNote: v.hadNote === true || !!(v.answer && v.answer.note), pressedAt: v.pressedAt, savedAt: v.savedAt };
      }).filter(function (x) { return x && (!checkId || x.checkId === checkId); });
    }
    return {
      newest: function () {
        var by = {};
        items().forEach(function (x) { if (!by[x.checkId] || cmp(x, by[x.checkId]) > 0) by[x.checkId] = x; });
        return Object.keys(by).map(function (k) { return by[k]; });
      },
      press: function (check, answer, base) {
        var seen = items(check.checkId).sort(function (a, b) { return -cmp(a, b); }); // 新しい順
        var rep = [];
        seen.forEach(function (p) { [p.rid].concat(p.replaces).forEach(function (r) { if (typeof r === 'string' && rep.indexOf(r) < 0) rep.push(r); }); });
        rep = rep.slice(0, cfg().REPLACES_MAX);
        var savedAt = Date.now();
        seen.forEach(function (p) { savedAt = Math.max(savedAt, p.savedAt + 1); });
        var rid = MP.api.newRequestId();
        var item = { checkId: check.checkId, title: String(check.title || ''), base: typeof base === 'number' ? base : 0, replaces: rep, answer: slim(answer), pressedAt: Date.now(), savedAt: savedAt };
        if (answer && answer.note) item.hadNote = true; // 一言があった印だけ（中身は書かない）
        var key = pre + check.checkId + ':' + rid;
        var wrote = setA(area, key, JSON.stringify(item)); // 新しい鍵を先に書く（一言は書かない）
        // 書けたか確かめられなかった（書いた後の読み取りの失敗など）ときは、書いた鍵も消しにいく。消せなければ、その画面ではこの鍵を送らない（1 回だけ送る答えを後で送り直さない）
        var stuck = !wrote && !delA(area, key) ? rid : '';
        var left = [], leftStatus = [];
        seen.forEach(function (p) { if (!delA(area, pre + p.checkId + ':' + p.rid)) { left.push(p.rid); leftStatus.push(p.answer && p.answer.status ? String(p.answer.status) : ''); } }); // 古い鍵を消す（消せなかったものを返す）
        return { item: Object.assign({ rid: rid }, item), wrote: wrote, left: left, leftStatus: leftStatus, stuck: stuck };
      },
      remove: function (checkId, rid) { return delA(area, pre + checkId + ':' + rid); },
    };
  }

  function gc(area) {
    var keep = cfg().KEEP_DAYS * 86400000, now = Date.now();
    var people = {};
    keysOf(area).forEach(function (k) {
      var v = parse(getA(area, k));
      if (!v || typeof v.savedAt !== 'number' || now - v.savedAt > keep) { delA(area, k); return; }
      var m = /^mp\.safety\.p:(E\d{4}):/.exec(k);
      if (!m) return;
      var p = people[m[1]] = people[m[1]] || { newest: 0, keys: [] };
      p.newest = Math.max(p.newest, v.savedAt);
      p.keys.push(k);
    });
    var ids = Object.keys(people).sort(function (a, b) { return people[a].newest - people[b].newest; });
    while (ids.length > cfg().PEOPLE_MAX) people[ids.shift()].keys.forEach(function (k) { delA(area, k); });
  }

  MP.safetyPending = { open: open, gc: gc, cmp: cmp };
})();
