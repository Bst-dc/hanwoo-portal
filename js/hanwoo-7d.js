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

  /* ───── 한 달 추이 차트 ───── */
  var TREND_DAYS = 30;
  var QUALITIES = ['1++', '1+', '1', '2', '3'];
  var TOTAL_COLOR = '#161A19'; // 전체 평균 선: 잉크색 굵은 선
  var TREND_COLORS = { '1++': '#1F4E9C', '1+': '#2A9D8F', '1': '#E9A23B', '2': '#D95926', '3': '#8A6FB3' };
  var DASHES = ['', '7 4', '2 4']; // 세부등급 A 실선 · B 파선 · C 점선
  var STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

  function niceStep(range) {
    var raw = range / 5;
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i] >= raw) return STEPS[i];
    return STEPS[STEPS.length - 1];
  }
  function fmt(n) { return Math.round(n).toLocaleString('ko-KR'); }
  function pct(n) { return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }

  /** 끝 날짜에서 30일 안의 경매일들(휴장일 제외). */
  function monthDates(data, epochMs) {
    var p = pickDates(data, epochMs, 60);
    var start = toYmd(+p.end.slice(0, 4), +p.end.slice(4, 6) - 1, +p.end.slice(6, 8) - (TREND_DAYS - 1));
    return { dates: p.dates.filter(function (d) { return d >= start; }), end: p.end, stale: p.stale };
  }

  /** 육질등급 5묶음(A·B·C를 두수 가중평균)과 묶음별 세부등급 3개의 일별 값.
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
      var grades = data.grades.filter(function (g) { return g.slice(0, -1) === q; }).map(function (g) {
        return { label: g, points: gradePts(g) };
      });
      var points = dates.map(function (d, i) {
        var sum = 0, cnt = 0;
        grades.forEach(function (gr) { var p = gr.points[i]; if (p) { sum += p.avg * p.cnt; cnt += p.cnt; } });
        return cnt > 0 ? { avg: Math.round(sum / cnt), cnt: cnt } : null;
      });
      return { key: q, label: q, color: TREND_COLORS[q], points: points, grades: grades };
    });
    // 전체 평균(등외제외): API가 준 E행 값을 그대로 쓴다. 옛 저장분(total 없음)·거래 없는 날은 null
    var total = { key: 'total', label: '전체', color: TOTAL_COLOR, points: dates.map(function (d) {
      var f = idx[d + '|' + sel.market + '|' + sel.sex];
      var t = f && f.status === 'ok' ? f.total : null;
      return t && typeof t.amt === 'number' && t.amt > 0 && t.cnt > 0 ? { avg: t.amt, cnt: t.cnt } : null;
    }) };
    return { dates: dates, end: m.end, stale: m.stale, groups: groups, total: total };
  }

  function firstLast(points) {
    var f = null, l = null;
    points.forEach(function (p) { if (p) { if (!f) f = p; l = p; } });
    return { first: f, last: l };
  }

  /** 그릴 선 목록. expanded가 있으면 그 묶음의 세부등급 A·B·C 3줄, 없으면 5묶음.
      mode 'rate'는 각 선의 첫 값을 0%로 맞춰 오르내림을 비교한다. */
  function trendSeries(tr, mode, expanded) {
    var src = [];
    var g = tr.groups.filter(function (x) { return x.key === expanded; })[0];
    if (g) g.grades.forEach(function (gr, i) { src.push({ label: gr.label, color: g.color, dash: DASHES[i % 3], points: gr.points }); });
    else tr.groups.forEach(function (x) { src.push({ label: x.label, color: x.color, dash: '', points: x.points }); });
    if (tr.total && tr.total.points.some(Boolean)) src.push({ label: tr.total.label, color: tr.total.color, dash: '', total: true, points: tr.total.points });
    return src.map(function (sr) {
      var base = firstLast(sr.points).first;
      return { label: sr.label, color: sr.color, dash: sr.dash, total: !!sr.total, points: sr.points.map(function (p) {
        if (!p) return null;
        return { price: p.avg, cnt: p.cnt, v: mode === 'rate' ? (p.avg / base.avg - 1) * 100 : p.avg };
      }) };
    });
  }

  function renderTrend(tr, mode, expanded) {
    var series = trendSeries(tr, mode, expanded);
    var vals = [];
    series.forEach(function (sr) { sr.points.forEach(function (p) { if (p) vals.push(p.v); }); });
    if (!vals.length || tr.dates.length < 2) return '<p class="h7d-msg">추이를 그릴 시세가 부족합니다.</p>';
    var W = 720, H = 320, L = 58, R = 60, T = 16, B = 34, n = tr.dates.length;
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var step = niceStep(Math.max(hi - lo, mode === 'rate' ? 2 : 1000));
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    if (hi === lo) hi = lo + step;
    var X = function (i) { return L + (W - L - R) * i / (n - 1); };
    var Y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); };
    var svg = '<svg class="h7d-chart h7d-trend" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="등급별 한 달 가격 추이 선 차트">';
    for (var v = lo; v <= hi + 1e-9; v += step) {
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) +
        '" class="' + (mode === 'rate' && Math.abs(v) < 1e-9 ? 'grid zero' : 'grid') + '"/><text x="' + (L - 6) + '" y="' + (Y(v) + 4).toFixed(1) +
        '" text-anchor="end" class="ax">' + (mode === 'rate' ? pct(v) : fmt(v)) + '</text>';
    }
    var every = Math.ceil(n / 8);
    tr.dates.forEach(function (d, i) {
      if ((n - 1 - i) % every === 0) svg += '<text x="' + X(i).toFixed(1) + '" y="' + (H - B + 18) + '" text-anchor="middle" class="ax">' +
        (+d.slice(4, 6)) + '/' + (+d.slice(6, 8)) + '</text>';
    });
    var ends = [];
    series.forEach(function (sr) {
      var path = '', dots = '', last = null;
      sr.points.forEach(function (p, i) {
        if (!p) return;
        path += (path ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1);
        dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="2.5" fill="' + sr.color + '"' +
          (p.cnt <= FEW_HEAD ? ' opacity="0.35"' : '') + '/>';
        last = { x: X(i), y: Y(p.v) };
      });
      if (!path) return; // 값이 하루도 없는 묶음은 선도 끝 이름도 그리지 않는다
      svg += '<path d="' + path + '" fill="none" stroke="' + sr.color + '" stroke-width="' + (sr.total ? 3.5 : 2) + '"' +
        (sr.dash ? ' stroke-dasharray="' + sr.dash + '"' : '') + ' stroke-linejoin="round"/>' + dots;
      if (last) ends.push({ label: sr.label, color: sr.color, x: last.x, y: last.y });
    });
    ends.sort(function (a, b) { return a.y - b.y; }); // 선 끝 이름이 겹치지 않게 위에서부터 최소 13px 간격
    for (var k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 13) ends[k].y = ends[k - 1].y + 13;
    ends.forEach(function (e) {
      svg += '<text x="' + (e.x + 8).toFixed(1) + '" y="' + (e.y + 4).toFixed(1) + '" class="end" fill="' + e.color + '">' + e.label + '</text>';
    });
    svg += '<line class="cross" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" visibility="hidden"/>';
    var cw = (W - L - R) / (n - 1);
    tr.dates.forEach(function (d, i) {
      svg += '<rect class="hit" data-i="' + i + '" data-x="' + X(i).toFixed(1) + '" x="' + (X(i) - cw / 2).toFixed(1) + '" y="' + T +
        '" width="' + cw.toFixed(1) + '" height="' + (H - T - B) + '" fill="transparent"/>';
    });
    return svg + '</svg>';
  }

  function trendTooltip(tr, mode, expanded, i) {
    var h = '<b>' + dateLabel(tr.dates[i]) + '</b>';
    trendSeries(tr, mode, expanded).forEach(function (sr) {
      var p = sr.points[i];
      h += '<div><i style="background:' + sr.color + '"></i>' + sr.label + ' ' +
        (p ? fmt(p.price) + '원' + (mode === 'rate' ? ' (' + pct(p.v) + ')' : '') + ' · ' + p.cnt + '두' : '–') + '</div>';
    });
    return h;
  }

  /** 묶음 단추 5개: 색 점 · 이름 · 최근 값 · 기간 변동률. 누르면 그 묶음의 A·B·C로 펼치고, 다시 누르면 5묶음으로 돌아간다. */
  function trendLegend(tr, expanded) {
    var tl = tr.total ? firstLast(tr.total.points) : { last: null };
    var totalChip = '';
    if (tl.last) {
      var tUp = tl.last.avg >= tl.first.avg;
      totalChip = '<span class="h7d-lg-total" title="등외 제외 전체 평균(축산물품질평가원 집계)"><i style="background:' + TOTAL_COLOR + '"></i><span>전체</span>' +
        '<span class="v">' + fmt(tl.last.avg) + ' <span class="chg ' + (tUp ? 'up' : 'down') + '">' + (tUp ? '▲' : '▼') +
        Math.abs((tl.last.avg / tl.first.avg - 1) * 100).toFixed(1) + '%</span></span></span>';
    }
    return totalChip + tr.groups.map(function (g) {
      var fl = firstLast(g.points);
      var info = '–';
      if (fl.last) {
        var up = fl.last.avg >= fl.first.avg;
        info = fmt(fl.last.avg) + ' <span class="chg ' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') +
          Math.abs((fl.last.avg / fl.first.avg - 1) * 100).toFixed(1) + '%</span>';
      }
      return '<button type="button" class="h7d-lg" data-key="' + g.key + '" aria-pressed="' + (expanded === g.key) + '">' +
        '<i style="background:' + g.color + '"></i><span>' + g.label + '</span><span class="v">' + info + '</span></button>';
    }).join('');
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
        // 한 달 추이: 5묶음 선 ↔ 묶음 하나의 A·B·C, 가격 ↔ 변동률. 열려 있을 때만 그린다.
        var tBtn = el.querySelector('[data-h7d-trend-toggle]');
        var tBox = el.querySelector('[data-h7d-trend]');
        var tView = { mode: 'price', expanded: null };
        var tr = null;
        function drawTrend() {
          if (!tBtn || !tBox || tBox.hidden) return;
          tr = trend(data, now, sel);
          var chart = tBox.querySelector('[data-h7d-trend-chart]');
          tBox.querySelector('[data-h7d-trend-legend]').innerHTML = trendLegend(tr, tView.expanded);
          chart.innerHTML = renderTrend(tr, tView.mode, tView.expanded);
          [].forEach.call(tBox.querySelectorAll('[data-mode]'), function (b) {
            b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === tView.mode));
          });
          var note = tr.dates.length ? dateLabel(tr.dates[0]) + ' ~ ' + dateLabel(tr.dates[tr.dates.length - 1]) + ' 경매일 ' + tr.dates.length + '일 · ' : '';
          tBox.querySelector('[data-h7d-trend-note]').textContent = note + (tView.expanded
            ? tView.expanded + ' 등급 세부: 실선 A · 파선 B · 점선 C. 묶음 단추를 다시 누르면 전체로 돌아갑니다.'
            : '등급 묶음(A·B·C 두수 가중평균). 묶음 단추를 누르면 세부 등급 A·B·C를 봅니다.') +
            ' 흐린 점은 ' + FEW_HEAD + '두 이하 거래.';
        }
        if (tBtn && tBox) {
          tBtn.addEventListener('click', function () {
            var open = tBox.hidden;
            tBox.hidden = !open;
            tBtn.setAttribute('aria-expanded', String(open));
            tBtn.textContent = open ? '한 달 추이 차트 닫기 ▴' : '한 달 추이 차트 보기 ▾';
            drawTrend();
          });
          tBox.addEventListener('click', function (ev) {
            var m = ev.target.closest('[data-mode]'), g = ev.target.closest('.h7d-lg');
            if (m) tView.mode = m.getAttribute('data-mode');
            else if (g) tView.expanded = tView.expanded === g.getAttribute('data-key') ? null : g.getAttribute('data-key');
            else return;
            drawTrend();
          });
          // 날짜 위에 올리면 세로선과 그날 값 상자
          var tip = tBox.querySelector('[data-h7d-trend-tip]');
          tBox.addEventListener('mousemove', function (ev) {
            var hit = ev.target.closest && ev.target.closest('.hit');
            var cross = tBox.querySelector('.cross');
            if (!hit || !tr) { tip.hidden = true; if (cross) cross.setAttribute('visibility', 'hidden'); return; }
            cross.setAttribute('x1', hit.getAttribute('data-x')); cross.setAttribute('x2', hit.getAttribute('data-x'));
            cross.setAttribute('visibility', 'visible');
            tip.innerHTML = trendTooltip(tr, tView.mode, tView.expanded, +hit.getAttribute('data-i'));
            tip.hidden = false;
            var wrap = tBox.getBoundingClientRect();
            var x = ev.clientX - wrap.left + 14;
            tip.style.left = Math.min(x, wrap.width - tip.offsetWidth - 4) + 'px';
            tip.style.top = Math.max(0, ev.clientY - wrap.top - tip.offsetHeight - 10) + 'px';
          });
          tBox.addEventListener('mouseleave', function () {
            tip.hidden = true;
            var cross = tBox.querySelector('.cross');
            if (cross) cross.setAttribute('visibility', 'hidden');
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
    monthDates: monthDates, trend: trend, trendSeries: trendSeries,
    renderTrend: renderTrend, trendTooltip: trendTooltip, trendLegend: trendLegend, niceStep: niceStep, renderTable: renderTable, renderControls: renderControls, load: load };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hanwoo7d = api;
})(this);
