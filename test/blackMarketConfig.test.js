import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PURCHASE_CNT,
  compareBlackMarketPurchaseConfigs,
  normalizeBlackMarketPurchaseCnt,
  normalizeBlackMarketPurchaseList,
} from "../src/utils/batch/blackMarketConfig.js";

const list = (itemIds) => itemIds.map((itemId) => ({ itemId, discount: 10 }));

test("采购次数留空时表示不改动账号当前次数", () => {
  for (const blank of [null, undefined, ""]) {
    assert.equal(normalizeBlackMarketPurchaseCnt(blank), null);
  }
});

test("采购次数只接受 1~15 的整数（含边界）", () => {
  assert.equal(normalizeBlackMarketPurchaseCnt(1), 1);
  assert.equal(normalizeBlackMarketPurchaseCnt(MAX_PURCHASE_CNT), 15);
  assert.equal(normalizeBlackMarketPurchaseCnt("12"), 12);
  // 小数截断为整数
  assert.equal(normalizeBlackMarketPurchaseCnt(2.9), 2);
});

test("越界、非数字、零与负数一律视为无效", () => {
  for (const invalid of [0, -1, 16, 99, "abc", NaN, Infinity]) {
    assert.equal(normalizeBlackMarketPurchaseCnt(invalid), null);
  }
});

test("留空次数时只比对清单，不因服务器次数不同而重复下发", () => {
  const current = { purchaseCnt: 7, purchaseItemList: list([2002, 2003]) };
  const configured = {
    purchaseCnt: null,
    purchaseItemList: list([2003, 2002]),
  };

  assert.equal(compareBlackMarketPurchaseConfigs(current, configured), true);
});

test("填写次数后，次数或清单任一不同都判定为需要下发", () => {
  const current = { purchaseCnt: 2, purchaseItemList: list([2002]) };

  assert.equal(
    compareBlackMarketPurchaseConfigs(current, {
      purchaseCnt: 2,
      purchaseItemList: list([2002]),
    }),
    true,
  );
  assert.equal(
    compareBlackMarketPurchaseConfigs(current, {
      purchaseCnt: 5,
      purchaseItemList: list([2002]),
    }),
    false,
  );
  assert.equal(
    compareBlackMarketPurchaseConfigs(current, {
      purchaseCnt: 2,
      purchaseItemList: list([2003]),
    }),
    false,
  );
});

test("越界次数按无效处理：归为 null，只比清单", () => {
  const current = { purchaseCnt: 9, purchaseItemList: list([2002]) };

  assert.equal(
    compareBlackMarketPurchaseConfigs(current, {
      purchaseCnt: 16,
      purchaseItemList: list([2002]),
    }),
    true,
  );
});

test("清单归一化按 itemId 升序去重，折扣限定 1~10", () => {
  const normalized = normalizeBlackMarketPurchaseList([
    { itemId: 2003, discount: 99 },
    { itemId: 2002, discount: 0 },
    { itemId: 2003, discount: 5 },
  ]);

  assert.deepEqual(normalized, [
    { itemId: 2002, discount: 1, note: "青铜宝箱" },
    { itemId: 2003, discount: 5, note: "黄金宝箱" },
  ]);
});
