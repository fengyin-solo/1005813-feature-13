import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  // 内涝处置与抢险队调度走专用的队列流转函数，通用入口不许直接改这两个模块的状态，
  // 保证单向推进、退水锁定、待归队联动这些硬规则只在一处生效。
  if (key === WATERLOG_KEY) {
    return { ok: false, message: '内涝点请在处置队列上操作：待处置只能「派出处置」，处置中只能「确认退水」' }
  }
  if (key === RESCUE_KEY) {
    return { ok: false, message: '抢险任务请在抢险队调度页按队列操作，不允许直接改状态' }
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ---------------------------------------------------------------------------
// 内涝处置队列（waterlog）与抢险队待归队（rescueteam）的专用流转
// 规则只在这里落地，页面只负责渲染与收集输入：
// 1. 内涝记录按 待处置 → 处置中 → 已退水 单向推进，不许跳级，已退水锁定不可改数；
// 2. 同一内涝编号重复上报合并到原记录，不新增；
// 3. 派哪支队伍由积水深度与影响范围决定，达到警戒深度的先派；
// 4. 现场报回的退水时间与系统记录不一致时，以现场记录为准；
// 5. 退水办结联动抢险队：处置对应任务进入「待归队」清单。
// ---------------------------------------------------------------------------

const WATERLOG_KEY = 'waterlog'
const RESCUE_KEY = 'rescueteam'
const WATERLOG_PREFIX = 'WLOG-'
const RESCUE_PREFIX = 'RESC-'

// 积水深度警戒值（厘米）：达到即优先派出，且按警戒档配队。
export const DEPTH_ALERT_CM = 30
export const DEPTH_CRITICAL_CM = 50

export const SCOPE_OPTIONS = ['交通主干道', '下穿隧道', '路口', '学校', '商圈', '居民小区', '背街小巷']

export type ReportInput = {
  code?: string
  site?: string
  depthCm?: number
  scope?: string
}

export type WaterlogQueue = {
  active: EntryRow[]
  completed: EntryRow[]
}

export type RescueQueue = {
  pendingReturn: EntryRow[]
  active: EntryRow[]
  completed: EntryRow[]
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function nowStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// 积水深度统一按厘米数值存，历史脏数据（含中文/单位）兜底解析成 0。
export function parseDepthCm(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const matched = String(value ?? '').match(/-?\d+(\.\d+)?/)
  return matched ? Number(matched[0]) : 0
}

export function isAlertDepth(depthCm: number): boolean {
  return depthCm >= DEPTH_ALERT_CM
}

export function depthLevel(depthCm: number): 'critical' | 'alert' | 'normal' {
  if (depthCm >= DEPTH_CRITICAL_CM) return 'critical'
  if (depthCm >= DEPTH_ALERT_CM) return 'alert'
  return 'normal'
}

export function depthLevelLabel(depthCm: number): string {
  const level = depthLevel(depthCm)
  return level === 'critical' ? '特急' : level === 'alert' ? '警戒' : '一般'
}

const TRAFFIC_SCOPES = ['交通主干道', '下穿隧道', '路口']
const COMMUNITY_SCOPES = ['学校', '商圈', '居民小区', '背街小巷']

// 派队规则：积水深度定队伍级别，影响范围定专业方向。
// 深度达到警戒（≥30cm）先派重型/专业队伍；一般积水按交通或社区场景配保障队。
export function recommendTeam(depthCm: number, scope: string): string {
  if (depthCm >= DEPTH_CRITICAL_CM) {
    return TRAFFIC_SCOPES.includes(scope) ? '重型抢险一队' : '重型抢险二队'
  }
  if (depthCm >= DEPTH_ALERT_CM) {
    if (TRAFFIC_SCOPES.includes(scope)) return '交通保障抢险队'
    if (scope === '学校' || scope === '商圈') return '应急突击队'
    return '应急突击队'
  }
  if (TRAFFIC_SCOPES.includes(scope)) return '交通保障抢险队'
  if (COMMUNITY_SCOPES.includes(scope)) return '社区排水抢险队'
  return '街道应急小分队'
}

function nextCode(rows: EntryRow[], field: string, prefix: string): string {
  let max = 0
  for (const row of rows) {
    const matched = String(row[field] ?? '').match(/(\d+)\s*$/)
    if (matched) {
      max = Math.max(max, Number(matched[1]))
    }
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

// 处置队列：处置中始终排在最前（按到场先后），其后待处置按警戒深度优先；
// 已退水的收进已完成一面，按退水时间倒序。
export function listWaterlogQueue(keyword = ''): WaterlogQueue {
  const word = keyword.trim()
  const rows = listRows(WATERLOG_KEY).filter((row) => {
    if (!word) return true
    return ['内涝编号', '内涝点位', '影响范围', '处置队'].some((field) =>
      String(row[field] ?? '').includes(word),
    )
  })
  const rank = (status: string): number => (status === '处置中' ? 0 : 1)
  const active = rows
    .filter((row) => row.status !== '已退水')
    .sort((a, b) => {
      const byStatus = rank(String(a.status)) - rank(String(b.status))
      if (byStatus !== 0) return byStatus
      // 同为处置中：先到场的在前；同为待处置：警戒/特急深度在前。
      if (a.status === '处置中' && b.status === '处置中') {
        return String(a.到场时间 ?? '').localeCompare(String(b.到场时间 ?? ''))
      }
      return parseDepthCm(b.积水深度) - parseDepthCm(a.积水深度) || Number(a.id) - Number(b.id)
    })
  const completed = rows
    .filter((row) => row.status === '已退水')
    .sort((a, b) => String(b.退水时间 ?? '').localeCompare(String(a.退水时间 ?? '')))
  return { active, completed }
}

// 上报警情：同一内涝编号只留一条，第二次上报合并到原记录而不是插一条新的。
// 合并不改变状态——处置中的继续处置，已退水的也不会被退回处置中改数。
export function reportWaterlog(input: ReportInput): ActionResult & { id?: number } {
  const code = input.code?.trim() || nextCode(listRows(WATERLOG_KEY), '内涝编号', WATERLOG_PREFIX)
  const site = input.site?.trim()
  if (!site) {
    return { ok: false, message: '内涝点位不能为空' }
  }
  const depthCm = Number(input.depthCm)
  if (!Number.isFinite(depthCm) || depthCm < 0) {
    return { ok: false, message: '积水深度要填一个不小于 0 的数字（厘米）' }
  }
  const scope = input.scope?.trim() || '背街小巷'
  const rows = listRows(WATERLOG_KEY)
  const index = rows.findIndex((row) => String(row.内涝编号 ?? '') === code)

  if (index >= 0) {
    const existing = rows[index]
    const reportCount = Number(existing.上报次数 ?? 1) + 1
    const merged: EntryRow = {
      ...existing,
      // 点位以首报为准，后续只刷新险情数据；深度与影响范围取最新一次上报。
      积水深度: depthCm,
      影响范围: scope,
      上报次数: reportCount,
      末次上报时间: nowStamp(),
    }
    const next = [...rows]
    next[index] = merged
    saveRows(WATERLOG_KEY, next)
    const locked = existing.status === '已退水' ? '（该点已退水锁定，新上报未改其状态）' : ''
    return {
      ok: true,
      id: Number(existing.id),
      message: `内涝点 ${code} 第 ${reportCount} 次上报，已合并到原记录${locked}`,
    }
  }

  const stamp = nowStamp()
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id,
    status: '待处置',
    pending: true,
    abnormal: false,
    内涝编号: code,
    内涝点位: site,
    积水深度: depthCm,
    影响范围: scope,
    处置队: '',
    到场时间: '',
    退水时间: '',
    退水时间依据: '',
    首次上报时间: stamp,
    末次上报时间: stamp,
    上报次数: 1,
  }
  saveRows(WATERLOG_KEY, [...rows, row])
  return { ok: true, id, message: `内涝点 ${code} 已登记入待处置队列，建议派「${recommendTeam(depthCm, scope)}」` }
}

// 派出处置：只允许 待处置 → 处置中，不许跳级。队伍按深度与影响范围定，警戒深度先派。
export function dispatchWaterlog(id: number): ActionResult {
  const rows = listRows(WATERLOG_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的内涝点记录` }
  }
  const current = rows[index]
  if (current.status === '已退水') {
    return { ok: false, message: `${current.内涝编号} 已退水办结并锁定，不能重新派出` }
  }
  if (current.status === '处置中') {
    return { ok: false, message: `${current.内涝编号} 已在处置中，不能重复派出` }
  }

  const depthCm = parseDepthCm(current.积水深度)
  const scope = String(current.影响范围 ?? '')
  const team = recommendTeam(depthCm, scope)
  const stamp = nowStamp()
  const updated: EntryRow = {
    ...current,
    status: '处置中',
    pending: true,
    abnormal: false,
    处置队: team,
    到场时间: stamp,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(WATERLOG_KEY, next)
  syncRescueOnDispatch(updated, stamp)
  return { ok: true, message: `${current.内涝编号} 由「${team}」出动处置${isAlertDepth(depthCm) ? '（警戒深度，优先派出）' : ''}` }
}

// 派出处置联动抢险队：有同点位待派队任务就推进，没有就补建一条抢险中任务。
function syncRescueOnDispatch(waterlog: EntryRow, stamp: string): void {
  const team = String(waterlog.处置队 ?? '')
  const site = String(waterlog.内涝点位 ?? '')
  const rows = listRows(RESCUE_KEY)
  const index = rows.findIndex(
    (row) => String(row.目标点位 ?? '') === site && (row.status === '待派队' || row.status === '抢险中'),
  )
  if (index >= 0) {
    const existing = rows[index]
    const moved: EntryRow = {
      ...existing,
      status: '抢险中',
      pending: true,
      抢险队: team || String(existing.抢险队 ?? ''),
      出队时间: stamp,
    }
    const next = [...rows]
    next[index] = moved
    saveRows(RESCUE_KEY, next)
    return
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id,
    status: '抢险中',
    pending: true,
    abnormal: false,
    任务编号: nextCode(rows, '任务编号', RESCUE_PREFIX),
    任务类型: '内涝处置',
    目标点位: site,
    抢险队: team,
    出队时间: stamp,
    关联内涝编号: String(waterlog.内涝编号 ?? ''),
  }
  saveRows(RESCUE_KEY, [...rows, row])
}

// 确认退水：只允许 处置中 → 已退水（单向、不许跳级）；退水时间以现场报回为准，
// 与系统记录不一致时用现场值覆盖，并在「退水时间依据」里留痕。
export function confirmWaterlogReceded(id: number, fieldRecededTime: string): ActionResult {
  const fieldTime = fieldRecededTime.trim()
  if (!fieldTime) {
    return { ok: false, message: '请填写现场报回的退水时间' }
  }
  const rows = listRows(WATERLOG_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的内涝点记录` }
  }
  const current = rows[index]
  if (current.status === '待处置') {
    return { ok: false, message: `${current.内涝编号} 还没派出处置，不能直接确认退水（不许跳级）` }
  }
  if (current.status === '已退水') {
    return { ok: false, message: `${current.内涝编号} 已退水办结并锁定，退水时间不能再改` }
  }

  const systemTime = String(current.退水时间 ?? '').trim()
  const overridden = systemTime !== '' && systemTime !== fieldTime
  const updated: EntryRow = {
    ...current,
    status: '已退水',
    pending: false,
    abnormal: false,
    退水时间: fieldTime,
    退水时间依据: overridden ? `现场记录（覆盖系统值 ${systemTime}）` : '现场记录',
  }
  const next = [...rows]
  next[index] = updated
  saveRows(WATERLOG_KEY, next)
  // 退水办结的结果落到抢险队的待归队清单。
  syncRescueOnReceded(updated)
  return {
    ok: true,
    message: overridden
      ? `${current.内涝编号} 已确认退水，退水时间按现场记录取 ${fieldTime}（已覆盖系统值）`
      : `${current.内涝编号} 已确认退水，处置队进入待归队清单`,
  }
}

function syncRescueOnReceded(waterlog: EntryRow): void {
  const code = String(waterlog.内涝编号 ?? '')
  const site = String(waterlog.内涝点位 ?? '')
  const rows = listRows(RESCUE_KEY)
  const index = rows.findIndex(
    (row) =>
      String(row.关联内涝编号 ?? '') === code ||
      (String(row.目标点位 ?? '') === site && (row.status === '待派队' || row.status === '抢险中')),
  )
  if (index >= 0) {
    const existing = rows[index]
    if (existing.status === '已归队') return
    const moved: EntryRow = { ...existing, status: '待归队', pending: true }
    const next = [...rows]
    next[index] = moved
    saveRows(RESCUE_KEY, next)
    return
  }
  // 任务不在册（外部队伍处置）也补一条待归队，保证待归队清单不丢。
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id,
    status: '待归队',
    pending: true,
    abnormal: false,
    任务编号: nextCode(rows, '任务编号', RESCUE_PREFIX),
    任务类型: '内涝处置',
    目标点位: site,
    抢险队: String(waterlog.处置队 ?? ''),
    出队时间: String(waterlog.到场时间 ?? ''),
    关联内涝编号: code,
  }
  saveRows(RESCUE_KEY, [...rows, row])
}

const RESCUE_ALLOWED: Record<string, string[]> = {
  待派队: ['派出抢险'],
  抢险中: ['确认待归', '终止任务'],
  待归队: ['确认归队'],
}

// 抢险队队列：待归队单列一块（退水办结落进来的），其余按状态归集。
export function listRescueQueue(keyword = ''): RescueQueue {
  const word = keyword.trim()
  const rows = listRows(RESCUE_KEY).filter((row) => {
    if (!word) return true
    return ['任务编号', '任务类型', '目标点位', '抢险队', '关联内涝编号'].some((field) =>
      String(row[field] ?? '').includes(word),
    )
  })
  const pendingReturn = rows
    .filter((row) => row.status === '待归队')
    .sort((a, b) => Number(a.id) - Number(b.id))
  const active = rows
    .filter((row) => row.status === '待派队' || row.status === '抢险中')
    .sort((a, b) => {
      const rank = (status: string): number => (status === '抢险中' ? 0 : 1)
      return rank(String(a.status)) - rank(String(b.status)) || Number(a.id) - Number(b.id)
    })
  const completed = rows
    .filter((row) => row.status === '已归队' || row.status === '已终止')
    .sort((a, b) => Number(b.id) - Number(a.id))
  return { pendingReturn, active, completed }
}

// 抢险任务动作：同样单向推进。派出 待派队→抢险中；退水办结 抢险中→待归队；归队 待归队→已归队。
export function runRescueAction(id: number, action: string): ActionResult {
  const rows = listRows(RESCUE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的抢险任务` }
  }
  const current = rows[index]
  const allowed = RESCUE_ALLOWED[String(current.status)] ?? []
  if (!allowed.includes(action)) {
    return { ok: false, message: `「${current.status}」状态不能执行「${action}」` }
  }

  const target =
    action === '派出抢险' ? '抢险中' : action === '确认待归' ? '待归队' : action === '确认归队' ? '已归队' : '已终止'
  const stamp = nowStamp()
  const updated: EntryRow = {
    ...current,
    status: target,
    pending: target === '抢险中' || target === '待归队',
    abnormal: action === '终止任务',
  }
  if (action === '派出抢险') {
    updated.出队时间 = stamp
  }
  if (action === '确认归队') {
    updated.归队时间 = stamp
  }
  const next = [...rows]
  next[index] = updated
  saveRows(RESCUE_KEY, next)
  return { ok: true, message: `抢险任务 ${current.任务编号} 已${action}，当前状态「${target}」` }
}

export type WaterlogStats = {
  pendingCount: number
  processingCount: number
  recededCount: number
  alertCount: number
}

export function waterlogStats(): WaterlogStats {
  const rows = listRows(WATERLOG_KEY)
  return {
    pendingCount: rows.filter((row) => row.status === '待处置').length,
    processingCount: rows.filter((row) => row.status === '处置中').length,
    recededCount: rows.filter((row) => row.status === '已退水').length,
    alertCount: rows.filter(
      (row) => row.status !== '已退水' && isAlertDepth(parseDepthCm(row.积水深度)),
    ).length,
  }
}

export type RescueStats = {
  dispatchingCount: number
  workingCount: number
  pendingReturnCount: number
  returnedCount: number
}

export function rescueStats(): RescueStats {
  const rows = listRows(RESCUE_KEY)
  return {
    dispatchingCount: rows.filter((row) => row.status === '待派队').length,
    workingCount: rows.filter((row) => row.status === '抢险中').length,
    pendingReturnCount: rows.filter((row) => row.status === '待归队').length,
    returnedCount: rows.filter((row) => row.status === '已归队').length,
  }
}
