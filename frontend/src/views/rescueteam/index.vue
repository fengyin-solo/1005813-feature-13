<template>
  <section class="page" data-module="rescueteam">
    <header class="page-head">
      <div>
        <h2>抢险队调度</h2>
        <p class="page-desc">
          抢险任务按 待派队 → 抢险中 → 待归队 → 已归队 单向推进。内涝点确认退水后，
          处置队伍自动落到「待归队清单」，现场归队后在此办结。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出抢险队调度清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待派队</span>
        <strong class="stat-value">{{ stats.dispatchingCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">抢险中</span>
        <strong class="stat-value processing">{{ stats.workingCount }}</strong>
      </article>
      <article class="stat-card stat-return">
        <span class="stat-label">待归队（退水办结）</span>
        <strong class="stat-value">{{ stats.pendingReturnCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已归队</span>
        <strong class="stat-value done">{{ stats.returnedCount }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item filter-wide">
        <span>队列检索</span>
        <input v-model="keyword" placeholder="按任务编号 / 点位 / 抢险队 / 内涝编号检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetKeyword">重置条件</button>
    </form>

    <h3 class="queue-title return-title">待归队清单（{{ queue.pendingReturn.length }}）</h3>
    <table class="data-table return-table">
      <thead>
        <tr>
          <th>任务编号</th>
          <th>任务类型</th>
          <th>目标点位</th>
          <th>抢险队</th>
          <th>关联内涝编号</th>
          <th>出队时间</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in queue.pendingReturn" :key="String(row.id)" class="return-row">
          <td>{{ row.任务编号 }}</td>
          <td>{{ row.任务类型 }}</td>
          <td>{{ row.目标点位 }}</td>
          <td>{{ row.抢险队 }}</td>
          <td>{{ row.关联内涝编号 || '—' }}</td>
          <td>{{ row.出队时间 || '—' }}</td>
          <td><span class="status-pill return-pill">{{ row.status }}</span></td>
          <td class="row-actions">
            <button class="link" type="button" @click="runAction('确认归队', row)">确认归队</button>
          </td>
        </tr>
        <tr v-if="!queue.pendingReturn.length">
          <td colspan="8" class="empty-state">暂无待归队队伍，退水办结的处置队会自动进入本清单</td>
        </tr>
      </tbody>
    </table>

    <h3 class="queue-title">出动中任务（{{ queue.active.length }}）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>任务编号</th>
          <th>任务类型</th>
          <th>目标点位</th>
          <th>抢险队</th>
          <th>关联内涝编号</th>
          <th>出队时间</th>
          <th>负责人</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in queue.active" :key="String(row.id)">
          <td>{{ row.任务编号 }}</td>
          <td>{{ row.任务类型 }}</td>
          <td>{{ row.目标点位 }}</td>
          <td>{{ row.抢险队 }}</td>
          <td>{{ row.关联内涝编号 || '—' }}</td>
          <td>{{ row.出队时间 || '—' }}</td>
          <td>{{ row.负责人 || '—' }}</td>
          <td><span class="status-pill">{{ row.status }}</span></td>
          <td class="row-actions">
            <button v-if="row.status === '待派队'" class="link" type="button" @click="runAction('派出抢险', row)">
              派出抢险
            </button>
            <template v-if="row.status === '抢险中'">
              <button class="link" type="button" @click="runAction('确认待归', row)">确认待归</button>
              <button class="link danger-link" type="button" @click="runAction('终止任务', row)">终止任务</button>
            </template>
          </td>
        </tr>
        <tr v-if="!queue.active.length">
          <td colspan="9" class="empty-state">暂无待派队或抢险中的任务</td>
        </tr>
      </tbody>
    </table>

    <section class="done-panel">
      <button class="done-toggle" type="button" @click="showCompleted = !showCompleted">
        {{ showCompleted ? '▾' : '▸' }} 已办结（{{ queue.completed.length }}）
      </button>
      <table v-if="showCompleted" class="data-table">
        <thead>
          <tr>
            <th>任务编号</th>
            <th>任务类型</th>
            <th>目标点位</th>
            <th>抢险队</th>
            <th>出队时间</th>
            <th>归队时间</th>
            <th>当前状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in queue.completed" :key="String(row.id)" class="done-row">
            <td>{{ row.任务编号 }}</td>
            <td>{{ row.任务类型 }}</td>
            <td>{{ row.目标点位 }}</td>
            <td>{{ row.抢险队 }}</td>
            <td>{{ row.出队时间 || '—' }}</td>
            <td>{{ row.归队时间 || '—' }}</td>
            <td><span class="status-pill done-pill">{{ row.status }}</span></td>
          </tr>
          <tr v-if="!queue.completed.length">
            <td colspan="7" class="empty-state">暂无已办结任务</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ queue.pendingReturn.length + queue.active.length + queue.completed.length }} 条抢险任务</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import {
  downloadEntries,
  listRescueQueue,
  moduleMeta,
  rescueStats,
  runRescueAction,
  type RescueQueue,
  type RescueStats,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('rescueteam')
const queue = ref<RescueQueue>({ pendingReturn: [], active: [], completed: [] })
const stats = ref<RescueStats>({ dispatchingCount: 0, workingCount: 0, pendingReturnCount: 0, returnedCount: 0 })
const keyword = ref('')
const errorMessage = ref('')
const successMessage = ref('')
const showCompleted = ref(false)

function reload() {
  queue.value = listRescueQueue(keyword.value)
  stats.value = rescueStats()
}

function resetKeyword() {
  keyword.value = ''
  successMessage.value = ''
  errorMessage.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  const result = runRescueAction(Number(row.id), action)
  successMessage.value = result.ok ? result.message : ''
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

onMounted(reload)
</script>
