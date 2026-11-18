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
  function pickDates(data, epochMs, windowN) {
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
    }).slice(-(windowN || WINDOW));
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

  /* ───── 한 달 추이 ─────
     기본은 '시작 → 현재' 비교(renderDumbbell), '자세히 보기'를 누르면 등급별 작은 선 차트(renderMinis).
     2·3등급은 거래가 적어 뺐다(11-18). 전체 평균은 API가 준 등외제외 값을 그대로 쓴다. */
  var TREND_DAYS = 30;
  var QUALITIES = ['1++', '1+', '1'];
  var TOTAL_COLOR = '#161A19';
  var TREND_COLORS = { '1++': '#1F4E9C', '1+': '#2A9D8F', '1': '#E9A23B' };

  function fmt(n) { return Math.round(n).toLocaleString('ko-KR'); }

  /** 끝 날짜에서 30일 안의 경매일들(휴장일 제외). */
  function monthDates(data, epochMs) {
    var p = pickDates(data, epochMs, 60);
    var start = toYmd(+p.end.slice(0, 4), +p.end.slice(4, 6) - 1, +p.end.slice(6, 8) - (TREND_DAYS - 1));
    return { dates: p.dates.filter(function (d) { return d >= start; }), end: p.end, stale: p.stale };
  }

  /** 육질등급 묶음(1++·1+·1, A·B·C를 두수 가중평균)과 전체(등외제외) 평균의 일별 값.
      값이 없는 날은 0이 아니라 null — 선은 그 날을 건너뛰고 이어진다. */
  function trend(data, epochMs, sel) {
    var m = monthDates(data, epochMs), dates = m.dates;
    var idx = indexFetches(data);
    var sexCodes = data.sexes.map(function (x) { return x.code; });
    function gradePts(g) {
      return dates.map(function (d) {
        var c = cell(idx, d, sel.market, sel.sex, g, sexCodes);
        return c.kind === 'ok' && typeof c.cnt === 'number' && c.cnt > 0 ? { avg: c.amt, cnt: c.cnt } : null;
      });
    }
    var groups = QUALITIES.map(function (q) {
      var grades = data.grades.filter(function (g) { return g.slice(0, -1) === q; }).map(gradePts);
      var points = dates.map(function (d, i) {
        var sum = 0, cnt = 0;
        grades.forEach(function (pts) { var p = pts[i]; if (p) { sum += p.avg * p.cnt; cnt += p.cnt; } });
        return cnt > 0 ? { avg: Math.round(sum / cnt), cnt: cnt } : null;
      });
      return { key: q, label: q, color: TREND_COLORS[q], points: points };
    });
    // 전체 평균(등외제외): API가 준 E행 값을 그대로 쓴다. 옛 저장분(total 없음)·거래 없는 날은 null
    var total = { key: 'total', label: '전체', color: TOTAL_COLOR, points: dates.map(function (d) {
      var f = idx[d + '|' + sel.market + '|' + sel.sex];
      var t = f && f.status === 'ok' ? f.total : null;
      return t && typeof t.amt === 'number' && t.amt > 0 && t.cnt > 0 ? { avg: t.amt, cnt: t.cnt } : null;
    }) };
    return { dates: dates, end: m.end, stale: m.stale, groups: groups, total: total };
  }

  /** 줄 목록(전체 → 1++ → 1+ → 1): 기간 안 첫 값 → 마지막 값과 변동률. 값이 하루도 없는 줄은 뺀다. */
  function trendRows(tr) {
    var src = [{ key: 'total', label: '전체', color: tr.total.color, points: tr.total.points }].concat(
      tr.groups.map(function (g) { return { key: g.key, label: g.label + ' 등급', color: g.color, points: g.points }; }));
    var rows = [];
    src.forEach(function (s) {
      var fi = -1, li = -1;
      s.points.forEach(function (p, i) { if (p) { if (fi < 0) fi = i; li = i; } });
      if (fi < 0) return;
      var f = s.points[fi].avg, l = s.points[li].avg;
      rows.push({ key: s.key, label: s.label, color: s.color, points: s.points, fi: fi, li: li, first: f, last: l, pct: (l / f - 1) * 100 });
    });
    return rows;
  }

  function pctChip(pct) {
    var up = pct >= 0;
    return '<span class="chg ' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + Math.abs(pct).toFixed(1) + '%</span>';
  }

  /** 시작 → 현재: 줄마다 속 빈 동그라미(시작) → 꽉 찬 동그라미(최근) + 오른쪽에 변동률. */
  function renderDumbbell(tr) {
    var rows = trendRows(tr);
    if (!rows.length || tr.dates.length < 2) return '<p class="h7d-msg">추이를 그릴 시세가 부족합니다.</p>';
    var W = 720, RH = 54, L = 84, R = 90, T = 10, H = T + RH * rows.length + 30;
    var vals = [];
    rows.forEach(function (r) { vals.push(r.first, r.last); });
    var lo = Math.min.apply(null, vals) - 800, hi = Math.max.apply(null, vals) + 800;
    var step = hi - lo > 9000 ? 2000 : 1000;
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    var X = function (v) { return L + (W - L - R) * (v - lo) / (hi - lo); };
    var svg = '<svg class="h7d-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="등급별 한 달 전 대비 현재 가격">';
    for (var v = lo; v <= hi; v += step) {
      svg += '<line x1="' + X(v).toFixed(1) + '" x2="' + X(v).toFixed(1) + '" y1="' + T + '" y2="' + (H - 24) + '" class="grid"/>' +
        '<text x="' + X(v).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" class="ax">' + fmt(v) + '</text>';
    }
    rows.forEach(function (r, i) {
      var y = T + i * RH + RH / 2, x1 = X(r.first), x2 = X(r.last), up = r.pct >= 0;
      svg += '<text x="' + (L - 10) + '" y="' + (y + 4) + '" text-anchor="end" class="rowlab">' + r.label + '</text>' +
        '<line x1="' + x1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y1="' + y + '" y2="' + y + '" stroke="' + r.color + '" stroke-width="3" opacity="0.5"/>' +
        '<circle cx="' + x1.toFixed(1) + '" cy="' + y + '" r="6" fill="#fff" stroke="' + r.color + '" stroke-width="2.5"><title>' + dateLabel(tr.dates[r.fi]) + ' ' + fmt(r.first) + '원</title></circle>' +
        '<circle cx="' + x2.toFixed(1) + '" cy="' + y + '" r="7" fill="' + r.color + '"><title>' + dateLabel(tr.dates[r.li]) + ' ' + fmt(r.last) + '원</title></circle>' +
        '<text x="' + x1.toFixed(1) + '" y="' + (y - 13) + '" text-anchor="middle" class="ax">' + fmt(r.first) + '</text>' +
        '<text x="' + x2.toFixed(1) + '" y="' + (y + 24) + '" text-anchor="middle" class="val">' + fmt(r.last) + '</text>' +
        '<text x="' + (W - R + 14) + '" y="' + (y + 5) + '" class="pct ' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + Math.abs(r.pct).toFixed(1) + '%</text>';
    });
    return svg + '</svg>';
  }

  /** 작은 차트 모음: 줄마다 한 칸. 점선은 전체 평균(칸마다 세로 범위가 달라 위·아래 정도만 본다). */
  function renderMinis(tr) {
    var rows = trendRows(tr);
    if (!rows.length || tr.dates.length < 2) return '<p class="h7d-msg">추이를 그릴 시세가 부족합니다.</p>';
    var W = 320, H = 120, L = 6, R = 6, T = 10, B = 18, n = tr.dates.length;
    var tot = tr.total.points;
    return '<div class="h7d-minis">' + rows.map(function (r) {
      var ref = r.key === 'total' ? null : tot;
      var vals = [];
      r.points.concat(ref || []).forEach(function (p) { if (p) vals.push(p.avg); });
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo) * 0.12 || 500;
      lo -= pad; hi += pad;
      var X = function (i) { return L + (W - L - R) * i / (n - 1); };
      var Y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); };
      function path(a) {
        var d = '';
        a.forEach(function (p, i) { if (p) d += (d ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.avg).toFixed(1); });
        return d;
      }
      var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + r.label + ' 가격 추이">';
      if (ref && ref.some(Boolean)) svg += '<path d="' + path(ref) + '" fill="none" stroke="#B9BEBD" stroke-width="1.5" stroke-dasharray="4 3"/>';
      svg += '<path d="' + path(r.points) + '" fill="none" stroke="' + r.color + '" stroke-width="2.5" stroke-linejoin="round"/>';
      r.points.forEach(function (p, i) {
        if (p && (i === r.fi || i === r.li)) svg += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.avg).toFixed(1) + '" r="3.5" fill="' + r.color + '"/>';
      });
      svg += '<text x="' + L + '" y="' + (H - 3) + '" class="ax">' + dateLabel(tr.dates[0]).replace(/\(.\)/, '') + '</text>' +
        '<text x="' + (W - R) + '" y="' + (H - 3) + '" text-anchor="end" class="ax">' + dateLabel(tr.dates[n - 1]).replace(/\(.\)/, '') + '</text></svg>';
      return '<div class="h7d-mini"><div class="mt"><span>' + r.label + (r.key === 'total' ? ' 평균' : '') + '</span><span><b>' + fmt(r.last) + '</b> ' + pctChip(r.pct) + '</span></div>' + svg + '</div>';
    }).join('') + '</div>';
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
    var warn = el.querySelector('[data-h7d-warn]'); // 없으면 경고를 meta 앞에 붙인다(예전 배치)
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
          drawTrend();
        }
        // 한 달 추이: 열려 있을 때만 그린다. 기본은 '시작 → 현재', '자세히 보기'를 눌러야 작은 차트 모음이 열린다.
        var tBtn = el.querySelector('[data-h7d-trend-toggle]');
        var tBox = el.querySelector('[data-h7d-trend]');
        var dBtn = el.querySelector('[data-h7d-detail-toggle]');
        var dBox = el.querySelector('[data-h7d-detail]');
        function drawTrend() {
          if (!tBtn || !tBox || tBox.hidden) return;
          var tr = trend(data, now, sel);
          tBox.querySelector('[data-h7d-trend-main]').innerHTML = renderDumbbell(tr);
          if (dBox && !dBox.hidden) dBox.innerHTML = renderMinis(tr);
          var n = tr.dates.length;
          tBox.querySelector('[data-h7d-trend-note]').textContent = n < 2 ? '' :
            dateLabel(tr.dates[0]) + ' ~ ' + dateLabel(tr.dates[n - 1]) + ' 경매일 ' + n + '일 · 속 빈 동그라미 = 기간 시작, 꽉 찬 동그라미 = 최근 · ' +
            '등급은 A·B·C 두수 가중평균, 전체는 등외제외 평균(원/kg).';
        }
        if (tBtn && tBox) {
          tBtn.addEventListener('click', function () {
            var open = tBox.hidden;
            tBox.hidden = !open;
            tBtn.setAttribute('aria-expanded', String(open));
            tBtn.textContent = open ? '한 달 추이 닫기 ▴' : '한 달 추이 보기 ▾';
            drawTrend();
          });
        }
        if (dBtn && dBox) {
          dBtn.addEventListener('click', function () {
            var open = dBox.hidden;
            dBox.hidden = !open;
            dBtn.setAttribute('aria-expanded', String(open));
            dBtn.textContent = open ? '자세히 보기 닫기 ▴' : '자세히 보기 ▾';
            drawTrend();
          });
        }
        controls.addEventListener('click', function (ev) {
          var b = ev.target.closest('button[data-key]');
          if (!b) return;
          sel[b.getAttribute('data-key')] = b.getAttribute('data-code');
          draw();
        });
        draw();
        var gen = String(data.generatedAt || '').replace('T', ' ').slice(0, 16);
        var staleMsg = pick.stale ? dateLabel(pick.end) + ' 시세가 아직 없습니다(갱신 대기 또는 공휴일). 표는 그 전 경매일까지입니다.' : '';
        if (warn) warn.textContent = staleMsg;
        meta.textContent = (data.dummy ? '[개발용 가짜 데이터] ' : '') +
          (!warn && staleMsg ? '⚠ ' + staleMsg + ' ' : '') +
          '단위 원/kg(결함포함 평균 경락가) · 괄호는 두수 · 흐린 숫자는 ' + FEW_HEAD + '두 이하 거래 · – 거래 없음 · 수집 ' + gen;
      })
      .catch(function (e) {
        // 실패하면 가짜 숫자 대신 실패했다는 사실만 보여준다
        table.innerHTML = '<p class="h7d-msg">시세를 불러오지 못했습니다. (' + e.message + ')</p>';
        meta.textContent = '';
        if (warn) warn.textContent = '';
      });
  }

  var api = { endDate: endDate, pickDates: pickDates, dateLabel: dateLabel, indexFetches: indexFetches, cell: cell,
    monthDates: monthDates, trend: trend, trendRows: trendRows, renderDumbbell: renderDumbbell, renderMinis: renderMinis, renderTable: renderTable, renderControls: renderControls, load: load };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hanwoo7d = api;
})(this);
