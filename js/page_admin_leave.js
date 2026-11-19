/*
 * 休暇の管理（管理者だけ）。計画 docs/plans/stage2-leave-plan.md 第10・11章
 *
 * 未確認の申請（まとめて「確認した」）・付与の候補（出勤率つきで確定・日数を直す・付与しない）・全員の残り（前借り・もうすぐ消える・年 5 日・控えが古い）・
 * 締めた期間の振り分けの変化。付与の確定は、まず下見（dryRun）で締めた期間の変化を見せてから送る
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, LV = MP.leaveView;
    var data = null;
    var save = MP.api.saver();

    function load(first) {
      var p = first ? MP.guard.enter({ admin: true, load: { action: 'leave.admin.overview', args: {} } })
        : MP.api.call('leave.admin.overview', {}).then(function (res) { return { res: res }; });
      return p.then(function (r) {
        if (!r.res.ok) { ui.pageMessage(r.res.message, 'error'); return; }
        data = r.res.data;
        ui.$('view').hidden = false;
        render();
      });
    }

    function jp(d) { return d ? Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日' : ''; }
    function link(id, name) { return ui.el('strong', { text: name }); }

    function render() {
      renderUnseen();
      renderCands();
      renderPeople();
      renderClosed();
    }

    function renderUnseen() {
      var ul = ui.clear(ui.$('unseen'));
      ui.$('seen-all').hidden = !data.unseen.length;
      if (!data.unseen.length) { ul.appendChild(ui.el('li', { class: 'sub', text: '未確認の申請はありません' })); return; }
      data.unseen.forEach(function (l) {
        ul.appendChild(ui.el('li', {}, [
          ui.el('div', { class: 'item-title' }, [link(l.employeeId, l.name), ' ', jp(l.date), ' ', l.state === '取消' ? ui.el('span', { class: 'tag off', text: '取消' }) : null,
            l.recordVersion > 1 && l.state !== '取消' ? ui.el('span', { class: 'tag warn', text: '直した' }) : null]),
          ui.el('div', { text: LV.label(l) + (l.note ? '　メモ: ' + l.note : '') }),
          ui.el('div', { class: 'sub', text: '送った日時 ' + ui.fmtDateTime(l.sentAt) }),
        ]));
      });
    }

    function seenAll() {
      var items = data.unseen.map(function (l) { return { leaveId: l.leaveId, version: l.recordVersion }; });
      return save('leave.admin.seen', { items: items }).then(function (res) {
        if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
        var t = res.data.changed.length ? res.data.seen.length + '件を確認しました。' + res.data.changed.length + '件は直されたので確認していません' : res.data.seen.length + '件を確認しました';
        return load(false).then(function () { ui.pageMessage(t, 'ok'); });
      });
    }

    function attText(a) {
      if (!a) return '';
      if (a.ratio === null) return '出勤率: 全労働日なし';
      return '出勤率 ' + Math.round(a.ratio * 1000) / 10 + '%（' + a.attended + ' / ' + a.workDays + ' 日・' + jp(a.from) + '〜' + jp(a.to) + '）' + (a.insufficient ? '・使い始める前の日を含む（データが足りない。紙の記録で確かめてください）' : '');
    }

    function renderCands() {
      var ul = ui.clear(ui.$('cands'));
      var any = false;
      data.people.forEach(function (p) {
        (p.candidates || []).forEach(function (c) {
          any = true;
          var choice = ui.el('select', { 'aria-label': '付与のしかた' }, [
            ui.el('option', { value: 'table', text: '表のとおり（' + c.days + '日）', selected: c.defaultChoice === 'table' }),
            ui.el('option', { value: 'edit', text: '日数を直す' }),
            ui.el('option', { value: 'none', text: '付与しない（0 日）', selected: c.defaultChoice === 'none' }),
          ]);
          var days = ui.el('input', { type: 'number', min: '0', max: '40', value: String(c.days), 'aria-label': '日数', class: 'leave-days' });
          var reason = ui.el('input', { type: 'text', maxlength: '30', 'aria-label': '理由', placeholder: '理由（8 割に届かないとき・日数を直すときは必ず）' });
          var btn = ui.el('button', { type: 'button', class: 'btn primary', text: '確定する', disabled: c.blockedByPrev, on: { click: function () {
            ui.run(function () { return confirmGrant(p, c, choice.value, Number(days.value), reason.value.trim()); });
          } } });
          ul.appendChild(ui.el('li', {}, [
            ui.el('div', { class: 'item-title' }, [link(p.employeeId, p.name), ' ' + c.no + '回目 ' + jp(c.date) + ' 表の日数 ' + c.days + '日']),
            ui.el('div', { class: c.low ? 'msg warn' : 'sub', text: attText(c.attendance) + (c.low ? '・8 割に届いていません' : '') }),
            c.blockedByPrev ? ui.el('p', { class: 'msg info', text: '前の付与が確定待ちです。先に確定してください' }) : null,
            ui.el('div', { class: 'row' }, [choice]),
            ui.el('div', { class: 'row' }, [days, reason]),
            ui.el('div', { class: 'item-actions' }, [btn]),
          ]));
        });
      });
      if (!any) ul.appendChild(ui.el('li', { class: 'sub', text: '今は付与の候補はありません' }));
    }

    function confirmGrant(p, c, choice, days, reason) {
      var args = { mode: 'confirm', employeeId: p.employeeId, no: c.no, choice: choice, reason: reason };
      if (choice === 'edit') args.days = days;
      // まず下見（締めた期間の変化を見せる）
      return MP.api.call('leave.admin.grant.save', Object.assign({ dryRun: true }, args)).then(function (res) {
        if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
        var ch = res.data.closedChanges;
        var go = ch.length
          ? ui.confirm('締めた期間の振り分けが変わります', '確定すると、締めた期間の次の日の振り分けが変わります。\n' + ch.map(function (x) { return '・' + jp(x.date) + ' ' + LV.changeText('休暇の振り分け（自動）', x.before, x.after); }).join('\n'), '確定する', 'primary')
          : ui.confirm(p.name + 'の付与を確定する', c.no + '回目 ' + jp(c.date) + '・' + (choice === 'none' ? '付与しない' : (choice === 'edit' ? days : c.days) + '日') + (res.data.offset ? '\n振替の前借り ' + LV.hm(res.data.offset) + ' と相殺します' : ''), '確定する', 'primary');
        return go.then(function (yes) {
          if (!yes) return;
          return save('leave.admin.grant.save', Object.assign({ confirmClosed: ch.length > 0 }, args)).then(function (r2) {
            if (!r2.ok) { ui.pageMessage(r2.message, 'error'); return; }
            return load(false).then(function () { ui.pageMessage('付与を確定しました', 'ok'); });
          });
        });
      });
    }

    function renderPeople() {
      var ul = ui.clear(ui.$('people'));
      var st = ui.$('stale-note');
      st.hidden = !data.staleCount;
      st.textContent = '控えが古い人が ' + data.staleCount + ' 人います（残りはその場で計算して出しています）。「作り直す」で直ります';
      data.people.forEach(function (p) {
        if (!p.ready) {
          ul.appendChild(ui.el('li', {}, [ui.el('div', { class: 'item-title' }, [p.name, ' ', ui.el('span', { class: 'tag off', text: '準備中' })]),
            ui.el('div', { class: 'sub', text: '使い始める日が入っていません（休暇の使い始めの画面で入れます）' })]));
          return;
        }
        var b = p.balance, dm = b.dayMin || 480;
        var warns = (p.warnings || []).map(function (w) {
          return w.code === 'BORROW_OVER' ? '前借りが上限を超えています' : w.code === 'BORROW_NEAR' ? '前借りが上限に近い（' + LV.hm(w.borrowed) + ' / ' + LV.hm(w.limit) + '）'
            : w.code === 'SOON_EXPIRE' ? 'もうすぐ消える有給 ' + w.items.map(function (s) { return jp(s.expire) + ' ' + LV.dh(s.minutes, dm); }).join('・')
              : w.code === 'GRANT_PENDING' ? '付与の確定待ち' : w.code === 'FIVE_DAY' ? '年 5 日に届いていません（' + w.taken + ' 日・予定 ' + w.planned + ' 日）' : '';
        }).filter(Boolean);
        var actions = [ui.el('a', { class: 'btn', href: 'leave.html?employeeId=' + encodeURIComponent(p.employeeId), text: '休暇の画面' })];
        if (!p.fresh || (p.fixDays || []).length) actions.push(ui.el('button', { type: 'button', class: 'btn', text: '作り直す', on: { click: function () { ui.run(function () { return rebuild(p.employeeId); }); } } }));
        (p.grants || []).filter(function (g) { return g.state === '有効' && g.kind !== 'initial'; }).slice(-1).forEach(function (g) {
          actions.push(ui.el('button', { type: 'button', class: 'btn danger', text: g.no + '回目の付与を取り消す', on: { click: function () { cancelGrant(p, g); } } }));
        });
        ul.appendChild(ui.el('li', {}, [
          ui.el('div', { class: 'item-title' }, [link(p.employeeId, p.name), p.fresh ? null : ui.el('span', { class: 'tag warn', text: '控えが古い' })]),
          ui.el('div', { text: '有給 ' + LV.dh(b.paid, dm) + '・振替残高 ' + LV.hm(b.furikae) + (b.borrowed ? '・前借り ' + LV.hm(b.borrowed) : '') }),
          warns.length ? ui.el('div', { class: 'msg warn', text: warns.join(' ／ ') }) : null,
          (p.conflicts || []).length ? ui.el('div', { class: 'msg warn', text: '休みと勤務が重なっています: ' + p.conflicts.map(function (c) { return jp(c.date); }).join('・') }) : null,
          p.staleMonths && p.staleMonths.length ? ui.el('div', { class: 'sub', text: '古い月: ' + p.staleMonths.join('・') }) : null,
          fixLines(p),
          p.lastRebuildFailure ? ui.el('div', { class: 'sub', text: '最後の作り直しの失敗: ' + p.lastRebuildFailure.at }) : null,
          ui.el('div', { class: 'item-actions' }, actions),
        ]));
      });
    }

    /** 直す日（第17章 17-16）: 月次集計のずれは「作り直す」で、日報の計算し直しが要る日は日報の画面の「計算し直す」で直す */
    function fixLines(p) {
      var fd = p.fixDays || [];
      if (!fd.length) return null;
      var monthly = fd.filter(function (f) { return f.kind === 'monthly'; }).map(function (f) { return jp(f.date); });
      var recalc = fd.filter(function (f) { return f.kind === 'recalc'; });
      return ui.el('div', { class: 'msg warn' }, [
        monthly.length ? ui.el('div', { text: '月次集計のずれ: ' + monthly.join('・') + '（「作り直す」で直ります）' }) : null,
        recalc.length ? ui.el('div', {}, ['日報の計算し直しが要る日: '].concat(recalc.map(function (f) {
          return ui.el('a', { href: 'report.html?view=day&employee=' + encodeURIComponent(p.employeeId) + '&date=' + f.date, text: jp(f.date) + ' ' });
        }))) : null,
      ]);
    }

    function cancelGrant(p, g) {
      ui.confirm('付与を取り消す', p.name + ' の ' + g.no + '回目（' + jp(g.date) + '・' + g.days + '日）を取り消しますか？', '取り消す', 'danger').then(function (yes) {
        if (!yes) return;
        ui.run(function () {
          var args = { mode: 'cancel', employeeId: p.employeeId, grantId: g.grantId, baseVersion: g.recordVersion, reason: '' };
          return MP.api.call('leave.admin.grant.save', Object.assign({ dryRun: true }, args)).then(function (res) {
            if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
            var ch = res.data.closedChanges;
            var go = ch.length ? ui.confirm('締めた期間の振り分けが変わります', ch.length + '日の振り分けが変わります。取り消しますか？', '取り消す', 'danger') : Promise.resolve(true);
            return go.then(function (yes2) {
              if (!yes2) return;
              return save('leave.admin.grant.save', Object.assign({ confirmClosed: ch.length > 0 }, args)).then(function (r2) {
                if (!r2.ok) { ui.pageMessage(r2.message, 'error'); return; }
                return load(false).then(function () { ui.pageMessage('付与を取り消しました', 'ok'); });
              });
            });
          });
        });
      });
    }

    function rebuild(id) {
      return save('leave.admin.rebuild', { employeeId: id }).then(function (res) {
        if (!res.ok) { ui.pageMessage(res.message, 'error'); return; }
        var bad = res.data.results.filter(function (r) { return !r.ok; }).length;
        var recalc = [];
        res.data.results.forEach(function (r) { (r.recalcDays || []).forEach(function (d) { recalc.push(jp(d)); }); });
        var text = bad ? bad + '人は作り直せませんでした。もう一度押してください' : '作り直しました' + (recalc.length ? '。日報の計算し直しが要る日が残っています: ' + recalc.join('・') + '（日報の画面で「計算し直す」）' : '');
        return load(false).then(function () { ui.pageMessage(text, bad || recalc.length ? 'warn' : 'ok'); });
      });
    }

    function renderClosed() {
      var ul = ui.clear(ui.$('closed'));
      if (!data.closedChanges.length) { ul.appendChild(ui.el('li', { class: 'sub', text: '最近の変化はありません' })); return; }
      data.closedChanges.forEach(function (c) {
        ul.appendChild(ui.el('li', {}, [
          ui.el('div', { class: 'item-title', text: c.name + ' ' + jp(c.date) }),
          ui.el('div', { text: LV.changeText('休暇の振り分け（自動）', c.before, c.after) }),
          ui.el('div', { class: 'sub', text: ui.fmtDateTime(c.at) + '・' + c.by }),
        ]));
      });
    }

    ui.$('seen-all').addEventListener('click', function () { ui.run(seenAll); });
    ui.$('rebuild-all').addEventListener('click', function () { ui.run(function () { return rebuild(null); }); });
    return load(true);
  });
})();
