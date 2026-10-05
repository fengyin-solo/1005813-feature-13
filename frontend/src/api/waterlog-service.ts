import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 内涝点处置队列：状态机、排序、派队、合并、退水时间取舍全部收在这一个服务里，
// 页面只负责渲染。上半部分是不碰存储的纯规则，下半部分是读写本地数据层的联动。

const WATERLOG_KEY = 'waterlog'
const RESCUETEAM_KEY = 'rescueteam'

/** 处置队列的状态机：只能按这个顺序一格一格往后走，已退水是终点 */
export const WATERLOG_FLOW = ['待处置', '处置中', '已退水'] as const

/** 积水深度警戒线（厘米）：达到或超过的点位要先派队 */
export const WARNING_DEPTH_CM = 30

export type WaterlogReport = {
  内涝编号: string
  内涝点位: string
  积水深度: number
  影响范围: string
  /** 现场报回来的退水时间；与系统记录对不上时以它为准 */
  现场退水时间?: string
}

export type ReportResult = ActionResult & { merged: boolean }

// ---------- 纯规则 ----------

/** 当前状态的下一个状态；已退水没有下一个，返回 null */
export function nextStatus(current: string): string | null {
  const index = WATERLOG_FLOW.indexOf(current as (typeof WATERLOG_FLOW)[number])
  if (index < 0 || index === WATERLOG_FLOW.length - 1) {
    return null
  }
  return WATERLOG_FLOW[index + 1]
}

export function isWarningDepth(depthCm: number): boolean {
  return depthCm >= WARNING_DEPTH_CM
}

function depthOf(row: EntryRow): number {
  const depth = Number(row['积水深度'])
  return Number.isFinite(depth) ? depth : 0
}

/** 派哪支队伍：看积水深度和影响范围，达警戒或卡住隧道、主干道等要害的出强排队 */
export function pickTeam(depthCm: number, scope: string): string {
  const critical = /隧道|立交|主干道|快速路|桥洞|地下通道/.test(scope)
  if (isWarningDepth(depthCm) || critical) {
    return '强排抢险队'
  }
  if (depthCm >= 15) {
    return '机动抢险队'
  }
  return '巡查处置组'
}

/** 在办队列排序：处置中排最前；待处置里达警戒的先派，再按深度降序、先上报先排 */
export function sortActiveQueue(rows: EntryRow[]): EntryRow[] {
  const rank = (status: string) => (status === '处置中' ? 0 : 1)
  return [...rows].sort((a, b) => {
    const statusGap = rank(String(a.status)) - rank(String(b.status))
    if (statusGap !== 0) {
      return statusGap
    }
    const alertGap = Number(isWarningDepth(depthOf(b))) - Number(isWarningDepth(depthOf(a)))
    if (alertGap !== 0) {
      return alertGap
    }
    const depthGap = depthOf(b) - depthOf(a)
    if (depthGap !== 0) {
      return depthGap
    }
    return Number(a.id) - Number(b.id)
  })
}

/** 拆队列：还在办的是处置队列，已退水的收进已完成（按退水时间倒序） */
export function splitQueue(rows: EntryRow[]): { active: EntryRow[]; done: EntryRow[] } {
  const active = rows.filter((row) => String(row.status) !== '已退水')
  const done = rows
    .filter((row) => String(row.status) === '已退水')
    .sort((a, b) => String(b['退水时间'] ?? '').localeCompare(String(a['退水时间'] ?? '')))
  return { active: sortActiveQueue(active), done }
}

/** 退水时间冲突：以现场记录为准；现场没报才落系统时间 */
export function resolveRecedeTime(systemTime: string, fieldTime: string): string {
  const field = fieldTime.trim()
  return field === '' ? systemTime : field
}

/**
 * 同一内涝编号重复上报：合并进原记录，不插新行。
 * 原记录的 id 和状态不动；已退水的记录封存不许改数，唯一开口是按现场记录更正退水时间。
 */
export function mergeReport(existing: EntryRow, report: WaterlogReport): EntryRow {
  if (String(existing.status) === '已退水') {
    const fieldTime = (report.现场退水时间 ?? '').trim()
    if (fieldTime === '' || fieldTime === String(existing['退水时间'] ?? '')) {
      return existing
    }
    return { ...existing, 退水时间: fieldTime }
  }
  const depth = Number.isFinite(report.积水深度) ? report.积水深度 : depthOf(existing)
  return {
    ...existing,
    内涝点位: report.内涝点位.trim() === '' ? existing['内涝点位'] : report.内涝点位.trim(),
    积水深度: depth,
    影响范围: report.影响范围.trim() === '' ? existing['影响范围'] : report.影响范围.trim(),
    现场退水时间: (report.现场退水时间 ?? '').trim() || String(existing['现场退水时间'] ?? ''),
    上报次数: Number(existing['上报次数'] ?? 1) + 1,
    abnormal: isWarningDepth(depth),
  }
}

// ---------- 读写联动 ----------

function now(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 上报内涝点：同一编号只留一条，第二次起上报合并到原记录，不插新行 */
export function reportWaterlog(report: WaterlogReport): ReportResult {
  const code = report.内涝编号.trim()
  if (code === '') {
    return { ok: false, message: '内涝编号不能为空', merged: false }
  }
  const rows = listRows(WATERLOG_KEY)
  const existing = rows.find((row) => String(row['内涝编号']) === code)
  if (existing) {
    const merged = mergeReport(existing, report)
    saveRows(
      WATERLOG_KEY,
      rows.map((row) => (row.id === merged.id ? merged : row)),
    )
    if (String(existing.status) === '已退水') {
      return {
        ok: true,
        merged: true,
        message:
          merged === existing
            ? `内涝编号 ${code} 已退水办结，记录封存，本次上报未改动任何数据`
            : `内涝编号 ${code} 已退水办结，退水时间已按现场记录更正，其余数据保持封存`,
      }
    }
    return {
      ok: true,
      merged: true,
      message: `内涝编号 ${code} 已有记录（第 ${String(merged['上报次数'])} 次上报），已合并到原记录，未新增条目`,
    }
  }
  const depth = Number.isFinite(report.积水深度) ? report.积水深度 : 0
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const row: EntryRow = {
    id,
    status: '待处置',
    pending: true,
    abnormal: isWarningDepth(depth),
    内涝编号: code,
    内涝点位: report.内涝点位.trim(),
    积水深度: depth,
    影响范围: report.影响范围.trim(),
    处置队: '',
    到场时间: '',
    退水时间: '',
    处置状态: '待处置',
    上报次数: 1,
    现场退水时间: (report.现场退水时间 ?? '').trim(),
  }
  saveRows(WATERLOG_KEY, [...rows, row])
  return { ok: true, merged: false, message: `内涝点 ${code} 已登记，进入待处置队列` }
}

/**
 * 推进处置队列：待处置 → 处置中 → 已退水，一次只能走一格。
 * 不许跳级（目标状态由当前状态唯一决定），已退水的记录到此封存，不许退回处置中改数。
 */
export function advanceWaterlog(id: number, fieldRecedeTime = ''): ActionResult {
  const rows = listRows(WATERLOG_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的内涝点记录` }
  }
  const current = String(rows[index].status)
  const target = nextStatus(current)
  if (target === null) {
    return { ok: false, message: '这条记录已退水办结，不能退回处置中改数' }
  }
  let updated: EntryRow = { ...rows[index], status: target, 处置状态: target }
  if (target === '处置中') {
    const team = pickTeam(depthOf(updated), String(updated['影响范围'] ?? ''))
    updated = {
      ...updated,
      处置队: team,
      到场时间: now(),
      abnormal: isWarningDepth(depthOf(updated)),
    }
    ensureRescueTask(updated, team)
  }
  if (target === '已退水') {
    const reported = fieldRecedeTime.trim() || String(updated['现场退水时间'] ?? '')
    updated = {
      ...updated,
      pending: false,
      abnormal: false,
      退水时间: resolveRecedeTime(now(), reported),
    }
    markPendingReturn(updated)
  }
  const next = [...rows]
  next[index] = updated
  saveRows(WATERLOG_KEY, next)
  return { ok: true, message: `内涝点记录已推进到「${target}」` }
}

/** 处置队列：active 是在办的（处置中最前、达警戒先派），done 是收进已完成的已退水记录 */
export function waterlogQueue(): { active: EntryRow[]; done: EntryRow[] } {
  return splitQueue(listRows(WATERLOG_KEY))
}

/** 抢险队待归队清单：内涝点退水办结、队伍还没确认归队的任务 */
export function pendingReturnTasks(): EntryRow[] {
  return listRows(RESCUETEAM_KEY).filter(
    (task) => String(task.status) === '抢险中' && String(task['办结结果'] ?? '') !== '',
  )
}

/** 确认归队：从待归队清单里销号，记下归队时间 */
export function confirmReturn(taskId: number): ActionResult {
  const tasks = listRows(RESCUETEAM_KEY)
  const index = tasks.findIndex((task) => Number(task.id) === taskId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${taskId} 的抢险任务` }
  }
  if (String(tasks[index].status) !== '抢险中') {
    return { ok: false, message: '只有抢险中的任务才能确认归队' }
  }
  const next = [...tasks]
  next[index] = {
    ...tasks[index],
    status: '已归队',
    任务状态: '已归队',
    pending: false,
    归队时间: now(),
  }
  saveRows(RESCUETEAM_KEY, next)
  return { ok: true, message: '抢险队已确认归队' }
}

/** 派队的同时在抢险队调度里挂一条抢险中的任务；同一内涝编号复用原任务，不重复派 */
function ensureRescueTask(waterlog: EntryRow, team: string): void {
  const tasks = listRows(RESCUETEAM_KEY)
  const code = String(waterlog['内涝编号'])
  const existing = tasks.find(
    (task) => String(task['关联内涝编号'] ?? '') === code && String(task.status) !== '已终止',
  )
  if (existing) {
    const updated: EntryRow = {
      ...existing,
      status: '抢险中',
      任务状态: '抢险中',
      pending: true,
      抢险队: team,
      目标点位: String(waterlog['内涝点位'] ?? ''),
      出队时间: now(),
      归队时间: '',
      办结结果: '',
    }
    saveRows(
      RESCUETEAM_KEY,
      tasks.map((task) => (task.id === updated.id ? updated : task)),
    )
    return
  }
  const id = tasks.reduce((max, task) => Math.max(max, Number(task.id)), 0) + 1
  const task: EntryRow = {
    id,
    status: '抢险中',
    pending: true,
    abnormal: false,
    任务编号: `RESC-${String(id).padStart(4, '0')}`,
    任务类型: '内涝抢险',
    目标点位: String(waterlog['内涝点位'] ?? ''),
    抢险队: team,
    出队时间: now(),
    归队时间: '',
    负责人: '',
    任务状态: '抢险中',
    关联内涝编号: code,
    办结结果: '',
  }
  saveRows(RESCUETEAM_KEY, [...tasks, task])
}

/** 退水办结：结果落到抢险队的待归队清单（给抢险中的关联任务挂上办结结果） */
function markPendingReturn(waterlog: EntryRow): void {
  const tasks = listRows(RESCUETEAM_KEY)
  const code = String(waterlog['内涝编号'])
  let changed = false
  const next = tasks.map((task) => {
    if (String(task['关联内涝编号'] ?? '') !== code || String(task.status) !== '抢险中') {
      return task
    }
    changed = true
    return {
      ...task,
      办结结果: `内涝点${code}已退水（退水时间 ${String(waterlog['退水时间'])}），待归队`,
    }
  })
  if (changed) {
    saveRows(RESCUETEAM_KEY, next)
  }
}
