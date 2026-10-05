"""한우 세부등급(등외 제외 15개) 일별 경락가격 수집 → data/hanwoo_7d.json  (GitHub Actions가 매일 실행)

실행:
    $env:EKAPE_KEY = "공공데이터포털 Decoding 키"
    python scripts/fetch_prices.py            # 실제 수집
    python scripts/fetch_prices.py --dummy    # 키 없이 가짜 값으로 흐름만 확인

JSON의 fetches 한 건 = API 호출 한 번(날짜 × 도매시장 × 성별).
  status: ok(경매 있음) / closed(휴장: 모든 행에 두수 없음)
          pending(끝 날짜가 평일인데 전 시장 휴장 → 업로드 전일 수 있음) / error(수집 실패)
  grades: 등급별 {amt: 원/kg, cnt: 두수}, 그날 해당 등급 거래가 없으면 null (0으로 채우지 않는다)
"""
import argparse
import json
import logging
import os
import random
import sys
import time
import urllib.error
from collections import Counter
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
MARKETS = [("0513", "음성"), ("0905", "고령"), ("0202", "부경")]
SEXES = [("025003", "거세"), ("025001", "암소")]
GRADES = [q + y for q in ("1++", "1+", "1", "2", "3") for y in "ABC"]  # 육질×육량 세부등급 15개, 등외 제외
DAYS = 21  # 경매일 7일을 채우려면 주말·연휴를 넘어야 한다(2026 추석: 9/23~9/28 6일 연속 휴장 → 14일로는 6일뿐이었음)
OUT = Path(__file__).resolve().parent.parent / "data" / "hanwoo_7d.json"

API_URL = "http://data.ekape.or.kr/openapi-data/service/user/grade/auct/cattlePriceDetail"
BREED = ("024001", "한우")
API_SEX_NM = {"025003": "거세", "025001": "암"}  # 응답 judgeSexNm 표기

RETRIES = 3
BACKOFF_SEC = 2        # 재시도 대기: 2초, 4초
CALL_GAP_SEC = 0.2     # 호출 간 간격(초당 150건 제한보다 한참 느리게)
MAX_ERROR_RATIO = 0.2  # 실패가 이보다 많으면 기존 파일을 덮어쓰지 않는다
ABORT_AFTER = 6        # 연속 실패가 이만큼(하루치 전체)이면 키·네트워크 문제로 보고 즉시 중단
RETRYABLE_CODES = {"01", "02", "04", "05"}
JUMP_RATIO = 0.15      # 요약: 직전 경매일 대비 이만큼 변하면 표시
JUMP_MIN_HEAD = 3      # 요약: 양쪽 다 이 두수 이상일 때만 급변으로 본다(1~2두는 원래 출렁인다)  # 일시 장애(앱·DB·HTTP 오류, 시간초과). 99(키 오류) 등은 다시 해도 같다

log = logging.getLogger("hanwoo7d")


class ApiError(Exception):
    def __init__(self, msg, retry=False):
        super().__init__(msg)
        self.retry = retry


class Abort(Exception):
    pass


def latest_date(now):
    """오전 10시 전이면 그제, 10시부터는 어제가 가장 최근 확정 데이터(위젯 JS와 같은 규칙)."""
    return (now - timedelta(days=2 if now.hour < 10 else 1)).date()


def parse_response(raw, ymd, sex_cd):
    """응답 XML 하나 → {"status", "grades"}. 1단계에서 본 모양과 다르면 조용히 넘기지 않고 ApiError."""
    root = ET.fromstring(raw)
    code = root.findtext(".//resultCode")
    if code != "00":
        raise ApiError(f"resultCode={code} {root.findtext('.//resultMsg')}", retry=code in RETRYABLE_CODES)
    rows = [{c.tag: (c.text or "").strip() for c in it} for it in root.iter("item")]
    if not rows:
        raise ApiError("item 0건 (휴장일에도 값 없는 행이 오는 것이 정상)")
    for r in rows:
        # 가이드: 코드가 틀리면 오류 대신 입력값을 되돌려준다 → 이름으로 대조
        got = (r.get("judgeBreedNm"), r.get("judgeSexNm"), r.get("startYmd"))
        if got != (BREED[1], API_SEX_NM[sex_cd], ymd):
            raise ApiError(f"요청과 다른 응답 {got}")
    if not any(r.get("auctCnt", "0") not in ("", "0") for r in rows):
        return {"status": "closed", "grades": {g: None for g in GRADES}}

    detail = {r.get("gradeNm"): r for r in rows if r.get("gradeType") == "A"}  # A = 육질+육량 세부등급
    grades = {}
    for g in GRADES:
        if g not in detail:
            raise ApiError(f"{g} 행 없음")
        r = detail[g]
        if not r.get("auctAmt"):
            grades[g] = None  # 그날 이 등급 거래 없음 — 0원이 아니다
            continue
        amt, lo, hi = float(r["auctAmt"]), float(r["minAuctAmt"]), float(r["maxAuctAmt"])
        if not 0 < lo <= amt <= hi:
            raise ApiError(f"{g} 가격 이상: 최저 {lo} 평균 {amt} 최고 {hi}")
        grades[g] = {"amt": round(amt), "cnt": int(r["auctCnt"])}
    return {"status": "ok", "grades": grades}


def fetch_day(key, ymd, market_cd, sex_cd):
    q = urllib.parse.urlencode({
        "serviceKey": key, "abattCode": market_cd, "startYmd": ymd, "endYmd": ymd,
        "breedCd": BREED[0], "sexCd": sex_cd, "defectIncludeYn": "Y",
    })
    with urllib.request.urlopen(f"{API_URL}?{q}", timeout=20) as r:
        return parse_response(r.read(), ymd, sex_cd)


def fetch_day_dummy(ymd, market_cd, sex_cd):
    rnd = random.Random(f"{ymd}{market_cd}{sex_cd}")
    if datetime.strptime(ymd, "%Y%m%d").weekday() >= 5:
        return {"status": "closed", "grades": {g: None for g in GRADES}}
    base = 29000 if sex_cd == "025003" else 27000
    grades = {}
    for i, g in enumerate(GRADES):
        if rnd.random() < 0.15:
            grades[g] = None
        else:
            grades[g] = {"amt": base - i * 900 + rnd.randint(-500, 500), "cnt": rnd.randint(1, 50)}
    return {"status": "ok", "grades": grades}


TRANSIENT = (urllib.error.URLError, TimeoutError, ConnectionError, ET.ParseError)


def fetch_with_retry(fetcher, ymd, market_cd, sex_cd):
    """네트워크 오류와 일시 장애 resultCode만 재시도한다. 키 오류·응답 모양 이상은 다시 해도 같으므로 바로 올린다."""
    for attempt in range(1, RETRIES + 1):
        try:
            return fetcher(ymd, market_cd, sex_cd)
        except ApiError as e:
            if not e.retry or attempt == RETRIES:
                raise
            err = e
        except TRANSIENT as e:
            if attempt == RETRIES:
                raise
            err = e
        log.warning("    재시도 %d/%d %s %s %s: %s", attempt, RETRIES - 1, ymd, market_cd, sex_cd, err)
        time.sleep(BACKOFF_SEC * attempt)


def describe(res):
    if res["status"] != "ok":
        return res["status"]
    return "  ".join(f"{g} {v['amt']:,}({v['cnt']})" if v else f"{g} –" for g, v in res["grades"].items())


def collect(dates, fetcher, prev):
    """날짜 × 시장 × 성별을 모두 호출한다. 한 칸이 실패해도 멈추지 않고, 이전에 받은 값이 있으면 그것을 유지한다.
    단 연속 ABORT_AFTER건 실패면 Abort — 키가 틀렸거나 API가 내려간 것이니 끝까지 돌 이유가 없다."""
    fetches, errors, streak = [], 0, 0
    names = {**dict(MARKETS), **dict(SEXES)}
    for ymd in dates:
        for m_cd, _ in MARKETS:
            for s_cd, _ in SEXES:
                label = f"{ymd} {names[m_cd]} {names[s_cd]}"
                try:
                    res = fetch_with_retry(fetcher, ymd, m_cd, s_cd)
                    log.info("%s  %s", label, describe(res))
                    streak = 0
                except Exception as e:  # 예상 못 한 파싱 오류(KeyError 등)도 이 칸만 실패로 남긴다
                    errors += 1
                    streak += 1
                    why = f"{type(e).__name__}: {e}"[:200]
                    if streak >= ABORT_AFTER:
                        raise Abort(f"연속 {streak}건 실패 — 키 또는 네트워크 문제로 보고 중단 (마지막: {why})")
                    old = prev.get((ymd, m_cd, s_cd))
                    if old and old.get("status") in ("ok", "closed"):
                        log.warning("%s  실패 → 이전 값 유지 (%s)", label, why)
                        res = {"status": old["status"], "grades": old["grades"], "reused": True}
                    else:
                        log.error("%s  실패 (%s)", label, why)
                        res = {"status": "error", "grades": None, "error": why}
                fetches.append({"date": ymd, "market": m_cd, "sex": s_cd, **res})
                if CALL_GAP_SEC:
                    time.sleep(CALL_GAP_SEC)
    return fetches, errors


def mark_pending(fetches, end_ymd):
    """끝 날짜가 평일인데 전 시장이 '휴장'이면 업로드 전일 수 있다 → pending(위젯은 '갱신 대기 또는 공휴일')."""
    day = [f for f in fetches if f["date"] == end_ymd]
    weekday = datetime.strptime(end_ymd, "%Y%m%d").weekday() < 5
    if day and weekday and all(f["status"] == "closed" for f in day):
        for f in day:
            f["status"] = "pending"
        log.warning("%s 평일인데 전 시장 휴장으로 응답 → pending(업로드 전이거나 공휴일)", end_ymd)


def summarize(data):
    """5단계: 결과가 정상인지 사람이 한눈에 판단할 요약. 이상 신호는 [주의] 줄로 모은다."""
    idx = {(f["date"], f["market"], f["sex"]): f for f in data["fetches"]}
    mk = [m["code"] for m in data["markets"]]
    sx = [s["code"] for s in data["sexes"]]
    nm = {**{m["code"]: m["name"] for m in data["markets"]}, **{s["code"]: s["name"] for s in data["sexes"]}}
    warns = []

    st = Counter(f["status"] for f in data["fetches"])
    reused = sum(1 for f in data["fetches"] if f.get("reused"))
    lines = [f"수집 {data['generatedAt']} · {len(data['fetches'])}건 · "
             + ", ".join(f"{k} {v}" for k, v in sorted(st.items()))
             + (f" · 이전 값 유지 {reused}" if reused else ""),
             "", "날짜별 상태 (o 경매 · c 휴장 · p 대기 · e 오류 / 음성·고령·부경 × 거세·암소)"]
    for d in data["dates"]:
        row = " ".join("".join(idx[(d, m, s)]["status"][0] if (d, m, s) in idx else "?" for s in sx) for m in mk)
        lines.append(f"  {d}  {row}")

    def status(d, m, s):
        return idx.get((d, m, s), {}).get("status")
    days = [d for d in data["dates"] if any(status(d, m, s) not in ("closed", "pending") for m in mk for s in sx)][-7:]
    if len(days) < 7:
        warns.append(f"최근 경매일이 {len(days)}일뿐 — 수집 기간(DAYS={len(data['dates'])}) 부족")
    lines += ["", f"최근 경매일 {len(days)}일 ({days[0] if days else '-'} ~ {days[-1] if days else '-'}), 원/kg",
              f"  {'':14}{'일수':>4}{'최저':>9}{'평균':>9}{'최고':>9}{'최근':>9}{'두수':>6}"]
    for m in mk:
        for s in sx:
            for g in data["grades"]:
                label = f"{nm[m]} {nm[s]} {g}"
                series = [(d, idx[(d, m, s)]["grades"][g]) for d in days
                          if status(d, m, s) == "ok" and (idx[(d, m, s)]["grades"] or {}).get(g)]
                if not series:
                    lines.append(f"  {label:14}{0:>4}   거래 없음")
                    continue
                amts = [v["amt"] for _, v in series]
                lines.append(f"  {label:14}{len(series):>4}{min(amts):>9,}{round(sum(amts) / len(amts)):>9,}"
                             f"{max(amts):>9,}{amts[-1]:>9,}{sum(v['cnt'] for _, v in series):>6}")
                for (d0, v0), (d1, v1) in zip(series, series[1:]):
                    ch = (v1["amt"] - v0["amt"]) / v0["amt"]
                    if abs(ch) >= JUMP_RATIO and min(v0["cnt"], v1["cnt"]) >= JUMP_MIN_HEAD:
                        warns.append(f"{label} {d0}→{d1} {ch:+.0%} ({v0['amt']:,}→{v1['amt']:,}원, {v0['cnt']}→{v1['cnt']}두)")

    for d in days:  # 같은 날 두 시장 값이 완전히 같으면 코드가 엉뚱한 시장을 가리킬 수 있다
        for s in sx:
            for g in data["grades"]:
                seen = {}
                for m in mk:
                    v = (idx.get((d, m, s), {}).get("grades") or {}).get(g)
                    if v:
                        key = (v["amt"], v["cnt"])
                        if key in seen:
                            warns.append(f"{d} {nm[s]} {g}: {nm[seen[key]]}와 {nm[m]} 값이 같음 — 도매시장 코드 확인 필요")
                        seen[key] = m
    for f in data["fetches"]:
        if f["status"] in ("error", "pending") or f.get("reused"):
            warns.append(f"{f['date']} {nm[f['market']]} {nm[f['sex']]}: "
                         + ("이전 값 유지" if f.get("reused") else f["status"]) + (f" ({f['error']})" if f.get("error") else ""))

    lines += ["", f"이상 신호 {len(warns)}건" if warns else "이상 신호 없음"] + [f"  [주의] {w}" for w in warns]
    return lines, warns


def publish_summary(lines):
    text = "\n".join(lines)
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY")  # Actions 실행 화면에 같은 요약을 띄운다
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"## 한우 7일 시세 수집 요약\n\n```\n{text}\n```\n")


def load_prev(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        log.warning("기존 파일을 읽지 못해 무시합니다: %s", e)
        return {}
    if data.get("dummy"):
        return {}
    return {(f["date"], f["market"], f["sex"]): f for f in data.get("fetches", [])}


def write_atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)  # 쓰는 도중 실패해도 기존 파일이 반쯤 깨지지 않게


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dummy", action="store_true", help="키 없이 가짜 값으로 실행")
    ap.add_argument("--report", action="store_true", help="수집 없이 기존 JSON의 요약만 출력")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    if args.report:
        publish_summary(summarize(json.loads(Path(args.out).read_text(encoding="utf-8")))[0])
        return 0

    now = datetime.now(KST)
    end = latest_date(now)
    dates = [(end - timedelta(days=i)).strftime("%Y%m%d") for i in range(DAYS - 1, -1, -1)]
    if args.dummy:
        fetcher = fetch_day_dummy
    else:
        # Encoding 키(%2B 등)를 넣어도 되게 풀어 둔다. Decoding 키에는 %가 없어 그대로다
        key = urllib.parse.unquote(os.environ.get("EKAPE_KEY", "").strip().strip('"').strip("'"))
        if not key:
            log.error('환경변수 EKAPE_KEY가 없습니다. ($env:EKAPE_KEY = "Decoding 키")')
            return 2
        fetcher = lambda ymd, m, s: fetch_day(key, ymd, m, s)  # noqa: E731

    total = len(dates) * len(MARKETS) * len(SEXES)
    log.info("수집 시작 %s~%s, %d건 (%s)", dates[0], dates[-1], total, "가짜" if args.dummy else "실제 API")
    prev = {} if args.dummy else load_prev(args.out)
    try:
        fetches, errors = collect(dates, fetcher, prev)
    except Abort as e:
        log.error("%s. 기존 파일은 그대로 둡니다.", e)
        return 1
    mark_pending(fetches, dates[-1])

    if errors / total > MAX_ERROR_RATIO:
        log.error("실패 %d/%d건(%.0f%%)이 기준 %.0f%%를 넘어 기존 파일을 덮어쓰지 않습니다.",
                  errors, total, 100 * errors / total, 100 * MAX_ERROR_RATIO)
        return 1

    data = {
        "dummy": bool(args.dummy),
        "source": "축산물품질평가원 축산물등급판정정보 auct/cattlePriceDetail (결함포함가격)",
        "generatedAt": now.isoformat(timespec="seconds"),
        "dates": dates,
        "markets": [{"code": c, "name": n} for c, n in MARKETS],
        "sexes": [{"code": c, "name": n} for c, n in SEXES],
        "grades": GRADES,
        "fetches": fetches,
    }
    write_atomic(args.out, data)
    log.info("저장 %s (실패 %d/%d건)", args.out, errors, total)
    publish_summary(summarize(data)[0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
