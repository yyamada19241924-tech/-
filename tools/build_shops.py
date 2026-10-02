"""OpenStreetMap から、ミナミ周辺のお土産系のお店を取り出して data/shops.js を作る。

出典: © OpenStreetMap contributors (ODbL)。Overpass API で取得する(APIキー不要)。
OpenStreetMap は有志が登録している地図なので、実際のお店より少ないことがある。

分類:
    gift   … お土産屋・雑貨(shop=gift / souvenir)
    sweets … お菓子・お茶・アニメグッズ(shop=confectionery / pastry / tea / anime)

データを更新したいときだけ実行する。
    python tools/build_shops.py
"""
import json
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# ミナミ 現地リサーチ(minami3d)の地図の移動範囲と同じ(南, 西, 北, 東)
BBOX = (34.635, 135.465, 34.695, 135.54)

SHOP_GROUP = {
    "gift": "gift",
    "souvenir": "gift",
    "souvenirs": "gift",
    "confectionery": "sweets",
    "pastry": "sweets",
    "tea": "sweets",
    "anime": "sweets",
}
SHOP_LABEL = {
    "gift": "お土産・雑貨",
    "souvenir": "お土産・雑貨",
    "souvenirs": "お土産・雑貨",
    "confectionery": "お菓子",
    "pastry": "洋菓子・パン",
    "tea": "お茶",
    "anime": "アニメグッズ",
}
GROUP_LABEL = {"gift": "お土産・雑貨", "sweets": "お菓子・お茶・アニメ"}
MIN_ITEMS = 50  # 極端に少なければ取得失敗とみなし、既存データを残す


def fetch_shops():
    tags = "|".join(SHOP_GROUP)
    s, w, n, e = BBOX
    query = f'[out:json][timeout:90];nwr["shop"~"^({tags})$"]({s},{w},{n},{e});out center tags;'
    req = urllib.request.Request(
        OVERPASS_URL,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "osaka-minpaku-map/1.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.load(res)["elements"]


def build_items(elements):
    items = []
    for el in elements:
        tags = el.get("tags", {})
        shop = tags.get("shop")
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        if shop not in SHOP_GROUP or lat is None:
            continue
        item = {"lat": round(lat, 6), "lon": round(lon, 6), "group": SHOP_GROUP[shop], "kind": SHOP_LABEL[shop]}
        name = tags.get("name") or tags.get("name:ja") or tags.get("name:en")
        if name:
            item["name"] = name
        items.append(item)
    items.sort(key=lambda x: (x["group"], x["lat"], x["lon"]))
    return items


def main():
    items = build_items(fetch_shops())
    if len(items) < MIN_ITEMS:
        raise SystemExit(f"お店の件数が少なすぎます({len(items)}件)。既存データはそのままにします。")
    to_json = lambda d: json.dumps(d, ensure_ascii=False, separators=(",", ":"))
    (DATA_DIR / "shops.js").write_text(
        "// 自動生成ファイル(tools/build_shops.py)。手で編集しない。\n"
        "// データ: © OpenStreetMap contributors (ODbL)\n"
        f'const SHOPS_DATA_DATE = "{date.today().isoformat()}";\n'
        f"const SHOP_GROUP_LABEL = {to_json(GROUP_LABEL)};\n"
        f"const SHOPS_DATA = {to_json(items)};\n",
        encoding="utf-8",
    )
    print("内訳:", dict(Counter(x["group"] for x in items)))
    print(f"合計 {len(items)}件")


if __name__ == "__main__":
    main()
