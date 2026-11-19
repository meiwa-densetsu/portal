/*
 * 休暇の表示の計算（計画 docs/plans/stage2-leave-plan.md 第9〜11章）。画面の部品を使わない純粋な JS（Node のテストでも読み込む）
 *
 *   MP.leaveView.dh(分, 1日の分)         … 「2日と3時間」「1時間30分」（分 → 日と時間）
 *   MP.leaveView.hm(分)                  … 「1:30」（時間の量）
 *   MP.leaveView.time(分)                … 「9:00」（時刻）
 *   MP.leaveView.label(休み)             … 「有給 1日」「有給 9:00〜10:30」（日報の画面の印）
 *   MP.leaveView.noteText(日付, 休みの並び) … 出勤簿の備考の行「10月5日 有給 9:00〜10:30」（1日の休みは施工内容に出すので入れない）
 *   MP.leaveView.dayContent(休みの並び)  … 1日の休みの日の施工内容「有給」「有給・振替」「欠勤」（無ければ ''）
 *   MP.leaveView.allocText(振り分け)      … 「有給 1:30・振替休日 0:30」
 *   MP.leaveView.changeText(対象, 前, 後) … 修正履歴の 1 行の文
 *   MP.leaveView.bannerText(未確認, 確認待ち) … ホームの帯の文
 *   MP.leaveView.mark(休み)              … 表形式の行の印「有」「振」「欠」（色だけに頼らない）
 *   MP.leaveView.careText(看護・介護の残り) … 残りの一覧の 1 行「看護休暇（長男）」「残り 30:00」「うち有給 18:00（…）」
 */
(function (root) {
  'use strict';

  var KIND = { leave: '休み', kango: '看護休暇', kaigo: '介護休暇' };
  var UNIT = { day: '1日', half: '半日', hour: '時間' };

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function time(m) {
    if (typeof m !== 'number' || !isFinite(m)) return '';
    return Math.floor(m / 60) + ':' + pad(m % 60);
  }

  function hm(m) {
    var neg = m < 0;
    var a = Math.abs(m || 0);
    return (neg ? '−' : '') + Math.floor(a / 60) + ':' + pad(a % 60);
  }

  /** 分 → 「◯日と◯時間◯分」（1 日の分で割る。0 は「0」） */
  function dh(m, dayMin) {
    var neg = m < 0;
    var a = Math.abs(m || 0);
    if (!a) return '0';
    var parts = [];
    if (dayMin > 0) {
      var d = Math.floor(a / dayMin);
      a -= d * dayMin;
      if (d) parts.push(d + '日');
    }
    var h = Math.floor(a / 60), mm = a % 60;
    if (h || mm) parts.push((h ? h + '時間' : '') + (mm ? mm + '分' : ''));
    return (neg ? '−' : '') + parts.join('と');
  }

  function md(date) { return Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日'; }

  /** 振り分けの中身の名前の並び（有給・振替休日・欠勤・看護〔介護〕の有給・無給） */
  function parts(alloc, kind) {
    if (!alloc) return [];
    var care = kind === 'kaigo' ? '介護' : '看護';
    var out = [];
    if (alloc.carePaid) out.push({ name: care + '（有給）', min: alloc.carePaid, mark: care.charAt(0) });
    if (alloc.careUnpaid) out.push({ name: care + '（無給）', min: alloc.careUnpaid, mark: care.charAt(0) });
    if (alloc.paid) out.push({ name: '有給', min: alloc.paid, mark: '有' });
    if (alloc.furikae) out.push({ name: '振替休日', min: alloc.furikae, mark: '振' });
    if (alloc.absent) out.push({ name: '欠勤', min: alloc.absent, mark: '欠' });
    return out;
  }

  /** 1 種類だけならその名前、分かれたら「休み」（看護・介護は「看護休暇」など） */
  function headName(l) {
    var p = parts(l.alloc, l.kind);
    if (p.length === 1) return p[0].name;
    if (!p.length) return KIND[l.kind] || '休み';
    return KIND[l.kind] || '休み';
  }

  function allocText(alloc, kind) {
    return parts(alloc, kind).map(function (p) { return p.name + ' ' + hm(p.min); }).join('・');
  }

  function hasTime(l) { return typeof l.from === 'number' && typeof l.to === 'number' && l.to > l.from; }

  function span(l) {
    if (l.unit === 'hour') return time(l.from) + '〜' + time(l.to);
    if (l.unit === 'half') return '半日' + (hasTime(l) ? ' ' + time(l.from) + '〜' + time(l.to) : ''); // 半日の時刻（第17章 17-2）
    return UNIT[l.unit] || '';
  }

  /** 日報の画面の印「有給 1日」「休み 9:00〜11:00（有給 1:30・振替休日 0:30）」 */
  function label(l) {
    var p = parts(l.alloc, l.kind);
    var text = headName(l) + ' ' + span(l);
    if (p.length > 1) text += '（' + allocText(l.alloc, l.kind) + '）';
    return text;
  }

  /** 出勤簿の備考の行（半日・時間の休み。Q11）と、自動の埋め（2b。Q13「有給 0:30（足りない時間）」） */
  function noteText(date, leaves, auto) {
    var out = [];
    (leaves || []).forEach(function (l) {
      if (l.unit === 'day') return;
      out.push(md(date) + ' ' + label(l));
    });
    if (auto) {
      var a = parts({ paid: auto.paid, furikae: auto.furikae, absent: auto.absent }, 'leave');
      if (a.length) out.push(md(date) + ' ' + a.map(function (p) { return p.name + ' ' + hm(p.min); }).join('・') + '（足りない時間）');
    }
    return out;
  }

  /** 1日の休みの日の施工内容（昼の欄）「有給」「有給・振替」「欠勤」「看護休暇」。1日の休みが無ければ '' */
  function dayContent(leaves) {
    var l = (leaves || []).filter(function (x) { return x.unit === 'day'; })[0];
    if (!l) return '';
    var p = parts(l.alloc, l.kind);
    if (!p.length) return KIND[l.kind] || '休み';
    var names = [];
    p.forEach(function (x) {
      var n = x.name === '振替休日' ? '振替' : x.name.replace(/（.*）/, '');
      if (names.indexOf(n) < 0) names.push(n);
    });
    return names.join('・');
  }

  /** 表形式の行の印（「有」「振」「欠」を並べる。時刻のある休みは時刻も） */
  function mark(l) {
    var p = parts(l.alloc, l.kind);
    var m = p.map(function (x) { return x.mark; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join('');
    return (m || '休') + (l.unit === 'hour' || l.unit === 'half' ? ' ' + span(l) : '');
  }

  function parse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /** 修正履歴の 1 行の文（「日付 / 種類 単位 時刻 / 状態」。自動の変化は「（自動）有給 ◯・振替 ◯・欠勤 ◯」） */
  function changeText(target, beforeRaw, afterRaw) {
    if (target === '休暇の振り分け（自動）') {
      var f = function (rows) {
        if (!Array.isArray(rows) || !rows.length) return 'なし';
        return rows.map(function (r) {
          var t = allocText({ paid: r[1], furikae: r[2], absent: r[3], carePaid: r[4], careUnpaid: r[5] }, 'leave');
          return (r[0] === 'auto' ? '足りない時間 ' : '') + (t || '0');
        }).join(' ／ ');
      };
      return '（自動）' + f(parse(beforeRaw)) + ' → ' + f(parse(afterRaw));
    }
    var one = function (o) {
      if (!o || typeof o !== 'object' || !Object.keys(o).length) return 'なし';
      if (target === '休暇の申請') {
        var t = o.unit === '時間' ? time(o.from) + '〜' + time(o.to) : o.unit;
        return [o.date, (o.kind || '') + ' ' + t, o.note ? 'メモ「' + o.note + '」' : '', o.state].filter(Boolean).join(' / ');
      }
      if (target === '有給の付与') return [o.date, o.kind, (o.days === null || o.days === undefined ? '' : o.days + '日'), o.state].filter(Boolean).join(' / ');
      return Object.keys(o).map(function (k) { return k + ': ' + o[k]; }).join(' / ');
    };
    return one(parse(beforeRaw)) + ' → ' + one(parse(afterRaw));
  }

  function bannerText(unseen, pending) {
    var out = [];
    if (unseen > 0) out.push('申請している人がいます（' + unseen + '件）');
    if (pending > 0) out.push('有給の付与の確認待ち（' + pending + '人）');
    return out;
  }

  /**
   * 日報の画面のその場の計算に渡す休みの区間（第17章 17-1・17-8 (3)）: その日の休みと次の日の休み（1440 ずらす）。
   * data は report.period の答え（日ごとの leave と leaveNext）。区間の作り方は共有の計算（CalcLeave.reportLeaves）
   */
  function reportLeavesFor(data, date) {
    var CL = root && root.CalcLeave;
    if (!CL || !data || !data.days) return [];
    var items = function (d) {
      var day = data.days.filter(function (x) { return x.date === d; })[0];
      if (day) return Array.isArray(day.leave) ? day.leave : [];
      return data.leaveNext && data.leaveNext.date === d ? data.leaveNext.items : [];
    };
    var t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1);
    return CL.reportLeaves(items(date), items(new Date(t).toISOString().slice(0, 10)));
  }

  /** 日付の範囲から、会社の出勤日（marks の W・P）だけを並べる（休みをまとめて申請するとき） */
  function workDates(calendar, from, to) {
    var out = [];
    if (!calendar || !from || !to || from > to) return out;
    var base = Date.UTC(Number(calendar.from.slice(0, 4)), Number(calendar.from.slice(5, 7)) - 1, Number(calendar.from.slice(8, 10)));
    var t0 = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
    var t1 = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
    for (var t = t0; t <= t1; t += 86400000) {
      var i = Math.round((t - base) / 86400000);
      var c = calendar.marks.charAt(i);
      if (c === 'W' || c === 'P') out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }

  /** その日の会社カレンダーの印（W・H・P・'-'。範囲の外は ''） */
  function markOf(calendar, date) {
    if (!calendar) return '';
    var base = Date.UTC(Number(calendar.from.slice(0, 4)), Number(calendar.from.slice(5, 7)) - 1, Number(calendar.from.slice(8, 10)));
    var t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
    var i = Math.round((t - base) / 86400000);
    return i >= 0 && i < calendar.marks.length ? calendar.marks.charAt(i) : '';
  }

  function jpYmd(d) { return d ? Number(d.slice(0, 4)) + '年' + Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日' : ''; }

  /**
   * 看護・介護の残りの 1 行（計画 第18章 18-4）。c はサーバーの leave.mine の care[] の 1 つ。
   * 返す値: { label: '看護休暇（長男）', value: '残り 30:00', sub: 'うち有給 18:00（年 30:00・うち有給 18:00 ＝ 1 日 6:00 × 5 日・3 日／2026年7月1日〜2027年9月30日）' }
   * 1 日の所定が取れない（枠が null）ときは、0 と出さずに数えられないことを出す
   */
  function careText(c) {
    var label = (c.kind === 'kaigo' ? '介護休暇' : '看護休暇') + '（' + c.name + '）';
    var span = jpYmd(c.yearFrom) + (c.yearTo ? '〜' + jpYmd(c.yearTo) : 'から');
    if (c.totalLimit === null || c.paidLimit === null || c.dayMin === null) {
      return { label: label, value: '数えられません', sub: '1 日の所定労働時間が決まっていないため数えられません（管理者に伝えてください）' };
    }
    return {
      label: label, value: '残り ' + hm(c.totalLeft),
      sub: 'うち有給 ' + hm(c.paidLeft) + '（年 ' + hm(c.totalLimit) + '・うち有給 ' + hm(c.paidLimit) + ' ＝ 1 日 ' + hm(c.dayMin) + ' × ' + c.days + ' 日・' + c.paidDays + ' 日／' + span + '）',
    };
  }

  var api = { dh: dh, hm: hm, time: time, label: label, noteText: noteText, dayContent: dayContent, allocText: allocText, changeText: changeText,
    bannerText: bannerText, mark: mark, workDates: workDates, markOf: markOf, reportLeavesFor: reportLeavesFor, careText: careText, KIND: KIND, UNIT: UNIT };
  if (root) { root.MP = root.MP || {}; root.MP.leaveView = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
