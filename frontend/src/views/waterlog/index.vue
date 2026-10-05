<template>
  <section class="page" data-module="waterlog">
    <header class="page-head">
      <div>
        <h2>内涝点处置队列</h2>
        <p class="page-desc">
          暴雨多点积水统一排队：处置中排在最前，待处置按警戒深度优先派出，已退水收进已完成；
          状态只许 待处置 → 处置中 → 已退水 单向推进，不许跳级、已退水锁定不可改。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出处置清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待处置</span>
        <strong class="stat-value">{{ stats.pendingCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">处置中</span>
        <strong class="stat-value processing">{{ stats.processingCount }}</strong>
      </article>
      <article class="stat-card stat-alert">
        <span class="stat-label">警戒深度未退水（≥{{ DEPTH_ALERT_CM }}cm）</span>
        <strong class="stat-value">{{ stats.alertCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已退水（已完成）</span>
        <strong class="stat-value done">{{ stats.recededCount }}</strong>
      </article>
    </div>

    <!-- 上报警情：同一内涝编号第二次上报会合并进原记录，不插新条 -->
    <form class="report-form" @submit.prevent="submitReport">
      <label class="report-item">
        <span>内涝编号（留空自动生成）</span>
        <input v-model="report.code" placeholder="如 WLOG-0007，重报同一编号即合并" />
      </label>
      <label class="report-item report-wide">
        <span>内涝点位 *</span>
        <input v-model="report.site" placeholder="如 中山北路下穿隧道" />
      </label>
      <label class="report-item">
        <span>积水深度（厘米）*</span>
        <input v-model.number="report.depthCm" type="number" min="0" step="1" placeholder="30" />
      </label>
      <label class="report-item">
        <span>影响范围</span>
        <select v-model="report.scope">
          <option v-for="item in SCOPE_OPTIONS" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <button class="btn primary" type="submit">上报警情 / 重复上报合并</button>
    </form>

    <div class="rule-hint">
      派队规则：深度 ≥{{ DEPTH_CRITICAL_CM }}cm 派重型抢险队（交通场景一队），
      ≥{{ DEPTH_ALERT_CM }}cm 派交通保障抢险队 / 应急突击队并优先派出，其余按交通、社区场景派保障小分队。
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item filter-wide">
        <span>队列检索</span>
        <input v-model="keyword" placeholder="按内涝编号 / 点位 / 影响范围 / 处置队检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetKeyword">重置条件</button>
    </form>

    <h3 class="queue-title">
      处置队列 · 处置中优先（{{ queue.active.length }}）
    </h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>优先级</th>
          <th>内涝编号</th>
          <th>内涝点位</th>
          <th>积水深度</th>
          <th>影响范围</th>
          <th>处置队</th>
          <th>上报</th>
          <th>到场时间</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in queue.active" :key="String(row.id)">
          <td><span :class="['badge', levelClass(row)]">{{ levelText(row) }}</span></td>
          <td>{{ row.内涝编号 }}</td>
          <td>{{ row.内涝点位 }}</td>
          <td>
            <span :class="depthClass(row)">{{ row.积水深度 }} cm</span>
          </td>
          <td>{{ row.影响范围 }}</td>
          <td>{{ row.处置队 || suggestTeam(row) }}</td>
          <td>
            第 {{ row.上报次数 ?? 1 }} 次
            <span v-if="Number(row.上报次数 ?? 1) > 1" class="merged-tag">已合并</span>
          </td>
          <td>{{ row.到场时间 || '—' }}</td>
          <td><span class="status-pill">{{ row.status }}</span></td>
          <td class="row-actions">
            <button v-if="row.status === '待处置'" class="link" type="button" @click="dispatch(row)">
              派出处置（{{ suggestTeam(row) }}）
            </button>
            <button v-if="row.status === '处置中'" class="link" type="button" @click="openRecede(row)">
              确认退水
            </button>
          </td>
        </tr>
        <tr v-if="!queue.active.length">
          <td colspan="10" class="empty-state">当前没有待处置或处置中的内涝点，可在上方上报警情</td>
        </tr>
      </tbody>
    </table>

    <section class="done-panel">
      <button class="done-toggle" type="button" @click="showCompleted = !showCompleted">
        {{ showCompleted ? '▾' : '▸' }} 已完成 · 已退水（{{ queue.completed.length }}，按退水时间倒序）
      </button>
      <table v-if="showCompleted" class="data-table">
        <thead>
          <tr>
            <th>内涝编号</th>
            <th>内涝点位</th>
            <th>峰值深度</th>
            <th>处置队</th>
            <th>到场时间</th>
            <th>退水时间（现场记录）</th>
            <th>退水时间依据</th>
            <th>当前状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in queue.completed" :key="String(row.id)" class="done-row">
            <td>{{ row.内涝编号 }}</td>
            <td>{{ row.内涝点位 }}</td>
            <td>{{ row.积水深度 }} cm</td>
            <td>{{ row.处置队 }}</td>
            <td>{{ row.到场时间 }}</td>
            <td>{{ row.退水时间 }}</td>
            <td>
              {{ row.退水时间依据 || '现场记录' }}
              <span v-if="String(row.退水时间依据 ?? '').includes('覆盖')" class="field-tag">现场修正</span>
            </td>
            <td><span class="status-pill done-pill">{{ row.status }}</span></td>
          </tr>
          <tr v-if="!queue.completed.length">
            <td colspan="8" class="empty-state">暂无已退水办结的内涝点</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ queue.active.length + queue.completed.length }} 条内涝点记录（同编号已去重合并）</span>
      <span v-if="message" :class="messageOk ? 'success-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 确认退水：现场报回的退水时间优先，与系统记录不一致时以现场为准 -->
    <div v-if="recedeTarget" class="modal-mask" @click.self="closeRecede">
      <div class="modal-box">
        <h3 class="modal-title">确认退水 · {{ recedeTarget.内涝编号 }}</h3>
        <p class="modal-sub">{{ recedeTarget.内涝点位 }}｜{{ recedeTarget.处置队 }}</p>
        <label class="modal-field">
          <span>现场报回的退水时间 *</span>
          <input v-model="recedeTime" placeholder="YYYY-MM-DD HH:mm" />
        </label>
        <p v-if="systemRecedeTime" class="modal-note">
          系统原记录退水时间为 {{ systemRecedeTime }}，提交后以现场记录为准覆盖。
        </p>
        <p v-else class="modal-note">退水办结后，处置队伍将进入抢险队「待归队」清单。</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeRecede">取消</button>
          <button class="btn primary" type="button" @click="submitRecede">按现场时间确认退水</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  confirmWaterlogReceded,
  DEPTH_ALERT_CM,
  DEPTH_CRITICAL_CM,
  depthLevel,
  depthLevelLabel,
  dispatchWaterlog,
  downloadEntries,
  isAlertDepth,
  listWaterlogQueue,
  moduleMeta,
  parseDepthCm,
  recommendTeam,
  reportWaterlog,
  SCOPE_OPTIONS,
  waterlogStats,
  type WaterlogQueue,
  type WaterlogStats,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('waterlog')
const queue = ref<WaterlogQueue>({ active: [], completed: [] })
const stats = ref<WaterlogStats>({ pendingCount: 0, processingCount: 0, recededCount: 0, alertCount: 0 })
const keyword = ref('')
const message = ref('')
const messageOk = ref(false)
const showCompleted = ref(false)

const report = reactive({ code: '', site: '', depthCm: '' as number | '', scope: '路口' })

const recedeTarget = ref<EntryRow | null>(null)
const recedeTime = ref('')
const systemRecedeTime = computed(() => String(recedeTarget.value?.退水时间 ?? '').trim())

function depthOf(row: EntryRow): number {
  return parseDepthCm(row.积水深度)
}

function levelText(row: EntryRow): string {
  return row.status === '处置中' ? '处置中' : depthLevelLabel(depthOf(row))
}

function levelClass(row: EntryRow): string {
  if (row.status === '处置中') return 'badge-processing'
  const level = depthLevel(depthOf(row))
  return level === 'critical' ? 'badge-critical' : level === 'alert' ? 'badge-alert' : 'badge-normal'
}

function depthClass(row: EntryRow): string {
  return isAlertDepth(depthOf(row)) ? 'depth-alert' : ''
}

function suggestTeam(row: EntryRow): string {
  return recommendTeam(depthOf(row), String(row.影响范围 ?? ''))
}

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function reload() {
  queue.value = listWaterlogQueue(keyword.value)
  stats.value = waterlogStats()
}

function resetKeyword() {
  keyword.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function submitReport() {
  const result = reportWaterlog({
    code: report.code,
    site: report.site,
    depthCm: report.depthCm === '' ? Number.NaN : Number(report.depthCm),
    scope: report.scope,
  })
  notify(result.ok, result.message)
  if (result.ok) {
    report.code = ''
    report.site = ''
    report.depthCm = ''
    reload()
  }
}

function dispatch(row: EntryRow) {
  const result = dispatchWaterlog(Number(row.id))
  notify(result.ok, result.message)
  reload()
}

function nowForInput(): string {
  const d = new Date()
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function openRecede(row: EntryRow) {
  recedeTarget.value = row
  recedeTime.value = String(row.退水时间 ?? '').trim() || nowForInput()
  message.value = ''
}

function closeRecede() {
  recedeTarget.value = null
  recedeTime.value = ''
}

function submitRecede() {
  if (!recedeTarget.value) return
  const result = confirmWaterlogReceded(Number(recedeTarget.value.id), recedeTime.value)
  notify(result.ok, result.message)
  if (result.ok) {
    closeRecede()
    reload()
  }
}

onMounted(reload)
</script>
