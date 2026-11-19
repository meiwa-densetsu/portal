/* ホーム（入口。メニューは決まった中身なので、控えの「自分の情報」があればすぐ出す。計画 stage2-switch-speed-plan.md 1-2）
 * 段階4（計画 stage4-board-plan.md 第3-1節・11-3・11-5）: 社内ポータル（安否確認・受付・お知らせ・リンク）を portal.home の 1 回の読み込みで出す。
 *   端末の控え（MP.store.homeView。見出しだけ）があれば先に出し、本物の答えが来たらすべて置き換える（本物に無いものは消える）。
 *   控えは本人のログインのときだけ書く（答えを頼んだときのログインが今と同じ・見ている間でない・共有のログインでない）
 */
(function () {
  'use strict';
  MP.boot.start(function () {
    var ui = MP.ui, el = ui.el;
    var VERSION_WAIT_MS = 2000; // 控えの仕組み（sw.js）の答えを待つ長さ。来なければ「なし」
    var asked = false;

    /** 今この画面を受け持っている sw.js に版を聞く → 版の文字か null（受け持つものが無い・答えが来ない・形が違う） */
    function swVersion() {
      return new Promise(function (resolve) {
        var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
        if (!sw || typeof MessageChannel !== 'function') { resolve(null); return; }
        var ch = new MessageChannel();
        var timer = setTimeout(function () { resolve(null); }, VERSION_WAIT_MS);
        ch.port1.onmessage = function (ev) {
          clearTimeout(timer);
          var v = ev.data && ev.data.version;
          resolve(typeof v === 'string' && /^[A-Za-z0-9._-]{1,20}$/.test(v) ? v : null);
        };
        try { sw.postMessage({ type: 'version' }, [ch.port2]); } catch (e) { clearTimeout(timer); resolve(null); }
      });
    }

    /** 管理者のホームにだけ、一番下に「画面の版 22・控えの仕組み 22」（計画 stage2-calendar-import-sw-plan.md 第6章） */
    function showVersion(me) {
      var p = MP.ui.$('app-version');
      var admin = MP.guard.isAdmin(me);
      p.hidden = !admin;
      if (!admin || asked) return;
      asked = true;
      var app = '画面の版 ' + MP.config.APP_VERSION;
      p.textContent = app + '・控えの仕組み 確かめています';
      swVersion().then(function (v) { p.textContent = app + '・控えの仕組み ' + (v || 'なし'); });
    }

    /** メニューを出す（管理者・部長のメニューの出し分け）。本物の答えが来たら、もう一度呼ばれる */
    function show(me) {
      MP.ui.$('home').hidden = false;
      MP.ui.$('admin-menu').hidden = !MP.guard.isAdmin(me);
      MP.ui.$('manager-menu').hidden = me.role !== '部長'; // 部長の一覧（手順9）。管理者は管理者のメニューから
      MP.ui.$('portal-admin-menu').hidden = !MP.guard.isAdmin(me);
      MP.ui.$('portal-manager-menu').hidden = me.role !== '部長';
      showVersion(me);
    }

    /**
     * 休暇（段階2。計画 stage2-leave-plan.md 第10章 Q10）: 管理者のホームの上に「申請している人がいます（◯件）」「有給の付与の確認待ち（◯人）」。
     * 押すと休暇の管理の画面。部長・社員には出さない。件数は portal.home の答え（leave。leave.admin.unseen と同じ数え方）から出し、別に聞かない
     * （ホームの問い合わせは 1 回。stage4-board-plan.md 24-16）。数えられなかった（null）ときは何も出さない。端末には控えない
     */
    function leaveBanner(me, d) {
      var box = MP.ui.$('leave-banner');
      var lines = MP.guard.isAdmin(me) && !MP.guard.viewing() && d && typeof d === 'object' ? MP.leaveView.bannerText(d.unseen, d.pendingGrants) : [];
      MP.ui.clear(box);
      box.hidden = !lines.length;
      if (lines.length) box.appendChild(MP.ui.el('a', { href: 'admin_leave.html', text: lines.join('・') + '（休暇の管理へ）' }));
    }

    // ---- 社内ポータルの欄（段階4）----
    function renderSafety(s) {
      var box = ui.clear(ui.$('portal-safety'));
      box.hidden = !(s && s.active);
      if (box.hidden) return;
      var training = s.training ? '【訓練】' : '';
      if (s.answered) {
        box.className = 'card safety-card done';
        box.appendChild(el('p', { class: 'safety-head', text: training + '安否確認（' + s.title + '）に答えました' }));
        box.appendChild(el('div', { class: 'menu' }, [el('a', { class: 'btn', href: 'safety.html', text: '答えを見る・直す' })]));
        return;
      }
      box.className = 'card safety-card';
      box.appendChild(el('p', { class: 'safety-head', text: training + '安否確認: 答えてください' }));
      box.appendChild(el('p', { class: 'sub', text: s.title }));
      box.appendChild(el('div', { class: 'menu' }, [el('a', { class: 'btn danger', href: 'safety.html', id: 'safety-go', text: '安否を答える' })]));
    }

    function renderForms(list) {
      var box = ui.$('portal-forms');
      var ul = ui.clear(ui.$('form-list'));
      box.hidden = !list.length;
      list.forEach(function (f) {
        var tags = [];
        if (f.confirmedDate) tags.push(el('span', { class: 'tag ok', text: '日程が決まりました ' + MP.portal.dateLabel(f.confirmedDate) }));
        else if (f.open && !f.answered) tags.push(el('span', { class: 'tag warn', text: '回答をお願いします' }));
        else if (f.answered) tags.push(el('span', { class: 'tag ok', text: '回答済み' }));
        ul.appendChild(el('li', { 'data-form': f.formId }, [
          el('a', { class: 'item-title', href: 'form.html?id=' + encodeURIComponent(f.formId), text: f.title }),
          el('div', { class: 'item-tags' }, tags),
          f.deadlineLabel && !f.confirmedDate ? el('div', { class: 'sub', text: '締切 ' + f.deadlineLabel }) : null,
        ]));
      });
    }

    function renderPosts(list, more, unreadImportant) {
      var box = ui.$('portal-posts');
      var ul = ui.clear(ui.$('post-list'));
      box.hidden = false;
      if (!list.length) ul.appendChild(el('li', { class: 'sub', text: 'お知らせはありません' }));
      list.forEach(function (p) {
        ul.appendChild(el('li', { 'data-post': p.postId }, [
          el('a', { class: 'item-title', href: 'board.html?id=' + encodeURIComponent(p.postId), text: p.title }),
          el('div', { class: 'item-tags' }, [
            p.important ? el('span', { class: 'tag off', text: '重要' }) : null,
            p.read ? null : el('span', { class: 'tag warn', text: p.important ? '「読みました」を押してください' : '未読' }),
            el('span', { class: 'sub', text: MP.portal.dateLabel(p.date) }),
          ]),
        ]));
      });
      if (more) ul.appendChild(el('li', { class: 'sub', text: 'ほかにもお知らせがあります' }));
      if (unreadImportant > 0) ul.appendChild(el('li', { class: 'sub', text: '重要なお知らせで、まだ「読みました」を押していないものが ' + unreadImportant + ' 件あります' }));
    }

    function renderLinks(list) {
      var box = ui.clear(ui.$('link-list'));
      ui.$('portal-links').hidden = !list.length;
      list.forEach(function (l) {
        var a = MP.portal.link(l.name, l.url);
        if (a.tagName === 'A') a.className = 'btn';
        box.appendChild(a);
      });
    }

    function renderPortal(d, stale) {
      if (!d || typeof d !== 'object') return;
      renderSafety(d.safety || null);
      renderForms(Array.isArray(d.forms) ? d.forms : []);
      renderPosts(Array.isArray(d.posts) ? d.posts : [], d.postsMore === true, typeof d.unreadImportant === 'number' ? d.unreadImportant : 0);
      renderLinks(Array.isArray(d.links) ? d.links : []);
      ui.$('portal-stale').hidden = !stale;
    }

    /** 端末に控える形（見出しだけ。健康診断の確定日・本文は入れない。計画 11-3） */
    function forCache(d) {
      return {
        posts: (d.posts || []).map(function (p) { return { postId: p.postId, title: p.title, important: p.important, date: p.date, read: p.read }; }),
        postsMore: d.postsMore === true, unreadImportant: d.unreadImportant || 0,
        links: (d.links || []).map(function (l) { return { linkId: l.linkId, name: l.name, url: l.url }; }),
        forms: (d.forms || []).filter(function (f) { return !f.confirmedDate || f.open; }).map(function (f) {
          return { formId: f.formId, kind: f.kind, title: f.title, deadline: f.deadline, deadlineLabel: f.deadlineLabel, open: f.open, answered: f.answered, confirmedDate: '' };
        }),
        safety: d.safety && d.safety.active ? { active: true, checkId: d.safety.checkId, title: d.safety.title, training: d.safety.training, answered: d.safety.answered } : { active: false },
      };
    }

    /** 本物の答え（me と portal.home の答え） */
    function real(me, res) {
      show(me);
      if (!res || !res.ok) return;
      renderPortal(res.data, false);
      leaveBanner(me, res.data.leave);
      if (!me.viewAs) {
        MP.store.setHomeView(me.employeeId, forCache(res.data), res.sentMark);
        if (MP.remind && MP.remind.safety && res.data.safety) MP.remind.safety(res.data.safety, res.sentMark);
      }
    }

    return MP.guard.enter({ instant: true, noLoadingNote: true, load: { action: 'portal.home' }, onMe: real }).then(function (entered) {
      if (entered.early) {
        show(entered.me);
        renderPortal(MP.store.homeView(), true); // 控え（無ければ何も出さない）
        return;
      }
      real(entered.me, entered.res);
    });
  });
})();
