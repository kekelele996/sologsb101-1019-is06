/**
 * 修复工序 store（Pinia setup store）
 * 维护工序顺序、拖拽重排落库重编号与完成态；完成即回写书叶状态。
 * 登记工序失败时只把本侧那一条落到 repairTaskOutbox 重试发件箱，
 * 重试仅回写 repairOrders，绝不触碰库房调阅单 / 预约记录（两侧故障隔离）。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { retryOutboxEntry } from '@/utils/circulation'
import { createEmptyOrderDraft, type OrderState, type RepairOrder, type RepairOrderDraft } from '@/types/repairOrder'
import { createOutboxEntry, type RepairTaskOutbox } from '@/types/repairTaskOutbox'
import { useLeafStore } from './leafStore'

export interface RegisterResult {
  ok: boolean
  /** 失败时是否已落到本侧重试发件箱 */
  queued: boolean
  message: string
}

export const useRepairStore = defineStore('repair', () => {
  const orders = ref<RepairOrder[]>([])
  const outbox = ref<RepairTaskOutbox[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')
  const sortMode = ref<'manual' | 'leaf'>(readUiPrefs().repairSort)
  /** 修复室侧模拟「登记工序失败」开关（演示本侧失败只重试本侧） */
  const simulateFailure = ref(false)

  const orderedOrders = computed<RepairOrder[]>(() =>
    [...orders.value].sort((a, b) =>
      a.leafId === b.leafId ? a.seq - b.seq : a.leafId.localeCompare(b.leafId)
    )
  )

  const totalSteps = computed<number>(() => orders.value.length)
  const doneSteps = computed<number>(() => orders.value.filter((order) => order.state === 'done').length)
  const donePercent = computed<number>(() =>
    orders.value.length === 0 ? 0 : Math.round((doneSteps.value / orders.value.length) * 100)
  )

  async function loadOrders(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.repairOrders.toArray()
      rows.sort((a, b) => (a.leafId === b.leafId ? a.seq - b.seq : a.leafId.localeCompare(b.leafId)))
      orders.value = rows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '工序读取失败'
    } finally {
      loading.value = false
    }
  }

  async function loadOutbox(): Promise<void> {
    const rows = await db.repairTaskOutbox.toArray()
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    outbox.value = rows
  }

  const pendingOutboxCount = computed<number>(() => outbox.value.filter((item) => item.status === 'pending').length)

  function setSimulateFailure(value: boolean): void {
    simulateFailure.value = value
  }

  /**
   * 修复室登记一道工序（本侧）。
   * 打开「模拟本侧登记失败」时不写 repairOrders，而是把这一条落到本侧重试发件箱；
   * 库房的调阅单 / 预约记录全程不参与、不被改动。
   */
  async function registerOrder(draft: RepairOrderDraft): Promise<RegisterResult> {
    if (simulateFailure.value) {
      const now = Date.now()
      const row: RepairTaskOutbox = {
        ...createOutboxEntry(
          draft.leafId,
          { ...draft, id: createId('order'), createdAt: now, updatedAt: now },
          '修复室本侧登记工序失败（模拟），已入本侧重试队列；库房调阅单不动'
        ),
        id: createId('outbox'),
        createdAt: now,
        updatedAt: now
      }
      await db.repairTaskOutbox.put(row)
      await loadOutbox()
      return { ok: false, queued: true, message: '本侧工序登记失败，已落到修复室本侧重试队列（库房调阅单未改动）' }
    }
    await createOrder(draft)
    return { ok: true, queued: false, message: '工序已登记' }
  }

  /** 只重试本侧那几条：逐条把发件箱快照回写到 repairOrders，不触碰库房表 */
  async function retryPendingOutbox(): Promise<{ done: number; failed: number }> {
    const pending = outbox.value.filter((item) => item.status === 'pending')
    let done = 0
    let failed = 0
    for (const entry of pending) {
      try {
        await retryOutboxEntry(entry)
        done += 1
      } catch {
        failed += 1
        await db.repairTaskOutbox.update(entry.id, {
          attempts: entry.attempts + 1,
          lastAttemptAt: Date.now(),
          lastError: '重试仍失败（本侧），保留在队列稍后再试',
          updatedAt: Date.now()
        } as never)
      }
    }
    await Promise.all([loadOutbox(), loadOrders()])
    return { done, failed }
  }

  async function abandonOutbox(id: string): Promise<void> {
    await db.repairTaskOutbox.update(id, { status: 'abandoned', updatedAt: Date.now() } as never)
    await loadOutbox()
  }

  function ordersOfLeaf(leafId: string): RepairOrder[] {
    return orders.value.filter((order) => order.leafId === leafId).sort((a, b) => a.seq - b.seq)
  }

  function nextSeq(leafId: string): number {
    const list = orders.value.filter((order) => order.leafId === leafId)
    return list.length === 0 ? 1 : Math.max(...list.map((order) => order.seq)) + 1
  }

  async function createOrder(draft: RepairOrderDraft): Promise<RepairOrder> {
    const now = Date.now()
    const row: RepairOrder = { ...draft, id: createId('order'), createdAt: now, updatedAt: now }
    await db.repairOrders.put(row)
    await loadOrders()
    return row
  }

  /** 按叶生成标准工序序列（补破 → 托裱 → 溜口 → 裁齐 → 压平） */
  async function generateSequence(leafId: string): Promise<number> {
    const existing = ordersOfLeaf(leafId)
    const names: RepairOrderDraft['name'][] = ['mend', 'mount', 'corner', 'trim', 'press']
    let created = 0
    for (let index = 0; index < names.length; index += 1) {
      const seq = index + 1
      if (existing.some((order) => order.seq === seq)) continue
      const draft = createEmptyOrderDraft(leafId, seq)
      await db.repairOrders.put({
        ...draft,
        name: names[index] as RepairOrderDraft['name'],
        material: '',
        id: createId('order'),
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      created += 1
    }
    await loadOrders()
    return created
  }

  async function updateOrder(id: string, patch: Partial<RepairOrder>): Promise<void> {
    await db.repairOrders.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadOrders()
  }

  async function removeOrder(id: string): Promise<void> {
    const target = orders.value.find((order) => order.id === id)
    await db.repairOrders.delete(id)
    if (target) {
      const rest = orders.value
        .filter((order) => order.leafId === target.leafId && order.id !== id)
        .sort((a, b) => a.seq - b.seq)
        .map((order, index) => ({ ...order, seq: index + 1, updatedAt: Date.now() }))
      if (rest.length > 0) await db.repairOrders.bulkPut(rest)
    }
    await loadOrders()
  }

  async function batchUpdate(ids: string[], patch: Partial<RepairOrder>): Promise<void> {
    if (ids.length === 0) return
    const now = Date.now()
    const rows = orders.value.filter((order) => ids.includes(order.id)).map((order) => ({ ...order, ...patch, updatedAt: now }))
    await db.repairOrders.bulkPut(rows)
    await loadOrders()
  }

  /** 拖拽重排：按新顺序落库并重编号 */
  async function reorderOrders(leafId: string, orderedIds: string[]): Promise<void> {
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]))
    const rows = orders.value
      .filter((order) => order.leafId === leafId)
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER
        return ai - bi
      })
      .map((order, index) => ({ ...order, seq: index + 1, updatedAt: Date.now() }))
    await db.repairOrders.bulkPut(rows)
    await loadOrders()
  }

  /** 推进工序状态；完成时回写书叶状态 */
  async function advanceOrder(id: string): Promise<OrderState> {
    const order = orders.value.find((item) => item.id === id)
    if (!order) return 'todo'
    const flow: OrderState[] = ['todo', 'doing', 'done']
    const index = flow.indexOf(order.state)
    const next = index < 0 || index >= flow.length - 1 ? order.state : (flow[index + 1] as OrderState)
    if (next === order.state) return order.state
    await updateOrder(id, { state: next })
    if (next === 'done') {
      const leafStore = useLeafStore()
      const leaf = leafStore.leafById(order.leafId)
      if (leaf) {
        const siblings = ordersOfLeaf(order.leafId)
        const allDone = siblings.every((item) => item.state === 'done' || item.id === id)
        if (allDone) await leafStore.updateLeaf(leaf.id, { state: 'repaired' })
        else if (leaf.state === 'pending') await leafStore.updateLeaf(leaf.id, { state: 'repairing' })
      }
    } else if (next === 'doing') {
      const leafStore = useLeafStore()
      const leaf = leafStore.leafById(order.leafId)
      if (leaf && leaf.state === 'pending') await leafStore.updateLeaf(leaf.id, { state: 'repairing' })
    }
    return next
  }

  function setSortMode(mode: 'manual' | 'leaf'): void {
    sortMode.value = mode
    writeUiPrefs({ ...readUiPrefs(), repairSort: mode })
  }

  return {
    orders,
    orderedOrders,
    outbox,
    loading,
    ready,
    error,
    sortMode,
    simulateFailure,
    totalSteps,
    doneSteps,
    donePercent,
    pendingOutboxCount,
    loadOrders,
    loadOutbox,
    registerOrder,
    retryPendingOutbox,
    abandonOutbox,
    setSimulateFailure,
    ordersOfLeaf,
    nextSeq,
    createOrder,
    generateSequence,
    updateOrder,
    removeOrder,
    batchUpdate,
    reorderOrders,
    advanceOrder,
    setSortMode
  }
})
