/*
 * 休暇の使い始め（管理者だけ）。計画 docs/plans/stage2-leave-plan.md 第7章「初めの残高の有給」・第11章・第13章 3〜4
 *
 * 社員ごとに: 起点の日・振替の初めの分（± 時間）・今ある有給（付与日・元の日数・残りの日数と時間を何行か）・振替の調整・看護介護の対象者（2c）。
 * 開くときに休暇のシートを用意する（prepare: true）。用意できなければ入力を出さない
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, LV = MP.leaveView;
    var data = null;
    var save = MP.api.saver();

    function load(first) {
      var p = first ? MP.guard.enter({ admin: true, load: { action: 'leave.admin.overview', args: { prepare: true } } })
        : MP.api.call('leave.admin.overview', {}).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        data = r.res.data;
        ui.$('view').hidden = false;
        ui.$('sheets-bad').hidden = data.sheetsOk !== false;
        if (data.sheetsOk === false) { ui.clear(ui.$('people')); return; }
        render();
      });
    }

    function jp(d) { return d ? Number(d.slice(0, 4)) + '年' + Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日' : ''; }
    function input(type, value, label, extra) { return ui.el('input', Object.assign({ type: type, value: value === null || value === undefined ? '' : String(value), 'aria-label': label }, extra || {})); }
    function field(label, el) { return ui.el('label', { class: 'field' }, [ui.el('span', { text: label }), el]); }

    /** 結果を出して読み込み直す。CLOSED_EFFECT（締めた期間が変わる）は確かめてから confirmClosed を付けて送り直す */
    function send(action, args, done) {
      return save(action, args).then(function (res) {
        if (!res.ok && res.code === 'CLOSED_EFFECT') {
          return ui.confirm('締めた期間の振り分けが変わります', res.message, '変えて保存する', 'primary').then(function (yes) {
            if (yes) return send(action, Object.assign({}, args, { confirmClosed: true }), done);
          });
        }
        if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
        return load(false).then(function () { ui.pageMessage(done, 'ok'); });
      });
    }

    function render() {
      var ul = ui.clear(ui.$('people'));
      data.people.forEach(function (p) { ul.appendChild(personCard(p)); });
    }

    function personCard(p) {
      var prof = p.profile;
      var start = input('date', prof ? prof.startDate : '', '使い始める日');
      var furSign = ui.el('select', { 'aria-label': '振替の残りの向き' }, [ui.el('option', { value: '1', text: 'プラス' }), ui.el('option', { value: '-1', text: 'マイナス（前借り）' })]);
      var f0 = prof ? prof.initialFurikae : 0;
      furSign.value = f0 < 0 ? '-1' : '1';
      var furH = input('number', Math.floor(Math.abs(f0) / 60), '振替の残り（時間）', { min: '0', max: '999', class: 'leave-days' });
      var furM = ui.el('select', { 'aria-label': '振替の残り（分）' }, [ui.el('option', { value: '0', text: '0分' }), ui.el('option', { value: '30', text: '30分' })]);
      furM.value = String(Math.abs(f0) % 60 >= 30 ? 30 : 0);
      var note = input('text', prof ? prof.note : '', 'メモ', { maxlength: '30' });
      var saveBtn = ui.el('button', { type: 'button', class: 'btn primary', text: prof ? '起点・振替を直す' : '起点・振替を保存', on: { click: function () {
        var minutes = Number(furSign.value) * (Number(furH.value || 0) * 60 + Number(furM.value));
        ui.run(function () {
          return send('leave.admin.profile.save', { employeeId: p.employeeId, baseVersion: prof ? prof.recordVersion : 0, startDate: start.value, initialFurikae: minutes, note: note.value.trim() }, p.name + 'の起点と振替を保存しました');
        });
      } } });
      var initial = (p.grants || []).filter(function (g) { return g.kind === 'initial' && g.state === '有効'; });
      var initList = ui.el('ul', { class: 'list' }, initial.map(function (g) {
        return ui.el('li', {}, [
          ui.el('span', { text: '付与日 ' + jp(g.date) + '・残り ' + LV.dh(g.minutes, g.dayMin) + '（' + jp(g.expire) + ' に消える）' + (g.initialOrigDays !== null ? '・元の日数 ' + g.initialOrigDays + '日' : '') }),
          ui.el('button', { type: 'button', class: 'btn danger', text: '取り消す', on: { click: function () {
            ui.confirm('初めの残高を取り消す', jp(g.date) + ' の分を取り消しますか？', '取り消す', 'danger').then(function (yes) {
              if (yes) ui.run(function () { return send('leave.admin.grant.save', { mode: 'initialCancel', employeeId: p.employeeId, grantId: g.grantId, baseVersion: g.recordVersion, reason: '' }, '取り消しました'); });
            });
          } } }),
        ]);
      }));
      var gDate = input('date', '', '付与日');
      var gOrig = input('number', '', '元の日数（分かれば）', { min: '0', max: '40', class: 'leave-days' });
      var gDays = input('number', '0', '残りの日数', { min: '0', max: '40', class: 'leave-days' });
      var gHours = ui.el('select', { 'aria-label': '残りの時間' });
      for (var m = 0; m < 480; m += 30) gHours.appendChild(ui.el('option', { value: String(m), text: LV.hm(m) }));
      var gNote = input('text', '', '理由（例 紙の記録）', { maxlength: '30' });
      var addInit = ui.el('button', { type: 'button', class: 'btn', text: '今ある有給を足す', disabled: !prof, on: { click: function () {
        ui.run(function () {
          return send('leave.admin.grant.save', { mode: 'initial', employeeId: p.employeeId, grantId: null, date: gDate.value, origDays: gOrig.value === '' ? null : Number(gOrig.value),
            remainDays: Number(gDays.value || 0), remainMinutes: Number(gHours.value), reason: gNote.value.trim() }, '今ある有給を足しました');
        });
      } } });
      // 振替の調整
      var aDate = input('date', '', '調整の日');
      var aSign = ui.el('select', { 'aria-label': '調整の向き' }, [ui.el('option', { value: '1', text: '足す' }), ui.el('option', { value: '-1', text: '引く' })]);
      var aH = input('number', '0', '調整（時間）', { min: '0', max: '999', class: 'leave-days' });
      var aM = ui.el('select', { 'aria-label': '調整（分）' }, [ui.el('option', { value: '0', text: '0分' }), ui.el('option', { value: '30', text: '30分' })]);
      var aReason = input('text', '', '調整の理由', { maxlength: '30' });
      var addAdj = ui.el('button', { type: 'button', class: 'btn', text: '振替を調整する', disabled: !prof, on: { click: function () {
        ui.run(function () {
          return send('leave.admin.adjust.save', { employeeId: p.employeeId, adjustId: null, date: aDate.value, minutes: Number(aSign.value) * (Number(aH.value || 0) * 60 + Number(aM.value)), reason: aReason.value.trim() }, '振替を調整しました');
        });
      } } });
      var adjList = ui.el('ul', { class: 'list' }, (p.adjusts || []).filter(function (a) { return a.state === '有効'; }).map(function (a) {
        return ui.el('li', {}, [ui.el('span', { text: jp(a.date) + ' ' + LV.hm(a.minutes) + '（' + a.reason + '）' }),
          ui.el('button', { type: 'button', class: 'btn danger', text: '取り消す', on: { click: function () {
            ui.run(function () { return send('leave.admin.adjust.save', { employeeId: p.employeeId, adjustId: a.adjustId, baseVersion: a.recordVersion, cancel: true }, '調整を取り消しました'); });
          } } })]);
      }));
      // 看護・介護の対象者（2c。呼び名だけ。氏名・生年月日は入れない）
      var cKind = ui.el('select', { 'aria-label': '種類' }, [ui.el('option', { value: 'kango', text: '子の看護' }), ui.el('option', { value: 'kaigo', text: '介護' })]);
      var cName = input('text', '', '呼び名（例 長男）', { maxlength: '10' });
      var cFrom = input('date', '', '始めの日');
      var cTo = input('date', '', '終わりの日（任意）');
      var addCare = ui.el('button', { type: 'button', class: 'btn', text: '対象者を登録する', on: { click: function () {
        ui.run(function () {
          return send('leave.admin.care.save', { employeeId: p.employeeId, targetId: null, baseVersion: 0, kind: cKind.value, name: cName.value.trim(), from: cFrom.value, to: cTo.value, active: true }, '対象者を登録しました');
        });
      } } });
      var careList = ui.el('ul', { class: 'list' }, (p.careTargets || []).map(function (t) {
        return ui.el('li', {}, [ui.el('span', { text: (t.kind === 'kaigo' ? '介護' : '子の看護') + '・' + t.name + '・' + jp(t.from) + '〜' + jp(t.to) + (t.active ? '' : '（止めた）') }),
          ui.el('button', { type: 'button', class: 'btn', text: t.active ? '止める' : '戻す', on: { click: function () {
            ui.run(function () { return send('leave.admin.care.save', { employeeId: p.employeeId, targetId: t.targetId, baseVersion: t.recordVersion, kind: t.kind, name: t.name, from: t.from, to: t.to, active: !t.active }, '対象者を直しました'); });
          } } })]);
      }));
      return ui.el('li', { class: 'subbox' }, [
        ui.el('h2', {}, [p.name + ' ', prof ? ui.el('span', { class: 'tag ok', text: '入れ終わった' }) : ui.el('span', { class: 'tag off', text: 'まだ' }), p.hireDate ? ui.el('span', { class: 'sub', text: '　入社日 ' + jp(p.hireDate) }) : ui.el('span', { class: 'msg warn', text: '入社日が入っていません（社員の管理で入れてください。付与の候補が出ません）' })]),
        ui.el('h3', { text: '起点と振替の残り' }),
        ui.el('div', { class: 'row' }, [field('使い始める日', start), field('振替の残り', furSign), field('時間', furH), field('分', furM)]),
        field('メモ', note),
        ui.el('div', { class: 'item-actions' }, [saveBtn]),
        ui.el('h3', { text: '今ある有給（付与された日ごと）' }),
        initial.length ? initList : ui.el('p', { class: 'sub', text: prof ? 'まだ入れていません' : '先に使い始める日を保存してください' }),
        ui.el('div', { class: 'row' }, [field('付与日', gDate), field('元の日数', gOrig), field('残りの日数', gDays), field('残りの時間', gHours)]),
        field('理由', gNote),
        ui.el('div', { class: 'item-actions' }, [addInit]),
        ui.el('h3', { text: '振替の調整' }),
        adjList,
        ui.el('div', { class: 'row' }, [field('日', aDate), field('向き', aSign), field('時間', aH), field('分', aM)]),
        field('理由', aReason),
        ui.el('div', { class: 'item-actions' }, [addAdj]),
        ui.el('h3', { text: '子の看護・介護の対象者' }),
        careList,
        ui.el('div', { class: 'row' }, [field('種類', cKind), field('呼び名', cName), field('始めの日', cFrom), field('終わりの日', cTo)]),
        ui.el('div', { class: 'item-actions' }, [addCare]),
      ]);
    }

    return load(true);
  });
})();
