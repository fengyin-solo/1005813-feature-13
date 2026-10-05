<template>
  <section class="page" data-module="waterlog">
    <header class="page-head">
      <div>
        <h2>内涝点处置队列</h2>
        <p class="page-desc">
          暴雨期间多点积水统一排队：待处置 → 处置中 → 已退水单向推进，不许跳级；
          处置中的排最前，达警戒的先派，已退水收进已完成。同一内涝编号重复上报只留一条。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出内涝点处置清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="submitReport">
      <label class="filter-item">
        <span>内涝编号</span>
        <input v-model="draft.内涝编号" placeholder="如 WATE-0005" />
      </label>
      <label class="filter-item">
        <span>内涝点位</span>
        <input v-model="draft.内涝点位" placeholder="积水点位置" />
      </label>
      <label class="filter-item">
        <span>积水深度(cm)</span>
        <input v-model="draft.积水深度" type="number" min="0" :placeholder="`≥${warningDepth} 达警戒`" />
      </label>
      <label class="filter-item">
        <span>影响范围</span>
        <input v-model="draft.影响范围" placeholder="如 主干道双向车道" />
      </label>
      <label class="filter-item">
        <span>现场退水时间</span>
        <input v-model="draft.现场退水时间" placeholder="可选，与系统对不上以现场为准" />
      </label>
      <button class="btn primary" type="submit">上报/登记</button>
    </form>

    <h3 class="section-title">处置队列（在办 {{ activeRows.length }} 条，处置中排最前）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>队列序号</th>
          <th>内涝编号</th>
          <th>内涝点位</th>
          <th>积水深度(cm)</th>
          <th>影响范围</th>
          <th>处置队</th>
          <th>到场时间</th>
          <th>上报次数</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in activeRows" :key="String(row.id)" :class="{ 'row-warning': isWarning(row) }">
          <td>{{ index + 1 }}</td>
          <td>{{ row.内涝编号 }}</td>
          <td>{{ row.内涝点位 }}</td>
          <td>
            {{ row.积水深度 }}
            <span v-if="isWarning(row)" class="badge-warning">达警戒</span>
          </td>
          <td>{{ row.影响范围 }}</td>
          <td>{{ row.处置队 || '—' }}</td>
          <td>{{ row.到场时间 || '—' }}</td>
          <td>{{ row.上报次数 ?? 1 }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button v-if="row.status === '待处置'" class="link" type="button" @click="dispatch(row)">
              派出处置
            </button>
            <button v-else-if="row.status === '处置中'" class="link" type="button" @click="openRecede(row)">
              确认退水
            </button>
          </td>
        </tr>
        <tr v-if="!activeRows.length">
          <td colspan="10" class="empty-state">当前没有在办的内涝点，可在上方上报登记</td>
        </tr>
      </tbody>
    </table>

    <form v-if="receding" class="filter-bar recede-bar" @submit.prevent="confirmRecede">
      <span>确认退水：{{ receding.内涝编号 }}（{{ receding.内涝点位 }}）</span>
      <label class="filter-item">
        <span>现场退水时间</span>
        <input v-model="recedeTime" placeholder="留空取系统当前时间；对不上以现场为准" />
      </label>
      <button class="btn primary" type="submit">办结退水</button>
      <button class="btn ghost" type="button" @click="receding = null">取消</button>
    </form>

    <h3 class="section-title">已完成（已退水 {{ doneRows.length }} 条，办结后封存不可退回）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>内涝编号</th>
          <th>内涝点位</th>
          <th>处置队</th>
          <th>到场时间</th>
          <th>退水时间</th>
          <th>当前状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in doneRows" :key="String(row.id)">
          <td>{{ row.内涝编号 }}</td>
          <td>{{ row.内涝点位 }}</td>
          <td>{{ row.处置队 || '—' }}</td>
          <td>{{ row.到场时间 || '—' }}</td>
          <td>{{ row.退水时间 || '—' }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!doneRows.length">
          <td colspan="6" class="empty-state">还没有已退水的内涝点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条内涝点记录（同一编号重复上报只留一条）</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  advanceWaterlog,
  isWarningDepth,
  reportWaterlog,
  WARNING_DEPTH_CM,
  waterlogQueue,
} from '@/api/waterlog-service'
import type { EntryRow } from '@/data/types'

const warningDepth = WARNING_DEPTH_CM

const activeRows = ref<EntryRow[]>([])
const doneRows = ref<EntryRow[]>([])
const message = ref('')
const messageOk = ref(true)
const receding = ref<EntryRow | null>(null)
const recedeTime = ref('')
const draft = ref({ 内涝编号: '', 内涝点位: '', 积水深度: '', 影响范围: '', 现场退水时间: '' })

function isWarning(row: EntryRow): boolean {
  return isWarningDepth(Number(row.积水深度) || 0)
}

const stats = computed(() => [
  { label: '待处置内涝点', value: activeRows.value.filter((row) => row.status === '待处置').length },
  { label: '处置中内涝点', value: activeRows.value.filter((row) => row.status === '处置中').length },
  {
    label: '达警戒待派',
    value: activeRows.value.filter((row) => row.status === '待处置' && isWarning(row)).length,
  },
  { label: '已退水', value: doneRows.value.length },
])

const total = computed(() => activeRows.value.length + doneRows.value.length)

function exportRows() {
  downloadEntries('waterlog')
}

function submitReport() {
  const result = reportWaterlog({
    内涝编号: draft.value.内涝编号,
    内涝点位: draft.value.内涝点位,
    积水深度: Number(draft.value.积水深度),
    影响范围: draft.value.影响范围,
    现场退水时间: draft.value.现场退水时间,
  })
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    draft.value = { 内涝编号: '', 内涝点位: '', 积水深度: '', 影响范围: '', 现场退水时间: '' }
    reload()
  }
}

function dispatch(row: EntryRow) {
  const result = advanceWaterlog(Number(row.id))
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    reload()
  }
}

function openRecede(row: EntryRow) {
  receding.value = row
  recedeTime.value = String(row.现场退水时间 ?? '')
}

function confirmRecede() {
  if (!receding.value) {
    return
  }
  const result = advanceWaterlog(Number(receding.value.id), recedeTime.value)
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    receding.value = null
    recedeTime.value = ''
    reload()
  }
}

function reload() {
  message.value = ''
  try {
    const queue = waterlogQueue()
    activeRows.value = queue.active
    doneRows.value = queue.done
  } catch (error) {
    messageOk.value = false
    message.value = error instanceof Error ? error.message : '内涝点处置队列读取失败'
  }
}

onMounted(reload)
</script>
