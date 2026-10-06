/**
 * 预约记录（Reservation）数据模型
 * 读者预约某一册次；据预约开调阅单。调阅单因在修占用挂起时，
 * 预约记录照留不删，修完放行后回写预约状态。
 */

/** 预约状态 */
// active   预约有效（含调阅单挂起等待期间）
// fulfilled 已据预约调阅
// closed   预约关闭（撤销 / 过期）
export type ReservationState = 'active' | 'fulfilled' | 'closed'

export interface Reservation {
  id: string
  /** 预约登记号 */
  reserveNo: string
  volumeId: string
  reader: string
  /** 预约到馆日期 yyyy-MM-dd */
  reserveDate: string
  state: ReservationState
  /** 关联已开的调阅单 id */
  requestId: string | null
  note: string
  createdAt: number
  updatedAt: number
}

export type ReservationDraft = Omit<Reservation, 'id' | 'createdAt' | 'updatedAt'>

export const RESERVATION_STATE_LABEL: Record<ReservationState, string> = {
  active: '预约中',
  fulfilled: '已调阅',
  closed: '已关闭'
}

export const RESERVATION_STATE_COLOR: Record<ReservationState, string> = {
  active: '#3a6ea5',
  fulfilled: '#1e8449',
  closed: '#8c8c8c'
}

export function createEmptyReservationDraft(volumeId: string): ReservationDraft {
  return {
    reserveNo: '',
    volumeId,
    reader: '',
    reserveDate: new Date().toISOString().slice(0, 10),
    state: 'active',
    requestId: null,
    note: ''
  }
}
