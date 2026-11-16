/*
 * 画面のファイル（HTML・CSS・JS・アイコン）を端末に覚える（計画 stage1-step12-sw-plan.md）
 * - データ（GAS とのやり取り）は一切覚えない: GET 以外・別のサイト・範囲の外・決めた種類以外には手を出さない
 * - HTML はまずネット。通信そのものが失敗したときだけ、覚えた分を出す。鍵は「?」より後ろを外した住所
 * - 部品（CSS・JS・アイコン）はまず覚えた分。出した後に、裏で 1 回だけ取り直して差し替える
 * - 版は、覚える場所の名前と片付けにだけ使う。通信の扱いは版によらず同じ
 * - 開いている画面を途中で横取りしない（すぐの交代・すぐの引き取りはしない。交代は画面がすべて閉じた後）
 * - 止めるときは tools/sw_stop.js をこの名前で置く（このファイルを消すだけでは、端末に登録が残る）
 */
'use strict';

var VERSION = '18'; // web/js/config.js の APP_VERSION と同じ値（tests/web_static_test.js が確かめる）
var PREFIX = 'portal-v';
var CACHE = PREFIX + VERSION;
var PAGE_PATH = /(?:\.html|\/)$/;
var PART_PATH = /\.(?:js|css|png|svg|ico|json)$/;
var PART_QUERY = /^(?:\?v=[A-Za-z0-9._-]{1,20})?$/; // 「?」が無いか、版だけ
var refreshed = {}; // 裏で取り直した住所（起きている間だけの控え）

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

self.addEventListener('install', noop);

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
