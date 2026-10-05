"""수집 스크립트 테스트 (네트워크·키 불필요)
- 3단계: 실제 응답 2건(음성 2026-10-02 거세·암소)이 의도대로 해석되는지
- 4단계: 실패해도 멈추지 않기, 재시도, 이전 값 유지, pending, 실패 많으면 덮어쓰지 않기

실행: python scripts/test_fetch_prices.py   (네트워크·키 불필요)
기대값은 사용자가 브라우저로 직접 본 응답 원문에서 옮겨 적은 숫자다.
"""
import json
import os
import tempfile
import urllib.error
from pathlib import Path

import fetch_prices as fp
from fetch_prices import ApiError, parse_response

fp.BACKOFF_SEC = 0
fp.CALL_GAP_SEC = 0

FX = Path(__file__).resolve().parent / "fixtures"


def raises(fn, needle):
    try:
        fn()
    except ApiError as e:
        assert needle in str(e), f"예외 메시지에 '{needle}' 없음: {e}"
        return
    raise AssertionError(f"ApiError('{needle}')가 나야 하는데 통과함")


def test_castrated_real():
    r = parse_response((FX / "0513_20261002_025003.xml").read_bytes(), "20261002", "025003")
    # 기대값: 사용자가 붙여준 검사 스크립트 출력(음성 10/2 거세)에서 옮김
    assert r["status"] == "ok" and list(r["grades"]) == fp.GRADES and len(fp.GRADES) == 15
    assert "등외" not in r["grades"]
    expect = {"1++A": (29268, 55), "1++B": (27452, 52), "1++C": (25608, 28),
              "1+A": (25294, 24), "1+B": (24491, 46), "1+C": (22759, 9),
              "1A": (23022, 15), "1B": (22177, 16), "1C": (20550, 10),
              "2A": (19043, 8), "2B": (19269, 6), "2C": (18399, 1),
              "3A": None, "3B": None, "3C": None}
    got = {g: (v["amt"], v["cnt"]) if v else None for g, v in r["grades"].items()}
    assert got == expect, got


def test_cow_real_with_no_trade_grade():
    r = parse_response((FX / "0513_20261002_025001.xml").read_bytes(), "20261002", "025001")
    assert r["status"] == "ok"
    assert r["grades"]["1++A"] is None, "거래 없는 등급은 0이 아니라 None"
    assert r["grades"]["1++B"] == {"amt": 28695, "cnt": 8}
    assert r["grades"]["1++C"] == {"amt": 25407, "cnt": 5}
    assert r["grades"]["1+A"] is None and r["grades"]["1+C"] is None
    assert r["grades"]["1+B"] == {"amt": 25275, "cnt": 3}
    assert r["grades"]["3B"] == {"amt": 13220, "cnt": 3}


def test_closed_day():
    r = parse_response((FX / "closed_20261003_025003.xml").read_bytes(), "20261003", "025003")
    assert r == {"status": "closed", "grades": {g: None for g in fp.GRADES}}, r


def test_rejects_bad_responses():
    good = (FX / "0513_20261002_025001.xml").read_bytes()
    # 키 오류: HTTP 200 + resultCode 99
    raises(lambda: parse_response(
        b"<response><header><resultCode>99</resultCode><resultMsg>no key</resultMsg></header></response>",
        "20261002", "025001"), "resultCode=99")
    # 성별 코드를 잘못 보내 입력값이 되돌아온 경우(가이드에 명시된 동작)
    raises(lambda: parse_response(good.replace("<judgeSexNm>암<".encode(), b"<judgeSexNm>025009<"),
                                  "20261002", "025001"), "요청과 다른 응답")
    # 요청한 날짜와 다른 날짜가 온 경우
    raises(lambda: parse_response(good, "20261001", "025001"), "요청과 다른 응답")
    # 1++C 행이 사라진 경우(스키마 변경)
    raises(lambda: parse_response(good.replace(b"<gradeNm>1++C</gradeNm>", b"<gradeNm>X</gradeNm>"),
                                  "20261002", "025001"), "1++C 행 없음")
    # 평균가가 최고가보다 큰 경우
    raises(lambda: parse_response(good.replace(b"<auctAmt>28695<", b"<auctAmt>39999<"),
                                  "20261002", "025001"), "가격 이상")


OK = {"status": "ok", "grades": {"1++A": {"amt": 29000, "cnt": 3}, "1++B": None, "1++C": {"amt": 25000, "cnt": 1}}}


def test_retry_then_success():
    calls = []
    def flaky(ymd, m, s):
        calls.append(1)
        if len(calls) < 3:
            raise urllib.error.URLError("timed out")
        return OK
    assert fp.fetch_with_retry(flaky, "20261002", "0513", "025003") == OK
    assert len(calls) == 3


def test_no_retry_on_schema_error():
    calls = []
    def bad(ymd, m, s):
        calls.append(1)
        raise ApiError("1++C 행 없음")
    raises(lambda: fp.fetch_with_retry(bad, "20261002", "0513", "025003"), "행 없음")
    assert len(calls) == 1, "응답 모양이 틀린 건 재시도해도 같으니 1번만"


def test_collect_keeps_going_and_reuses_prev():
    def fetcher(ymd, m, s):
        if m == "0905":
            raise urllib.error.URLError("down")  # 고령만 계속 실패
        return OK
    prev = {("20261002", "0905", "025003"): {"status": "ok", "grades": {"1++A": {"amt": 1, "cnt": 1}}}}
    fetches, errors = fp.collect(["20261002"], fetcher, prev)
    by = {(f["market"], f["sex"]): f for f in fetches}
    assert len(fetches) == 6 and errors == 2
    assert by[("0513", "025003")]["status"] == "ok", "다른 시장은 정상 수집"
    assert by[("0905", "025003")]["reused"] is True and by[("0905", "025003")]["grades"]["1++A"]["amt"] == 1
    assert by[("0905", "025001")]["status"] == "error", "이전 값이 없으면 error로 남김"


def test_key_error_not_retried_and_aborts_fast():
    calls = []
    def bad_key(ymd, m, s):
        calls.append(1)
        raise ApiError("resultCode=99 등록되지 않은 서비스키", retry="99" in fp.RETRYABLE_CODES)
    try:
        fp.collect([f"202610{d:02d}" for d in range(1, 15)], bad_key, {})
    except fp.Abort as e:
        assert "연속 6건" in str(e)
    else:
        raise AssertionError("Abort가 나야 함")
    assert len(calls) == fp.ABORT_AFTER, f"재시도 없이 {fp.ABORT_AFTER}번만 불러야 하는데 {len(calls)}번"


def test_isolated_failures_do_not_abort():
    n = []
    def every_third_fails(ymd, m, s):
        n.append(1)
        if len(n) % 3 == 0:
            raise ApiError("1++C 행 없음")
        return OK
    fetches, errors = fp.collect(["20261001", "20261002"], every_third_fails, {})
    assert len(fetches) == 12 and errors == 4


def test_pending_only_for_weekday_end_date():
    closed = lambda d: [{"date": d, "status": "closed"} for _ in range(6)]
    f = closed("20261002")  # 금
    fp.mark_pending(f, "20261002")
    assert all(x["status"] == "pending" for x in f)
    f = closed("20261003")  # 토
    fp.mark_pending(f, "20261003")
    assert all(x["status"] == "closed" for x in f), "주말은 진짜 휴장"
    f = closed("20261002") + [{"date": "20261002", "status": "ok"}]
    fp.mark_pending(f, "20261002")
    assert f[0]["status"] == "closed", "한 시장이라도 열렸으면 진짜 휴장"


def test_main_does_not_overwrite_when_mostly_failing():
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "h.json"
        out.write_text('{"keep": true}', encoding="utf-8")
        orig, os.environ["EKAPE_KEY"] = fp.fetch_day, "x"
        fp.fetch_day = lambda *a: (_ for _ in ()).throw(urllib.error.URLError("down"))
        try:
            assert fp.main(["--out", str(out)]) == 1
        finally:
            fp.fetch_day = orig
            os.environ.pop("EKAPE_KEY", None)
        assert json.loads(out.read_text(encoding="utf-8")) == {"keep": True}, "기존 파일이 그대로여야 함"


def test_summary_flags_anomalies():
    days = [f"202610{d:02d}" for d in range(1, 8)]
    def f(d, m, s, amt, cnt=10):
        return {"date": d, "market": m, "sex": s, "status": "ok", "grades": {"1++A": {"amt": amt, "cnt": cnt}}}
    fetches = [f(d, "0513", "025003", 29000) for d in days[:6]] + [f(days[6], "0513", "025003", 35000)]  # +21%
    fetches += [f(days[0], "0905", "025003", 29000)]                       # 음성과 완전히 같은 값
    fetches += [f(days[1], "0202", "025003", 20000, 1), f(days[2], "0202", "025003", 30000, 1)]  # 1두 급변은 무시
    fetches += [{"date": days[3], "market": "0202", "sex": "025001", "status": "error", "grades": None, "error": "x"}]
    data = {"generatedAt": "t", "dates": days, "grades": ["1++A"], "fetches": fetches,
            "markets": [{"code": c, "name": n} for c, n in fp.MARKETS], "sexes": [{"code": c, "name": n} for c, n in fp.SEXES]}
    _, warns = fp.summarize(data)
    text = "\n".join(warns)
    assert "+21%" in text, text
    assert "음성와 고령 값이 같음" in text, text
    assert "부경 거세 1++A" not in text, "1두짜리 출렁임은 급변으로 보지 않음"
    assert "부경 암소: error" in text, text
    assert len(warns) == 3, warns


def test_main_writes_valid_json():
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "h.json"
        assert fp.main(["--dummy", "--out", str(out)]) == 0
        data = json.loads(out.read_text(encoding="utf-8"))
        assert len(data["dates"]) == fp.DAYS and len(data["fetches"]) == fp.DAYS * 6
        assert data["dummy"] is True


if __name__ == "__main__":
    import logging
    logging.disable(logging.CRITICAL)  # 테스트 출력에는 수집 로그를 섞지 않는다
    tests = [v for k, v in dict(globals()).items() if k.startswith("test_")]
    for t in tests:
        t()
        print(f"통과  {t.__name__}")
    print(f"\n{len(tests)}개 모두 통과")
