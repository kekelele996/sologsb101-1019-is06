/**
 * 库房侧数据模型：预约记录（Reservation）与调阅单（AccessRequest）
 *
 * 现状是库房这边记调阅单和预约记录、修复室记在修册次和工序，
 * 两边各记各的、靠册次号人工对账，经常两边都当册子在对方手上。
 * 引入在修占用后：库房放行一册前先查修复室是否在修占用——
 * 占用未解除则把调阅单挂起（held），预约记录照留，修完解除占用再放行。
 */

/** 调阅单状态 */
// reviewing 库房待审核放行
// held      命中在修占用，挂起等修完（预约照留，不动修复室任何数据）
// ready     占用已解除，可放行（自动从 held 转入，等待库房放行）
// lent      已放行到阅览
// returned  已归还入库
// cancelled 撤销
export type AccessState = 'reviewing' | 'held' | 'ready' | 'lent' | 'returned' | 'cancelled'

export interface AccessRequest {
  id: string
  /** 调阅单号（库房台账编号，人工可读） */
  requestNo: string
  /** 关联册次 id（对账主键，取代口头打招呼） */
  volumeId: string
  /** 预约记录 id，挂起期间预约照留 */
  reservationId: string | null
  /** 调阅人 */
  reader: string
  /** 阅览用途 / 备注 */
  purpose: string
  state: AccessState
  /** 命中挂起时记录的占用 id，便于修完后精准解锁 */
  blockedByOccupancyId: string | null
  /** 挂起原因快照（修复负责人等） */
  heldReason: string
  /** 预约/申请日期 yyyy-MM-dd */
  requestDate: string
  /** 放行日期 */
  lentAt: number | null
  createdAt: number
  updatedAt: number
}

export type AccessRequestDraft = Omit<AccessRequest, 'id' | 'createdAt' | 'updatedAt'>

export const ACCESS_STATE_LABEL: Record<AccessState, string> = {
  reviewing: '待审核',
  held: '占用挂起',
  ready: '待放行',
  lent: '已调阅',
  returned: '已归还',
  cancelled: '已撤销'
}

export const ACCESS_STATE_COLOR: Record<AccessState, string> = {
  reviewing: '#3a6ea5',
  held: '#d68910',
  ready: '#8e44ad',
  lent: '#1e8449',
  returned: '#8c8c8c',
  cancelled: '#a0a0a0'
}

/** 库房可执行「放行」动作的状态 */
export function canLend(state: AccessState): boolean {
  return state === 'reviewing' || state === 'ready'
}

/** 占用解除后需要重新尝试放行的挂起单 */
export function isAwaitingRepair(state: AccessState): boolean {
  return state === 'held'
}

export function createEmptyAccessDraft(volumeId: string, reservationId: string | null): AccessRequestDraft {
  return {
    requestNo: '',
    volumeId,
    reservationId,
    reader: '',
    purpose: '',
    state: 'reviewing',
    blockedByOccupancyId: null,
    heldReason: '',
    requestDate: new Date().toISOString().slice(0, 10),
    lentAt: null
  }
}
