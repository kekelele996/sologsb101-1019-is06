/**
 * 调阅单（AccessRequest）数据模型
 * 库房按册次号把书借给阅览前登记调阅单；放行前先看修复室有没有在修占用，
 * 占用未解除则把调阅单挂起，预约记录照留，等修完解除后再放行。
 */

/** 调阅单状态：待放行 / 已放行（已借出阅览）/ 已挂起（占用未解除）/ 已归还 / 已取消 */
export type AccessStatus = 'pending' | 'released' | 'held' | 'returned' | 'cancelled';

export interface AccessRequest {
  id: string;
  /** 调阅单号（库房业务编号） */
  requestNo: string;
  /** 对账主键：册次号 */
  volumeNo: number;
  /** 能解析到本库册次时回填 */
  volumeId: string | null;
  /** 书名（冗余） */
  bookTitle: string;
  /** 调阅人 / 阅览人 */
  reader: string;
  /** 关联预约记录 id（可空：允许没有预约直接调阅） */
  reservationId: string | null;
  /** 当前状态 */
  status: AccessStatus;
  /** 挂起原因（如修复室在修占用），放行后清空 */
  holdReason: string;
  /** 申请日期 yyyy-MM-dd */
  applyDate: string;
  /** 放行日期 yyyy-MM-dd */
  releaseDate: string;
  createdAt: number;
  updatedAt: number;
}

export type AccessRequestDraft = Omit<AccessRequest, 'id' | 'createdAt' | 'updatedAt'>;

export const ACCESS_STATUS_LABEL: Record<AccessStatus, string> = {
  pending: '待放行',
  released: '已放行',
  held: '已挂起',
  returned: '已归还',
  cancelled: '已取消'
};

export const ACCESS_STATUS_COLOR: Record<AccessStatus, string> = {
  pending: '#d68910',
  released: '#1e8449',
  held: '#b03a2e',
  returned: '#3a6ea5',
  cancelled: '#8c8c8c'
};

export const ACCESS_STATUS_OPTIONS: ReadonlyArray<{ value: AccessStatus; label: string }> = [
  { value: 'pending', label: '待放行' },
  { value: 'released', label: '已放行' },
  { value: 'held', label: '已挂起' },
  { value: 'returned', label: '已归还' },
  { value: 'cancelled', label: '已取消' }
];

/** 挂起 / 待放行都还没真正出库房，可以再次尝试放行 */
export function canTryRelease(status: AccessStatus): boolean {
  return status === 'pending' || status === 'held';
}

export function createEmptyAccessDraft(volumeNo: number, volumeId: string | null, bookTitle: string): AccessRequestDraft {
  return {
    requestNo: '',
    volumeNo,
    volumeId,
    bookTitle,
    reader: '',
    reservationId: null,
    status: 'pending',
    holdReason: '',
    applyDate: new Date().toISOString().slice(0, 10),
    releaseDate: ''
  };
}
