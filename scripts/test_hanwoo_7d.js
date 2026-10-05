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

console.log(`\n${n}개 모두 통과`);
