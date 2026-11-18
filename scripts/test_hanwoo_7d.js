// 3단계 극소수 데이터 테스트: 위젯의 날짜 규칙과 셀 판정.  실행: node scripts/test_hanwoo_7d.js
const assert = require('node:assert/strict');
const h = require('../js/hanwoo-7d.js');

// 한국시간 y-m-d h:mi → epoch ms (KST = UTC+9)
const kst = (y, m, d, hh, mi) => Date.UTC(y, m - 1, d, hh - 9, mi);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('통과 ', name); };

t('10시 경계: 09:59는 그제, 10:00은 어제', () => {
  assert.equal(h.endDate(kst(2026, 10, 5, 9, 59)), '20261003');
  assert.equal(h.endDate(kst(2026, 10, 5, 10, 0)), '20261004');
});
t('UTC로는 전날인 KST 새벽도 한국 날짜로 계산', () => {
  assert.equal(h.endDate(kst(2026, 10, 5, 8, 30)), '20261003'); // UTC 10/4 23:30
  assert.equal(h.endDate(kst(2026, 10, 5, 23, 59)), '20261004');
});
t('월말·연말·윤년 경계', () => {
  assert.equal(h.endDate(kst(2026, 10, 1, 9, 0)), '20260929');
  assert.equal(h.endDate(kst(2027, 1, 1, 11, 0)), '20261231');
  assert.equal(h.endDate(kst(2026, 3, 1, 9, 30)), '20260227');
  assert.equal(h.endDate(kst(2028, 3, 1, 11, 0)), '20280229');
});

// 9/21~10/4 수집분: 주말과 추석(9/24·9/25)은 세 시장 모두 휴장
const dates = [];
for (let d = new Date(Date.UTC(2026, 8, 21)); d <= Date.UTC(2026, 9, 4); d.setUTCDate(d.getUTCDate() + 1))
  dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
const closedDays = ['20260924', '20260925', '20260926', '20260927', '20261003', '20261004'];
const mk = (over = {}) => ({
  dates, markets: [{ code: '0513', name: '음성' }], sexes: [{ code: '025003', name: '거세' }], grades: ['1++A'],
  fetches: dates.map(date => ({
    date, market: '0513', sex: '025003',
    status: over[date] || (closedDays.includes(date) ? 'closed' : 'ok'),
    grades: { '1++A': { amt: 29000, cnt: 3 } },
  })),
});

t('경매일 7일: 휴장일을 건너뛰고 끝 날짜에서 거슬러 7일', () => {
  const p = h.pickDates(mk(), kst(2026, 10, 5, 10, 0));
  assert.deepEqual(p.dates, ['20260922', '20260923', '20260928', '20260929', '20260930', '20261001', '20261002']);
  assert.equal(p.stale, false);
});
t('10시 전이면 끝 날짜가 하루 당겨진다', () => {
  const p = h.pickDates(mk(), kst(2026, 10, 2, 9, 0)); // 끝 = 9/30
  assert.deepEqual(p.dates.slice(-2), ['20260929', '20260930']);
  assert.equal(p.dates.length, 6, '9/21부터 수집했으므로 9/30까지 경매일은 6일');
});
t('수집 오류 난 날은 빠지지 않고 남는다', () => {
  const p = h.pickDates(mk({ '20261001': 'error' }), kst(2026, 10, 5, 10, 0));
  assert.ok(p.dates.includes('20261001'));
});
t('끝 날짜가 아직 수집 전이면 stale', () => {
  const d = mk(); d.dates = dates.filter(x => x <= '20261002'); d.fetches = d.fetches.filter(f => f.date <= '20261002');
  assert.equal(h.pickDates(d, kst(2026, 10, 5, 10, 0)).stale, true);
});

t('끝 날짜가 pending이면 빼고 stale (업로드 지연·평일 공휴일)', () => {
  const p = h.pickDates(mk({ '20261002': 'pending' }), kst(2026, 10, 3, 10, 0)); // 끝 = 10/2(금)
  assert.equal(p.dates.includes('20261002'), false);
  assert.equal(p.dates[p.dates.length - 1], '20261001');
  assert.equal(p.stale, true);
});

t('셀 판정: 값 없음은 0이 아니라 – / 휴장 / 오류 / 미수집', () => {
  const idx = h.indexFetches({ fetches: [
    { date: 'D1', market: 'M', sex: 'S', status: 'ok', grades: { A: { amt: 28695, cnt: 8 }, B: null, Z: { amt: 0, cnt: 1 } } },
    { date: 'D2', market: 'M', sex: 'S', status: 'closed', grades: { A: null } },
    { date: 'D3', market: 'M', sex: 'S', status: 'error' },
  ] });
  assert.equal(h.cell(idx, 'D1', 'M', 'S', 'A').text, '28,695');
  assert.equal(h.cell(idx, 'D1', 'M', 'S', 'B').text, '–');
  assert.equal(h.cell(idx, 'D1', 'M', 'S', 'C').text, '오류', '등급 키 자체가 없으면 스키마 이상');
  assert.equal(h.cell(idx, 'D1', 'M', 'S', 'Z').text, '오류', '0원은 오류');
  assert.equal(h.cell(idx, 'D2', 'M', 'S', 'A').text, '휴장');
  assert.equal(h.cell(idx, 'D3', 'M', 'S', 'A').text, '오류');
  assert.equal(h.cell(idx, 'D9', 'M', 'S', 'A').text, '미수집');
});

t('한 성별만 출하가 없으면 휴장이 아니라 – (실데이터: 9/21 고령 암소)', () => {
  const idx = h.indexFetches({ fetches: [
    { date: 'D', market: 'G', sex: 'ste', status: 'ok', grades: { A: null } },
    { date: 'D', market: 'G', sex: 'cow', status: 'closed', grades: { A: null } },
    { date: 'D', market: 'B', sex: 'ste', status: 'closed', grades: { A: null } },
    { date: 'D', market: 'B', sex: 'cow', status: 'closed', grades: { A: null } },
  ] });
  assert.equal(h.cell(idx, 'D', 'G', 'cow', 'A', ['ste', 'cow']).text, '–');
  assert.equal(h.cell(idx, 'D', 'B', 'cow', 'A', ['ste', 'cow']).text, '휴장', '두 성별 모두 없으면 시장 휴장');
});

t('표: 고른 시장·성별의 등급 15줄, 육질등급 바뀌는 줄에 구분선', () => {
  const grades = ['1++', '1+', '1', '2', '3'].flatMap(q => ['A', 'B', 'C'].map(y => q + y));
  const d = { ...mk(), grades, sexes: [{ code: '025003', name: '거세' }, { code: '025001', name: '암소' }] };
  const html = h.renderTable(d, kst(2026, 10, 5, 10, 0), { market: '0513', sex: '025003' });
  assert.equal((html.match(/<tr/g) || []).length, 1 + 15);
  assert.equal((html.match(/class="group"/g) || []).length, 4);
  assert.ok(html.includes('<th>3C</th>') && !html.includes('등외'));
  assert.ok(html.includes('29,000 <span class="cnt">(3)</span>'), '단가 옆 괄호에 두수');
  assert.ok(!/휴장 <span class="cnt">/.test(html), '휴장·거래없음 칸에는 두수를 붙이지 않음');
  const ctl = h.renderControls({ markets: [{ code: 'a', name: '음성' }, { code: 'b', name: '고령' }], sexes: d.sexes }, { market: 'b', sex: '025003' });
  assert.ok(ctl.includes('data-code="b" aria-pressed="true"') && ctl.includes('data-code="a" aria-pressed="false"'));
});


// 한 달 추이: 10/1~10/2(목·금), 10/5(월)에 두 등급 묶음. 1++A·1++B가 묶여 '1++'가 된다.
const tdata = (() => {
  const g = (a, c) => ({ amt: a, cnt: c });
  const day = (date, grades) => ({ date, market: 'M', sex: 'S', status: 'ok', grades });
  const none = { '1++A': null, '1++B': null, '1+A': null };
  return { dates: ['20260901', '20261001', '20261002', '20261005'],
    markets: [{ code: 'M', name: 'm' }], sexes: [{ code: 'S', name: 's' }], grades: ['1++A', '1++B', '1+A'],
    fetches: [
      day('20260901', { '1++A': g(10000, 1), '1++B': null, '1+A': null }), // 30일 밖이라 제외돼야 함
      day('20261001', { '1++A': g(30000, 1), '1++B': g(20000, 3), '1+A': g(10000, 2) }),
      day('20261002', { '1++A': g(33000, 2), '1++B': null, '1+A': null }),
      day('20261005', { '1++A': g(36000, 1), '1++B': g(24000, 1), '1+A': g(12000, 4) }),
    ] };
})();
const tnow = kst(2026, 10, 6, 10, 0), tsel = { market: 'M', sex: 'S' };

t('추이: 30일 밖 날짜 제외, 묶음은 두수 가중평균, 값 없는 날은 null', () => {
  const tr = h.trend(tdata, tnow, tsel);
  assert.deepEqual(tr.dates, ['20261001', '20261002', '20261005']);
  const g1 = tr.groups.find(g => g.key === '1++');
  assert.equal(g1.points[0].avg, 22500, '(30000*1 + 20000*3) / 4');
  assert.equal(g1.points[1].avg, 33000, '한 등급만 있는 날은 그 값');
  assert.equal(g1.points[2].avg, 30000, '(36000 + 24000) / 2');
  const g3 = tr.groups.find(g => g.key === '3');
  assert.ok(g3.points.every(p => p === null), '등급이 아예 없는 묶음은 전부 null(0 아님)');
});
t('추이: 변동률은 각 선의 첫 값을 0%로, 펼치면 A·B·C 줄', () => {
  const tr = h.trend(tdata, tnow, tsel);
  const rate = h.trendSeries(tr, 'rate', null).find(s => s.label === '1++');
  assert.equal(rate.points[0].v, 0);
  assert.ok(Math.abs(rate.points[2].v - (30000 / 22500 - 1) * 100) < 1e-9);
  const ex = h.trendSeries(tr, 'price', '1++');
  assert.deepEqual(ex.map(s => s.label), ['1++A', '1++B']);
  assert.equal(h.trendSeries(tr, 'price', null).length, 5);
});
t('추이: 전체(등외제외) 평균 선 — API 값 그대로, total 없는 날은 null, 항상 마지막 선', () => {
  const d = JSON.parse(JSON.stringify(tdata));
  d.fetches.find(f => f.date === '20261001').total = { amt: 25501, cnt: 270 };
  d.fetches.find(f => f.date === '20261005').total = { amt: 26000, cnt: 6 };
  // 20261002는 total 키 없음(옛 저장분)
  const tr = h.trend(d, tnow, tsel);
  assert.deepEqual(tr.total.points.map(p => p && p.avg), [25501, null, 26000]);
  const ser = h.trendSeries(tr, 'price', null);
  assert.equal(ser.length, 6, '5묶음 + 전체');
  assert.equal(ser[5].label, '전체'); assert.equal(ser[5].total, true);
  assert.equal(h.trendSeries(tr, 'price', '1++').slice(-1)[0].label, '전체', '세부등급을 펼쳐도 전체 선은 남는다');
  const svg = h.renderTrend(tr, 'price', null);
  assert.ok(svg.includes('stroke-width="3.5"') && svg.includes('>전체<'));
  assert.ok(h.trendLegend(tr, null).includes('h7d-lg-total') && h.trendLegend(tr, null).includes('26,000'));
  assert.ok(!h.trendLegend(h.trend(tdata, tnow, tsel), null).includes('h7d-lg-total'), 'total이 전혀 없으면 칩을 만들지 않는다');
});
t('추이: SVG에 선·날짜 칸 생성, 평균 없는 묶음은 선 없음, 데이터 부족하면 안내 문구', () => {
  const tr = h.trend(tdata, tnow, tsel);
  const svg = h.renderTrend(tr, 'price', null);
  assert.equal((svg.match(/<path /g) || []).length, 2, '데이터 있는 묶음(1++, 1+)만 선');
  assert.equal((svg.match(/class="hit"/g) || []).length, 3);
  assert.ok(h.renderTrend({ dates: ['20261001'], groups: tr.groups }, 'price', null).includes('부족'));
  assert.ok(h.trendTooltip(tr, 'price', null, 0).includes('22,500원 · 4두'));
  const lg = h.trendLegend(tr, '1++');
  assert.ok(lg.includes('data-key="1++" aria-pressed="true"') && lg.includes('▲'));
  assert.equal(h.niceStep(7000), 2000);
});

console.log(`\n${n}개 모두 통과`);
