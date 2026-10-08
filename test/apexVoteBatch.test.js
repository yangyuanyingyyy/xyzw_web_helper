import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/loadModule.js";

/**
 * 一键批量逐鹿盐山助威（batchApexVote）测试。
 *
 * 依赖全部 mock（与 scheduledTaskRegistry.test.js 同思路）：
 * 规则引擎按用例给出确定性结果，网络命令按调用序列返回固定响应。
 */

const baseRules = (over = {}) => ({
  ApexScheduleStatus: { Unlocked: 1, Locked: 2 },
  ApexStageType: { TaoTai: 4, ZhengShi: 3 },
  calibrateServerTime: (now) => now,
  checkSupportInTime: () => false,
  getCurrentRounds: () => [1],
  getCurrentSeason: () => 1,
  // 起点取 0、终点取远未来：保证 nowMs 落在赛季窗口内
  getDateZeroTime: (dateText) =>
    dateText === "2027/06/10" ? 9000000000000 : 0,
  getAdvanceNum: () => 1,
  getGuessTabs: () => [],
  getScheduleIdByStage: () => 10,
  getSeasonConf: () => ({ startDate: "2026/06/15", endDate: "2027/06/10" }),
  getStageInfoByRound: () => ({ 4: { isEnable: true }, 3: {} }),
  getSupportGroupId: () => 1,
  ...over,
});

const baseDeps = (sendMessage) => ({
  selectedTokens: { value: ["test"] },
  tokens: { value: [{ id: "test", name: "test" }] },
  tokenStatus: { value: {} },
  isRunning: { value: false },
  shouldStop: { value: false },
  ensureConnection: async () => {},
  releaseConnectionSlot() {},
  connectionQueue: { active: 0 },
  batchSettings: { maxActive: 1 },
  addLog() {},
  message: { success() {}, warning() {}, error() {} },
  currentRunningTokenId: { value: null },
  tokenStore: {
    closeWebSocketConnection() {},
    sendMessageWithPromise: sendMessage,
  },
});

const loadVote = (rules) =>
  loadModule(new URL("../src/utils/batch/tasksApex.js", import.meta.url), {
    "@/utils/apexRules": rules,
    "@/utils/apexRateLimit": {
      ApexAction: { READ: "read", GUESS: "guess", VOTE: "vote" },
      runApexAction: (_action, task) => task(0),
      isApexRateLimited: () => false,
      apexCooldownLeft: () => 0,
    },
  });

test("no vote items skips the account with a completed status", async () => {
  const { createTasksApex } = await loadVote(baseRules());
  const requests = [];
  const deps = baseDeps(async (_id, cmd) => {
    requests.push(cmd);
    if (cmd === "apex_getroleinfo") {
      return { apexRoleInfo: { voteItemCnt: 0, resetTime: { season: 1 } } };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await createTasksApex(deps).batchApexVote();
  assert.deepEqual(requests, ["apex_getroleinfo"]);
  assert.equal(deps.tokenStatus.value.test, "completed");
});

test("a round outside the support window skips after reading role info", async () => {
  const rules = baseRules({ getSeasonConf: () => null });
  const { createTasksApex } = await loadVote(rules);
  const requests = [];
  const deps = baseDeps(async (_id, cmd) => {
    requests.push(cmd);
    if (cmd === "apex_getroleinfo") {
      return { apexRoleInfo: { voteItemCnt: 5, resetTime: { season: 1 } } };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await createTasksApex(deps).batchApexVote();
  assert.deepEqual(requests, ["apex_getroleinfo"]);
  assert.equal(deps.tokenStatus.value.test, "completed");
});

test("voting uses the full item count for the top team of the open round", async () => {
  const rules = baseRules({ checkSupportInTime: () => true });
  const { createTasksApex } = await loadVote(rules);
  const requests = [];
  const deps = baseDeps(async (_id, cmd, params) => {
    requests.push([cmd, params]);
    if (cmd === "apex_getroleinfo") {
      return {
        apexRoleInfo: {
          voteItemCnt: 66,
          group: {},
          resetTime: { season: 1, day: "261008" },
        },
      };
    }
    if (cmd === "apex_getvotelist") {
      return {
        apexVoteList: [
          { teamId: 101, name: "Top", cheerCnt: 900, isOut: false },
          { teamId: 102, name: "Second", cheerCnt: 800, isOut: false },
        ],
        last: true,
      };
    }
    if (cmd === "apex_vote") {
      return {};
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await createTasksApex(deps).batchApexVote();

  assert.deepEqual(requests.map(([c]) => c), [
    "apex_getroleinfo",
    "apex_getvotelist",
    "apex_vote",
  ]);
  const [voteCmd, voteParams] = requests[2];
  assert.equal(voteCmd, "apex_vote");
  assert.equal(voteParams.teamId, 101);
  assert.equal(voteParams.round, 1);
  assert.equal(voteParams.voteCnt, 66);
  assert.equal(deps.tokenStatus.value.test, "completed");
});

test("an eliminated top row is skipped in favor of the first active team", async () => {
  const rules = baseRules({ checkSupportInTime: () => true });
  const { createTasksApex } = await loadVote(rules);
  let voteParams = null;
  const deps = baseDeps(async (_id, cmd, params) => {
    if (cmd === "apex_getroleinfo") {
      return {
        apexRoleInfo: {
          voteItemCnt: 10,
          group: {},
          resetTime: { season: 1 },
        },
      };
    }
    if (cmd === "apex_getvotelist") {
      return {
        apexVoteList: [
          { teamId: 201, name: "Out", cheerCnt: 999, isOut: true },
          { teamId: 202, name: "Active", cheerCnt: 500, isOut: false },
        ],
        last: true,
      };
    }
    if (cmd === "apex_vote") {
      voteParams = params;
      return {};
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await createTasksApex(deps).batchApexVote();
  assert.equal(voteParams.teamId, 202);
});

// ==================== 一键领取逐鹿盐山任务奖励（batchApexTaskClaim） ====================
// 每次完整遍历 confId 1~7 不跳过，全部发送 apex_taskclaim，由服务器裁决；
// 成功/失败如实记录日志；单个失败不阻断整批。

test("every confId 1-7 is attempted without skipping", async () => {
  const { createTasksApex } = await loadVote(baseRules());
  const claims = [];
  const deps = baseDeps(async (_id, cmd, params) => {
    if (cmd === "apex_getroleinfo") {
      // 即使 taskClaimedMap 已有标记，也不跳过
      return {
        apexRoleInfo: {
          taskClaimedMap: { 1: true, 4: true },
          resetTime: { season: 1 },
        },
      };
    }
    if (cmd === "apex_taskclaim") {
      claims.push(params.confId);
      return {
        reward: [{ type: 3, itemId: 16001, value: params.confId, ext: 0 }],
        apexRoleInfo: {},
      };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await createTasksApex(deps).batchApexTaskClaim();
  // 全部 7 个都请求，包括 map 里已标记的 1 和 4
  assert.deepEqual(claims, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(deps.tokenStatus.value.test, "completed");
});

test("a single claim failure does not block the remaining tasks", async () => {
  const { createTasksApex } = await loadVote(baseRules());
  const claims = [];
  const logs = [];
  const deps = baseDeps(async (_id, cmd, params) => {
    if (cmd === "apex_getroleinfo") {
      return { apexRoleInfo: { taskClaimedMap: {}, resetTime: { season: 1 } } };
    }
    if (cmd === "apex_taskclaim") {
      claims.push(params.confId);
      if (params.confId === 3) {
        throw new Error("claim failed");
      }
      return {
        reward: [],
        apexRoleInfo: { taskClaimedMap: { [params.confId]: true } },
      };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  deps.addLog = (entry) => logs.push(entry.message);
  await createTasksApex(deps).batchApexTaskClaim();
  // 3 失败但 4~7 仍然继续
  assert.deepEqual(claims, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(deps.tokenStatus.value.test, "completed");
  // 失败有日志
  assert.equal(logs.some((m) => m.includes("任务3 领取失败")), true);
});

test("server code 200020 is treated as already-claimed and stays silent", async () => {
  const { createTasksApex } = await loadVote(baseRules());
  const claims = [];
  const logs = [];
  const deps = baseDeps(async (_id, cmd, params) => {
    if (cmd === "apex_getroleinfo") {
      return { apexRoleInfo: { taskClaimedMap: {}, resetTime: { season: 1 } } };
    }
    if (cmd === "apex_taskclaim") {
      claims.push(params.confId);
      // 4、5、6 返回 200020（已领过/未完成）
      if ([4, 5, 6].includes(params.confId)) {
        throw new Error(
          "服务器错误: 200020 - 出了点小问题，请尝试重启游戏解决～",
        );
      }
      return {
        reward: [{ type: 3, itemId: 16001, value: 1, ext: 0 }],
        apexRoleInfo: {},
      };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  deps.addLog = (entry) => logs.push(entry.message);
  await createTasksApex(deps).batchApexTaskClaim();
  // 全部 7 个都请求（含 200020 的）
  assert.deepEqual(claims, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(deps.tokenStatus.value.test, "completed");
  // 200020 的任务不产生任何失败/警告日志
  assert.equal(logs.some((m) => m.includes("任务4")), false);
  assert.equal(logs.some((m) => m.includes("任务5")), false);
  assert.equal(logs.some((m) => m.includes("任务6")), false);
  // 汇总日志含"跳过3"（4、5、6）
  assert.equal(logs.some((m) => m.includes("跳过3")), true);
});

test("rewards are parsed with vote item counting", async () => {
  const { createTasksApex } = await loadVote(baseRules());
  let voteRewards = 0;
  const deps = baseDeps(async (_id, cmd, params) => {
    if (cmd === "apex_getroleinfo") {
      return { apexRoleInfo: { taskClaimedMap: {}, resetTime: { season: 1 } } };
    }
    if (cmd === "apex_taskclaim") {
      const value = params.confId === 1 ? 5 : 10;
      voteRewards += value;
      return {
        reward: [{ type: 3, itemId: 16001, value, ext: 0 }],
        apexRoleInfo: {},
      };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await createTasksApex(deps).batchApexTaskClaim();
  // 奖励解析正常走完（此处只验证流程不抛错、状态 completed）
  assert.equal(deps.tokenStatus.value.test, "completed");
});

test("no getroleinfo request is needed before claiming", async () => {
  const { createTasksApex } = await loadVote(baseRules());
  const requests = [];
  const deps = baseDeps(async (_id, cmd) => {
    requests.push(cmd);
    if (cmd === "apex_taskclaim") {
      return { reward: [], apexRoleInfo: {} };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  await createTasksApex(deps).batchApexTaskClaim();
  // 不再预查 getroleinfo（无跳过逻辑后不需要基线）
  assert.equal(requests.includes("apex_getroleinfo"), false);
  assert.equal(requests.filter((c) => c === "apex_taskclaim").length, 7);
});
