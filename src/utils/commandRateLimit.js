/**
 * 通用游戏命令限流（全局速率闸门 + AIMD 自适应冷却）。
 *
 * 服务器对高频命令有频控，超限返回业务码 200400「操作太快，请稍后再试」。
 * 逐鹿盐山（apex_*）已有专用限流器 utils/apexRateLimit.js，但日常任务、
 * 批量开箱/钓鱼/爬塔等批量流程此前完全没有限流：一旦被 200400 打回，
 * dailyTaskRunner 会把它当致命错误直接中断整个账号。
 *
 * 本模块提供两层保护：
 *  1. 全局速率闸门：任意两条命令之间至少间隔 1000/maxQps 毫秒，削平多账号并发突发。
 *     注意这里不做「全局串行」——批量流程命令量大，串行会把一轮日常拖到几十分钟。
 *     只做速率整形（pacing），保持多账号并行但限制聚合 QPS。
 *  2. 按命令族的 AIMD 自适应冷却：被 200400 打回 → est *= 1.5；连续成功 3 次 → est -= 200。
 *     估计值收敛到服务器真实冷却，既不更快（避免 200400）也不更慢（不浪费时间）。
 *
 * ⚠️ 排队耗时不计入响应超时
 * 调用方传入的 timeout 是从 send() 被调用那一刻起算的，而本模块的等待发生在调用之前。
 * 因此 runGameCommand 会先等、再发，调用方无需感知等待时长。
 */

/** 命令族：只读查询 / 写操作 / 战斗 */
export const CommandFamily = {
  READ: "read",
  WRITE: "write",
  BATTLE: "battle",
};

/** 各族间隔估计值下限（ms）：低于此值基本必被服务器打回 */
const EST_FLOOR = { read: 150, write: 300, battle: 400 };

/** 间隔估计值上限（ms）：超过 15s 多为异常/全局限流，不再无脑拉长 */
const EST_CEIL = 15000;

/** 间隔估计初始值（ms） */
const EST_DEFAULT = { read: 400, write: 900, battle: 1200 };

/** 排期余量（ms）：避免贴边触发 200400 */
const EST_MARGIN = 200;

/** 200400 后的乘性放大系数 */
const EST_GROW = 1.5;

/** 连续成功后每次下调的步长（ms） */
const EST_SHRINK = 200;

/** 连续成功多少次才下调一次（避免在边界上反复抖动） */
const OK_BEFORE_SHRINK = 3;

/** 估计值持久化键（跨会话沿用学习结果） */
const STORE_KEY = "cmd:estCooldown:v1";

/** 聚合 QPS 持久化键 */
const QPS_STORE_KEY = "cmd:maxQps:v1";

/** 默认聚合 QPS：8 条/秒，足以削平突发又不至于把批量流程拖垮 */
const DEFAULT_MAX_QPS = 8;

/** 单条命令遇到 200400 后的默认最大自动重试次数 */
const DEFAULT_MAX_RETRY = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 只读命令：不改动服务器状态，冷却可以最短 */
const READ_COMMANDS = new Set([
  "role_getroleinfo",
  "system_getdatabundlever",
  "presetteam_getinfo",
  "arena_getareatarget",
  "arena_startarea",
  "collection_goodslist",
  "store_getinfo",
  "legion_getinfo",
  "mail_getlist",
  "task_getdailytask",
]);

/** 战斗命令：服务器侧结算较重，冷却最长 */
const BATTLE_COMMANDS = new Set([
  "fight_startareaarena",
  "fight_startpvp",
  "fight_starttower",
  "fight_startboss",
  "fight_startlegionboss",
  "fight_startdungeon",
  "fight_startlevel",
  "fight_level",
]);

/**
 * 按命令名判定所属族。
 * @param {string} cmd 协议命令名
 * @returns {string} CommandFamily 之一；未知命令按写处理（更保守）
 */
export const commandFamily = (cmd) => {
  if (READ_COMMANDS.has(cmd)) return CommandFamily.READ;
  if (BATTLE_COMMANDS.has(cmd)) return CommandFamily.BATTLE;
  return CommandFamily.WRITE;
};

const clampEst = (key, val) =>
  Math.min(EST_CEIL, Math.max(EST_FLOOR[key] ?? 300, Math.round(val)));

const loadEst = () => {
  const est = { ...EST_DEFAULT };
  try {
    if (typeof localStorage === "undefined") return est;
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    for (const key of Object.keys(est)) {
      if (Number.isFinite(saved[key])) est[key] = clampEst(key, saved[key]);
    }
  } catch {
    /* localStorage 不可用时退回初始值 */
  }
  return est;
};

const persistEst = () => {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...est }));
    }
  } catch {
    /* ignore */
  }
};

/** 读取聚合 QPS 上限；不可用时退回默认值 */
const loadMaxQps = () => {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_MAX_QPS;
    const saved = Number(localStorage.getItem(QPS_STORE_KEY));
    if (Number.isFinite(saved) && saved >= 1 && saved <= 60) return saved;
  } catch {
    /* ignore */
  }
  return DEFAULT_MAX_QPS;
};

const est = loadEst();
const nextAllowedAt = { read: 0, write: 0, battle: 0 };
const okStreak = { read: 0, write: 0, battle: 0 };

/** 全局速率闸门：下一条命令最早可发出的时刻 */
let globalNextAt = 0;

export const getMaxQps = () => loadMaxQps();

export const setMaxQps = (qps) => {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(QPS_STORE_KEY, String(qps));
    }
  } catch {
    /* ignore */
  }
};

/**
 * 判断错误是否为服务器限流（200400）。
 * @param {unknown} e 捕获到的异常
 * @returns {boolean} 是 200400「操作太快」时为 true
 */
export const isRateLimited = (e) =>
  /200400|操作太快/.test(e && e.message ? e.message : String(e));

/**
 * 当前学习到的发送间隔（ms）。
 * @param {string} key 命令族
 * @returns {number} 间隔估计值
 */
export const commandEstMs = (key) => est[key] ?? 0;

/** 自适应限流概览文案（证明间隔是学习出来的，而非写死的常量） */
export const commandEstText = () =>
  `自适应限流：查询 ${(est.read / 1000).toFixed(1)}s · 写入 ${(est.write / 1000).toFixed(1)}s · 战斗 ${(est.battle / 1000).toFixed(1)}s（聚合 ≤ ${loadMaxQps()} 条/秒）`;

/** 复位学习到的间隔（排查问题时用） */
export const resetCommandEstimates = () => {
  Object.assign(est, EST_DEFAULT);
  nextAllowedAt.read = 0;
  nextAllowedAt.write = 0;
  nextAllowedAt.battle = 0;
  okStreak.read = 0;
  okStreak.write = 0;
  okStreak.battle = 0;
  persistEst();
};

const scheduleNext = (key) => {
  nextAllowedAt[key] = Date.now() + est[key] + EST_MARGIN;
};

const onSuccess = (key) => {
  okStreak[key] += 1;
  if (okStreak[key] >= OK_BEFORE_SHRINK) {
    est[key] = clampEst(key, est[key] - EST_SHRINK);
    okStreak[key] = 0;
    persistEst();
  }
};

const onRateLimited = (key) => {
  okStreak[key] = 0;
  est[key] = clampEst(key, est[key] * EST_GROW);
  persistEst();
};

/**
 * 预约全局速率闸门，返回还需等待的毫秒数。
 * @returns {number} 等待毫秒数
 */
const reserveGlobalSlot = () => {
  const now = Date.now();
  const gap = Math.max(1, Math.round(1000 / loadMaxQps()));
  const at = Math.max(now, globalNextAt);
  globalNextAt = at + gap;
  return at - now;
};

const cooldownLeft = (key) => Math.max(0, nextAllowedAt[key] - Date.now());

/**
 * 发送一条游戏命令，带全局速率整形与 200400 自适应退避重试。
 *
 * @param {object} opt 选项
 * @param {string} opt.cmd 协议命令名（用于判定命令族）
 * @param {Function} opt.send 实际发送函数，返回 Promise
 * @param {number} [opt.maxRetry] 200400 最大自动重试次数
 * @param {Function} [opt.onWait] 等待冷却时的回调，参数为等待毫秒数（用于日志）
 * @param {Function} [opt.shouldStop] 取消防御：返回 true 时不再重试，直接抛出
 * @param {boolean} [opt.paced] 是否走全局速率闸门，默认 true
 * @returns {Promise<*>} send 的返回值
 * @throws {Error} 重试耗尽或遇到非限流错误时抛出原始异常
 */
export const runGameCommand = async ({
  cmd,
  send,
  maxRetry = DEFAULT_MAX_RETRY,
  onWait,
  shouldStop,
  paced = true,
}) => {
  const key = commandFamily(cmd);
  const retries = Math.max(0, maxRetry);

  for (let attempt = 0; ; attempt += 1) {
    const wait = (paced ? reserveGlobalSlot() : 0) + cooldownLeft(key);
    if (wait > 0) {
      onWait?.(wait);
      await sleep(wait);
    }
    if (shouldStop?.()) throw new Error("任务已停止，取消限流等待后的发送");

    try {
      const res = await send();
      onSuccess(key);
      scheduleNext(key);
      return res;
    } catch (e) {
      if (!isRateLimited(e)) {
        okStreak[key] = 0;
        scheduleNext(key);
        throw e;
      }
      onRateLimited(key);
      scheduleNext(key);
      if (attempt >= retries) throw e;
      // 退避一段时间再试，避免连续硬撞服务器冷却窗口
      const backoff = Math.min(est[key] + EST_MARGIN, EST_CEIL);
      onWait?.(backoff);
      await sleep(backoff);
      if (shouldStop?.()) throw new Error("任务已停止，取消限流重试");
    }
  }
};
