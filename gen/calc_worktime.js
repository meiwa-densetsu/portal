// 自動生成（tools/build.js）。直接編集しない。正本: shared/calc_worktime.js
/**
 * 画面とサーバーで共有する計算（正本）。GAS のサービス（SpreadsheetApp など）は使わない純粋な JS。
 * tools/build.js が GAS 用（server/gen_calc_worktime.js）とブラウザ用（web/gen/calc_worktime.js）を生成する。
 * 生成物は直接編集しない。
 *
 * 手順1では時刻の変換だけ。休憩・実働・残業の計算は手順4で、ユーザーから計算式を受け取ってから書く
 * （計画 第5章 5-1 は仮の案。第7章⑦）。
 */
var CalcWorktime = (function () {
  'use strict';

  /** 計算ルールの版。計算の中身を変えたら上げる（日報に「計算ルールの世代」として残す） */
  var VERSION = 1;

  /**
   * 'H:MM' または 'HH:MM' を「その日の0時からの分」に変える。形が違えば null。
   * maxMinutes … 受け付ける最大の分（出勤は 23:59 = 1439、退勤は日またぎを含めて 47:59 = 2879）
   */
  function parseHm(text, maxMinutes) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
    if (!m) return null;
    var h = Number(m[1]);
    var min = Number(m[2]);
    if (min > 59) return null;
    var total = h * 60 + min;
    var max = typeof maxMinutes === 'number' ? maxMinutes : 1439;
    if (total > max) return null;
    return total;
  }

  /** 分を 'H:MM' に変える（510 → '8:30'、1530 → '25:30'）。整数でない・負の値は null */
  function formatHm(minutes) {
    if (typeof minutes !== 'number' || !isFinite(minutes) || minutes < 0 || Math.floor(minutes) !== minutes) return null;
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return h + ':' + (m < 10 ? '0' + m : String(m));
  }

  return { VERSION: VERSION, parseHm: parseHm, formatHm: formatHm };
})();
