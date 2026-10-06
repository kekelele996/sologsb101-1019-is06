/**
 * 库房—修复室占用协同的核心判定与本侧重试逻辑。
 * - 库房放行一册前先看修复室有没有在修占用；占用未解除（含待认领）先挂起调阅单，预约记录照留。
 * - 修复室登记工序失败后只重试本侧那几条：重试仅回写 repairOrders，绝不触碰调阅单 / 预约。
 */
import { db } from '@/utils/db'
import type { Occupation } from '@/types/occupation'
import { isOccupationBlocking, OCCUPATION_STATUS_LABEL } from '@/types/occupation'
import type { AccessRequest } from '@/types/accessRequest'
import type { RepairOrder } from '@/types/repairOrder'
import type { RepairTaskOutbox } from '@/types/repairTaskOutbox'

/** 找出会阻塞某册放行的占用：同册次号且状态为在修 / 待认领 */
export function blockingOccupations(occupations: Occupation[], volumeNo: number): Occupation[] {
  return occupations.filter((item) => item.volumeNo === volumeNo && isOccupationBlocking(item.status))
}

export interface ReleaseDecision {
  /** 是否可以放行 */
  allowed: boolean
  /** 不可放行时的原因（可放行为空串） */
  reason: string
  /** 命中的占用记录（在修 / 待认领） */
  blockers: Occupation[]
}

/**
 * 库房放行判定：按册次号对账修复室占用。
 * - 有在修占用 → 挂起；有历史待认领 → 同样不得放行（先等人认领）。
 */
export function evaluateRelease(occupations: Occupation[], volumeNo: number): ReleaseDecision {
  const blockers = blockingOccupations(occupations, volumeNo)
  if (blockers.length === 0) return { allowed: true, reason: '', blockers: [] }
  const labels = blockers.map((item) => OCCUPATION_STATUS_LABEL[item.status])
  const unclaimed = blockers.some((item) => item.status === 'unclaimed')
  const reason = unclaimed
    ? `第 ${volumeNo} 册存在「待认领」历史占用，需先由修复室认领核实，暂不能放行`
    : `第 ${volumeNo} 册修复室在修占用中（${labels.join('、')}），占用未解除，调阅单先挂起，预约记录照留`
  return { allowed: false, reason, blockers }
}

/**
 * 尝试放行一册调阅单（纯判定，返回应落库的状态补丁，由 store 落库）。
 * 放行通过 → released；占用未解除 → held 并写挂起原因。
 */
export function decideRequestPatch(
  request: AccessRequest,
  occupations: Occupation[]
): Pick<AccessRequest, 'status' | 'holdReason' | 'releaseDate'> {
  const decision = evaluateRelease(occupations, request.volumeNo)
  const today = new Date().toISOString().slice(0, 10)
  if (decision.allowed) {
    return { status: 'released', holdReason: '', releaseDate: today }
  }
  return { status: 'held', holdReason: decision.reason, releaseDate: '' }
}

/**
 * 重试修复室本侧失败登记：只把发件箱里的工序快照回写到 repairOrders，
 * 全程不读不写库房的 accessRequests / reservations 表（本侧重试隔离）。
 */
export async function retryOutboxEntry(entry: RepairTaskOutbox): Promise<void> {
  // 事务只涉及修复室本侧表：repairOrders + repairTaskOutbox
  await db.transaction('rw', [db.repairOrders, db.repairTaskOutbox], async () => {
    const order = { ...(entry.payload as Partial<RepairOrder>) } as RepairOrder
    const now = Date.now()
    if (!order.id) order.id = `order_retry_${entry.id}`
    order.createdAt = typeof order.createdAt === 'number' ? order.createdAt : entry.createdAt
    order.updatedAt = now
    await db.repairOrders.put(order)
    await db.repairTaskOutbox.update(entry.id, {
      status: 'done',
      attempts: entry.attempts + 1,
      lastAttemptAt: now,
      lastError: '',
      updatedAt: now
    } as never)
  })
}
