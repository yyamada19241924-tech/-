"""大阪市が公開する宿泊施設一覧(旅館業・特区民泊・住宅宿泊事業)から、
インバウンド向けの民泊・ゲストハウス系施設だけを取り出して data/minpaku.js を作る。

出典: 大阪市「旅館業・特区民泊・住宅宿泊事業の施設等一覧」(オープンデータ, CC-BY4.0)
      https://www.city.osaka.lg.jp/kenko/page/0000382418.html

対象にする施設:
    - 住宅宿泊事業(民泊新法)   … 全件
    - 特区民泊                … 全件
    - 旅館業のうち簡易宿所営業 … ゲストハウス寄りのものだけ(大型ホテル・旅館は除く)

住宅宿泊事業・特区民泊は「統合CSV」に緯度経度つきで入っているが、旅館業は
種別(簡易宿所か旅館・ホテルか)が別CSV(ryokan.csv)にしかないため、
施設名称+所在地で突き合わせて絞り込む。

データを更新したいときだけ実行する。
    python tools/build_data.py
"""
import csv
import html
import io
import re
import urllib.request
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urljoin

PAGE_URL = "https://www.city.osaka.lg.jp/kenko/page/0000382418.html"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# 統合CSVは業種ごとに件数が全く違うので、極端に少なければ取得失敗とみなす
MIN_ROWS = {"住宅宿泊事業": 1500, "特区民泊": 5000, "旅館業": 1000}

TYPE_CODE = {"住宅宿泊事業": "shinpou", "特区民泊": "tokku"}
TYPE_LABEL = {
    "shinpou": "住宅宿泊事業(民泊新法)",
    "tokku": "特区民泊",
    "kani": "簡易宿所(旅館業)",
}


def fetch_text(url, encoding):
    req = urllib.request.Request(url, headers={"User-Agent": "osaka-minpaku-map/1.0"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read().decode(encoding)


def find_base_url(page_html):
    """ページのリンクは <base href> 基準の相対パスなので、まずそれを取る。"""
    m = re.search(r'<base\s+href="([^"]+)"', page_html, re.IGNORECASE)
    return m.group(1) if m else PAGE_URL


def find_csv_url(page_html, base_url, keyword):
    """ページ内のリンクから、ファイル名に keyword を含むCSVのURLを探す。"""
    m = re.search(rf'href="([^"]*{keyword}[^"]*\.csv)"', page_html, re.IGNORECASE)
    if not m:
        raise SystemExit(f"'{keyword}' を含むCSVのリンクが見つかりません。ページ構成が変わった可能性があります。")
    return urljoin(base_url, html.unescape(m.group(1)))


def read_csv_rows(url):
    text = fetch_text(url, "cp932")
    return list(csv.reader(io.StringIO(text)))[1:]  # ヘッダーを除く


def split_lat_lon(a, b):
    """大阪市の統合CSVは緯度・経度の列名が逆になっているため、
    値の大きさ(大阪は北緯34度台・東経135度台)で判定する。"""
    a, b = float(a), float(b)
    return (a, b) if a < 100 else (b, a)  # -> (lat, lon)


def load_kani_keys(ryokan_url):
    """旅館業CSVから、簡易宿所営業(ゲストハウス寄り)の (施設名称, 所在地) の集合を作る。"""
    rows = read_csv_rows(ryokan_url)
    if len(rows) < MIN_ROWS["旅館業"]:
        raise SystemExit(f"旅館業CSVの件数が少なすぎます({len(rows)}件)。既存データはそのままにします。")
    return {
        (row[1].strip(), row[2].strip())
        for row in rows
        if len(row) >= 5 and row[4].strip() == "簡易宿所営業"
    }


def build_items(ketsugo_url, kani_keys):
    rows = read_csv_rows(ketsugo_url)
    counts = {"住宅宿泊事業": 0, "特区民泊": 0, "旅館業": 0}
    for row in rows:
        if row and row[0] in counts:
            counts[row[0]] += 1
    for kind, minimum in MIN_ROWS.items():
        if counts[kind] < minimum:
            raise SystemExit(f"{kind}の件数が少なすぎます({counts[kind]}件)。既存データはそのままにします。")

    items = []
    for row in rows:
        if len(row) < 5 or not row[0]:
            continue
        kind, name, addr = row[0], row[1].strip(), row[2].strip()
        if kind == "旅館業":
            if (name, addr) not in kani_keys:
                continue
            type_code = "kani"
        elif kind in TYPE_CODE:
            type_code = TYPE_CODE[kind]
        else:
            continue
        try:
            lat, lon = split_lat_lon(row[3], row[4])
        except ValueError:
            continue
        item = {"lat": round(lat, 6), "lon": round(lon, 6), "addr": addr, "type": type_code}
        if name and name not in ("−", "－", "ー", "-"):  # 施設名称が無い行はプレースホルダーが入っている
            item["name"] = name
        items.append(item)
    return items


def to_json(data):
    import json
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def write_js(filename, lines):
    header = (
        "// 自動生成ファイル(tools/build_data.py)。手で編集しない。\n"
        "// データ: 大阪市「旅館業・特区民泊・住宅宿泊事業の施設等一覧」(CC-BY4.0)\n"
        "// https://www.city.osaka.lg.jp/kenko/page/0000382418.html\n"
    )
    (DATA_DIR / filename).write_text(header + "".join(lines), encoding="utf-8")


def find_source_date(ketsugo_url):
    m = re.search(r"(20\d{6})", ketsugo_url)
    if not m:
        return date.today().isoformat()
    d = datetime.strptime(m.group(1), "%Y%m%d").date()
    return d.isoformat()


def main():
    page_html = fetch_text(PAGE_URL, "utf-8")
    base_url = find_base_url(page_html)
    ketsugo_url = find_csv_url(page_html, base_url, "ketsugo")
    ryokan_url = find_csv_url(page_html, base_url, "ryokan")

    kani_keys = load_kani_keys(ryokan_url)
    items = build_items(ketsugo_url, kani_keys)
    items.sort(key=lambda x: (x["type"], x["addr"]))

    source_date = find_source_date(ketsugo_url)
    write_js("minpaku.js", [
        f'const MINPAKU_DATA_DATE = "{source_date}";\n',
        f"const MINPAKU_TYPE_LABEL = {to_json(TYPE_LABEL)};\n",
        f"const MINPAKU_DATA = {to_json(items)};\n",
    ])

    from collections import Counter
    print(f"{source_date}時点のデータを保存しました。")
    print("内訳:", dict(Counter(x["type"] for x in items)))
    print(f"合計 {len(items)}件")


if __name__ == "__main__":
    main()
