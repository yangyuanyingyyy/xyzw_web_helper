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
