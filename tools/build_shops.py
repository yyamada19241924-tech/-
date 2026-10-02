"""ミナミ周辺のお土産系のお店を集めて data/shops.js を作る。

2つの無料データを合わせて使う(どちらもAPIキー不要)。
    - Overture Maps(Meta・Microsoft などが公開するお店データ。CDLA-Permissive-2.0)… 件数が多い
    - OpenStreetMap(Overpass API。ODbL)… Overture に無い店を補う
同じ場所(25m以内)に同じ分類の店があれば、Overture 側を残して OpenStreetMap 側は捨てる。

分類:
    gift   … お土産・ギフト・雑貨
    sweets … お菓子・お茶・アニメ・ホビー

準備(初回だけ): pip install overturemaps
データを更新したいときだけ実行する。
    python tools/build_shops.py
"""
import json
import math
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.error
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# ミナミ 現地リサーチ(minami3d)の地図の移動範囲と同じ(南, 西, 北, 東)
BBOX = (34.635, 135.465, 34.695, 135.54)
DEDUPE_M = 25
MIN_CONFIDENCE = 0.6  # Overture の「実在しそう度」。低いものは閉店・誤登録が多い
MIN_ITEMS = 200  # 極端に少なければ取得失敗とみなし、既存データを残す

GROUP_LABEL = {"gift": "お土産・雑貨", "sweets": "お菓子・お茶・アニメ"}

# OpenStreetMap の shop=* → (分類, 表示名)
OSM_SHOPS = {
    "gift": ("gift", "お土産・雑貨"),
    "souvenir": ("gift", "お土産・雑貨"),
    "souvenirs": ("gift", "お土産・雑貨"),
    "confectionery": ("sweets", "お菓子"),
    "pastry": ("sweets", "洋菓子・パン"),
    "tea": ("sweets", "お茶"),
    "anime": ("sweets", "アニメグッズ"),
}

# Overture の taxonomy.primary → (分類, 表示名)
OVERTURE_CATEGORIES = {
    "souvenir_store": ("gift", "お土産"),
    "gift_shop": ("gift", "ギフト・雑貨"),
    "flowers_and_gifts_store": ("gift", "ギフト・雑貨"),
    "duty_free_store": ("gift", "免税店"),
    "candy_store": ("sweets", "お菓子"),
    "japanese_confectionery_shop": ("sweets", "和菓子"),
    "dessert_shop": ("sweets", "スイーツ"),
    "comic_books_store": ("sweets", "漫画・アニメ"),
    "hobby_shop": ("sweets", "ホビー・アニメ"),
    "toy_store": ("sweets", "おもちゃ・キャラクター"),
}
# 「花とギフト」の分類には花屋も入っているので、店名で外す
FLORIST_NAME = re.compile(r"花|フラワー|フローリスト|園芸|flower|florist|fleur", re.IGNORECASE)


def distance(a, b):
    r = math.pi / 180
    h = math.sin((b["lat"] - a["lat"]) * r / 2) ** 2 + math.cos(a["lat"] * r) * math.cos(b["lat"] * r) * math.sin((b["lon"] - a["lon"]) * r / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))


def make_item(lat, lon, group, kind, name, source):
    item = {"lat": round(lat, 6), "lon": round(lon, 6), "group": group, "kind": kind, "src": source}
    if name:
        item["name"] = name
    return item


def fetch_overture():
    s, w, n, e = BBOX
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "places.geojsonseq"
        subprocess.run(
            [sys.executable, "-m", "overturemaps", "download", f"--bbox={w},{s},{e},{n}",
             "-f", "geojsonseq", "--type=place", "-o", str(out)],
            check=True,
        )
        rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines() if line.strip()]

    items = []
    for row in rows:
        p = row["properties"]
        category = (p.get("taxonomy") or {}).get("primary")
        if category not in OVERTURE_CATEGORIES or (p.get("confidence") or 0) < MIN_CONFIDENCE:
            continue
        name = (p.get("names") or {}).get("primary")
        if category == "flowers_and_gifts_store" and name and FLORIST_NAME.search(name):
            continue
        lon, lat = row["geometry"]["coordinates"]
        group, kind = OVERTURE_CATEGORIES[category]
        items.append(make_item(lat, lon, group, kind, name, "overture"))
    return items


def fetch_osm():
    s, w, n, e = BBOX
    query = f'[out:json][timeout:90];nwr["shop"~"^({"|".join(OSM_SHOPS)})$"]({s},{w},{n},{e});out center tags;'
    req = urllib.request.Request(
        OVERPASS_URL,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "osaka-minpaku-map/1.0", "Accept": "application/json"},
    )
    # Overpass は混んでいると 504 などを返すので、少し待って何回かやり直す
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                elements = json.load(res)["elements"]
            break
        except urllib.error.HTTPError as err:
            if attempt == 3 or err.code not in (429, 502, 503, 504):
                raise
            print(f"Overpass が混雑中({err.code})。{20 * (attempt + 1)}秒待ってやり直します")
            time.sleep(20 * (attempt + 1))

    items = []
    for el in elements:
        tags = el.get("tags", {})
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        if tags.get("shop") not in OSM_SHOPS or lat is None:
            continue
        group, kind = OSM_SHOPS[tags["shop"]]
        name = tags.get("name") or tags.get("name:ja") or tags.get("name:en")
        items.append(make_item(lat, lon, group, kind, name, "osm"))
    return items


def merge(overture, osm):
    extra = [
        o for o in osm
        if not any(x["group"] == o["group"] and distance(x, o) <= DEDUPE_M for x in overture)
    ]
    items = overture + extra
    items.sort(key=lambda x: (x["group"], x["lat"], x["lon"]))
    return items, len(extra)


def main():
    overture = fetch_overture()
    osm = fetch_osm()
    items, osm_extra = merge(overture, osm)
    if len(items) < MIN_ITEMS:
        raise SystemExit(f"お店の件数が少なすぎます({len(items)}件)。既存データはそのままにします。")
    to_json = lambda d: json.dumps(d, ensure_ascii=False, separators=(",", ":"))
    (DATA_DIR / "shops.js").write_text(
        "// 自動生成ファイル(tools/build_shops.py)。手で編集しない。\n"
        "// データ: © Overture Maps Foundation (CDLA-Permissive-2.0) / © OpenStreetMap contributors (ODbL)\n"
        f'const SHOPS_DATA_DATE = "{date.today().isoformat()}";\n'
        f"const SHOP_GROUP_LABEL = {to_json(GROUP_LABEL)};\n"
        f"const SHOPS_DATA = {to_json(items)};\n",
        encoding="utf-8",
    )
    print(f"Overture {len(overture)}件 + OpenStreetMapのみ {osm_extra}件(重複除外前 {len(osm)}件)")
    print("内訳:", dict(Counter(x["group"] for x in items)))
    print(f"合計 {len(items)}件")


if __name__ == "__main__":
    main()
