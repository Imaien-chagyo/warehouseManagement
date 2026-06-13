/* ===== 在庫管理アプリ フロント ===== */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let STATE = {
  items: [],
  locations: [],
  categories: [],
  units: [],
  products: [],
  filterLoc: '',   // '' = すべて
  search: '',
  category: '',
  onlyLow: false,
  editingId: null,
  adjustId: null,
  adjustMode: 'in',
  moveId: null,
  actionId: null,
};

// ---- API ----
function getPassword() { return localStorage.getItem('inv_pw') || ''; }

async function api(action, extra = {}) {
  if (!CONFIG.GAS_URL || CONFIG.GAS_URL.indexOf('script.google.com') < 0) {
    throw new Error('config.js に GAS_URL が設定されていません');
  }
  showLoader(true);
  try {
    const res = await fetch(CONFIG.GAS_URL, {
      method: 'POST',
      // text/plain にすることで CORS プリフライトを回避（GASの定番対策）
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, password: getPassword(), ...extra }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '不明なエラー');
    return data.data;
  } finally {
    showLoader(false);
  }
}

// ---- ログイン ----
async function tryLogin(pw) {
  localStorage.setItem('inv_pw', pw);
  try {
    const data = await api('list');
    onLoaded(data);
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
  } catch (e) {
    localStorage.removeItem('inv_pw');
    $('#loginError').textContent = e.message;
  }
}

function logout() {
  localStorage.removeItem('inv_pw');
  location.reload();
}

// ---- データ取得 ----
async function reload() {
  try {
    const data = await api('list');
    onLoaded(data);
    toast('更新しました');
  } catch (e) { toast(e.message); }
}

function onLoaded(data) {
  STATE.items = data.items || [];
  STATE.locations = data.locations || [];
  STATE.categories = data.categories || [];
  STATE.units = data.units || [];
  STATE.products = data.products || [];
  buildLocTabs();
  buildCategoryOptions();
  buildLocationSelects();
  buildUnitSelect();
  buildProductSelect();
  render();
}

// ---- フィルターUI構築 ----
function buildLocTabs() {
  const tabs = $('#locTabs');
  const locs = ['', ...STATE.locations];
  tabs.innerHTML = locs.map(l =>
    `<button data-loc="${l}" class="${l === STATE.filterLoc ? 'active' : ''}">${l || 'すべて'}</button>`
  ).join('');
  $$('#locTabs button').forEach(b => b.onclick = () => {
    STATE.filterLoc = b.dataset.loc;
    buildLocTabs();
    render();
  });
}

function buildCategoryOptions() {
  const cats = STATE.categories;
  $('#catFilter').innerHTML = '<option value="">全カテゴリ</option>' +
    cats.map(c => `<option value="${c}" ${c === STATE.category ? 'selected' : ''}>${c}</option>`).join('');
  $('#f_cat').innerHTML = '<option value="">（未設定）</option>' +
    cats.map(c => `<option value="${c}">${c}</option>`).join('');
}

function buildLocationSelects() {
  const opts = STATE.locations.map(l => `<option value="${l}">${l}</option>`).join('');
  $('#f_loc').innerHTML = opts;
  $('#moveTo').innerHTML = opts;
}

function buildUnitSelect() {
  $('#f_unit').innerHTML = STATE.units.map(u => `<option value="${u}">${u}</option>`).join('');
}

function buildProductSelect() {
  const opts = STATE.products
    .map(p => `<option value="${esc(p.商品名)}">${esc(p.商品名)}</option>`).join('');
  $('#f_product').innerHTML =
    '<option value="">商品を選択…</option>' +
    opts +
    '<option value="__new__">＋ 新しい商品を登録…</option>';
}

// 商品プルダウンの選択に応じて、専用登録画面の表示や既定値の自動入力を切り替え
function onProductChange() {
  const v = $('#f_product').value;
  if (v === '__new__') {
    $('#f_product').value = ''; // 選択は一旦リセット（登録成功後に選び直す）
    openProductModal();         // 商品名・カテゴリ・単位・標準原価のみの専用画面
  } else if (v) {
    $('#f_name').value = v;
    applyProductDefaults(v);
  } else {
    $('#f_name').value = '';
  }
}

// マスタの既定値を在庫フォームに反映
function applyProductDefaults(name) {
  const p = STATE.products.find(x => x.商品名 === name);
  if (!p) return;
  $('#f_cat').value = p.カテゴリ || '';
  $('#f_unit').value = p.単位 || STATE.units[0] || '個';
  $('#f_price').value = p.標準原価 || 0;
}

// ---- 商品マスタ 新規登録（専用画面） ----
function openProductModal() {
  $('#p_cat').innerHTML = '<option value="">（未設定）</option>' +
    STATE.categories.map(c => `<option value="${c}">${c}</option>`).join('');
  $('#p_unit').innerHTML = STATE.units.map(u => `<option value="${u}">${u}</option>`).join('');
  $('#p_name').value = '';
  $('#p_cat').value = '';
  $('#p_unit').value = STATE.units[0] || '個';
  $('#p_price').value = 0;
  showModal('productModal');
}

function closeProductModal() {
  $('#productModal').classList.add('hidden');
}

async function saveProductMaster() {
  const product = {
    商品名: $('#p_name').value.trim(),
    カテゴリ: $('#p_cat').value,
    単位: $('#p_unit').value,
    標準原価: parseInt($('#p_price').value, 10) || 0,
  };
  if (!product.商品名) { toast('商品名を入力してください'); return; }
  if (STATE.products.some(p => p.商品名 === product.商品名)) {
    toast('同じ商品名が既に登録されています'); return;
  }
  try {
    await api('saveProduct', { product });
    await reloadSilent();        // マスタを取り直してプルダウン更新
    closeProductModal();
    // 登録した商品を在庫フォームで選択済みにし、既定値を反映
    $('#f_product').value = product.商品名;
    $('#f_name').value = product.商品名;
    applyProductDefaults(product.商品名);
    toast('商品マスタに登録しました');
  } catch (e) { toast(e.message); }
}

// ---- 一覧描画 ----
function filteredItems() {
  return STATE.items.filter(i => {
    if (STATE.filterLoc && i.保管場所 !== STATE.filterLoc) return false;
    if (STATE.category && i.カテゴリ !== STATE.category) return false;
    if (STATE.search && !String(i.商品名).toLowerCase().includes(STATE.search.toLowerCase())) return false;
    if (STATE.onlyLow && !isLow(i)) return false;
    return true;
  });
}

function isLow(i) { return Number(i.しきい値) > 0 && Number(i.在庫数量) <= Number(i.しきい値); }

function render() {
  // 「すべて」タブはカテゴリ別の合算サマリー、拠点タブは明細
  if (STATE.filterLoc) renderDetail();
  else renderSummary();
}

// 拠点を選んでいるときの明細表示（入出庫・編集が可能）
function renderDetail() {
  const items = filteredItems();
  const list = $('#list');

  const lowCount = STATE.items.filter(isLow).length;
  $('#summary').textContent =
    `表示 ${items.length} 件 / 全 ${STATE.items.length} 件` +
    (lowCount ? ` ・ 在庫切れ間近 ${lowCount} 件` : '');

  if (!items.length) {
    list.innerHTML = '<div class="empty">該当する商品がありません</div>';
    return;
  }

  list.innerHTML = items.map(i => {
    const low = isLow(i);
    return `
    <div class="card ${low ? 'low' : ''}">
      <div class="card-main">
        <div class="card-name">${esc(i.商品名)}</div>
        <div class="card-meta">
          <span class="badge loc">${esc(i.保管場所)}</span>
          ${i.カテゴリ ? `<span class="badge">${esc(i.カテゴリ)}</span>` : ''}
          ${low ? '<span class="badge low">在庫切れ間近</span>' : ''}
        </div>
        <div class="card-sub">原価 ¥${Number(i.原価).toLocaleString()}${i.しきい値 ? ` ・ しきい値 ${i.しきい値}` : ''}</div>
      </div>
      <div class="qty-box">
        <div class="qty-num ${low ? 'low' : ''}">${i.在庫数量}<span class="unit">${esc(i.単位)}</span></div>
        <div class="qty-label">在庫</div>
        <div class="stepper">
          <button onclick="quickAdjust('${i.id}', -1)">−</button>
          <button onclick="quickAdjust('${i.id}', 1)">＋</button>
        </div>
      </div>
      <button class="card-menu" onclick="openAction('${i.id}')">⋯</button>
    </div>`;
  }).join('');
}

// 「すべて」タブ: 商品名で拠点をまたいで合算し、カテゴリ別に集計表示（閲覧専用）
function renderSummary() {
  const list = $('#list');
  // 場所以外のフィルタ（カテゴリ・検索）を適用
  const base = STATE.items.filter(i => {
    if (STATE.category && i.カテゴリ !== STATE.category) return false;
    if (STATE.search && !String(i.商品名).toLowerCase().includes(STATE.search.toLowerCase())) return false;
    return true;
  });

  // 商品名で合算
  const map = {};
  base.forEach(i => {
    const k = i.商品名;
    if (!map[k]) map[k] = { 商品名: i.商品名, カテゴリ: i.カテゴリ || '未分類', 単位: i.単位, total: 0, th: 0, locs: {} };
    map[k].total += Number(i.在庫数量) || 0;
    map[k].th += Number(i.しきい値) || 0;
    map[k].locs[i.保管場所] = (map[k].locs[i.保管場所] || 0) + (Number(i.在庫数量) || 0);
  });
  const lowOf = p => p.th > 0 && p.total <= p.th;
  let products = Object.values(map);
  if (STATE.onlyLow) products = products.filter(lowOf);

  const lowCount = Object.values(map).filter(lowOf).length;
  $('#summary').textContent =
    `全拠点の合算 ・ ${products.length} 品目` +
    (lowCount ? ` ・ 在庫切れ間近 ${lowCount} 品目` : '');

  if (!products.length) {
    list.innerHTML = '<div class="empty">該当する商品がありません</div>';
    return;
  }

  // カテゴリ順（CATEGORIES の並び→その他）でグループ化
  const catOrder = [...STATE.categories, '未分類'];
  const groups = {};
  products.forEach(p => { (groups[p.カテゴリ] = groups[p.カテゴリ] || []).push(p); });
  const cats = Object.keys(groups).sort((a, b) => {
    const ia = catOrder.indexOf(a), ib = catOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  let html = '';
  cats.forEach(cat => {
    const ps = groups[cat].sort((a, b) => a.商品名.localeCompare(b.商品名, 'ja'));
    // カテゴリ内で単位が揃っていれば合計値を見出しに出す
    const units = [...new Set(ps.map(p => p.単位))];
    const catTotal = units.length === 1
      ? `計 ${ps.reduce((s, p) => s + p.total, 0)} ${units[0]}` : '';
    html += `<div class="cat-header"><span>${esc(cat)}</span><span class="cat-total">${catTotal}</span></div>`;
    html += ps.map(p => {
      const low = lowOf(p);
      const breakdown = STATE.locations
        .filter(l => p.locs[l] != null)
        .map(l => `${esc(l)} ${p.locs[l]}`).join('・');
      return `
      <div class="card ${low ? 'low' : ''}">
        <div class="card-main">
          <div class="card-name">${esc(p.商品名)}</div>
          <div class="card-meta">
            ${low ? '<span class="badge low">在庫切れ間近</span>' : ''}
          </div>
          <div class="card-sub"><span class="loc-break">${breakdown || '在庫なし'}</span></div>
        </div>
        <div class="qty-box">
          <div class="qty-num ${low ? 'low' : ''}">${p.total}<span class="unit">${esc(p.単位)}</span></div>
          <div class="qty-label">合計</div>
        </div>
      </div>`;
    }).join('');
  });
  list.innerHTML = html;
}

// ---- クイック入出庫 (±1) ----
async function quickAdjust(id, delta) {
  try {
    const r = await api('adjust', { id, delta });
    const item = STATE.items.find(x => x.id === id);
    if (item) item.在庫数量 = r.在庫数量;
    render();
  } catch (e) { toast(e.message); }
}

// ---- カードメニュー（操作選択） ----
function openAction(id) {
  const item = STATE.items.find(x => x.id === id);
  if (!item) return;
  STATE.actionId = id;
  $('#actionItemName').textContent = `${item.商品名}（${item.保管場所}）`;
  showModal('actionModal');
}

// ---- 数量指定の入出庫 ----
function openAdjust(id) {
  const item = STATE.items.find(x => x.id === id);
  STATE.adjustId = id;
  STATE.adjustMode = 'in';
  $('#adjustItemName').textContent = `${item.商品名}（${item.保管場所}）現在 ${item.在庫数量}`;
  $('#adjustQty').value = 1;
  $$('#adjustMode button').forEach(b => b.classList.toggle('active', b.dataset.mode === 'in'));
  showModal('adjustModal');
}

async function confirmAdjust() {
  const qty = Math.abs(parseFloat($('#adjustQty').value) || 0);
  if (qty <= 0) { toast('数量を入力してください'); return; }
  const delta = STATE.adjustMode === 'in' ? qty : -qty;
  try {
    const r = await api('adjust', { id: STATE.adjustId, delta });
    const item = STATE.items.find(x => x.id === STATE.adjustId);
    if (item) item.在庫数量 = r.在庫数量;
    closeModals();
    render();
    toast(STATE.adjustMode === 'in' ? '入庫しました' : '出庫しました');
  } catch (e) { toast(e.message); }
}

// ---- 追加 / 編集 ----
function openAdd() {
  STATE.editingId = null;
  $('#editTitle').textContent = '新規追加';
  $('#deleteBtn').classList.add('hidden');
  // 新規追加は商品マスタから選択する
  $('#lbl_product').classList.remove('hidden');
  $('#lbl_name').classList.add('hidden');
  $('#f_product').value = '';
  $('#f_name').value = '';
  $('#f_loc').value = STATE.filterLoc || STATE.locations[0] || '';
  $('#f_qty').value = 0;
  $('#f_unit').value = STATE.units[0] || '個';
  $('#f_cat').value = STATE.category || '';
  $('#f_price').value = 0;
  $('#f_threshold').value = 0;
  // 新規追加はしきい値を自動(15%)にするので入力欄は隠し、注記を出す
  $('#lbl_threshold').classList.add('hidden');
  $('#thNote').classList.remove('hidden');
  $('#moreFields').open = false; // 新規追加時は「その他」を畳んでおく
  showModal('editModal');
}

function openEdit(id) {
  const i = STATE.items.find(x => x.id === id);
  if (!i) return;
  STATE.editingId = id;
  $('#editTitle').textContent = '編集';
  $('#deleteBtn').classList.remove('hidden');
  // 編集時は商品名を直接編集（マスタ選択は隠す）
  $('#lbl_product').classList.add('hidden');
  $('#lbl_name').classList.remove('hidden');
  $('#f_name').value = i.商品名;
  $('#f_loc').value = i.保管場所;
  $('#f_qty').value = i.在庫数量;
  $('#f_unit').value = i.単位 || '個';
  $('#f_cat').value = i.カテゴリ || '';
  $('#f_price').value = i.原価;
  $('#f_threshold').value = i.しきい値;
  // 編集時はしきい値を手動調整できるよう表示
  $('#lbl_threshold').classList.remove('hidden');
  $('#thNote').classList.add('hidden');
  $('#moreFields').open = true; // 編集時は既存の値が見えるように開いておく
  showModal('editModal');
}

async function save() {
  const item = {
    商品名: $('#f_name').value.trim(),
    保管場所: $('#f_loc').value,
    在庫数量: parseFloat($('#f_qty').value) || 0,
    単位: $('#f_unit').value,
    カテゴリ: $('#f_cat').value,
    原価: parseInt($('#f_price').value, 10) || 0,
    しきい値: parseInt($('#f_threshold').value, 10) || 0,
  };
  if (!item.商品名) { toast('商品名を入力してください'); return; }
  try {
    if (STATE.editingId) {
      item.id = STATE.editingId;
      await api('update', { item });
      toast('保存しました');
    } else {
      await api('add', { item });
      toast('追加しました');
    }
    closeModals();
    await reloadSilent();
  } catch (e) { toast(e.message); }
}

async function removeItem() {
  if (!STATE.editingId) return;
  if (!confirm('この商品を削除しますか？')) return;
  try {
    await api('delete', { id: STATE.editingId });
    closeModals();
    await reloadSilent();
    toast('削除しました');
  } catch (e) { toast(e.message); }
}

// ---- 拠点間移動 ----
function openMove(id) {
  const i = STATE.items.find(x => x.id === id);
  if (!i) return;
  STATE.moveId = id;
  $('#moveItemName').textContent = `${i.商品名}（${i.保管場所}）在庫 ${i.在庫数量}`;
  // 移動先候補から「現在の場所」を除外
  $('#moveTo').innerHTML = STATE.locations
    .filter(l => l !== i.保管場所)
    .map(l => `<option value="${l}">${l}</option>`).join('');
  $('#moveQty').value = 1;
  showModal('moveModal');
}

async function confirmMove() {
  const qty = parseInt($('#moveQty').value, 10) || 0;
  const to_location = $('#moveTo').value;
  if (qty <= 0) { toast('移動数量を入力してください'); return; }
  try {
    await api('move', { id: STATE.moveId, to_location, qty });
    closeModals();
    await reloadSilent();
    toast('移動しました');
  } catch (e) { toast(e.message); }
}

async function reloadSilent() {
  const data = await api('list');
  onLoaded(data);
}

// ---- UIヘルパー ----
function showModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModals() { $$('.modal').forEach(m => m.classList.add('hidden')); }
function showLoader(on) { $('#loader').classList.toggle('hidden', !on); }
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- イベント登録 ----
function init() {
  $('#loginBtn').onclick = () => {
    const pw = $('#loginPw').value;
    if (!pw) { $('#loginError').textContent = 'パスワードを入力してください'; return; }
    tryLogin(pw);
  };
  $('#loginPw').onkeydown = (e) => { if (e.key === 'Enter') $('#loginBtn').click(); };

  $('#reloadBtn').onclick = reload;
  $('#logoutBtn').onclick = logout;
  $('#addBtn').onclick = openAdd;

  $('#search').oninput = (e) => { STATE.search = e.target.value; render(); };
  $('#catFilter').onchange = (e) => { STATE.category = e.target.value; render(); };
  $('#onlyLow').onchange = (e) => { STATE.onlyLow = e.target.checked; render(); };

  $('#adjustOk').onclick = confirmAdjust;
  $$('#adjustMode button').forEach(b => b.onclick = () => {
    STATE.adjustMode = b.dataset.mode;
    $$('#adjustMode button').forEach(x => x.classList.toggle('active', x === b));
  });

  $('#f_product').onchange = onProductChange;
  $('#saveBtn').onclick = save;
  $('#deleteBtn').onclick = removeItem;
  $('#moveOk').onclick = confirmMove;
  $('#productSaveBtn').onclick = saveProductMaster;
  $('#productCancel').onclick = closeProductModal;

  // 操作メニュー(カードの⋯)
  $('#actAdjust').onclick = () => { const id = STATE.actionId; closeModals(); openAdjust(id); };
  $('#actEdit').onclick   = () => { const id = STATE.actionId; closeModals(); openEdit(id); };
  $('#actMove').onclick   = () => { const id = STATE.actionId; closeModals(); openMove(id); };

  $$('[data-close]').forEach(b => b.onclick = closeModals);
  $$('.modal').forEach(m => m.onclick = (e) => { if (e.target === m) closeModals(); });
  // 商品マスタ登録は在庫フォームの上に重ねて開くので、背景クリックでは自分だけ閉じる
  $('#productModal').onclick = (e) => { if (e.target === $('#productModal')) closeProductModal(); };

  // 既にログイン済みなら自動ログイン
  if (getPassword()) tryLogin(getPassword());
}

document.addEventListener('DOMContentLoaded', init);
