/*
 * 画面のファイル（HTML・CSS・JS・アイコン）を端末に覚える（計画 stage1-step12-sw-plan.md）
 * - データ（GAS とのやり取り）は一切覚えない: GET 以外・別のサイト・範囲の外・決めた種類以外には手を出さない
 * - HTML はまずネット。通信そのものが失敗したときだけ、覚えた分を出す。鍵は「?」より後ろを外した住所
 * - 部品（CSS・JS・アイコン）はまず覚えた分。出した後に、裏で 1 回だけ取り直して差し替える
 * - 版は、覚える場所の名前と片付けにだけ使う。通信の扱いは版によらず同じ
 * - 新しい版のインストールで、画面のファイルをすべて先に覚える（PRECACHE。1 つでも取れなければインストールを失敗にする。計画 stage2-calendar-import-sw-plan.md 第3章）
 * - 開いている画面を途中で横取りしない（すぐの交代・すぐの引き取りはしない。交代は画面がすべて閉じた後）
 * - 止めるときは tools/sw_stop.js をこの名前で置く（このファイルを消すだけでは、端末に登録が残る）
 */
'use strict';

var VERSION = '25'; // web/js/config.js の APP_VERSION と同じ値（tests/web_static_test.js が確かめる）
var PREFIX = 'portal-v';
var CACHE = PREFIX + VERSION;
var PAGE_PATH = /(?:\.html|\/)$/;
var PART_PATH = /\.(?:js|css|png|svg|ico|json)$/;
var PART_QUERY = /^(?:\?v=[A-Za-z0-9._-]{1,20})?$/; // 「?」が無いか、版だけ
var refreshed = {}; // 裏で取り直した住所（起きている間だけの控え）

// 新しい版のインストールのときに、まとめて覚えるファイル（計画 stage2-calendar-import-sw-plan.md 第3章）。
// すべての HTML（鍵は「?」より後ろを外した住所）・入口の ./・HTML が読む部品（HTML に書いてあるとおりの ?v= 付き）・manifest とそのアイコン。
// tests/web_static_test.js が、web/ の中身とちょうど同じか・?v= が VERSION と同じかを確かめる（足し忘れ・ずれを止める）
var PRECACHE = [
  './', 'admin_bulk.html', 'admin_calendars.html', 'admin_changes.html', 'admin_closing.html', 'admin_departments.html', 'admin_devices.html',
  'admin_employee_calendar.html', 'admin_employees.html', 'admin_export.html', 'admin_legal.html', 'admin_task_export.html', 'devices.html',
  'home.html', 'index.html', 'invite.html', 'login.html', 'manager.html', 'my_numbers.html', 'password.html', 'register.html', 'report.html', 'report_grid.html',
  'share.html', 'share_view.html', 'task_recurring.html', 'task_requests.html', 'tasks.html', 'css/style.css?v=25', 'gen/calc_calendar.js?v=25',
  'gen/calc_report.js?v=25', 'gen/calc_task.js?v=25', 'gen/calc_worktime.js?v=25', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'js/api.js?v=25', 'js/boot.js?v=25', 'js/bulk.js?v=25',
  'js/bulk_book.js?v=25', 'js/calendar_import.js?v=25', 'js/calendar_view.js?v=25', 'js/config.js?v=25', 'js/export_book.js?v=25',
  'js/export_layout.js?v=25', 'js/grid.js?v=25', 'js/grid_core.js?v=25', 'js/guard.js?v=25', 'js/page_admin_bulk.js?v=25',
  'js/page_admin_calendars.js?v=25', 'js/page_admin_changes.js?v=25', 'js/page_admin_closing.js?v=25', 'js/page_admin_departments.js?v=25',
  'js/page_admin_devices.js?v=25', 'js/page_admin_employee_calendar.js?v=25', 'js/page_admin_employees.js?v=25', 'js/page_admin_export.js?v=25',
  'js/page_admin_legal.js?v=25', 'js/page_admin_task_export.js?v=25', 'js/page_devices.js?v=25', 'js/page_home.js?v=25', 'js/page_index.js?v=25',
  'js/page_invite.js?v=25', 'js/page_login.js?v=25', 'js/page_manager.js?v=25', 'js/page_my_numbers.js?v=25', 'js/page_password.js?v=25', 'js/page_register.js?v=25',
  'js/page_report.js?v=25', 'js/page_report_grid.js?v=25', 'js/page_share.js?v=25', 'js/page_share_view.js?v=25', 'js/page_task_recurring.js?v=25',
  'js/page_task_requests.js?v=25', 'js/page_tasks.js?v=25', 'js/remind.js?v=25', 'js/report.js?v=25', 'js/report_text.js?v=25', 'js/store.js?v=25',
  'js/sw_register.js?v=25', 'js/task_dialogs.js?v=25', 'js/task_export_layout.js?v=25', 'js/task_import.js?v=25', 'js/task_item.js?v=25',
  'js/task_optimistic.js?v=25', 'js/task_view.js?v=25', 'js/ui.js?v=25', 'manifest.json', 'vendor/exceljs-4.4.0.min.js?v=25',
  'admin_pay.html', 'gen/calc_pay.js?v=25', 'js/page_admin_pay.js?v=25',
  'board.html', 'form.html', 'safety.html', 'admin_board.html', 'admin_links.html', 'admin_forms.html', 'admin_form_edit.html', 'admin_form_result.html', 'admin_safety.html',
  'gen/calc_form.js?v=25', 'js/portal_text.js?v=25', 'js/safety_pending.js?v=25', 'js/form_excel.js?v=25', 'js/page_board.js?v=25', 'js/page_form.js?v=25', 'js/page_safety.js?v=25',
  'js/page_admin_board.js?v=25', 'js/page_admin_links.js?v=25', 'js/page_admin_forms.js?v=25', 'js/page_admin_form_edit.js?v=25', 'js/page_admin_form_result.js?v=25',
  'js/page_admin_safety.js?v=25',
  'leave.html', 'admin_leave.html', 'admin_leave_start.html', 'js/leave_view.js?v=25', 'js/page_leave.js?v=25', 'js/page_admin_leave.js?v=25',
  'js/page_admin_leave_start.js?v=25', 'gen/calc_leave.js?v=25',
];

function noop() {}

/** 覚えてよい答えか（成功・自分のサイトのふつうの答え・転送されていない） */
function storable(res) {
  return !!res && res.ok === true && res.type === 'basic' && !res.redirected;
}

function put(key, res) {
  return caches.open(CACHE).then(function (c) { return c.put(key, res); }).then(null, noop);
}

function match(key) {
  return caches.open(CACHE).then(function (c) { return c.match(key); }).then(null, function () { return undefined; });
}

/** HTML: まずネット。答えが来たらそのまま返す（覚えるのは storable のときだけ）。通信の失敗のときだけ覚えた分 */
function page(event, req, url) {
  var key = url.origin + url.pathname;
  return fetch(req).then(function (res) {
    if (storable(res)) event.waitUntil(put(key, res.clone()));
    return res;
  }, function (err) {
    return match(key).then(function (hit) {
      if (hit) return hit;
      throw err;
    });
  });
}

/** 裏の取り直し（失敗は捨てる。覚えた分はそのまま） */
function refresh(key) {
  return fetch(key, { cache: 'no-cache' }).then(function (res) {
    if (storable(res)) return put(key, res);
  }).then(null, noop);
}

/** 部品: まず覚えた分。無ければネットから取って覚える */
function part(event, req) {
  var key = req.url;
  return match(key).then(function (hit) {
    if (hit) {
      if (!refreshed[key]) {
        refreshed[key] = true; // 取り直しを始める前に付ける（同じ住所を同時に読んでも 1 回だけ）
        event.waitUntil(refresh(key));
      }
      return hit;
    }
    return fetch(req).then(function (res) {
      if (storable(res)) event.waitUntil(put(key, res.clone()));
      return res;
    });
  });
}

/**
 * インストールの先読み: PRECACHE を 1 つずつ順に「取る → 書く」。HTTP の控えは使わない（古い版のファイルを入れない）。
 * 1 つでも取れない（storable でない・通信の失敗）・書けなければ失敗（put() と違い、失敗を握りつぶさない）。
 * 失敗したら新しい版の覚える場所を消してから失敗で終える（消すのに失敗しても失敗で終える）。半端な控えのまま新しい版に替わらない
 */
function precache() {
  return caches.open(CACHE).then(function (c) {
    var chain = Promise.resolve();
    PRECACHE.forEach(function (p) {
      var key = new URL(p, self.registration.scope).href;
      chain = chain.then(function () {
        return fetch(key, { cache: 'reload' }).then(function (res) {
          if (!storable(res)) throw new Error('先読みで取れないファイル: ' + p);
          return c.put(key, res);
        });
      });
    });
    return chain;
  }).then(null, function (err) {
    return caches.delete(CACHE).then(function () { throw err; }, function () { throw err; });
  });
}

self.addEventListener('install', function (event) {
  var job = precache();
  job.then(null, noop); // 失敗は waitUntil に伝える（ここは「だれも受けていない失敗」の知らせを出さないためだけ）
  event.waitUntil(job);
});

// 今この画面を受け持っている sw.js の版を答える（管理者のホームの一番下に出す。計画 第6章）。返すのは版の数字だけ。ほかの動きは変えない
self.addEventListener('message', function (event) {
  var d = event.data;
  var port = event.ports && event.ports[0];
  if (!d || d.type !== 'version' || !port) return;
  port.postMessage({ version: VERSION });
});

self.addEventListener('activate', function (event) {
  // 古い版の覚える場所だけを消す。消し終わるまで待つ。1 つの失敗で止めない
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k).then(null, noop); }));
  }).then(null, noop));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.url.indexOf(self.registration.scope) !== 0) return;
  if (/\/sw\.js$/.test(url.pathname)) return;
  if (req.mode === 'navigate' || PAGE_PATH.test(url.pathname)) {
    event.respondWith(page(event, req, url));
    return;
  }
  if (PART_PATH.test(url.pathname) && PART_QUERY.test(url.search)) event.respondWith(part(event, req));
});
