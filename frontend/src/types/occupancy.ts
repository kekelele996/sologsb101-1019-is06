/**
 * 在修占用（Occupancy）数据模型
 * 修复室接手一册即占用该册次，是库房放行调阅前的唯一对账依据：
 * 只要存在 active 占用，库房调阅单一律挂起，等修复室解除占用后再放行。
 *
 * 旧数据没有占用记录：v2 → v3 升级时按「当前在修册次 + 在修工序证据」
 * 回填历史占用；回填不出在册册次或开工时间的，needsReview=true，
 * 记录只读保留，等修复室人工认领后再参与占用判断。
 */

/** 占用状态：在修占用中 / 已解除（修毕归还） */
export type OccupancyStatus = 'active' | 'released'

/** 占用来源：修复室登记 / v2→v3 历史回填 */
export type OccupancySource = 'desk' | 'backfill'

export interface Occupancy {
  id: string
  /** 关联册次 id；回填时若工序挂在已删除册次下则为 null（等人认领） */
  volumeId: string | null
  /** 接手开工时间；回填无工序证据时为 null，认领时补 */
  startAt: number | null
  /** 占用解除时间（修完归还），未解除为 null */
  endAt: number | null
  /** 解除说明（如：工序完成 / 装订送验） */
  releaseNote: string
  status: OccupancyStatus
  source: OccupancySource
  /** 回填但证据不足：只读，等人工认领确认 */
  needsReview: boolean
  /** 人工认领确认时间 */
  confirmedAt: number | null
  /** 认领人 / 当前修复负责人 */
  operator: string
  createdAt: number
  updatedAt: number
}

export type OccupancyDraft = Omit<Occupancy, 'id' | 'createdAt' | 'updatedAt'>

export const OCCUPANCY_STATUS_LABEL: Record<OccupancyStatus, string> = {
  active: '在修占用',
  released: '已解除'
}

export const OCCUPANCY_STATUS_COLOR: Record<OccupancyStatus, string> = {
  active: '#d68910',
  released: '#1e8449'
}

export const OCCUPANCY_SOURCE_LABEL: Record<OccupancySource, string> = {
  desk: '修复室登记',
  backfill: '历史回填'
}

/** 是否占用册次、阻塞库房放行（已解除 / 待认领的不阻塞） */
export function isOccupying(occupancy: Occupancy): boolean {
  return occupancy.status === 'active' && !occupancy.needsReview && occupancy.volumeId !== null
}

export function createEmptyOccupancyDraft(volumeId: string, operator = ''): OccupancyDraft {
  return {
    volumeId,
    startAt: Date.now(),
    endAt: null,
    releaseNote: '',
    status: 'active',
    source: 'desk',
    needsReview: false,
    confirmedAt: null,
    operator
  }
}
