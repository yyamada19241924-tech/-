// ミナミ 現地リサーチマップ(3D)
// 更新したら index.html の app.js?v= と style.css?v= の番号も上げる(スマホに古いファイルが残らないように)
// 地図: MapLibre GL + OpenFreeMap(OpenStreetMap、APIキー不要)。航空写真は国土地理院。
// 施設データは全体版と共通の ../data/minpaku.js。候補地はこのスマホの中(localStorage)にだけ保存する。

// ===== 設定 =====
// 範囲はミナミ版(../minami/index.html)と同じ: 13町 + 難波駅・大国町駅から半径500m
const AREA_TOWNS = [
  "中央区島之内", "中央区日本橋", "中央区西心斎橋", "中央区東心斎橋", "中央区南船場",
  "中央区千日前", "中央区道頓堀", "中央区難波", "中央区宗右衛門町", "中央区心斎橋筋",
  "浪速区元町", "浪速区難波中",
];
const AREA_STATIONS = [
  { lat: 34.666579, lon: 135.499196, radius: 500 }, // なんば(御堂筋線)
  { lat: 34.663663, lon: 135.501775, radius: 500 }, // 難波(南海)
  { lat: 34.656242, lon: 135.497868, radius: 500 }, // 大国町
];
const START = { center: [135.5015, 34.6655], zoom: 15.5, pitch: 55, bearing: -17 };
const NEAR_RADIUS = 200; // 「周辺の民泊件数」の半径(m)
const TYPE_COLOR = { shinpou: "#2e9e4f", tokku: "#1e73d8", kani: "#d8461e" };
const TYPE_ORDER = ["shinpou", "tokku", "kani"];
// お土産系のお店(OpenStreetMap)。民泊の丸と見分けやすいよう、黒ふちの丸にする
const SHOP_COLOR = { gift: "#e0a100", sweets: "#d6338f" };
const SHOP_ORDER = ["gift", "sweets"];
const STORAGE_KEY = "minami-research-candidates-v1";

// ===== ユーティリティ =====
const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// 2点間の距離(m)
function distance(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
}

const distanceLabel = (m) => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`);

let toastTimer = null;
function toast(msg) {
  $("toast").textContent = msg;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3000);
}

// ===== 施設データ =====
function inArea(d) {
  if (AREA_TOWNS.some((t) => d.addr.startsWith(t))) return true;
  return AREA_STATIONS.some((s) => distance(s.lat, s.lon, d.lat, d.lon) <= s.radius);
}

const ITEMS = MINPAKU_DATA.filter(inArea).map((d, i) => ({ ...d, id: i, title: d.name || MINPAKU_TYPE_LABEL[d.type] }));
const activeTypes = new Set(TYPE_ORDER);

const SHOPS = SHOPS_DATA.map((d, i) => ({ ...d, id: i, title: d.name || d.kind }));
const activeShops = new Set(SHOP_ORDER);

function shopsGeoJSON() {
  return {
    type: "FeatureCollection",
    features: SHOPS.filter((x) => activeShops.has(x.group)).map((x) => ({
      type: "Feature",
      properties: { id: x.id, group: x.group },
      geometry: { type: "Point", coordinates: [x.lon, x.lat] },
    })),
  };
}

function countNear(lat, lon, radius = NEAR_RADIUS) {
  return ITEMS.filter((x) => activeTypes.has(x.type) && distance(lat, lon, x.lat, x.lon) <= radius).length;
}

function itemsGeoJSON() {
  return {
    type: "FeatureCollection",
    features: ITEMS.filter((x) => activeTypes.has(x.type)).map((x) => ({
      type: "Feature",
      id: x.id,
      properties: { id: x.id, type: x.type },
      geometry: { type: "Point", coordinates: [x.lon, x.lat] },
    })),
  };
}

// ===== 地図 =====
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  ...START,
  maxBounds: [[135.465, 34.635], [135.54, 34.695]],
  minZoom: 13.5,
  maxPitch: 70,
  attributionControl: false,
});
// 出典は右下のボタンと重ならないよう左下に出す
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "お店: © Overture Maps Foundation" }), "bottom-left");
map.touchPitch.enable(); // 2本指で上下になぞると傾く

let photoOn = false;

// "load" は3Dの建物タイルを全部読み終えるまで来ないことがあるので、スタイルを読んだ時点でピンなどを足す
map.once("style.load", () => {
  // 地名は日本語だけにする(元のスタイルは英語+日本語の2行)
  map.getStyle().layers.forEach((l) => {
    if (l.type === "symbol" && map.getLayoutProperty(l.id, "text-field")) {
      map.setLayoutProperty(l.id, "text-field", ["coalesce", ["get", "name:ja"], ["get", "name"]]);
    }
  });

  // 航空写真(はじめは非表示)。立体の建物と地名の下に敷く
  map.addSource("photo", {
    type: "raster",
    tiles: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"],
    tileSize: 256,
    maxzoom: 18,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>',
  });
  map.addLayer({ id: "photo", type: "raster", source: "photo", layout: { visibility: "none" } }, "building-3d");

  // 民泊のピン
  map.addSource("items", { type: "geojson", data: itemsGeoJSON() });
  map.addLayer({
    id: "items",
    type: "circle",
    source: "items",
    paint: {
      "circle-color": ["match", ["get", "type"], "shinpou", TYPE_COLOR.shinpou, "tokku", TYPE_COLOR.tokku, TYPE_COLOR.kani],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 3, 16, 5, 18, 8],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 14, 0.6, 17, 1.5],
      "circle-pitch-alignment": "map",
    },
  });
  // お土産系のお店のピン(民泊より上に重ねる)
  map.addSource("shops", { type: "geojson", data: shopsGeoJSON() });
  map.addLayer({
    id: "shops",
    type: "circle",
    source: "shops",
    paint: {
      "circle-color": ["match", ["get", "group"], "gift", SHOP_COLOR.gift, SHOP_COLOR.sweets],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 4, 16, 6, 18, 9],
      "circle-stroke-color": "#2b2118",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 14, 1, 17, 2],
      "circle-pitch-alignment": "map",
    },
  });
  // 中心から半径200mの範囲(件数の対象)
  map.addSource("near", { type: "geojson", data: circleGeoJSON(START.center, NEAR_RADIUS) });
  map.addLayer({
    id: "near",
    type: "line",
    source: "near",
    paint: { "line-color": "#d8461e", "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.8 },
  }, "items");

  map.on("click", "items", (e) => showItem(ITEMS[e.features[0].properties.id]));
  map.on("click", "shops", (e) => showShop(SHOPS[e.features[0].properties.id]));
  ["items", "shops"].forEach((id) => {
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  });

  updateNear();
  renderCandidates();
});

// 中心(十字)のまわりの件数を表示
function circleGeoJSON([lon, lat], radius) {
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    pts.push([lon + (radius * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (radius * Math.cos(a)) / 110540]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [pts] } };
}

function updateNear() {
  const c = map.getCenter();
  $("near-count").textContent = `十字から${NEAR_RADIUS}m: 民泊 ${countNear(c.lat, c.lng)}件`;
  const src = map.getSource("near");
  if (src) src.setData(circleGeoJSON([c.lng, c.lat], NEAR_RADIUS));
}
map.on("move", updateNear);

// ===== 種別チップ =====
function renderChips() {
  const counts = { shinpou: 0, tokku: 0, kani: 0 };
  ITEMS.forEach((x) => counts[x.type]++);
  $("chips").innerHTML = TYPE_ORDER.map((t) => `
    <button type="button" class="chip" data-type="${t}" aria-pressed="${activeTypes.has(t)}" style="--dot:${TYPE_COLOR[t]}">
      <span class="dot"></span>${MINPAKU_TYPE_LABEL[t].replace(/\(.*\)/, "")}<span class="count">${counts[t]}</span>
    </button>`).join("") + SHOP_ORDER.map((g) => `
    <button type="button" class="chip shop" data-shop="${g}" aria-pressed="${activeShops.has(g)}" style="--dot:${SHOP_COLOR[g]}">
      <span class="dot"></span>${SHOP_GROUP_LABEL[g]}<span class="count">${SHOPS.filter((x) => x.group === g).length}</span>
    </button>`).join("");
}
$("chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  if (chip.dataset.shop) {
    const g = chip.dataset.shop;
    activeShops.has(g) ? activeShops.delete(g) : activeShops.add(g);
    chip.setAttribute("aria-pressed", String(activeShops.has(g)));
    map.getSource("shops")?.setData(shopsGeoJSON());
    return;
  }
  const t = chip.dataset.type;
  activeTypes.has(t) ? activeTypes.delete(t) : activeTypes.add(t);
  chip.setAttribute("aria-pressed", String(activeTypes.has(t)));
  map.getSource("items")?.setData(itemsGeoJSON());
  updateNear();
});

// ===== 拡大・縮小 =====
$("zoom-in-btn").addEventListener("click", () => map.zoomIn());
$("zoom-out-btn").addEventListener("click", () => map.zoomOut());

// ===== 3D・航空写真の切り替え =====
$("tilt-btn").addEventListener("click", (e) => {
  const on = map.getPitch() < 10;
  map.easeTo({ pitch: on ? START.pitch : 0, bearing: on ? map.getBearing() : 0 });
  map.setLayoutProperty("building-3d", "visibility", on ? "visible" : "none");
  e.currentTarget.setAttribute("aria-pressed", String(on));
});
map.on("pitchend", () => $("tilt-btn").setAttribute("aria-pressed", String(map.getPitch() >= 10)));

$("photo-btn").addEventListener("click", (e) => {
  photoOn = !photoOn;
  map.setLayoutProperty("photo", "visibility", photoOn ? "visible" : "none");
  // 写真のときは建物を半透明にして、屋根の写真が見えるようにする
  map.setPaintProperty("building-3d", "fill-extrusion-opacity", photoOn ? 0.45 : 0.8);
  e.currentTarget.setAttribute("aria-pressed", String(photoOn));
});

// ===== 現在地を追いかける =====
let watchId = null;
let here = null; // { lat, lon, accuracy }
let following = false;
const hereEl = document.createElement("div");
hereEl.className = "here-dot";
const hereMarker = new maplibregl.Marker({ element: hereEl });

function setFollowing(on) {
  following = on;
  $("follow-btn").setAttribute("aria-pressed", String(on));
}

function startWatch() {
  if (!navigator.geolocation) {
    toast("このブラウザでは位置情報が使えません");
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const first = !here;
      here = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
      hereMarker.setLngLat([here.lon, here.lat]).addTo(map);
      if (following) map.easeTo({ center: [here.lon, here.lat], zoom: first ? Math.max(map.getZoom(), 17) : map.getZoom(), duration: first ? 800 : 500 });
    },
    () => {
      toast("位置情報を取得できませんでした。スマホとブラウザの位置情報の許可を確認してください");
      stopWatch();
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

function stopWatch() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  setFollowing(false);
}

$("follow-btn").addEventListener("click", () => {
  if (following) {
    setFollowing(false);
    return;
  }
  setFollowing(true);
  if (watchId == null) startWatch();
  else if (here) map.easeTo({ center: [here.lon, here.lat] });
});
// 指で地図を動かしたら追いかけるのをやめる(現在地の点は出したまま)
map.on("dragstart", () => following && setFollowing(false));

// ===== 下のパネル =====
function openSheet(html) {
  $("sheet-body").innerHTML = html;
  $("sheet").hidden = false;
}
function closeSheet() {
  $("sheet").hidden = true;
}
$("sheet-close").addEventListener("click", closeSheet);

function showItem(item) {
  const dist = here ? `<p class="sub">現在地から ${distanceLabel(distance(here.lat, here.lon, item.lat, item.lon))}</p>` : "";
  const route = `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${item.lat},${item.lon}`;
  openSheet(`
    <p class="kind" style="--dot:${TYPE_COLOR[item.type]}"><span class="dot"></span>${escapeHtml(MINPAKU_TYPE_LABEL[item.type])}</p>
    <h2>${escapeHtml(item.title)}</h2>
    <p class="sub">${escapeHtml(item.addr)}</p>
    ${dist}
    <div class="actions"><a class="btn" href="${route}" target="_blank" rel="noopener">Googleマップで徒歩ルート</a></div>`);
}

function showShop(shop) {
  const dist = here ? `<p class="sub">現在地から ${distanceLabel(distance(here.lat, here.lon, shop.lat, shop.lon))}</p>` : "";
  const route = `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${shop.lat},${shop.lon}`;
  openSheet(`
    <p class="kind shop" style="--dot:${SHOP_COLOR[shop.group]}"><span class="dot"></span>${escapeHtml(shop.kind)}</p>
    <h2>${escapeHtml(shop.title)}</h2>
    ${dist}
    <p class="sub">${shop.src === "osm" ? "OpenStreetMap" : "Overture Maps"}の情報(${SHOPS_DATA_DATE}取得)。閉店している場合があります</p>
    <div class="actions"><a class="btn" href="${route}" target="_blank" rel="noopener">Googleマップで徒歩ルート</a></div>`);
}

// ===== 候補地(このスマホに保存) =====
function loadCandidates() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}
let candidates = loadCandidates();

function saveCandidates() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(candidates));
  } catch {
    toast("保存できませんでした(プライベートブラウズでは保存できないことがあります)");
  }
}

const candMarkers = [];
function renderCandidates() {
  candMarkers.forEach((m) => m.remove());
  candMarkers.length = 0;
  candidates.forEach((c, i) => {
    const el = document.createElement("button");
    el.className = "cand-pin";
    el.textContent = i + 1;
    el.setAttribute("aria-label", `候補地${i + 1}`);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      showCandidate(i);
    });
    candMarkers.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([c.lon, c.lat]).addTo(map));
  });
  $("cand-count").textContent = candidates.length;
}

const timeLabel = (iso) => new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

$("add-btn").addEventListener("click", () => {
  const c = map.getCenter();
  const n = countNear(c.lat, c.lng);
  openSheet(`
    <h2>候補地${candidates.length + 1}を追加</h2>
    <p class="sub">十字の位置 / 半径${NEAR_RADIUS}mの民泊 <b>${n}件</b></p>
    <label class="field-label" for="cand-note">メモ(人通り・周りの様子など)</label>
    <textarea id="cand-note" rows="3" placeholder="例: 角のコインパーキング横。外国人グループ多い"></textarea>
    <div class="actions">
      <button type="button" id="cand-save" class="btn">保存</button>
    </div>`);
  $("cand-save").addEventListener("click", () => {
    candidates.push({ lat: +c.lat.toFixed(6), lon: +c.lng.toFixed(6), note: $("cand-note").value.trim(), near: n, at: new Date().toISOString() });
    saveCandidates();
    renderCandidates();
    closeSheet();
    toast(`候補地${candidates.length}を保存しました`);
  });
});

function showCandidate(i) {
  const c = candidates[i];
  const route = `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}`;
  openSheet(`
    <h2>候補地${i + 1}</h2>
    <p class="sub">${timeLabel(c.at)} 記録 / 半径${NEAR_RADIUS}mの民泊 <b>${c.near}件</b></p>
    <p class="note">${c.note ? escapeHtml(c.note) : "(メモなし)"}</p>
    <div class="actions">
      <a class="btn" href="${route}" target="_blank" rel="noopener">Googleマップで開く</a>
      <button type="button" id="cand-del" class="btn ghost">削除</button>
    </div>`);
  // 削除は2回押しで確定(誤タップ防止)
  $("cand-del").addEventListener("click", (e) => {
    if (e.currentTarget.dataset.armed !== "1") {
      e.currentTarget.dataset.armed = "1";
      e.currentTarget.textContent = "もう一度押すと削除";
      return;
    }
    candidates.splice(i, 1);
    saveCandidates();
    renderCandidates();
    closeSheet();
    toast("削除しました");
  });
}

function candidatesText() {
  return candidates.map((c, i) =>
    `【候補地${i + 1}】${timeLabel(c.at)} 民泊${c.near}件(半径${NEAR_RADIUS}m)\n${c.note || "(メモなし)"}\nhttps://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}`
  ).join("\n\n");
}

$("list-btn").addEventListener("click", () => {
  if (candidates.length === 0) {
    openSheet(`<h2>候補地</h2><p class="sub">まだありません。地図を動かして十字を置きたい場所に合わせ、「＋ 十字の位置を候補地に」を押すと記録できます。</p>`);
    return;
  }
  openSheet(`
    <h2>候補地 ${candidates.length}件</h2>
    <ul class="cand-list">
      ${candidates.map((c, i) => `
        <li><button type="button" class="cand-row" data-i="${i}">
          <span class="cand-no">${i + 1}</span>
          <span class="cand-main"><span class="cand-note">${c.note ? escapeHtml(c.note) : "(メモなし)"}</span>
          <span class="sub">${timeLabel(c.at)} / 民泊${c.near}件</span></span>
        </button></li>`).join("")}
    </ul>
    <div class="actions">
      <button type="button" id="copy-btn" class="btn">一覧をコピー(LINEに貼れる)</button>
    </div>
    <textarea id="copy-area" class="copy-area" rows="4" readonly hidden></textarea>`);
  $("sheet-body").querySelectorAll(".cand-row").forEach((row) =>
    row.addEventListener("click", () => {
      const c = candidates[+row.dataset.i];
      map.easeTo({ center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 17) });
      showCandidate(+row.dataset.i);
    })
  );
  $("copy-btn").addEventListener("click", async () => {
    const text = candidatesText();
    try {
      await navigator.clipboard.writeText(text);
      toast("コピーしました。LINEなどに貼り付けてください");
    } catch {
      // コピーできない端末では、文字を表示して手動でコピーしてもらう
      const area = $("copy-area");
      area.value = text;
      area.hidden = false;
      area.select();
      toast("下の文字を長押ししてコピーしてください");
    }
  });
});

// ===== 起動 =====
renderChips();
