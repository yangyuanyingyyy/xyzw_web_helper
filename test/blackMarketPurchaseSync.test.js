import assert from "node:assert/strict";
import test from "node:test";
import * as blackMarketConfig from "../src/utils/batch/blackMarketConfig.js";
import { loadModule } from "./helpers/loadModule.js";

// tasksStore.js 使用无扩展名的相对导入（Vite 可解析、Node ESM 不行），
// 与其它批处理测试一致走 loadModule 注入依赖。
const { createTasksStore } = await loadModule(
  new URL("../src/utils/batch/tasksStore.js", import.meta.url),
  { "./blackMarketConfig": blackMarketConfig },
);

/** 本地配置：与服务器清单保持一致，便于只观察「次数」差异 */
const CONFIGURED_LIST = [{ itemId: 2002, discount: 10, note: "青铜宝箱" }];

function createDeps({ getResponses, localCnt }) {
  const sent = [];
  const logs = [];
  const tokenStatus = { value: {} };
  const deps = {
    selectedTokens: { value: ["t1"] },
    tokens: { value: [{ id: "t1", name: "测试账号" }] },
    tokenStatus,
    isRunning: { value: false },
    shouldStop: { value: false },
    ensureConnection: async () => {},
    releaseConnectionSlot() {},
    connectionQueue: { active: 0 },
    batchSettings: {
      maxActive: 1,
      blackMarketPurchaseList: CONFIGURED_LIST,
      blackMarketPurchaseCnt: localCnt,
    },
    tokenStore: {
      closeWebSocketConnection() {},
      async sendMessageWithPromise(_id, cmd, params) {
        sent.push({ cmd, params });
        if (cmd === "store_getpurchase") {
          const next = getResponses.shift();
          assert.ok(next, "store_getpurchase 调用次数超出预期");
          return next;
        }
        assert.equal(cmd, "store_setpurchase");
        return {};
      },
    },
    addLog: (entry) => logs.push(entry.message),
    currentRunningTokenId: { value: null },
    delayConfig: { action: 0 },
  };
  return { deps, sent, logs, tokenStatus };
}

const getCalls = (sent) => sent.filter((item) => item.cmd === "store_getpurchase");
const setCalls = (sent) => sent.filter((item) => item.cmd === "store_setpurchase");

test("留空次数且清单一致：直接跳过，不下发", async () => {
  const { deps, sent, tokenStatus } = createDeps({
    localCnt: null,
    getResponses: [{ purchaseCnt: 7, purchaseItemList: CONFIGURED_LIST }],
  });

  await createTasksStore(deps).store_syncpurchaseconfig();

  assert.equal(setCalls(sent).length, 0);
  assert.equal(getCalls(sent).length, 1);
  assert.equal(tokenStatus.value.t1, "completed");
});

test("留空次数但清单不同：沿用服务器现值下发次数", async () => {
  const { deps, sent } = createDeps({
    localCnt: null,
    getResponses: [
      { purchaseCnt: 7, purchaseItemList: [{ itemId: 2003, discount: 10 }] },
      { purchaseCnt: 7, purchaseItemList: CONFIGURED_LIST },
    ],
  });

  await createTasksStore(deps).store_syncpurchaseconfig();

  const [set] = setCalls(sent);
  assert.ok(set, "应下发一次 store_setpurchase");
  assert.equal(set.params.purchaseCnt, 7);
  assert.deepEqual(set.params.purchaseItemList, [
    { itemId: 2002, discount: 10 },
  ]);
});

test("配置了次数：清单一致也要按目标次数下发", async () => {
  const { deps, sent } = createDeps({
    localCnt: 3,
    getResponses: [
      { purchaseCnt: 7, purchaseItemList: CONFIGURED_LIST },
      { purchaseCnt: 3, purchaseItemList: CONFIGURED_LIST },
    ],
  });

  await createTasksStore(deps).store_syncpurchaseconfig();

  const [set] = setCalls(sent);
  assert.ok(set, "次数不一致时应下发");
  assert.equal(set.params.purchaseCnt, 3);
});

test("配置的次数与服务器一致且清单一致：跳过", async () => {
  const { deps, sent } = createDeps({
    localCnt: 3,
    getResponses: [{ purchaseCnt: 3, purchaseItemList: CONFIGURED_LIST }],
  });

  await createTasksStore(deps).store_syncpurchaseconfig();

  assert.equal(setCalls(sent).length, 0);
});

test("越界次数按留空处理：沿用服务器现值", async () => {
  const { deps, sent } = createDeps({
    localCnt: 99,
    getResponses: [
      { purchaseCnt: 5, purchaseItemList: [{ itemId: 2003, discount: 10 }] },
      { purchaseCnt: 5, purchaseItemList: CONFIGURED_LIST },
    ],
  });

  await createTasksStore(deps).store_syncpurchaseconfig();

  const [set] = setCalls(sent);
  assert.ok(set);
  assert.equal(set.params.purchaseCnt, 5);
});

test("写回后次数未生效：判定校验失败", async () => {
  const { deps, logs, tokenStatus } = createDeps({
    localCnt: 3,
    getResponses: [
      { purchaseCnt: 7, purchaseItemList: [{ itemId: 2003, discount: 10 }] },
      // 服务器返回的次数仍是 7，未接受 3
      { purchaseCnt: 7, purchaseItemList: CONFIGURED_LIST },
    ],
  });

  await createTasksStore(deps).store_syncpurchaseconfig();

  assert.equal(tokenStatus.value.t1, "failed");
  assert.ok(
    logs.some((line) => line.includes("黑市采购清单写回后校验失败")),
    "应记录校验失败日志",
  );
});
