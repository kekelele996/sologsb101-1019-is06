/**
 * 修复占用（Occupation）数据模型
 * 修复室接手一册即登记一条占用，作为库房放行前的占用判定依据；
 * 库房与修复室靠册次号（volumeNo）人工对账，volumeId 仅在本库可解析时回填。
 */

/** 占用状态：在修占用 / 已解除 / 待认领（旧数据回填不出的只读留档） */
export type OccupationStatus = 'active' | 'released' | 'unclaimed';

/** 占用来源：当前登记（修复室开工）/ 历史回填（v2→v3 升级按在修状态回填） */
export type OccupationSource = 'current' | 'backfilled';

export interface Occupation {
  id: string;
  /** 对账主键：册次号（库房与修复室共同的人工对账号） */
  volumeNo: number;
  /** 能解析到本库册次时回填，旧数据对账不上时为 null */
  volumeId: string | null;
  /** 书名（冗余，便于修复室 / 库房两侧识别） */
  bookTitle: string;
  /** 当前状态 */
  status: OccupationStatus;
  /** 来源：当前登记 / 历史回填 */
  source: OccupationSource;
  /** 修复室接手人 */
  restorer: string;
  /** 当前工序，如 托裱 */
  currentStep: string;
  /** 开工日期 yyyy-MM-dd */
  startDate: string;
  /** 解除日期 yyyy-MM-dd；待认领 / 在修时为空串 */
  releaseDate: string;
  /** 待认领原因（历史回填对账不上时填写） */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type OccupationDraft = Omit<Occupation, 'id' | 'createdAt' | 'updatedAt'>;

export const OCCUPATION_STATUS_LABEL: Record<OccupationStatus, string> = {
  active: '在修占用',
  released: '已解除',
  unclaimed: '待认领'
};

export const OCCUPATION_STATUS_COLOR: Record<OccupationStatus, string> = {
  active: '#b03a2e',
  released: '#1e8449',
  unclaimed: '#a8623a'
};

export const OCCUPATION_STATUS_OPTIONS: ReadonlyArray<{ value: OccupationStatus; label: string }> = [
  { value: 'active', label: '在修占用' },
  { value: 'released', label: '已解除' },
  { value: 'unclaimed', label: '待认领' }
];

export const OCCUPATION_SOURCE_LABEL: Record<OccupationSource, string> = {
  current: '当前登记',
  backfilled: '历史回填'
};

/** 待认领的历史占用只读，等人来认领，不允许库房直接放行 */
export function isOccupationReadOnly(status: OccupationStatus): boolean {
  return status === 'unclaimed';
}

/** 占用是否会阻塞库房放行：在修占用、待认领都不能放行 */
export function isOccupationBlocking(status: OccupationStatus): boolean {
  return status === 'active' || status === 'unclaimed';
}

export function createEmptyOccupationDraft(volumeNo: number, volumeId: string | null, bookTitle: string): OccupationDraft {
  return {
    volumeNo,
    volumeId,
    bookTitle,
    status: 'active',
    source: 'current',
    restorer: '',
    currentStep: '',
    startDate: new Date().toISOString().slice(0, 10),
    releaseDate: '',
    note: ''
  };
}
