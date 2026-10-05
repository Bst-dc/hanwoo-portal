"""1단계 데이터 검사: 음성공판장(0513) 하루치 한우 경락가격 응답을 눈으로 확인한다.

실행 (PowerShell, 저장소 폴더에서):
    $env:EKAPE_KEY = "공공데이터포털 Decoding 키"
    python scripts/inspect_ekape.py 20261002
"""
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

URL = "http://data.ekape.or.kr/openapi-data/service/user/grade/auct/cattlePriceDetail"
MARKET = ("0513", "농협음성")
BREED = ("024001", "한우")
SEXES = {"025003": "거세", "025001": "암"}
TARGET_GRADES = ("1++A", "1++B", "1++C")
NUM_FIELDS = ("auctCnt", "weight", "auctAmt", "minAuctAmt", "maxAuctAmt", "sumWeight", "sumAuctAmt")


def fetch(key, ymd, sex_cd):
    q = urllib.parse.urlencode({
        "serviceKey": key, "abattCode": MARKET[0], "startYmd": ymd, "endYmd": ymd,
        "breedCd": BREED[0], "sexCd": sex_cd, "defectIncludeYn": "Y",
    })
    with urllib.request.urlopen(f"{URL}?{q}", timeout=20) as r:
        return r.read()


def to_num(s):
    try:
        return float((s or "").replace(",", ""))
    except ValueError:
        return None


def check_row(r, ymd, sex_nm):
    """가이드상 잘못된 코드는 오류 없이 입력값을 되돌려주므로, 값끼리 맞는지로 이상 여부를 판단한다."""
    n = {f: to_num(r.get(f)) for f in NUM_FIELDS}
    issues = [f"{f} 비숫자" for f, v in n.items() if v is None]
    if r.get("judgeBreedNm") != BREED[1]:
        issues.append(f"품종={r.get('judgeBreedNm')}")
    if r.get("judgeSexNm") != sex_nm:
        issues.append(f"성별={r.get('judgeSexNm')}")
    if r.get("startYmd", "").replace("-", "") != ymd:
        issues.append(f"날짜={r.get('startYmd')}")
    if None not in n.values():
        if n["auctAmt"] <= 0:
            issues.append("평균가 0이하")
        if not n["minAuctAmt"] <= n["auctAmt"] <= n["maxAuctAmt"]:
            issues.append("최저≤평균≤최고 위반")
        if n["auctCnt"] and abs(n["weight"] * n["auctCnt"] - n["sumWeight"]) > n["auctCnt"]:
            issues.append("도체중×두수≠거래중량")
        if n["sumWeight"] and abs(n["auctAmt"] * n["sumWeight"] - n["sumAuctAmt"]) > 0.01 * n["sumAuctAmt"]:
            issues.append("평균가×중량≠거래대금(1%↑)")
    return n, issues


def inspect(raw, ymd, sex_cd):
    sex_nm = SEXES[sex_cd]
    print(f"\n{'=' * 78}\n{MARKET[1]} {ymd} {BREED[1]} {sex_nm}  (응답 {len(raw):,} bytes)")
    root = ET.fromstring(raw)
    code, msg = root.findtext(".//resultCode"), root.findtext(".//resultMsg")
    print(f"[결과코드] {code} / {msg} / totalCount={root.findtext('.//totalCount')}")
    if code != "00":
        print("[경고] 오류 응답입니다 (HTTP 200이어도 실패). 키·파라미터를 확인하세요.")
        return
    rows = [{c.tag: (c.text or "").strip() for c in it} for it in root.findall(".//item")]
    if not rows:
        print("[경고] 0건 — 휴장일이거나 해당 성별 출하가 없는 날입니다.")
        return

    print(f"[필드 {len(rows[0])}개] {', '.join(rows[0])}")
    print("[첫 레코드 원본]")
    for k, v in rows[0].items():
        print(f"    {k:<16}{v}")

    print(f"\n  {'구분':<5}{'코드':<6}{'등급명':<7}{'두수':>5}{'도체중':>7}{'평균가':>9}{'최저':>9}{'최고':>9}  검증")
    for r in rows:
        n, issues = check_row(r, ymd, sex_nm)
        mark = "*" if r.get("gradeNm") in TARGET_GRADES else " "
        fmt = lambda f: f"{n[f]:,.0f}" if n[f] is not None else "?"
        print(f"{mark} {r.get('gradeType', ''):<5}{r.get('gradeCd', ''):<6}{r.get('gradeNm', ''):<7}"
              f"{fmt('auctCnt'):>5}{fmt('weight'):>7}{fmt('auctAmt'):>9}{fmt('minAuctAmt'):>9}{fmt('maxAuctAmt'):>9}"
              f"  {'OK' if not issues else '[경고] ' + ', '.join(issues)}")

    names = [r.get("gradeNm") for r in rows]
    print(f"\n[등급명 전체] {names}")
    print(f"[대상 등급] 찾음={[g for g in TARGET_GRADES if g in names]} / 없음={[g for g in TARGET_GRADES if g not in names]}")
    print(f"[중복 등급명] {sorted({g for g in names if names.count(g) > 1}) or '없음'}")


def main():
    sys.stdout.reconfigure(errors="replace")  # 윈도우 콘솔(cp949)에서 못 찍는 문자로 멈추지 않게
    key = os.environ.get("EKAPE_KEY", "").strip()
    if not key:
        sys.exit('먼저 $env:EKAPE_KEY = "Decoding 키" 를 입력하세요.')
    ymd = sys.argv[1] if len(sys.argv) > 1 else "20261002"

    for sex_cd in SEXES:
        try:
            raw = fetch(key, ymd, sex_cd)
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"\n[경고] {SEXES[sex_cd]} 요청 실패: {e}")
            continue
        path = f"raw_{MARKET[0]}_{ymd}_{sex_cd}.xml"
        with open(path, "wb") as f:
            f.write(raw)
        print(f"\n[원본 저장] {path}")
        try:
            inspect(raw, ymd, sex_cd)
        except ET.ParseError as e:
            print(f"[경고] XML이 아닙니다: {e}\n{raw[:300]!r}")


if __name__ == "__main__":
    main()
