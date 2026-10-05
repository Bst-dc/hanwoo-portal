/* 한우 세부등급(등외 제외) 7일 시세 위젯: data/hanwoo_7d.json(GitHub Actions가 매일 갱신)을 읽어 표로 그린다.
   날짜 계산·셀 판정은 순수 함수로 두어 node에서 단위 테스트한다(scripts/test_hanwoo_7d.js). */
(function (root) {
  'use strict';

  var WINDOW = 7;
  var CUTOFF_HOUR = 10; // 도매시장 전날 데이터가 오전 10시경 올라온다
  var KST_OFFSET_MS = 9 * 3600 * 1000;
  var WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  var FEW_HEAD = 2; // 이 두수 이하는 흐리게: 1~2두 값은 시세로 읽기 어렵다

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // Date.UTC가 0일·음수일을 앞 달로 넘겨주므로 월말·연말 경계도 그대로 처리된다
  function toYmd(y, m, d) {
    var t = new Date(Date.UTC(y, m, d));
    return t.getUTCFullYear() + pad(t.getUTCMonth() + 1) + pad(t.getUTCDate());
  }

  /** 접속 시각(epoch ms)을 한국시간으로 보고, 10시 전이면 오늘-2일·이후면 오늘-1일이 표의 끝 날짜. */
  function endDate(epochMs) {
    var k = new Date(epochMs + KST_OFFSET_MS); // 브라우저 시간대와 무관하게 UTC 필드로 KST를 읽는다
    var back = k.getUTCHours() < CUTOFF_HOUR ? 2 : 1;
    return toYmd(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - back);
  }

  /** 끝 날짜 이전에서 경매가 있었던 최근 7일(오래된 날짜가 앞).
      세 시장 모두 휴장인 날만 뺀다. 수집 오류가 난 날은 빼지 않아야 '오류'로 드러난다.
      stale: 끝 날짜가 아직 수집 전이거나 pending(평일인데 전 시장 휴장 응답 = 업로드 전 또는 공휴일)
      — 하루 전 표를 최신처럼 보이지 않게 한다. */
  function pickDates(data, epochMs) {
    var end = endDate(epochMs);
    var st = {};
    (data.fetches || []).forEach(function (f) {
      var s = st[f.date] || (st[f.date] = { closed: true, pending: false });
      if (f.status !== 'closed') s.closed = false;
      if (f.status === 'pending') s.pending = true;
    });
    var all = (data.dates || []).slice().sort();
    var dates = all.filter(function (d) {
      return d <= end && !(st[d] && (st[d].closed || st[d].pending));
    }).slice(-WINDOW);
    return { end: end, dates: dates, stale: all.indexOf(end) < 0 || !!(st[end] && st[end].pending) };
  }

  function dateLabel(ymd) {
    var y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
    return m + '/' + d + '(' + WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] + ')';
  }

  function indexFetches(data) {
    var idx = {};
    (data.fetches || []).forEach(function (f) { idx[f.date + '|' + f.market + '|' + f.sex] = f; });
    return idx;
  }

  /** 셀 하나의 상태. 값이 없을 때 0을 만들지 않는 것이 핵심(조용한 실패 방지).
      sexCodes를 주면, 같은 날 같은 시장의 다른 성별은 경매가 있었을 때 '휴장' 대신 '–'(그 성별 출하 없음). */
  function cell(idx, date, market, sex, grade, sexCodes) {
    var f = idx[date + '|' + market + '|' + sex];
    if (!f) return { kind: 'missing', text: '미수집' };
    if (f.status === 'closed') {
      var marketOpen = (sexCodes || []).some(function (s) {
        var o = idx[date + '|' + market + '|' + s];
        return o && o.status === 'ok';
      });
      return marketOpen ? { kind: 'none', text: '–' } : { kind: 'closed', text: '휴장' };
    }
    if (f.status === 'pending') return { kind: 'missing', text: '대기' };
    if (f.status !== 'ok') return { kind: 'error', text: '오류' };
    var g = f.grades ? f.grades[grade] : undefined;
    if (g === null) return { kind: 'none', text: '–' };
    if (!g || typeof g.amt !== 'number' || !isFinite(g.amt) || g.amt <= 0) return { kind: 'error', text: '오류' };
    return { kind: 'ok', text: g.amt.toLocaleString('ko-KR'), amt: g.amt, cnt: g.cnt };
  }

  /** 고른 시장·성별 하나의 표: 등급 15줄 × 경매일 7칸. 육질등급(1++, 1+, 1, 2, 3)이 바뀌는 줄에 구분선. */
  function renderTable(data, epochMs, sel) {
    var dates = pickDates(data, epochMs).dates;
    var idx = indexFetches(data);
    var sexCodes = data.sexes.map(function (s) { return s.code; });
    var h = '<table class="h7d"><thead><tr><th>등급</th>';
    dates.forEach(function (d) { h += '<th class="num">' + dateLabel(d) + '</th>'; });
    h += '</tr></thead><tbody>';
    data.grades.forEach(function (g, gi) {
      var newQuality = gi > 0 && g.slice(0, -1) !== data.grades[gi - 1].slice(0, -1);
      h += '<tr' + (newQuality ? ' class="group"' : '') + '><th>' + g + '</th>';
      dates.forEach(function (d) {
        var c = cell(idx, d, sel.market, sel.sex, g, sexCodes);
        var few = c.kind === 'ok' && c.cnt <= FEW_HEAD ? ' few' : '';
        var cnt = c.kind === 'ok' && typeof c.cnt === 'number' ? ' <span class="cnt">(' + c.cnt + ')</span>' : '';
        h += '<td class="num c-' + c.kind + few + '">' + c.text + cnt + '</td>';
      });
      h += '</tr>';
    });
    return h + '</tbody></table>';
  }

  function renderControls(data, sel) {
    function group(label, key, items) {
      return '<div class="h7d-seg" role="group" aria-label="' + label + '">' + items.map(function (it) {
        return '<button type="button" data-key="' + key + '" data-code="' + it.code + '" aria-pressed="' +
          (sel[key] === it.code) + '">' + it.name + '</button>';
      }).join('') + '</div>';
    }
    return group('도매시장', 'market', data.markets) + group('성별', 'sex', data.sexes);
  }

  function load(el, url) {
    var now = Date.now();
    var table = el.querySelector('[data-h7d-table]');
    var controls = el.querySelector('[data-h7d-controls]');
    var meta = el.querySelector('[data-h7d-meta]');
    return fetch(url || 'data/hanwoo_7d.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var pick = pickDates(data, now);
        var sel = { market: data.markets[0].code, sex: data.sexes[0].code };
        function draw() {
          controls.innerHTML = renderControls(data, sel);
          table.innerHTML = renderTable(data, now, sel);
        }
        controls.addEventListener('click', function (ev) {
          var b = ev.target.closest('button[data-key]');
          if (!b) return;
          sel[b.getAttribute('data-key')] = b.getAttribute('data-code');
          draw();
        });
        draw();
        var gen = String(data.generatedAt || '').replace('T', ' ').slice(0, 16);
        meta.textContent = (data.dummy ? '[개발용 가짜 데이터] ' : '') +
          (pick.stale ? '⚠ ' + dateLabel(pick.end) + ' 시세가 아직 없습니다(갱신 대기 또는 공휴일). ' : '') +
          '단위 원/kg(결함포함 평균 경락가) · 괄호는 두수 · 흐린 숫자는 ' + FEW_HEAD + '두 이하 거래 · – 거래 없음 · 수집 ' + gen;
      })
      .catch(function (e) {
        // 실패하면 가짜 숫자 대신 실패했다는 사실만 보여준다
        table.innerHTML = '<p class="h7d-msg">시세를 불러오지 못했습니다. (' + e.message + ')</p>';
        meta.textContent = '';
      });
  }

  var api = { endDate: endDate, pickDates: pickDates, dateLabel: dateLabel, indexFetches: indexFetches, cell: cell,
    renderTable: renderTable, renderControls: renderControls, load: load };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hanwoo7d = api;
})(this);
