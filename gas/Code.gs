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
const LOCATIONS = ['学大', '笹塚', '田村', 'Graz'];
const CATEGORIES = ['抹茶', 'ほうじ茶パウダー', '煎茶', 'ほうじ茶', '和紅茶', '玄米茶'];
const UNITS = ['個', 'g', 'kg', '本', '袋', '箱'];
const HEADERS = ['id', '商品名', 'カテゴリ', '保管場所', '在庫数量', '単位', '原価', 'しきい値', '更新日時'];

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
    しきい値:  Number(row[7]) || 0,
    更新日時:  row[8]
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

// ===== 各操作 =====
function meta() {
  return { locations: LOCATIONS, categories: CATEGORIES, units: UNITS };
}

function listItems() {
  return { items: readAll(), locations: LOCATIONS, categories: CATEGORIES, units: UNITS };
}

function addItem(item) {
  const sheet = getSheet();
  const id = Utilities.getUuid();
  sheet.appendRow([
    id,
    item.商品名 || '',
    item.カテゴリ || '',
    item.保管場所 || '',
    Number(item.在庫数量) || 0,
    item.単位 || '個',
    Number(item.原価) || 0,
    Number(item.しきい値) || 0,
    new Date()
  ]);
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

  // 移動先の同一商品行を探す（商品名＋保管場所で一致）
  const all = readAll();
  const dest = all.find(o => o.商品名 === src.商品名 && o.保管場所 === req.to_location);
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
