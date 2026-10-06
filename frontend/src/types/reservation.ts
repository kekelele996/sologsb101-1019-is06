/**
 * 预约记录（Reservation）数据模型
 * 库房侧的阅览预约登记。即使调阅单因修复占用被挂起，预约记录也照留，
 * 修完解除占用后据此放行；预约记录不随调阅单的挂起 / 取消而删除。
 */

/** 预约状态：已预约 / 已转调阅 / 已到馆 / 已爽约（记录始终保留） */
export type ReservationStatus = 'reserved' | 'converted' | 'arrived' | 'missed';

export interface Reservation {
  id: string;
  /** 预约单号（库房业务编号） */
  reservationNo: string;
  /** 对账主键：册次号 */
  volumeNo: number;
  /** 能解析到本库册次时回填 */
  volumeId: string | null;
  /** 书名（冗余） */
  bookTitle: string;
  /** 预约阅览人 */
  reader: string;
  /** 预约到馆日期 yyyy-MM-dd */
  reserveDate: string;
  /** 当前状态 */
  status: ReservationStatus;
  /** 关联调阅单 id（由预约转调阅后回填，可空） */
  requestId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ReservationDraft = Omit<Reservation, 'id' | 'createdAt' | 'updatedAt'>;

export const RESERVATION_STATUS_LABEL: Record<ReservationStatus, string> = {
  reserved: '已预约',
  converted: '已转调阅',
  arrived: '已到馆',
  missed: '已爽约'
};

export const RESERVATION_STATUS_COLOR: Record<ReservationStatus, string> = {
  reserved: '#d68910',
  converted: '#3a6ea5',
  arrived: '#1e8449',
  missed: '#8c8c8c'
};

export const RESERVATION_STATUS_OPTIONS: ReadonlyArray<{ value: ReservationStatus; label: string }> = [
  { value: 'reserved', label: '已预约' },
  { value: 'converted', label: '已转调阅' },
  { value: 'arrived', label: '已到馆' },
  { value: 'missed', label: '已爽约' }
];

export function createEmptyReservationDraft(volumeNo: number, volumeId: string | null, bookTitle: string): ReservationDraft {
  return {
    reservationNo: '',
    volumeNo,
    volumeId,
    bookTitle,
    reader: '',
    reserveDate: new Date().toISOString().slice(0, 10),
    status: 'reserved',
    requestId: null
  };
}
