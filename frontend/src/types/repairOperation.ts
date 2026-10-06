/**
 * 修复室侧操作记录（RepairOperation）——本侧重试队列表
 *
 * 修复室「登记工序」可能在写完工序后失败（如本地写冲突 / 模拟故障）。
 * 每次登记都先落一条本侧操作记录：只包含修复室自己要写的内容
 * （工序推进、书叶状态回写），与库房的调阅单 / 预约完全不相关。
 * 失败后只重试这几条本侧记录，库房调阅单一动不动。
 *
 * 重试以工序 id + 目标状态做幂等键：重复执行不会产生重复工序。
 */

/** 操作类型：推进单道工序状态（含完成时回写书叶状态） */
export type RepairOpKind = 'advance-order'

/** 本侧操作状态 */
// pending 待处理（登记已记录，尚未成功落库）
// done    已成功完成
// failed  登记失败，等待「只重试本侧」
export type RepairOpState = 'pending' | 'done' | 'failed'

export interface RepairOperation {
  id: string
  kind: RepairOpKind
  /** 目标工序 id（幂等键的一部分） */
  orderId: string
  /** 关联书叶 id（完成时回写用） */
  leafId: string
  /** 期望推进到的工序状态 */
  targetOrderState: 'todo' | 'doing' | 'done'
  /** 工序完成时书叶应回写的状态；无需回写为 null */
  targetLeafState: 'pending' | 'repairing' | 'repaired' | null
  state: RepairOpState
  /** 最近一次失败的错误信息 */
  lastError: string
  /** 已尝试次数（重试不新增记录，只累加） */
  attempts: number
  createdAt: number
  updatedAt: number
}

export const REPAIR_OP_STATE_LABEL: Record<RepairOpState, string> = {
  pending: '待处理',
  done: '已完成',
  failed: '失败待重试'
}

export const REPAIR_OP_STATE_COLOR: Record<RepairOpState, string> = {
  pending: '#3a6ea5',
  done: '#1e8449',
  failed: '#c0392b'
}
