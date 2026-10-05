// 领域规则验证脚本：localStorage 打桩后直接跑 local-service 的内涝/抢险联动。
// 用完即删，不属于交付代码。
const esbuild = require('esbuild')
const path = require('path')
const assert = require('assert')

const store = {}
globalThis.window = {
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
  },
}

async function main() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        export * from './src/api/local-service'
        export { listRows, saveRows } from './src/data/local-store'
      `,
      resolveDir: path.join(__dirname, '..'),
      sourcefile: 'verify-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
  })
  const code = result.outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require)
  const svc = mod.exports

  const stamp = () => svc.nowStamp()
  console.log('now =', stamp())

  // 1. 初始队列：处置中在前；待处置中警戒深度(42)排在一般深度(22/18)前
  let q = svc.listWaterlogQueue()
  const activeCodes = q.active.map((r) => r.内涝编号)
  assert.deepStrictEqual(activeCodes, ['WLOG-0001', 'WLOG-0002', 'WLOG-0003', 'WLOG-0005', 'WLOG-0004'], activeCodes)
  assert.strictEqual(q.completed.length, 1)
  console.log('1) 队列排序 OK:', activeCodes.join(' > '))

  // 2. 派队规则
  assert.strictEqual(svc.recommendTeam(62, '下穿隧道'), '重型抢险一队')
  assert.strictEqual(svc.recommendTeam(55, '居民小区'), '重型抢险二队')
  assert.strictEqual(svc.recommendTeam(42, '学校'), '应急突击队')
  assert.strictEqual(svc.recommendTeam(35, '路口'), '交通保障抢险队')
  assert.strictEqual(svc.recommendTeam(18, '居民小区'), '社区排水抢险队')
  assert.strictEqual(svc.recommendTeam(12, '背街小巷'), '社区排水抢险队')
  assert.strictEqual(svc.recommendTeam(12, '未知片区'), '街道应急小分队')
  console.log('2) 深度+范围派队 OK')

  // 3. 已退水不可退回、不可改数
  const done = svc.listWaterlogQueue().completed[0]
  let r = svc.dispatchWaterlog(Number(done.id))
  assert.strictEqual(r.ok, false)
  r = svc.confirmWaterlogReceded(Number(done.id), '2026-10-05 10:00')
  assert.strictEqual(r.ok, false)
  console.log('3) 已退水锁定 OK:', r.message)

  // 4. 待处置不许跳级直接退水
  const w4 = svc.listRows('waterlog').find((x) => x.内涝编号 === 'WLOG-0004')
  r = svc.confirmWaterlogReceded(Number(w4.id), '2026-10-05 10:00')
  assert.strictEqual(r.ok, false)
  console.log('4) 禁止跳级 OK:', r.message)

  // 5. 重复上报合并（处置中的点）
  const before = svc.listRows('waterlog').filter((x) => x.内涝编号 === 'WLOG-0001').length
  assert.strictEqual(before, 1)
  r = svc.reportWaterlog({ code: 'WLOG-0001', site: '被忽略的点位名', depthCm: 70, scope: '下穿隧道' })
  assert.strictEqual(r.ok, true)
  const after = svc.listRows('waterlog').filter((x) => x.内涝编号 === 'WLOG-0001')
  assert.strictEqual(after.length, 1, '同编号只能有一条')
  assert.strictEqual(after[0].积水深度, 70)
  assert.strictEqual(after[0].上报次数, 3) // 种子里已是 2 次上报
  assert.strictEqual(after[0].内涝点位, '滨江大道下穿隧道', '点位以首报为准')
  assert.strictEqual(after[0].status, '处置中', '合并不改状态')
  console.log('5) 重复上报合并 OK:', r.message)

  // 6. 对已退水点重复上报：不复活、不退回
  r = svc.reportWaterlog({ code: 'WLOG-0006', site: '站前广场', depthCm: 40, scope: '交通主干道' })
  assert.strictEqual(r.ok, true)
  const w6 = svc.listRows('waterlog').find((x) => x.内涝编号 === 'WLOG-0006')
  assert.strictEqual(w6.status, '已退水')
  assert.strictEqual(w6.上报次数, 2)
  assert.strictEqual(w6.积水深度, 40)
  console.log('6) 已退水点重报不复活 OK')

  // 7. 新上报自动生成编号并入待处置队列
  const n0 = svc.listRows('waterlog').length
  r = svc.reportWaterlog({ site: '新建测试点', depthCm: 33, scope: '商圈' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(svc.listRows('waterlog').length, n0 + 1)
  const nw = svc.listRows('waterlog').find((x) => x.内涝点位 === '新建测试点')
  assert.strictEqual(nw.内涝编号, 'WLOG-0007')
  assert.strictEqual(nw.status, '待处置')
  assert.strictEqual(nw.处置队, '')
  console.log('7) 新点自动编号/入队 OK:', nw.内涝编号)

  // 8. 派出处置：定队伍、状态推进、联动抢险队建单
  r = svc.dispatchWaterlog(Number(nw.id))
  assert.strictEqual(r.ok, true)
  const nw2 = svc.listRows('waterlog').find((x) => x.id === nw.id)
  assert.strictEqual(nw2.status, '处置中')
  assert.strictEqual(nw2.处置队, '应急突击队')
  assert.ok(String(nw2.到场时间).length > 0)
  let linked = svc.listRows('rescueteam').find((x) => x.目标点位 === '新建测试点')
  assert.ok(linked, '应自动建抢险任务')
  assert.strictEqual(linked.status, '抢险中')
  console.log('8) 派出联动建抢险中任务 OK:', r.message)

  // 9. 警戒深度先派：待处置队列里 WLOG-0003(42) 始终排在最前
  q = svc.listWaterlogQueue()
  assert.strictEqual(q.active.find((x) => x.status === '待处置').内涝编号, 'WLOG-0003')
  console.log('9) 警戒深度置顶 OK')

  // 10. 确认退水，现场时间与系统不一致 -> 以现场为准 + 待归队
  r = svc.confirmWaterlogReceded(Number(nw2.id), '2026-10-05 11:20')
  assert.strictEqual(r.ok, true)
  const nw3 = svc.listRows('waterlog').find((x) => x.id === nw.id)
  assert.strictEqual(nw3.status, '已退水')
  assert.strictEqual(nw3.退水时间, '2026-10-05 11:20')
  assert.strictEqual(nw3.退水时间依据, '现场记录')
  linked = svc.listRows('rescueteam').find((x) => x.目标点位 === '新建测试点')
  assert.strictEqual(linked.status, '待归队', '退水办结落到待归队清单')
  console.log('10) 退水办结->待归队 OK')

  // 11. 现场修正：先给处置中点写一个系统退水时间，再用现场值覆盖
  const w3 = svc.listRows('waterlog').find((x) => x.内涝编号 === 'WLOG-0003')
  assert.strictEqual(svc.dispatchWaterlog(Number(w3.id)).ok, true)
  // 模拟系统已先记录一个值
  const rows = svc.listRows('waterlog')
  const i3 = rows.findIndex((x) => x.id === w3.id)
  rows[i3] = { ...rows[i3], 退水时间: '2026-10-05 12:00' }
  svc.saveRows('waterlog', rows)
  r = svc.confirmWaterlogReceded(Number(w3.id), '2026-10-05 11:30')
  assert.strictEqual(r.ok, true)
  const w3b = svc.listRows('waterlog').find((x) => x.id === w3.id)
  assert.strictEqual(w3b.退水时间, '2026-10-05 11:30')
  assert.ok(w3b.退水时间依据.includes('覆盖系统值 2026-10-05 12:00'))
  console.log('11) 现场时间覆盖系统值 OK:', r.message)

  // 12. 待归队 -> 确认归队 -> 已归队；不能跳过
  const rq = svc.listRescueQueue()
  assert.ok(rq.pendingReturn.some((x) => x.目标点位 === '新建测试点'))
  r = svc.runRescueAction(Number(linked.id), '确认待归') // 已待归队，不允许
  assert.strictEqual(r.ok, false)
  r = svc.runRescueAction(Number(linked.id), '确认归队')
  assert.strictEqual(r.ok, true)
  const linkedDone = svc.listRows('rescueteam').find((x) => x.id === linked.id)
  assert.strictEqual(linkedDone.status, '已归队')
  assert.ok(String(linkedDone.归队时间).length > 0)
  console.log('12) 待归队->已归队 OK')

  // 13. 抢险中任务不能直接确认归队（不许跳级）
  const r1 = svc.listRows('rescueteam').find((x) => x.任务编号 === 'RESC-0001')
  r = svc.runRescueAction(Number(r1.id), '确认归队')
  assert.strictEqual(r.ok, false)
  console.log('13) 抢险中禁止直接归队 OK:', r.message)

  // 14. 通用 runAction 对两个模块已被封死
  assert.strictEqual(svc.runAction('waterlog', Number(w4.id), '确认退水').ok, false)
  assert.strictEqual(svc.runAction('rescueteam', Number(r1.id), '派出抢险').ok, false)
  console.log('14) 通用动作入口封堵 OK')

  // 15. 统计
  const ws = svc.waterlogStats()
  const rs = svc.rescueStats()
  console.log('15) 统计 OK: 内涝', JSON.stringify(ws), '抢险', JSON.stringify(rs))
  assert.ok(ws.alertCount >= 0 && ws.pendingCount + ws.processingCount + ws.recededCount === svc.listRows('waterlog').length)

  console.log('\n全部规则验证通过 ✔')
}

main().catch((e) => { console.error(e); process.exit(1) })
