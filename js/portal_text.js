/*
 * 段階4の画面の共通の部品（計画 stage4-board-plan.md 11-9）
 *
 *   MP.portal.urlOk(s)           … リンクにしてよい URL か（サーバーの ptl_urlOk_ と同じ決まり ＋ new URL() で https とホスト名を確かめる）
 *   MP.portal.body(text)         … お知らせの本文を要素にする。行ごとに要素を分け、確かめを通った URL だけを a 要素にする（値を HTML として入れない）
 *   MP.portal.link(name, url)    … 外のサイトへのリンク（rel="noopener noreferrer"・target="_blank"）。URL が駄目なら文字だけ
 *   MP.portal.targetText(t, ch)  … 対象の説明（「全員」「工事部・事務」「田中 社員 ほか 2 人」）
 *   MP.portal.dateLabel(ms)      … 「11/18」
 */
(function () {
  'use strict';
  var MP = window.MP = window.MP || {};
  var URL_MAX = 2000;
  var SHAPE = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?::\d{1,5})?(?:[/?#][^\s"'<>\\]*)?$/;
  // 本文の中から URL らしい所を探す（見つけた後で urlOk を通ったものだけをリンクにする）
  var FIND = /https:\/\/[^\s"'<>\\　、。「」（）]+/g;

  function urlOk(s) {
    if (typeof s !== 'string' || s.length > URL_MAX || /[\u0000- \u007f-\u009f"'<>\\]/.test(s) || !SHAPE.test(s)) return false;
    try {
      var u = new URL(s);
      return u.protocol === 'https:' && !!u.hostname && u.username === '' && u.password === '' && u.hostname.indexOf('.') > 0;
    } catch (e) { return false; }
  }

  function link(name, url) {
    var ui = MP.ui;
    if (!urlOk(url)) return ui.el('span', { text: name });
    return ui.el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: name });
  }

  function body(text) {
    var ui = MP.ui;
    var box = ui.el('div', { class: 'post-body' });
    String(text || '').split('\n').forEach(function (line) {
      var p = ui.el('p', { class: 'post-line' });
      var last = 0, m;
      FIND.lastIndex = 0;
      while ((m = FIND.exec(line))) {
        var u = m[0].replace(/[.,!?)]+$/, ''); // 文の終わりの句読点はリンクに入れない
        if (m.index > last) p.appendChild(document.createTextNode(line.slice(last, m.index)));
        if (urlOk(u)) p.appendChild(link(u, u));
        else p.appendChild(document.createTextNode(u));
        last = m.index + u.length;
        FIND.lastIndex = last;
      }
      if (last < line.length) p.appendChild(document.createTextNode(line.slice(last)));
      if (!line) p.appendChild(document.createTextNode(' '));
      box.appendChild(p);
    });
    return box;
  }

  function targetText(t, choices) {
    if (!t) return '（対象が読めません）';
    if (t.type === 'all') return '全員';
    var list = t.type === 'depts' ? (choices && choices.departments) || [] : (choices && choices.people) || [];
    var key = t.type === 'depts' ? 'deptId' : 'employeeId';
    var names = t.ids.map(function (id) { var c = list.filter(function (x) { return x[key] === id; })[0]; return c ? c.name : id; });
    if (t.type === 'people' && names.length > 3) return names.slice(0, 3).join('・') + ' ほか ' + (names.length - 3) + ' 人';
    return names.join('・');
  }

  function dateLabel(v) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return Number(v.slice(5, 7)) + '/' + Number(v.slice(8, 10));
    return '';
  }

  /** 対象を選ぶ所（全員・部署・個人）。choices … { departments, people }。返す { el, get(), set(t) } */
  function targetPicker(idPrefix, choices) {
    var ui = MP.ui;
    var wrap = ui.el('div', { class: 'target-picker' });
    var sel = ui.el('select', { id: idPrefix + '-type' }, [
      ui.el('option', { value: 'all', text: '全員' }), ui.el('option', { value: 'depts', text: '部署で選ぶ' }), ui.el('option', { value: 'people', text: '人で選ぶ' }),
    ]);
    var boxes = { depts: ui.el('div', { class: 'check-list', id: idPrefix + '-depts' }), people: ui.el('div', { class: 'check-list', id: idPrefix + '-people' }) };
    (choices.departments || []).forEach(function (d) {
      boxes.depts.appendChild(ui.el('label', { class: 'check' }, [ui.el('input', { type: 'checkbox', value: d.deptId }), ' ' + d.name]));
    });
    (choices.people || []).forEach(function (p) {
      boxes.people.appendChild(ui.el('label', { class: 'check' }, [ui.el('input', { type: 'checkbox', value: p.employeeId }), ' ' + p.name]));
    });
    function sync() { boxes.depts.hidden = sel.value !== 'depts'; boxes.people.hidden = sel.value !== 'people'; }
    sel.addEventListener('change', sync);
    wrap.appendChild(ui.el('label', { for: idPrefix + '-type', text: '対象' }));
    wrap.appendChild(sel);
    wrap.appendChild(boxes.depts);
    wrap.appendChild(boxes.people);
    sync();
    return {
      el: wrap,
      get: function () {
        if (sel.value === 'all') return { type: 'all' };
        var ids = Array.prototype.slice.call(boxes[sel.value].querySelectorAll('input:checked')).map(function (i) { return i.value; });
        return { type: sel.value, ids: ids };
      },
      set: function (t) {
        sel.value = t && (t.type === 'depts' || t.type === 'people') ? t.type : 'all';
        ['depts', 'people'].forEach(function (k) {
          Array.prototype.slice.call(boxes[k].querySelectorAll('input')).forEach(function (i) { i.checked = !!t && t.type === k && t.ids.indexOf(i.value) >= 0; });
        });
        sync();
      },
    };
  }

  MP.portal = { urlOk: urlOk, link: link, body: body, targetText: targetText, dateLabel: dateLabel, targetPicker: targetPicker };
})();
