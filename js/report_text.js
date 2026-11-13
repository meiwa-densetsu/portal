/*
 * 日報の画面（1日ずつ・表）で共通の言葉。共有の計算（CalcReport）の誤りの code → 画面の文
 */
(function () {
  'use strict';
  MP.reportText = {
    MESSAGES: {
      EMPTY: '時刻を4つともそろえて入れてください', FORMAT: '形が正しくありません', STEP: '30分単位で入れてください',
      ORDER: '時刻の順番を確かめてください', SAME: '出社と退社が同じです', TOO_LONG: '24時間以上の勤務は入れられません',
      TOO_MANY: '勤務は2つ（日勤と夜勤）までです', TWO_DAY: '同じ日に日勤を2つは入れられません（夜勤は0時をまたぐか、0:00〜4:30に出社）',
      TWO_NIGHT: '同じ日に夜勤を2つは入れられません', TOO_LONG_TEXT: '文字が多すぎます', NEWLINE: '改行は入れられません',
      OVERLAP: '前後の勤務と時間が重なっています', SLOT_MISMATCH: '今の決まりでは計算できません。管理者に連絡してください',
      CONTENT_ONLY: '時刻の無い施工内容（有給など）は、ほかに勤務が無い日だけ入れられます',
    },
    WITH: { prevNight: '前の日の夜勤', day: 'この日の日勤', night: 'この日の夜勤', nextDay: '次の日の日勤', nextNight: '次の日の夜勤' },
  };
})();
