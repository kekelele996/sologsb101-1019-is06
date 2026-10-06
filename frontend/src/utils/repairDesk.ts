/**
 * 修复室登记工序：本侧操作记录（outbox）+ 故障注入 + 只重试本侧
 *
 * 边界约定（对应业务要求）：
 * - 登记工序只写修复室自己的表：repairOps / repairOrders / leaves。
 * - 无论登记成功还是失败，都不读写库房的 accessRequests / reservations。
 * - 失败后「重试本侧那几条」：按操作记录幂等重放，工序 id + 目标状态相同即跳过，
 *   不会产生重复工序，库房的调阅单始终不动。
 *
 * 故障注入：openFaultInjection() 打开后，下一次登记工序会在本侧写入中途失败，
 * 用于演示「修复室登记失败 → 只重试修复侧」。
 */
import { db, createId } from './db'
import type { RepairOrder, OrderState } from '@/types/repairOrder'
import type { LeafState } from '@/types/leaf'
import type { RepairOperation } from '@/types/repairOperation'

const FAULT_FLAG_KEY = 'gbbookrestore:fault-next-repair-register'

/** 打开故障注入：下一次登记工序在本侧写入中途失败 */
export function armFault(): void {
  try {
    localStorage.setItem(FAULT_FLAG_KEY, '1')
  } catch {
    /* ignore */
  }
}

export function disarmFault(): void {
  try {
    localStorage.removeItem(FAULT_FLAG_KEY)
  } catch {
    /* ignore */
  }
}

export function isFaultArmed(): boolean {
  try {
    return localStorage.getItem(FAULT_FLAG_KEY) === '1'
  } catch {
    return false
  }
}

function nextOrderState(state: OrderState): OrderState {
  const flow: OrderState[] = ['todo', 'doing', 'done']
  const index = flow.indexOf(state)
  if (index < 0 || index >= flow.length - 1) return state
  return flow[index + 1] as OrderState
}

/** 工序推进到 done 时书叶应回写的状态：全叶工序完成 → 已修复，否则修复中 */
function deriveLeafState(leafId: string, advancingOrderId: string, orders: RepairOrder[]): LeafState | null {
  const siblings = orders.filter((order) => order.leafId === leafId)
  if (siblings.length === 0) return null
  const allDone = siblings.every((order) => order.state === 'done' || order.id === advancingOrderId)
  return allDone ? 'repaired' : 'repairing'
}

export interface RegisterResult {
  op: RepairOperation
  /** 是否因为故障注入而登记失败（已落 failed 记录，等待本侧重试） */
  failed: boolean
  message: string
}

/**
 * 修复室登记一道工序（推进状态）。
 * 先在本侧事务内写操作记录 + 工序 + 书叶；故障注入开启时，
 * 在写完工序、回写书叶之前抛出，留下 failed 记录供本侧重试。
 */
export async function registerOrderAdvance(order: RepairOrder): Promise<RegisterResult> {
  const target = nextOrderState(order.state)
  if (target === order.state) {
    return { op: {} as RepairOperation, failed: false, message: '该工序已是末态，无需登记' }
  }
  const orders = await db.repairOrders.toArray()
  const targetLeafState = target === 'done' ? deriveLeafState(order.leafId, order.id, orders) : target === 'doing' ? 'repairing' : null

  const now = Date.now()
  const op: RepairOperation = {
    id: createId('rop'),
    kind: 'advance-order',
    orderId: order.id,
    leafId: order.leafId,
    targetOrderState: target,
    targetLeafState,
    state: 'pending',
    lastError: '',
    attempts: 0,
    createdAt: now,
    updatedAt: now
  }

  const faultArmed = isFaultArmed()
  try {
    await db.transaction('rw', [db.repairOps, db.repairOrders, db.leaves], async () => {
      await db.repairOps.put(op)
      await db.repairOrders.update(order.id, { state: target, updatedAt: Date.now() } as never)
      if (faultArmed) {
        // 模拟修复室本侧写入中途失败：书叶还没回写，操作记录已留痕
        throw new Error('故障注入：修复室登记工序时本侧写入中断')
      }
      if (targetLeafState) {
        await db.leaves.update(order.leafId, { state: targetLeafState, updatedAt: Date.now() } as never)
      }
      await db.repairOps.update(op.id, { state: 'done', updatedAt: Date.now() } as never)
    })
    return { op, failed: false, message: `工序已登记为「${target}」${targetLeafState ? '，并回写书叶状态' : ''}` }
  } catch (err) {
    disarmFault()
    const message = err instanceof Error ? err.message : '修复室登记工序失败'
    // 事务整体回滚：单独把本侧失败记录落库，作为「只重试本侧」的依据
    const failedOp: RepairOperation = {
      ...op,
      state: 'failed',
      lastError: message,
      attempts: 1,
      updatedAt: Date.now()
    }
    await db.repairOps.put(failedOp)
    return { op: failedOp, failed: true, message }
  }
}

/**
 * 只重试修复室本侧失败的那几条操作记录。
 * 事务仅含 repairOps / repairOrders / leaves，绝不包含库房任何表；
 * 以「工序当前状态是否已达目标」做幂等，重复重放安全。
 */
export async function retryFailedOps(ids?: string[]): Promise<{ retried: number; succeeded: number; stillFailed: number }> {
  const failed = await db.repairOps.where('state').equals('failed').toArray()
  const targets = ids ? failed.filter((op) => ids.includes(op.id)) : failed
  let succeeded = 0
  let stillFailed = 0

  for (const op of targets) {
    try {
      await db.transaction('rw', [db.repairOps, db.repairOrders, db.leaves], async () => {
        const order = await db.repairOrders.get(op.orderId)
        if (!order) throw new Error('工序已不存在，无法补登记')
        // 幂等：工序若已达目标状态，只补齐书叶回写与记录状态
        if (order.state !== op.targetOrderState) {
          await db.repairOrders.update(order.id, { state: op.targetOrderState, updatedAt: Date.now() } as never)
        }
        if (op.targetLeafState) {
          const leaf = await db.leaves.get(op.leafId)
          if (leaf && leaf.state !== op.targetLeafState) {
            await db.leaves.update(leaf.id, { state: op.targetLeafState, updatedAt: Date.now() } as never)
          }
        }
        await db.repairOps.put({ ...op, state: 'done', lastError: '', attempts: op.attempts + 1, updatedAt: Date.now() })
      })
      succeeded += 1
    } catch (err) {
      stillFailed += 1
      const message = err instanceof Error ? err.message : '重试仍失败'
      await db.repairOps.put({ ...op, lastError: message, attempts: op.attempts + 1, updatedAt: Date.now() })
    }
  }
  return { retried: targets.length, succeeded, stillFailed }
}

/** 查询当前失败待重试的本侧记录数 */
export async function countFailedOps(): Promise<number> {
  return db.repairOps.where('state').equals('failed').count()
}
