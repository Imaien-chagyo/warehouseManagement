/**
 * 在庫管理アプリ - バックエンド (Google Apps Script)
 *
 * 役割: スプレッドシートを簡易データベースとして、フロント(GitHub Pages)からの
 *       読み書きリクエストを処理するWeb API。
 *
 * 使い方は README.md を参照。
 */

// ===== 設定 =====
const SHEET_NAME = '在庫';
const MASTER_SHEET = '商品マスタ';
const SUPPLIER_SHEET = '仕入元マスタ';
const LOCATIONS = ['学大', '笹塚', '田村', 'Graz'];
const CATEGORIES = ['抹茶', 'ほうじ茶パウダー', '煎茶', 'ほうじ茶', '和紅茶', '玄米茶', 'その他'];
const UNITS = ['個', 'g', 'kg', '本', '袋', '箱'];
const LOW_RATIO = 0.15; // 在庫切れ間近の判定: 登録時数量のこの割合を下回ると間近
const HEADERS = ['id', '商品名', 'カテゴリ', '保管場所', '在庫数量', '単位', '原価', '仕入元', 'しきい値', '更新日時'];
const MASTER_HEADERS = ['商品名', 'カテゴリ', '単位', '標準原価', '仕入元', '有機'];
const SUPPLIER_HEADERS = ['仕入元'];

// 共有パスワード。デプロイ前に必ず変更してください。
// （ログイン画面で入力した値とここが一致すれば操作OK）
const PASSWORD = 'CHANGE_ME';

// ===== エントリポイント =====
function doGet(e) {
  // デプロイ確認用。ブラウザで開くとこのメッセージが出ればOK。
  return ContentService
    .createTextOutput('在庫管理API: 稼働中です。フロントからはPOSTでアクセスします。')
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // 同時編集による競合を防ぐ
  try {
    const req = JSON.parse(e.postData.contents);

    if (req.password !== PASSWORD) {
      return json({ ok: false, error: '認証エラー: パスワードが違います' });
    }

    let result;
    switch (req.action) {
      case 'list':   result = listItems(); break;
      case 'add':    result = addItem(req.item); break;
      case 'update': result = updateItem(req.item); break;
      case 'delete': result = deleteItem(req.id); break;
      case 'adjust': result = adjustQty(req.id, Number(req.delta)); break; // 入庫(+)/出庫(-)
      case 'move':   result = moveItem(req); break;                        // 拠点間移動
      case 'meta':   result = meta(); break;
      case 'saveProduct':   result = saveProduct(req.product); break;      // 商品マスタ 追加/更新
      case 'deleteProduct': result = deleteProduct(req.商品名); break;     // 商品マスタ 削除
      case 'addSupplier':   result = addSupplier(req.仕入元); break;       // 仕入元マスタ 追加
      case 'deleteSupplier':result = deleteSupplier(req.仕入元); break;    // 仕入元マスタ 削除
      default:       return json({ ok: false, error: '不明な操作: ' + req.action });
    }
    return json({ ok: true, data: result });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// ===== シート操作 =====
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  } else {
    // ヘッダーが現行定義と違えば修正（列構成の変更に追従）
    const head = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    if (head.join('|') !== HEADERS.join('|')) {
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function readAll() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  return values.map(rowToObj).filter(o => o.id); // 空行を除外
}

function rowToObj(row) {
  return {
    id:       String(row[0]),
    商品名:    row[1],
    カテゴリ:  row[2],
    保管場所:  row[3],
    在庫数量:  Number(row[4]) || 0,
    単位:      row[5] || '個',
    原価:      Number(row[6]) || 0,
    仕入元:    row[7] || '',
    しきい値:  Number(row[8]) || 0,
    更新日時:  row[9]
  };
}

function findRowIndexById(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2; // 実際の行番号
  }
  return -1;
}

// ===== 商品マスタ =====
function getMasterSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MASTER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MASTER_SHEET);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(MASTER_HEADERS);
    sheet.setFrozenRows(1);
  } else {
    const head = sheet.getRange(1, 1, 1, MASTER_HEADERS.length).getValues()[0];
    if (head.join('|') !== MASTER_HEADERS.join('|')) {
      sheet.getRange(1, 1, 1, MASTER_HEADERS.length).setValues([MASTER_HEADERS]);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function readProducts() {
  const sheet = getMasterSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, MASTER_HEADERS.length).getValues()
    .filter(r => r[0])
    .map(r => ({
      商品名: r[0], カテゴリ: r[1], 単位: r[2] || '個', 標準原価: Number(r[3]) || 0,
      仕入元: r[4] || '', 有機: (r[5] === true || String(r[5]).toUpperCase() === 'TRUE')
    }));
}

function findMasterRow(sheet, name) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const names = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < names.length; i++) {
    if (String(names[i][0]) === String(name)) return i + 2;
  }
  return -1;
}

// 在庫追加時に呼ぶ。マスタに無ければ既定値付きで登録（既存は変更しない）。
function ensureProduct(name, cat, unit, cost, supplier, organic) {
  if (!name) return;
  const sheet = getMasterSheet();
  if (findMasterRow(sheet, name) < 0) {
    sheet.appendRow([name, cat || '', unit || '個', Number(cost) || 0, supplier || '', organic ? true : false]);
  }
  ensureSupplier(supplier);
}

// マスタの追加/更新（既存なら上書き）
function saveProduct(p) {
  if (!p || !p.商品名) throw new Error('商品名が必要です');
  const sheet = getMasterSheet();
  const row = [p.商品名, p.カテゴリ || '', p.単位 || '個', Number(p.標準原価) || 0, p.仕入元 || '', p.有機 ? true : false];
  const r = findMasterRow(sheet, p.商品名);
  if (r < 0) sheet.appendRow(row);
  else sheet.getRange(r, 1, 1, MASTER_HEADERS.length).setValues([row]);
  ensureSupplier(p.仕入元);
  return { 商品名: p.商品名 };
}

function deleteProduct(name) {
  const sheet = getMasterSheet();
  const r = findMasterRow(sheet, name);
  if (r < 0) throw new Error('対象が見つかりません');
  sheet.deleteRow(r);
  return { 商品名: name };
}

// ===== 仕入元マスタ =====
function getSupplierSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SUPPLIER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SUPPLIER_SHEET);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(SUPPLIER_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function supplierNamesInSheet() {
  const sheet = getSupplierSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => r[0]).filter(Boolean).map(String);
}

// 仕入元マスタ＋既存データ(商品マスタの仕入元)を統合して候補を返す
function readSuppliers() {
  const set = {};
  supplierNamesInSheet().forEach(n => set[n] = true);
  readProducts().forEach(p => { if (p.仕入元) set[p.仕入元] = true; });
  return Object.keys(set).sort();
}

// 仕入元マスタに無ければ追加（既存データの取り込みにも使う）
function ensureSupplier(name) {
  name = (name || '').toString().trim();
  if (!name) return;
  const sheet = getSupplierSheet();
  if (supplierNamesInSheet().indexOf(name) < 0) {
    sheet.appendRow([name]);
  }
}

function addSupplier(name) {
  name = (name || '').toString().trim();
  if (!name) throw new Error('仕入元名が必要です');
  if (supplierNamesInSheet().indexOf(name) >= 0) throw new Error('同じ仕入元が既に登録されています');
  getSupplierSheet().appendRow([name]);
  return { 仕入元: name };
}

function deleteSupplier(name) {
  const sheet = getSupplierSheet();
  const names = supplierNamesInSheet();
  const idx = names.indexOf((name || '').toString().trim());
  if (idx < 0) throw new Error('対象が見つかりません');
  sheet.deleteRow(idx + 2);
  return { 仕入元: name };
}

// ===== 各操作 =====
function meta() {
  return { locations: LOCATIONS, categories: CATEGORIES, units: UNITS, products: readProducts(), suppliers: readSuppliers() };
}

function listItems() {
  return {
    items: readAll(),
    locations: LOCATIONS,
    categories: CATEGORIES,
    units: UNITS,
    products: readProducts(),
    suppliers: readSuppliers()
  };
}

function addItem(item) {
  const sheet = getSheet();
  const id = Utilities.getUuid();
  const qty = Number(item.在庫数量) || 0;
  // しきい値が指定されていなければ、登録時数量の15%を自動設定
  let threshold = Number(item.しきい値) || 0;
  if (threshold <= 0) threshold = Math.ceil(qty * LOW_RATIO);
  sheet.appendRow([
    id,
    item.商品名 || '',
    item.カテゴリ || '',
    item.保管場所 || '',
    qty,
    item.単位 || '個',
    Number(item.原価) || 0,
    item.仕入元 || '',
    threshold,
    new Date()
  ]);
  ensureProduct(item.商品名, item.カテゴリ, item.単位, item.原価, item.仕入元, item.有機); // マスタに無ければ登録
  ensureSupplier(item.仕入元); // 仕入元マスタに取り込み
  return { id: id };
}

function updateItem(item) {
  const sheet = getSheet();
  const r = findRowIndexById(sheet, item.id);
  if (r < 0) throw new Error('対象が見つかりません');
  sheet.getRange(r, 2, 1, HEADERS.length - 2).setValues([[
    item.商品名 || '',
    item.カテゴリ || '',
    item.保管場所 || '',
    Number(item.在庫数量) || 0,
    item.単位 || '個',
    Number(item.原価) || 0,
    item.仕入元 || '',
    Number(item.しきい値) || 0
  ]]);
  sheet.getRange(r, HEADERS.length).setValue(new Date());
  return { id: item.id };
}

function deleteItem(id) {
  const sheet = getSheet();
  const r = findRowIndexById(sheet, id);
  if (r < 0) throw new Error('対象が見つかりません');
  sheet.deleteRow(r);
  return { id: id };
}

function adjustQty(id, delta) {
  const sheet = getSheet();
  const r = findRowIndexById(sheet, id);
  if (r < 0) throw new Error('対象が見つかりません');
  const cur = Number(sheet.getRange(r, 5).getValue()) || 0;
  const next = cur + delta;
  if (next < 0) throw new Error('在庫数が0未満になります');
  sheet.getRange(r, 5).setValue(next);
  sheet.getRange(r, HEADERS.length).setValue(new Date());
  return { id: id, 在庫数量: next };
}

/**
 * 拠点間移動: 移動元(id)の数量を減らし、移動先(to_location)の同一商品行に足す。
 * 移動先に同じ商品名の行が無ければ新規作成する。
 */
function moveItem(req) {
  const sheet = getSheet();
  const qty = Number(req.qty);
  if (!(qty > 0)) throw new Error('移動数量を正しく入力してください');

  const r = findRowIndexById(sheet, req.id);
  if (r < 0) throw new Error('移動元が見つかりません');
  const src = rowToObj(sheet.getRange(r, 1, 1, HEADERS.length).getValues()[0]);

  if (req.to_location === src.保管場所) throw new Error('移動先が移動元と同じです');
  if (qty > src.在庫数量) throw new Error('移動数量が在庫数を超えています');

  // 移動元を減らす
  sheet.getRange(r, 5).setValue(src.在庫数量 - qty);
  sheet.getRange(r, HEADERS.length).setValue(new Date());

  // 移動先の同一商品行を探す（商品名＋仕入元＋保管場所で一致。仕入元が違えば別在庫）
  const all = readAll();
  const dest = all.find(o =>
    o.商品名 === src.商品名 && o.仕入元 === src.仕入元 && o.保管場所 === req.to_location);
  if (dest) {
    const dr = findRowIndexById(sheet, dest.id);
    sheet.getRange(dr, 5).setValue(dest.在庫数量 + qty);
    sheet.getRange(dr, HEADERS.length).setValue(new Date());
  } else {
    addItem({
      商品名: src.商品名,
      カテゴリ: src.カテゴリ,
      保管場所: req.to_location,
      在庫数量: qty,
      単位: src.単位,
      原価: src.原価,
      仕入元: src.仕入元,
      しきい値: src.しきい値
    });
  }
  return { ok: true };
}

// ===== ユーティリティ =====
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
