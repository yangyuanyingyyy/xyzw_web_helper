/**
 * 定时任务全局执行队列。
 *
 * 批量日常页的调度器（BatchDailyTasks.vue）命中一个定时任务后会直接
 * executeScheduledTask(task) 且不 await，因此：
 *   · 同一分钟命中的多个定时任务会并行起飞；
 *   · 每个定时任务内部又用 Promise.all 并行跑所有子任务；
 *   · 每个子任务再对全部账号 Promise.all。
 * 三层扇出叠加后瞬时请求数 = 任务数 × 子任务数 × 账号数，这是触发服务器
 * 频控（200400）的主要来源。
 *
 * 本模块提供一条全局串行链：定时任务按触发顺序排队执行，同一时刻只有一个
 * 定时任务在跑。这样并行度完全由「子任务 × 账号」两层决定，而这两层可以继续
 * 由 maxActive 与 commandRateLimit 治理。
 *
 * 队列带超时保护：上游任务卡死时不会永久阻塞后续任务，超时后跳过并记录。
 */

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 全局串行链：同一时刻只允许一个定时任务在跑 */
let chain = Promise.resolve();

/** 当前排队中的任务数（含正在执行的那个） */
let pending = 0;

export const scheduledQueueSize = () => pending;

/**
 * 把一次定时任务执行排入全局队列。
 *
 * @param {Function} task 实际执行函数，返回 Promise
 * @param {object} [opt] 选项
 * @param {number} [opt.timeoutMs] 排队+执行的整体超时，超时则跳过
 * @param {Function} [opt.onQueued] 入队回调，参数为当前队列长度
 * @param {Function} [opt.onTimeout] 超时回调
 * @returns {Promise<boolean>} 是否真正执行（false 表示被跳过）
 */
export const enqueueScheduledTask = async (
  task,
  { timeoutMs = DEFAULT_TIMEOUT_MS, onQueued, onTimeout } = {},
) => {
  pending += 1;
  onQueued?.(pending);

  const run = async () => {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("定时任务排队超时，已跳过本次执行")),
        timeoutMs,
      );
    });
    try {
      await Promise.race([task(), timeout]);
      return true;
    } catch (error) {
      if (/排队超时/.test(error.message || "")) {
        onTimeout?.();
        return false;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    const started = chain.then(run, run);
    chain = started.then(
      () => {},
      () => {},
    );
    return await started;
  } finally {
    pending = Math.max(0, pending - 1);
  }
};
