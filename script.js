// ===== 設定 =====
// エリア版(minami/ など)は、script.js を読む前に window.MAP_CONFIG を置いて範囲や地図を変える
const CFG = window.MAP_CONFIG || {};
const MAX_LIST_ITEMS = 200;
const WALK_M_PER_MIN = 80; // 徒歩の目安(不動産表示と同じ 80m/分)

// 大阪市の範囲(南西・北東)。地図の移動範囲と地名検索をここに絞る
const OSAKA_BOUNDS = L.latLngBounds([34.586, 135.31], [34.769, 135.6]);
const START_VIEW = CFG.startView || { center: [34.6873, 135.5019], zoom: 14 }; // 難波・ミナミ周辺(インバウンド宿泊が多いエリア)

const TYPE_COLOR = { shinpou: "#2e9e4f", tokku: "#1e73d8", kani: "#d8461e" };
const TYPE_ORDER = ["shinpou", "tokku", "kani"];

// ===== 要素 =====
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const listEl = $("result-list");
const detailEl = $("detail");
const sheetEl = $("sheet");
const sheetHandle = $("sheet-handle");
const chipsEl = $("cat-chips");
const toastEl = $("toast");

// ===== データ整形 =====
// エリア指定があれば、町名(住所の先頭)か駅からの距離で絞る
function inArea(d) {
  const area = CFG.area;
  if (!area) return true;
  if (area.towns.some((t) => d.addr.startsWith(t))) return true;
  return area.stations.some((s) => L.latLng(s.lat, s.lon).distanceTo([d.lat, d.lon]) <= s.radius);
}

const ALL_ITEMS = MINPAKU_DATA.filter(inArea).map((d, i) => ({
  ...d,
  id: i,
  title: d.name || MINPAKU_TYPE_LABEL[d.type],
  color: TYPE_COLOR[d.type],
}));

const activeTypes = new Set(TYPE_ORDER);
let visibleItems = [];
let selectedId = null;
let here = null; // 現在地 L.LatLng
const markers = new Map();

// ===== 地図 =====
const map = L.map("map", {
  preferCanvas: true, // 1万件超のピンを軽く描くため、canvasで描画する
  maxBounds: CFG.maxBounds ? L.latLngBounds(CFG.maxBounds) : OSAKA_BOUNDS.pad(0.1),
  minZoom: CFG.minZoom || 12,
  zoomSnap: 0.25, // ズームを細かい刻みにして、拡大・縮小を滑らかにする
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 100, // ホイール操作の感度をなめらかさに合わせて調整
}).setView(START_VIEW.center, START_VIEW.zoom);
map.zoomControl.setPosition("bottomleft");
const osmLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  className: "base-map", // 色を薄くするのは通常の地図だけ(航空写真はそのまま)
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
});
if (CFG.satellite) {
  // 国土地理院の航空写真(APIキー不要・出典表示で利用可)。写真はz18までなので、それ以上は拡大表示
  const photoLayer = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", {
    maxZoom: 19,
    maxNativeZoom: 18,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>(シームレス空中写真)',
  }).addTo(map);
  L.control.layers({ "航空写真": photoLayer, "地図": osmLayer }, null, { position: "bottomleft", collapsed: false }).addTo(map);
} else {
  osmLayer.addTo(map);
}
const markerLayer = L.layerGroup().addTo(map);
const hereLayer = L.layerGroup().addTo(map);
const pickLayer = L.layerGroup().addTo(map);
const stationLayer = L.layerGroup().addTo(map);

// ===== ユーティリティ =====
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function distanceLabel(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

function walkLabel(m) {
  return `徒歩${Math.max(1, Math.round(m / WALK_M_PER_MIN))}分`;
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
}

// 距離の基準は、現在地がわかっていれば現在地、なければ地図の中心
function origin() {
  return here || map.getCenter();
}

const isMobile = () => window.innerWidth < 900;

function focusOn(latlng, zoom) {
  let offsetY = 0;
  if (isMobile()) {
    const top = document.querySelector(".topbar").getBoundingClientRect().bottom;
    const bottom = window.innerHeight - sheetEl.offsetHeight;
    offsetY = window.innerHeight / 2 - (top + bottom) / 2;
  }
  const point = map.project(latlng, zoom).add([0, offsetY]);
  map.setView(map.unproject(point, zoom), zoom);
}

function fitPadding() {
  if (!isMobile()) return { padding: [60, 60] };
  const top = document.querySelector(".topbar").getBoundingClientRect().bottom;
  return { paddingTopLeft: [40, top + 30], paddingBottomRight: [40, sheetEl.offsetHeight + 30] };
}

function setSheetOpen(open) {
  sheetEl.classList.toggle("open", open);
  sheetHandle.setAttribute("aria-expanded", String(open));
}

// ===== 絞り込みUI(種別チップ) =====
function buildFilters() {
  const counts = { shinpou: 0, tokku: 0, kani: 0 };
  ALL_ITEMS.forEach((item) => counts[item.type]++);

  chipsEl.innerHTML = TYPE_ORDER.map(
    (type) => `
      <button type="button" class="chip" data-type="${type}" aria-pressed="${activeTypes.has(type)}" style="--dot:${TYPE_COLOR[type]}">
        <span class="dot"></span>${MINPAKU_TYPE_LABEL[type]}<span class="count">${counts[type].toLocaleString()}</span>
      </button>`
  ).join("");

  $("total-count").textContent = `${ALL_ITEMS.length.toLocaleString()}件`;
  $("data-date").textContent = MINPAKU_DATA_DATE;
}

// ===== ピン =====
function markerStyle(item, selected) {
  if (selected) return { radius: 11, color: "#fff", weight: 3, fillColor: item.color, fillOpacity: 1 };
  const z = map.getZoom();
  const radius = z >= 17 ? 6 : z >= 16 ? 5 : z >= 15 ? 4 : z >= 14 ? 3.5 : 2.5;
  return { radius, color: "#fff", weight: z >= 15 ? 1.2 : 0.6, fillColor: item.color, fillOpacity: 0.9 };
}

function restyleMarkers() {
  visibleItems.forEach((item) => markers.get(item.id).setStyle(markerStyle(item, item.id === selectedId)));
}

function applyFilters() {
  visibleItems = ALL_ITEMS.filter((item) => activeTypes.has(item.type));
  markerLayer.clearLayers();
  markers.clear();
  visibleItems.forEach((item) => {
    // ピンのクリックが地図のクリック(住所表示)にも伝わらないようにする
    const m = L.circleMarker([item.lat, item.lon], { ...markerStyle(item, item.id === selectedId), bubblingMouseEvents: false })
      .on("click", () => select(item.id, { keepZoom: true }))
      .bindTooltip(`${escapeHtml(item.title)}<br><span class="tip-sub">${escapeHtml(MINPAKU_TYPE_LABEL[item.type])}</span>`, { direction: "top", offset: [0, -4] })
      .addTo(markerLayer);
    markers.set(item.id, m);
  });
  if (selectedId != null && !markers.has(selectedId)) closeDetail();
  else if (selectedId != null) markers.get(selectedId).bringToFront();
  updateList();
}

// ===== 一覧 =====
function updateList() {
  const bounds = map.getBounds();
  const from = origin();
  const inView = visibleItems
    .filter((item) => bounds.contains([item.lat, item.lon]))
    .map((item) => ({ item, d: from.distanceTo([item.lat, item.lon]) }))
    .sort((a, b) => a.d - b.d);

  statusEl.textContent =
    visibleItems.length === 0
      ? "条件に合う施設がありません"
      : `この範囲に ${inView.length.toLocaleString()}件${here ? "(現在地から近い順)" : ""}`;

  if (inView.length === 0) {
    listEl.innerHTML = `<li class="empty">${
      visibleItems.length === 0
        ? "絞り込み条件をゆるめてみてください。"
        : "この範囲には施設がありません。地図を動かすか縮小してみてください。"
    }</li>`;
    return;
  }

  const rows = inView.slice(0, MAX_LIST_ITEMS).map(({ item, d }) => `
      <li>
        <button type="button" class="vm-item${item.id === selectedId ? " selected" : ""}" data-id="${item.id}" style="--dot:${item.color}">
          <span class="dot" aria-hidden="true"></span>
          <span class="vm-main">
            <span class="vm-title">${escapeHtml(item.title)}</span>
            <span class="vm-sub">${escapeHtml(MINPAKU_TYPE_LABEL[item.type])}</span>
          </span>
          <span class="vm-dist">${distanceLabel(d)}</span>
        </button>
      </li>`);
  if (inView.length > MAX_LIST_ITEMS) {
    rows.push(`<li class="empty">ほか ${(inView.length - MAX_LIST_ITEMS).toLocaleString()}件(地図を拡大すると絞れます)</li>`);
  }
  listEl.innerHTML = rows.join("");
}

// ===== 詳細 =====
function unhighlight() {
  const prev = ALL_ITEMS.find((x) => x.id === selectedId);
  if (prev && markers.has(prev.id)) markers.get(prev.id).setStyle(markerStyle(prev, false));
}

function select(id, { move = true, keepZoom = false } = {}) {
  unhighlight();
  const item = ALL_ITEMS.find((x) => x.id === id);
  selectedId = id;
  const m = markers.get(id);
  if (m) m.setStyle(markerStyle(item, true)).bringToFront();

  let distText = "📍ボタンで現在地からの距離を表示できます";
  if (here) {
    const d = here.distanceTo([item.lat, item.lon]);
    distText = `現在地から ${distanceLabel(d)}(${walkLabel(d)})`;
  }
  const route = `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${item.lat},${item.lon}`;

  detailEl.style.setProperty("--dot", item.color);
  detailEl.innerHTML = `
    <button type="button" class="close-btn" aria-label="閉じる">×</button>
    <h2>${escapeHtml(item.title)}</h2>
    <p class="maker">${escapeHtml(MINPAKU_TYPE_LABEL[item.type])}</p>
    <p class="distance${here ? "" : " hint"}">${distText}</p>
    <p class="note">${escapeHtml(item.addr)}</p>
    <div class="actions">
      <a class="btn btn-primary" href="${route}" target="_blank" rel="noopener">徒歩ルート</a>
    </div>`;
  detailEl.hidden = false;
  detailEl.querySelector(".close-btn").addEventListener("click", closeDetail);
  $("sheet-body").scrollTop = 0;
  setSheetOpen(true);
  if (move) focusOn([item.lat, item.lon], keepZoom ? map.getZoom() : Math.max(map.getZoom(), 17));
  updateList();
}

function closeDetail() {
  unhighlight();
  selectedId = null;
  detailEl.hidden = true;
  updateList();
}

// ===== 現在地 =====
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("unsupported"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 });
  });
}

async function updateHere() {
  const pos = await getLocation();
  const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
  if (!OSAKA_BOUNDS.contains(latlng)) {
    toast("現在地が大阪市外のため、現在地は使えません");
    return null;
  }
  here = latlng;
  hereLayer.clearLayers();
  L.circle(here, { radius: pos.coords.accuracy, color: "#e33", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(hereLayer);
  L.circleMarker(here, { radius: 8, color: "#fff", weight: 3, fillColor: "#e33", fillOpacity: 1 })
    .bindTooltip("現在地")
    .addTo(hereLayer);
  return here;
}

async function locate() {
  const btn = $("locate-btn");
  btn.disabled = true;
  try {
    if (await updateHere()) map.setView(here, 16);
  } catch {
    toast("位置情報を取得できませんでした");
  } finally {
    btn.disabled = false;
  }
}

async function nearest() {
  const btn = $("nearest-btn");
  btn.disabled = true;
  try {
    if (!(await updateHere())) return;
    if (visibleItems.length === 0) {
      toast("条件に合う施設がありません");
      return;
    }
    let best = null;
    let bestD = Infinity;
    for (const item of visibleItems) {
      const d = here.distanceTo([item.lat, item.lon]);
      if (d < bestD) [best, bestD] = [item, d];
    }
    setSheetOpen(true);
    map.fitBounds(L.latLngBounds([here, [best.lat, best.lon]]), { ...fitPadding(), maxZoom: 18 });
    select(best.id, { move: false });
  } catch {
    toast("位置情報を取得できませんでした");
  } finally {
    btn.disabled = false;
  }
}

// ===== 駅名検索(data/stations.js を使うのでオフラインでも動く) =====
const placeInput = $("place-input");
const suggestEl = $("suggest");
let suggestions = [];

function findStations(q) {
  const key = q.trim().replace(/駅$/, "");
  if (!key) return [];
  return STATIONS.filter((s) => s.name.includes(key) || (s.kana && s.kana.includes(key)))
    .sort((a, b) => b.name.startsWith(key) - a.name.startsWith(key) || a.name.length - b.name.length)
    .slice(0, 8);
}

// 駅の周り(半径300m)に対象施設が何件あるか
function countNear(lat, lon, radius = 300) {
  const p = L.latLng(lat, lon);
  return visibleItems.filter((item) => p.distanceTo([item.lat, item.lon]) <= radius).length;
}

function renderSuggest() {
  suggestions = findStations(placeInput.value);
  if (suggestions.length === 0) {
    suggestEl.hidden = true;
    return;
  }
  suggestEl.innerHTML = suggestions
    .map(
      (s, i) => `
      <li>
        <button type="button" data-i="${i}">
          <span class="suggest-name">${escapeHtml(s.name)}駅</span>
          <span class="suggest-sub">周辺300mに ${countNear(s.lat, s.lon)}件</span>
        </button>
      </li>`
    )
    .join("");
  suggestEl.hidden = false;
}

function goToStation(st) {
  suggestEl.hidden = true;
  placeInput.value = `${st.name}駅`;
  placeInput.blur();
  closeDetail();
  stationLayer.clearLayers();
  L.circleMarker([st.lat, st.lon], { radius: 5, color: "#222", weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false })
    .bindTooltip(`${st.name}駅`, { permanent: true, direction: "top", className: "station-label", offset: [0, -6] })
    .addTo(stationLayer);
  map.setView([st.lat, st.lon], 16);
}

// ===== 地名検索(駅で見つからないときだけOpenStreetMapのNominatimを使う) =====
async function moveToPlace(e) {
  e.preventDefault();
  const input = placeInput;
  const q = input.value.trim();
  if (!q) return;
  const st = findStations(q)[0];
  if (st) {
    goToStation(st);
    return;
  }
  suggestEl.hidden = true;
  input.blur();
  if (!navigator.onLine) {
    toast("地名検索はオンライン時のみ使えます");
    return;
  }
  try {
    const viewbox = [OSAKA_BOUNDS.getWest(), OSAKA_BOUNDS.getNorth(), OSAKA_BOUNDS.getEast(), OSAKA_BOUNDS.getSouth()].join(",");
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jp&viewbox=${viewbox}&bounded=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "Accept-Language": "ja" } });
    const data = await res.json();
    if (data.length === 0) {
      toast(`「${q}」は大阪市内で見つかりませんでした`);
      return;
    }
    closeDetail();
    stationLayer.clearLayers();
    map.setView([Number(data[0].lat), Number(data[0].lon)], 16);
  } catch {
    toast("地名検索でエラーが発生しました");
  }
}

// ===== タップした場所の住所(OpenStreetMapのNominatimで逆ジオコーディング。APIキー不要) =====
const REVERSE_INTERVAL_MS = 1000; // Nominatimの利用ルール(1秒に1回まで)を守る
let lastReverseAt = 0;
let reverseSeq = 0;

// Nominatimの日本の住所は「5, 難波一丁目, 中央区, 大阪市, 大阪府, 542-0076, 日本」のように小→大の順なので、並べ替える
function formatJpAddress(displayName) {
  return displayName
    .split(", ")
    .filter((part) => part !== "日本" && !/^\d{3}-?\d{4}$/.test(part))
    .reverse()
    .join("");
}

async function showAddressAt(latlng) {
  const seq = ++reverseSeq;
  pickLayer.clearLayers();
  L.circleMarker(latlng, { radius: 6, color: "#fff", weight: 2, fillColor: "#222", fillOpacity: 1, interactive: false }).addTo(pickLayer);
  focusOn(latlng, map.getZoom());
  const popup = L.popup({ offset: [0, -4] }).setLatLng(latlng).setContent("住所を調べています…").openOn(map);
  popup.on("remove", () => {
    if (seq === reverseSeq) pickLayer.clearLayers();
  });

  if (!navigator.onLine) {
    popup.setContent("住所の表示はオンライン時のみ使えます");
    return;
  }
  // 続けてタップされたときは、1秒あけてから最後の1回だけ問い合わせる
  const wait = lastReverseAt + REVERSE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (seq !== reverseSeq) return;
  lastReverseAt = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${latlng.lat}&lon=${latlng.lng}`;
    const res = await fetch(url, { headers: { "Accept-Language": "ja" } });
    const data = await res.json();
    if (seq !== reverseSeq) return;
    popup.setContent(data.display_name ? escapeHtml(formatJpAddress(data.display_name)) : "住所が見つかりませんでした");
  } catch {
    if (seq === reverseSeq) popup.setContent("住所を取得できませんでした");
  }
}

// ===== イベント =====
chipsEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const type = chip.dataset.type;
  if (activeTypes.has(type)) activeTypes.delete(type);
  else activeTypes.add(type);
  chipsEl.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(activeTypes.has(c.dataset.type))));
  applyFilters();
});
listEl.addEventListener("click", (e) => {
  const row = e.target.closest(".vm-item");
  if (row) select(Number(row.dataset.id));
});
sheetHandle.addEventListener("click", () => setSheetOpen(!sheetEl.classList.contains("open")));
$("locate-btn").addEventListener("click", locate);
$("nearest-btn").addEventListener("click", nearest);
$("place-form").addEventListener("submit", moveToPlace);
placeInput.addEventListener("input", renderSuggest);
placeInput.addEventListener("focus", renderSuggest);
placeInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") suggestEl.hidden = true;
});
suggestEl.addEventListener("pointerdown", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  e.preventDefault();
  goToStation(suggestions[Number(btn.dataset.i)]);
});
placeInput.addEventListener("blur", () => setTimeout(() => (suggestEl.hidden = true), 150));
map.on("click", (e) => showAddressAt(e.latlng));
map.on("moveend", updateList);
map.on("zoomend", restyleMarkers);
map.on("dragstart", () => setSheetOpen(false));

// ===== 起動 =====
buildFilters();
applyFilters();
