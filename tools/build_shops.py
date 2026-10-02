"""ミナミ周辺のインバウンド向けのお店を集めて data/shops.js を作る。

2つの無料データを合わせて使う(どちらもAPIキー不要)。
    - Overture Maps(Meta・Microsoft などが公開するお店データ。CDLA-Permissive-2.0)… 件数が多い
    - OpenStreetMap(Overpass API。ODbL)… Overture に無い店を補う
お店の分類(カテゴリ)と店名の言葉の両方で振り分ける。店名で拾うので、
カフェに分類されている抹茶の店や、キャラクターカフェなども入る。

分類(優先順。複数に当てはまるときは上を採用):
    anime    … アニメ・キャラクター(アニメ・漫画・ホビー・ゲーム・ガチャ・キャラクター店)
    matcha   … 抹茶・日本茶
    wa       … お土産・和雑貨(お土産専門店・手ぬぐい・扇子・着物・包丁・食品サンプル・民芸)
    shopping … ドラッグ・ドンキ・百均(チェーンのドラッグストア・ディスカウント・百貨店・家電量販)
    sweets   … お菓子・スイーツ(抹茶以外)

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
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# ミナミ 現地リサーチ(minami3d)の地図の移動範囲と同じ(南, 西, 北, 東)
BBOX = (34.635, 135.465, 34.695, 135.54)
MIN_CONFIDENCE = 0.6  # Overture の「実在しそう度」。低いものは閉店・誤登録が多い
MIN_ITEMS = 300  # 極端に少なければ取得失敗とみなし、既存データを残す

GROUP_LABEL = {
    "anime": "アニメ・キャラクター",
    "matcha": "抹茶・日本茶",
    "wa": "お土産・和雑貨",
    "sweets": "お菓子・スイーツ",
    "shopping": "ドラッグ・ドンキ・百均",
}
GROUP_ORDER = ["anime", "matcha", "wa", "shopping", "sweets"]

# ===== 店名の言葉 =====
NAME_WORDS = {
    "anime": r"アニメ|anime|ポケモン|pok[eé]mon|サンリオ|sanrio|ハローキティ|hello ?kitty|ジブリ|どんぐり共和国|ワンピース|one ?piece|"
             r"ジャンプ|jump ?shop|ちいかわ|すみっコ|リラックマ|カービィ|kirby|ガンダム|gundam|ガシャ|ガチャ|gacha|gashapon|カプセルトイ|"
             r"アニメイト|animate|駿河屋|らしんばん|まんだらけ|mandarake|メロンブックス|とらのあな|ゲーマーズ|k-books|ボークス|volks|"
             r"コトブキヤ|kotobukiya|フィギュア|figure|ホビー|hobby|トレカ|トレーディングカード|カードショップ|ドラゴンボール|鬼滅|コナン|"
             r"ハイキュー|キャラクター|任天堂|nintendo|カプコン|capcom|スクウェア・エニックス|square ?enix|バンダイ|bandai|タカラトミー|"
             r"プリキュア|セーラームーン|ミッフィー|miffy|スヌーピー|snoopy|ディズニー|disney|マリオ|特撮|ウルトラマン|"
             r"仮面ライダー|ゴジラ|godzilla|ヲタ|オタク|otaku|コスプレ|cosplay|メイドカフェ|メイド喫茶|maid ?cafe|ゲーム(?!.*(就労|支援))|スーパーポテト|"
             r"ジョーシン.*(ホビー|キッズ|ゲーム)|ボーネルンド|キディランド|kiddy ?land",
    "matcha": r"抹茶|matcha|宇治|茶寮|茶房|茶舗|日本茶|煎茶|ほうじ茶|玉露|茶屋本舗|伊藤久右衛門|中村藤吉|辻利|小山園|"
              r"一保堂|福寿園|伊右衛門|nana'?s green tea|ナナズグリーンティー|green ?tea|japanese ?tea|お茶の|茶葉",
    "wa": r"土産|みやげ|souvenir|和雑貨|手ぬぐい|てぬぐい|扇子|着物|きもの|kimono|浴衣|yukata|和傘|風呂敷|お箸|箸の|包丁|刃物|"
          r"knife|knives|cutlery|一文字|食品サンプル|道具屋|民芸|民藝|伝統工芸|和紙|招き猫|日本刀|"
          r"くいだおれ|大阪名物|japanese ?craft|crafts? of japan|和小物|がま口|印伝|漆|陶器|焼物|有田|九谷|今治",
    "shopping": r"^(mega|メガ)?ドン・?キホーテ|^ドンキ|don ?quijote|ダイソー|daiso|3coins|スリーコインズ|セリア|seria|キャンドゥ|"
                r"ロフト|東急ハンズ|^ハンズ|無印良品|muji|ビックカメラ|bic ?camera|ヨドバシ|ジョーシン|joshin|ラオックス|laox|"
                r"ダイコクドラッグ|daikoku|マツモトキヨシ|マツキヨ|matsumoto ?kiyoshi|スギ薬局|スギドラッグ|ココカラ|cocokara|"
                r"サンドラッグ|sun ?drug|コクミン|kokumin|ツルハ|ウエルシア|キリン堂|ドラッグイレブン|コスモス薬品|ドラッグストアコスモス|"
                r"アカカベ|セガミ|トモズ|tomod'?s|@cosme|アットコスメ|"
                # 百貨店は店名の先頭にあるときだけ(「ゴディバ 大丸心斎橋店」のようなテナントを百貨店扱いしない)
                r"^(高島屋|髙島屋|takashimaya|大丸|daimaru|近鉄百貨店|阪急|阪神百貨店|なんばマルイ|心斎橋パルコ|parco)",
    "sweets": r"和菓子|菓子|お菓子|せんべい|煎餅|おかき|饅頭|まんじゅう|大福|どら焼|羊羹|わらび餅|団子|だんご|chocolate|チョコレート|"
              r"パティスリー|patisserie|スイーツ|sweets|千鳥屋|鼓月|りくろー|551|蓬莱|ごかぼう|粟おこし|岩おこし",
}
NAME_RE = {g: re.compile(w, re.IGNORECASE) for g, w in NAME_WORDS.items()}
# 抹茶っぽい言葉でもタピオカ・紅茶専門などは外す
NOT_MATCHA = re.compile(r"タピオカ|bubble|ゴンチャ|gong ?cha|紅茶|black ?tea|ミルクティー|中国|台湾|アジアン|chinese|割烹", re.IGNORECASE)
# 観光客向けでない店(コンビニ・業務用スーパー・名前が百貨店に似ている薬局など)
NOT_TOURIST_SHOP = re.compile(r"ファミリーマート|ローソン|セブン-?イレブン|業務スーパー|大丸薬店|ビリサンドラッグ", re.IGNORECASE)
# 「花とギフト」の分類には花屋も入っているので、店名で外す
FLORIST = re.compile(r"花|フラワー|フローリスト|園芸|flower|florist|fleur", re.IGNORECASE)
# 店名だけで拾うと誤爆しやすい分類(会社・病院・学校など)は、店名マッチの対象から外す
NOT_SHOP_CATEGORY = re.compile(r"company|service|office|agency|school|clinic|hospital|dentist|doctor|surgery|"
                               r"manufactur|wholesale|supplier|real_estate|bank|hotel|hostel|church|temple|shrine|"
                               r"parking|government|association|organization|lawyer|accountant|consultant|station|train|transport|bus_", re.IGNORECASE)
# 飲食店は、抹茶(抹茶カフェ)とアニメ(キャラクターカフェ)以外では店名マッチの対象にしない(「串かつだるま」など)
FOOD_CATEGORY = re.compile(r"restaurant|bar$|_bar|pub|izakaya|food_court|cafe|coffee|diner|bistro|eatery|steakhouse|buffet", re.IGNORECASE)
NAME_ALLOWED_FOR_FOOD = {"anime", "matcha"}

# ===== 分類(カテゴリ)から決まるもの: カテゴリ → (分類, 表示名) =====
OVERTURE_CATEGORIES = {
    "comic_books_store": ("anime", "漫画・アニメ"),
    "hobby_shop": ("anime", "ホビー"),
    "toy_store": ("anime", "おもちゃ・キャラクター"),
    "video_game_store": ("anime", "ゲーム"),
    "souvenir_store": ("wa", "お土産"),
    "gift_shop": ("wa", "ギフト・雑貨"),
    "flowers_and_gifts_store": ("wa", "ギフト・雑貨"),
    "duty_free_store": ("wa", "免税店"),
    "kitchen_supply_store": ("wa", "包丁・台所道具"),
    "discount_store": ("shopping", "ディスカウント・百均"),
    "department_store": ("shopping", "百貨店"),
    "drugstore": ("shopping", "ドラッグストア"),
    "candy_store": ("sweets", "お菓子"),
    "japanese_confectionery_shop": ("sweets", "和菓子"),
    "dessert_shop": ("sweets", "スイーツ"),
}
# 薬局は調剤薬局が大半なので、チェーン名に当てはまるものだけ「ドラッグ」に入れる
CHAIN_ONLY_CATEGORIES = {"pharmacy", "drugstore", "electronics_store", "cosmetics_and_fragrance_store"}

OSM_SHOPS = {
    "anime": ("anime", "アニメグッズ"),
    "games": ("anime", "ゲーム"),
    "video_games": ("anime", "ゲーム"),
    "toys": ("anime", "おもちゃ・キャラクター"),
    "gift": ("wa", "お土産・雑貨"),
    "souvenir": ("wa", "お土産"),
    "souvenirs": ("wa", "お土産"),
    "craft": ("wa", "工芸"),
    "kimono": ("wa", "着物"),
    "knives": ("wa", "包丁"),
    "variety_store": ("shopping", "ディスカウント・百均"),
    "department_store": ("shopping", "百貨店"),
    "tea": ("matcha", "お茶"),
    "confectionery": ("sweets", "お菓子"),
    "pastry": ("sweets", "洋菓子"),
}
SUB_LABEL = {
    "anime": "アニメ・キャラクター",
    "matcha": "抹茶・日本茶",
    "wa": "お土産・和雑貨",
    "shopping": "ショッピング",
    "sweets": "お菓子",
}


def classify(name, category, category_map):
    """店名とカテゴリから (分類, 表示名) を決める。当てはまらなければ None。"""
    name = name or ""
    if NOT_TOURIST_SHOP.search(name):
        return None
    by_category = category_map.get(category)
    named = None
    if not NOT_SHOP_CATEGORY.search(category or ""):
        for g in GROUP_ORDER:
            if FOOD_CATEGORY.search(category or "") and g not in NAME_ALLOWED_FOR_FOOD:
                continue
            if NAME_RE[g].search(name) and not (g == "matcha" and NOT_MATCHA.search(name)):
                named = g
                break
    # 店名で決まる分類を優先(抹茶スイーツ店はお菓子ではなく抹茶に入れる、など)。
    # ただしカテゴリの方が優先順位が高ければカテゴリを使う
    if named and (not by_category or GROUP_ORDER.index(named) <= GROUP_ORDER.index(by_category[0])):
        kind = by_category[1] if by_category and by_category[0] == named else SUB_LABEL[named]
        return named, kind
    if by_category:
        group, kind = by_category
        if category in CHAIN_ONLY_CATEGORIES:
            return None
        if category == "flowers_and_gifts_store" and FLORIST.search(name):
            return None
        return group, kind
    return None


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
        if (p.get("confidence") or 0) < MIN_CONFIDENCE:
            continue
        category = (p.get("taxonomy") or {}).get("primary") or ""
        name = (p.get("names") or {}).get("primary")
        hit = classify(name, category, OVERTURE_CATEGORIES)
        if not hit:
            continue
        lon, lat = row["geometry"]["coordinates"]
        items.append(make_item(lat, lon, hit[0], hit[1], name, "overture"))
    return items


def fetch_osm():
    s, w, n, e = BBOX
    # お店全部とカフェを取り、店名とカテゴリで振り分ける
    query = f'[out:json][timeout:120];(nwr["shop"]({s},{w},{n},{e});nwr["amenity"="cafe"]({s},{w},{n},{e}););out center tags;'
    req = urllib.request.Request(
        OVERPASS_URL,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "osaka-minpaku-map/1.0", "Accept": "application/json"},
    )
    # Overpass は混んでいると 504 などを返すので、少し待って何回かやり直す
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
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
        if lat is None:
            continue
        name = tags.get("name") or tags.get("name:ja") or tags.get("name:en")
        names = " ".join(v for k, v in tags.items() if k.startswith("name") or k == "brand")
        category = tags.get("shop") or ""
        hit = classify(names, category, OSM_SHOPS)
        # OSM のドラッグストア(chemist)はチェーン名に当てはまるものだけ
        if not hit and category == "chemist" and NAME_RE["shopping"].search(names):
            hit = ("shopping", "ドラッグストア")
        if hit:
            items.append(make_item(lat, lon, hit[0], hit[1], name, "osm"))
    return items


def norm(name):
    return re.sub(r"[\s・()（）\-]|店$", "", (name or "").lower())


def is_same(a, b):
    """同じ店とみなすか: 近く(40m)で店名が似ている、または名前なしでごく近い(10m)"""
    d = distance(a, b)
    na, nb = norm(a.get("name")), norm(b.get("name"))
    if na and nb:
        return d <= 40 and (na in nb or nb in na or na[:4] == nb[:4])
    return d <= 10 and a["group"] == b["group"]


def merge(overture, osm):
    extra = [o for o in osm if not any(is_same(x, o) for x in overture)]
    items = overture + extra
    items.sort(key=lambda x: (GROUP_ORDER.index(x["group"]), x["lat"], x["lon"]))
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
        f"const SHOP_GROUP_ORDER = {to_json(GROUP_ORDER)};\n"
        f"const SHOP_GROUP_LABEL = {to_json(GROUP_LABEL)};\n"
        f"const SHOPS_DATA = {to_json(items)};\n",
        encoding="utf-8",
    )
    print(f"Overture {len(overture)}件 + OpenStreetMapのみ {osm_extra}件(OSM全体 {len(osm)}件)")
    print("内訳:", {GROUP_LABEL[g]: n for g, n in Counter(x["group"] for x in items).items()})
    print(f"合計 {len(items)}件")


if __name__ == "__main__":
    main()
