/**
 * 逐鹿盐山任务
 * 包含: 一键批量竞猜（自动选助威最高队伍）、一键批量助威（全量道具助威榜第一名）、
 *       一键批量领取任务奖励（apex_taskclaim confId 1~7）
 *
 * 开放判定复用 utils/apexRules.js（1:1 移植客户端规则）：
 *   · 竞猜：仅淘汰赛阶段（stage 4~10）且状态为 Unlocked / Locked 的场次可押；
 *     每阶段可押队伍数上限 = 该阶段 advanceNum（季军赛恒为 1）；
 *     分页 idx = 已加载条数，以响应 last 终止。
 *   · 助威：checkSupportInTime 判定该期是否处于可助威窗口
 *     （正式赛段 / 淘汰赛段且该期无 Locked / Fighting 场次）；
 *     助威榜 scheduleId = 淘汰赛段优先、其次正式赛段（等价客户端 currentScheduleId）。
 *   · 任务奖励：每次完整遍历 confId 1~7，全部逐个 apex_taskclaim 不跳过，
 *     由服务器裁决（可领则发放；已领/未完成则拒绝）。
 *     错误码 200020（"出了点小问题"）实测语义为「已领取过或任务未完成」，
 *     逐任务提示后跳过不计失败；其余错误如实记录。
 */

import {
  ApexAction,
  apexCooldownLeft,
  isApexRateLimited,
  runApexAction,
} from "@/utils/apexRateLimit";
import {
  ApexScheduleStatus,
  ApexStageType,
  calibrateServerTime,
  checkSupportInTime,
  getAdvanceNum,
  getCurrentRounds,
  getCurrentSeason,
  getDateZeroTime,
  getGuessTabs,
  getScheduleIdByStage,
  getSeasonConf,
  getStageInfoByRound,
  getSupportGroupId,
} from "@/utils/apexRules";

/** 单次请求超时（ms） */
const TIMEOUT_MS = 8000;

/** 单阶段分页拉取的最大页数（防御 last 异常导致死循环） */
const MAX_PAGES = 12;

/** 逐鹿盐山任务奖励的 confId 取值范围（ApexService.taskClaim 单值入参） */
const TASK_CLAIM_IDS = [1, 2, 3, 4, 5, 6, 7];

/** 助威道具 itemId（apexConstantConf.supportItemId，用于奖励日志文案） */
const VOTE_ITEM_ID = 16001;

/** 盐山金币 itemId（任务奖励的第二种常见产出） */
const SALT_COIN_ITEM_ID = 16002;

/** 只读拉取遇到 200400 时的自动重试次数 */
const READ_MAX_RETRY = 1;

/**
 * 经自适应限流器发送一条 apex 命令。
 *
 * 服务器对 apex_* 有频控（200400「操作太快」），固定 sleep 无法适配真实冷却，
 * 统一走 utils/apexRateLimit.js：串行排队 + AIMD 自适应间隔。
 * @param {string} action 动作类型（ApexAction）
 * @param {Function} task 实际发送函数；入参为排队耗时（ms），应叠加到响应超时上
 * @param {number} [maxRetry] 200400 自动重试次数
 * @returns {Promise<*>} 命令响应
 */
const sendApex = (action, task, maxRetry) =>
  runApexAction(action, task, { maxRetry });

/**
 * 解析当前赛季「竞猜开放中」的阶段页签。
 *
 * 逐期扫描所有「进行中」的期（历史期已全部结束，不含开放场次）：
 * 报名期与淘汰赛期在时间上是重叠的，只取默认一期会漏掉另一期已开押的阶段
 * （例：第 5 期报名中、第 4 期淘汰赛已开押）。期号与阶段全部由配置推导。
 *
 * @param {number} nowMs 服务端时间
 * @returns {Array<{season: number, round: number, tabs: Array}>} 所有开放期次；无开放场次时为空数组
 */
const resolveOpenGuesses = (nowMs) => {
  const season = getCurrentSeason(nowMs);
  if (season <= 0) return [];
  const openRounds = [];
  for (const round of getCurrentRounds(season, nowMs)) {
    const tabs = getGuessTabs(round, season, nowMs).filter(
      (t) =>
        t.state === ApexScheduleStatus.Unlocked ||
        t.state === ApexScheduleStatus.Locked,
    );
    if (tabs.length) openRounds.push({ season, round, tabs });
  }
  return openRounds;
};

/**
 * 助威道具持有量（等价面板 ApexChallenge.supportItemCnt）：
 * 服务端原始字段 voteItemCnt 仅在服务端赛季处于其配置窗口内时有效，否则为 0。
 * @param {object} apexRoleInfo apex_getroleinfo 返回的 apexRoleInfo
 * @param {number} roleSeason 服务端上报的赛季号
 * @param {number} nowMs 服务端时间
 * @returns {number} 有效助威道具数
 */
const resolveVoteItemCnt = (apexRoleInfo, roleSeason, nowMs) => {
  const conf = getSeasonConf(roleSeason);
  if (!conf) return 0;
  const start = getDateZeroTime(conf.startDate);
  const end = getDateZeroTime(conf.endDate);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    nowMs < start ||
    nowMs > end
  ) {
    return 0;
  }
  return Number(apexRoleInfo?.voteItemCnt) || 0;
};

/**
 * 助威榜所属阶段的 scheduleId（等价面板 ApexChallenge.voteScheduleId，
 * 客户端 apexScheduleData.currentScheduleId）：淘汰赛段优先，其次正式赛段。
 * @param {number} round 期号
 * @param {number} season 赛季号
 * @param {number} nowMs 服务端时间
 * @returns {number} scheduleId；无法推导时为 -1
 */
const resolveVoteScheduleId = (round, season, nowMs) => {
  const info = getStageInfoByRound(round, season, nowMs);
  if (info?.[ApexStageType.TaoTai]?.isEnable) {
    return getScheduleIdByStage(ApexStageType.TaoTai, round, season);
  }
  if (info?.[ApexStageType.ZhengShi]?.isEnable) {
    return getScheduleIdByStage(ApexStageType.ZhengShi, round, season);
  }
  return -1;
};

/**
 * 创建逐鹿盐山竞猜任务执行器
 * @param {object} deps - 依赖项
 * @returns {object} 任务函数集合
 */
export function createTasksApex(deps) {
  const {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    connectionQueue,
    batchSettings,
    tokenStore,
    addLog,
    message,
    currentRunningTokenId,
  } = deps;

  /**
   * 一键批量逐鹿盐山竞猜
   * 自动选每组对阵中助威数最高的队伍
   */
  const batchApexGuess = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        await ensureConnection(tokenId);

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始逐鹿盐山竞猜: ${token.name} ===`,
          type: "info",
        });

        // 1. 获取角色信息（resetTime.day 用于服务端时间校准）
        const roleResp = await sendApex(
          ApexAction.READ,
          // 排队耗时补偿进超时：本命令排在串行链尾时，冷却等待会吃掉预算，
          // 不补偿就会出现「还没等到响应先报超时」的假故障
          (queuedMs) =>
            tokenStore.sendMessageWithPromise(
              tokenId,
              "apex_getroleinfo",
              {},
              TIMEOUT_MS + queuedMs,
            ),
          READ_MAX_RETRY,
        );
        const apexInfo = roleResp?.apexRoleInfo || {};
        const guessMap = apexInfo.guessMap || {};

        // 2. 依据真实规则解析当前开放的竞猜阶段
        const openRounds = resolveOpenGuesses(
          calibrateServerTime(Date.now(), apexInfo.resetTime?.day),
        );
        if (!openRounds.length) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 当前无开放的竞猜阶段（竞猜仅在淘汰赛段开放）`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        // 3. 逐阶段分页拉取对阵并竞猜
        let successCount = 0;
        let skipCount = 0;
        let failCount = 0;
        /** 连续被 200400 打回后置位：中止该账号剩余竞猜，避免持续轰炸服务器 */
        let abortedByRateLimit = false;

        for (const open of openRounds) {
          if (shouldStop.value || abortedByRateLimit) break;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 第${open.season}赛季 第${open.round}期，开放竞猜 ${open.tabs.length} 个阶段`,
            type: "info",
          });
          for (const tab of open.tabs) {
            if (shouldStop.value) break;
            if (abortedByRateLimit) break;

            const advanceNum = getAdvanceNum(
              open.round,
              open.season,
              tab.stage,
            );
            const guessedTeamIds = new Set(guessMap[tab.scheduleId] || []);
            if (advanceNum > 0 && guessedTeamIds.size >= advanceNum) {
              skipCount++;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} ${tab.title} 已押满 ${advanceNum} 队，跳过`,
                type: "info",
              });
              continue;
            }

            // 分页拉取该阶段全部对阵：idx = 已加载条数，以 last 终止
            const allGroups = [];
            let last = false;
            for (let p = 0; p < MAX_PAGES && !last; p++) {
              if (shouldStop.value) break;
              const resp = await sendApex(
                ApexAction.READ,
                // 同上：分页循环每页都要重新等冷却，补偿后才不会误判超时
                (queuedMs) =>
                  tokenStore.sendMessageWithPromise(
                    tokenId,
                    "apex_getguesslist",
                    { scheduleId: tab.scheduleId, idx: allGroups.length },
                    TIMEOUT_MS + queuedMs,
                  ),
                READ_MAX_RETRY,
              );
              const groups = resp?.apexGuessList || [];
              if (groups.length === 0) break;
              allGroups.push(...groups);
              last = resp?.last === true;
            }

            if (allGroups.length === 0) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} ${tab.title} 没有对阵数据`,
                type: "warning",
              });
              continue;
            }
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${tab.title} 共 ${allGroups.length} 组对阵`,
              type: "info",
            });

            for (const group of allGroups) {
              if (shouldStop.value) break;
              if (abortedByRateLimit) break;
              if (advanceNum > 0 && guessedTeamIds.size >= advanceNum) break;

              const [team0, team1] = group;
              if (!team0 || !team1) continue;

              // 两队都已竞猜则跳过
              if (
                guessedTeamIds.has(team0.teamId) &&
                guessedTeamIds.has(team1.teamId)
              ) {
                skipCount++;
                continue;
              }

              // 选助威数更高的队伍
              let pick;
              if (guessedTeamIds.has(team0.teamId)) {
                pick = team1;
              } else if (guessedTeamIds.has(team1.teamId)) {
                pick = team0;
              } else {
                pick = team0.cheerCnt >= team1.cheerCnt ? team0 : team1;
              }

              try {
                await runApexAction(
                  ApexAction.GUESS,
                  (queuedMs) =>
                    tokenStore.sendMessageWithPromise(
                      tokenId,
                      "apex_guess",
                      { teamId: pick.teamId },
                      TIMEOUT_MS + queuedMs,
                    ),
                  {
                    // 等待服务器冷却时给出可见反馈，避免界面像卡死
                    onWait: (ms) =>
                      addLog({
                        time: new Date().toLocaleTimeString(),
                        message: `${token.name} 竞猜遇到服务器限流，等待 ${Math.ceil(ms / 1000)}s 后重试`,
                        type: "warning",
                      }),
                  },
                );
                guessedTeamIds.add(pick.teamId);
                successCount++;
                addLog({
                  time: new Date().toLocaleTimeString(),
                  message: `${token.name} ${tab.title} 竞猜 ${pick.name} (${pick.teamId}) 助威:${pick.cheerCnt} ✓`,
                  type: "success",
                });
              } catch (err) {
                failCount++;
                addLog({
                  time: new Date().toLocaleTimeString(),
                  message: `${token.name} ${tab.title} 竞猜 ${pick.name} 失败: ${err.message}`,
                  type: "error",
                });
                if (isApexRateLimited(err)) {
                  // 重试仍被限流：停止该账号后续竞猜，等待自适应间隔恢复
                  abortedByRateLimit = true;
                  addLog({
                    time: new Date().toLocaleTimeString(),
                    message: `${token.name} 连续被服务器限流（200400），约 ${Math.ceil(apexCooldownLeft(ApexAction.GUESS) / 1000)}s 后可继续，本次中止剩余竞猜`,
                    type: "warning",
                  });
                }
              }
            }
          }
        }

        if (abortedByRateLimit) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 因服务器限流提前结束，未完成部分稍后重跑即可续押`,
            type: "warning",
          });
        }

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 竞猜完成: 成功${successCount} 跳过${skipCount} 失败${failCount} ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 逐鹿盐山竞猜失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量逐鹿盐山竞猜结束");
  };

  /**
   * 一键批量逐鹿盐山助威
   * 默认选当前可助威的期，把全部助威道具投给助威榜第一名
   * 无道具 / 当前期不可助威 → 跳过该账号并提示
   */
  const batchApexVote = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        await ensureConnection(tokenId);

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始逐鹿盐山助威: ${token.name} ===`,
          type: "info",
        });

        // 1. 角色信息：道具 / 分组 / 服务端时间
        const roleResp = await sendApex(
          ApexAction.READ,
          (queuedMs) =>
            tokenStore.sendMessageWithPromise(
              tokenId,
              "apex_getroleinfo",
              {},
              TIMEOUT_MS + queuedMs,
            ),
          READ_MAX_RETRY,
        );
        const apexInfo = roleResp?.apexRoleInfo || {};
        const roleSeason = Number(apexInfo.resetTime?.season) || 0;
        const nowMs = calibrateServerTime(Date.now(), apexInfo.resetTime?.day);

        // 2. 道具判定（赛季窗口内才有效，等价面板 supportItemCnt）
        const voteItemCnt = resolveVoteItemCnt(apexInfo, roleSeason, nowMs);
        if (voteItemCnt <= 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 无助威道具，跳过`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        // 3. 找当前可助威的期（本地规则推演，与游戏判定一致）
        const season = getCurrentSeason(nowMs);
        let targetRound = null;
        if (season > 0) {
          for (const round of getCurrentRounds(season, nowMs)) {
            if (checkSupportInTime(round, season, nowMs)) {
              targetRound = round;
              break;
            }
          }
        }
        if (!targetRound) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 当前期不在助威时间内（仅正式赛段/淘汰赛段且无进行中场次可助威），跳过`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        // 4. 助威榜分组号（等价面板 fetchVoteBoard 的 groupId 取法）
        const scheduleId = resolveVoteScheduleId(
          targetRound,
          season,
          nowMs,
        );
        const groupId = getSupportGroupId(apexInfo.group, scheduleId);

        // 5. 分页拉助威榜取第一名（服务端按 cheerCnt 降序，首行即第一）
        const rows = [];
        let last = false;
        for (let p = 0; p < MAX_PAGES && !last; p++) {
          if (shouldStop.value) break;
          const resp = await sendApex(
            ApexAction.READ,
            (queuedMs) =>
              tokenStore.sendMessageWithPromise(
                tokenId,
                "apex_getvotelist",
                { groupId, round: targetRound, idx: rows.length },
                TIMEOUT_MS + queuedMs,
              ),
            READ_MAX_RETRY,
          );
          const list = resp?.apexVoteList || [];
          if (!list.length) break;
          rows.push(...list);
          last = resp?.last === true;
        }

        // 第一名 = 首个未淘汰的有效队伍（榜单已按 cheerCnt 降序）
        const top = rows.find(
          (t) => t && t.teamId != null && t.isOut !== true,
        );
        if (!top) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 当前期无可助威的队伍，跳过`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 第${season}赛季 第${targetRound}期，目标第一名：${top.name}（助威数 ${top.cheerCnt ?? 0}）`,
          type: "info",
        });

        // 6. 全量道具助威第一名
        await runApexAction(
          ApexAction.VOTE,
          (queuedMs) =>
            tokenStore.sendMessageWithPromise(
              tokenId,
              "apex_vote",
              { teamId: top.teamId, round: targetRound, voteCnt: voteItemCnt },
              TIMEOUT_MS + queuedMs,
            ),
          {
            // 等待冷却的提示：>2s 才记日志（短间隔是正常节奏尾巴，不刷屏）；
            // 排队是预防性节奏控制而非错误，用 info 而非 warning
            onWait: (ms) => {
              if (ms < 2000) return;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 按服务器节奏排队中，${Math.ceil(ms / 1000)}s 后执行投票`,
                type: "info",
              });
            },
          },
        );

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 已为 ${top.name} 助威 ${voteItemCnt} 个道具 ✓`,
          type: "success",
        });
        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 逐鹿盐山助威失败: ${error.message || "未知错误"}${isApexRateLimited(error) ? "（服务器限流，稍后重跑即可续投）" : ""}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量逐鹿盐山助威结束");
  };

  /**
   * 一键批量领取逐鹿盐山任务奖励
   * 对每个账号完整遍历 confId 1~7：不跳过任何 ID，全部逐个 apex_taskclaim
   * （由服务器裁决：可领则发放，已领/未完成则返回错误，如实记录日志）
   * 单个失败不阻断整批
   */
  const batchApexTaskClaim = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        await ensureConnection(tokenId);

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始领取逐鹿盐山任务奖励: ${token.name} ===`,
          type: "info",
        });

        let successCount = 0;
        let skipCount = 0;
        let failCount = 0;
        let voteItemTotal = 0;
        let abortedByRateLimit = false;

        // 完整轮询 confId 1~7，不跳过任何 ID
        for (const confId of TASK_CLAIM_IDS) {
          if (shouldStop.value || abortedByRateLimit) break;

          try {
            const resp = await sendApex(
              ApexAction.READ,
              (queuedMs) =>
                tokenStore.sendMessageWithPromise(
                  tokenId,
                  "apex_taskclaim",
                  { confId },
                  TIMEOUT_MS + queuedMs,
                ),
            );

            // 奖励解析：itemId 16001 = 助威道具，16002 = 盐山金币
            const reward = Array.isArray(resp?.reward) ? resp.reward : [];
            const parts = reward
              .map((r) => {
                const cnt = Number(r?.value) || 0;
                if (r?.itemId === VOTE_ITEM_ID) {
                  voteItemTotal += cnt;
                  return `助威道具×${cnt}`;
                }
                if (r?.itemId === SALT_COIN_ITEM_ID) {
                  return `盐山金币×${cnt}`;
                }
                return `道具${r?.itemId}×${cnt}`;
              })
              .filter(Boolean);
            successCount++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 任务${confId} 领取成功${parts.length ? `：${parts.join("，")}` : ""}`,
              type: "success",
            });
          } catch (error) {
            // 200020（"出了点小问题"）在本接口实测语义为「已领取过或任务未完成」：
            // 属正常业务结果而非异常，逐任务提示后跳过、不计入失败
            const isAlreadyDone =
              error?.message?.includes("200020") === true;
            if (isAlreadyDone) {
              skipCount++;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 任务${confId} 已领取过或未完成，跳过`,
                type: "info",
              });
              continue;
            }
            // 200160 模块未开启：该账号未解锁逐鹿盐山功能，
            // 后续任务必然同样报错，直接结束该账号
            const isModuleClosed =
              error?.message?.includes("200160") === true;
            if (isModuleClosed) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 逐鹿盐山功能模块未开启，跳过该账号`,
                type: "warning",
              });
              break;
            }
            failCount++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 任务${confId} 领取失败: ${error.message || "未知错误"}${isApexRateLimited(error) ? "（稍后重跑即可续领）" : ""}`,
              type: "error",
            });
            if (isApexRateLimited(error)) {
              // 连续被限流：停止该账号剩余领取，避免持续轰炸服务器
              abortedByRateLimit = true;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 因服务器限流提前结束，未完成部分稍后重跑即可续领`,
                type: "warning",
              });
              break;
            }
          }
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 任务奖励领取完成: 成功${successCount} 跳过${skipCount} 失败${failCount}${voteItemTotal > 0 ? `，共获得助威道具 ${voteItemTotal} 个` : ""} ===`,
          type: successCount > 0 ? "success" : "info",
        });
        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 逐鹿盐山任务奖励领取失败: ${error.message || "未知错误"}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量领取逐鹿盐山任务奖励结束");
  };

  return {
    batchApexGuess,
    batchApexVote,
    batchApexTaskClaim,
  };
}
