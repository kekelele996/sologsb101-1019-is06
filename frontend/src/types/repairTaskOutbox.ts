/**
 * 修复室本侧登记失败重试（RepairTaskOutbox）数据模型
 * 修复室登记工序失败后只重试本侧那几条：失败的工序登记落到本发件箱，
 * 重试时只回写 repairOrders 表，绝不触碰库房的调阅单 / 预约记录。
 */

/** 本侧任务状态：待重试 / 已重试成功 / 已放弃 */
export type OutboxStatus = 'pending' | 'done' | 'abandoned';

export interface RepairTaskOutbox {
  id: string;
  /** 书叶 id（登记对象，属于修复室本侧） */
  leafId: string;
  /** 失败时要落库的工序快照（重试时原样回写） */
  payload: Record<string, unknown>;
  /** 当前状态 */
  status: OutboxStatus;
  /** 最近失败原因 */
  lastError: string;
  /** 重试次数 */
  attempts: number;
  /** 最近重试时间戳；未重试为 0 */
  lastAttemptAt: number;
  createdAt: number;
  updatedAt: number;
}

export type RepairTaskOutboxDraft = Omit<RepairTaskOutbox, 'id'>;

export const OUTBOX_STATUS_LABEL: Record<OutboxStatus, string> = {
  pending: '待重试',
  done: '已重试成功',
  abandoned: '已放弃'
};

export const OUTBOX_STATUS_COLOR: Record<OutboxStatus, string> = {
  pending: '#b03a2e',
  done: '#1e8449',
  abandoned: '#8c8c8c'
};

export const OUTBOX_STATUS_OPTIONS: ReadonlyArray<{ value: OutboxStatus; label: string }> = [
  { value: 'pending', label: '待重试' },
  { value: 'done', label: '已重试成功' },
  { value: 'abandoned', label: '已放弃' }
];

export function createOutboxEntry(leafId: string, payload: Record<string, unknown>, error: string): Omit<RepairTaskOutbox, 'id'> {
  const now = Date.now();
  return {
    leafId,
    payload,
    status: 'pending',
    lastError: error,
    attempts: 0,
    lastAttemptAt: 0,
    createdAt: now,
    updatedAt: now
  };
}
