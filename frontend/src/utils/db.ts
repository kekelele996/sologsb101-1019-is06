/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑：
 *   v1 → v2：Paper 增加 dyeRecipe 字段并按纸种回填默认配方
 *   v2 → v3：新增库房「预约 / 调阅单」、修复室「在修占用」与本侧重试队列，
 *            并按当前在修状态回填一张历史占用（回填不出的只读等人认领）
 * - 十张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table, type Transaction } from 'dexie'
import type { Book } from '@/types/book'
import type { Volume } from '@/types/volume'
import type { Leaf } from '@/types/leaf'
import { DEFAULT_DYE_RECIPE, type Paper } from '@/types/paper'
import type { RepairOrder } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'
import type { Occupancy } from '@/types/occupancy'
import type { AccessRequest } from '@/types/accessRequest'
import type { Reservation } from '@/types/reservation'
import type { RepairOperation } from '@/types/repairOperation'

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbbookrestore'

/** 当前数据结构版本号 */
export const DB_VERSION = 3

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbbookrestore:db-version',
  lastBackupAt: 'gbbookrestore:last-backup-at',
  uiPrefs: 'gbbookrestore:ui-prefs'
} as const

export interface UiPrefs {
  lastBookId: string | null
  lastVolumeId: string | null
  repairSort: 'manual' | 'leaf'
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBookId: null, lastVolumeId: null, repairSort: 'manual' }

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastBookId: typeof parsed.lastBookId === 'string' ? parsed.lastBookId : null,
      lastVolumeId: typeof parsed.lastVolumeId === 'string' ? parsed.lastVolumeId : null,
      repairSort: parsed.repairSort === 'leaf' ? 'leaf' : 'manual'
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
  } catch {
    /* 隐私模式下忽略 */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value)
  } catch {
    /* ignore */
  }
}

export class BookRestoreDatabase extends Dexie {
  books!: Table<Book, string>
  volumes!: Table<Volume, string>
  leaves!: Table<Leaf, string>
  papers!: Table<Paper, string>
  repairOrders!: Table<RepairOrder, string>
  bindings!: Table<Binding, string>
  occupancies!: Table<Occupancy, string>
  accessRequests!: Table<AccessRequest, string>
  reservations!: Table<Reservation, string>
  repairOps!: Table<RepairOperation, string>

  constructor() {
    super(DB_NAME)
    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      books: 'id, title, era, level, updatedAt',
      volumes: 'id, bookId, volumeNo, state, updatedAt',
      leaves: 'id, volumeId, leafNo, damageType, state, updatedAt',
      papers: 'id, leafId, paperType, deltaE, updatedAt',
      repairOrders: 'id, leafId, seq, name, state, updatedAt',
      bindings: 'id, volumeId, verdict, finishDate, updatedAt'
    })
    // v2：Paper 增加 dyeRecipe 字段，按纸种为历史记录回填默认配方
    this.version(DB_VERSION)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Paper>('papers')
          .toCollection()
          .modify((paper) => {
            if (!paper.dyeRecipe || paper.dyeRecipe.length === 0) {
              paper.dyeRecipe = DEFAULT_DYE_RECIPE[paper.paperType] ?? DEFAULT_DYE_RECIPE.bamboo
            }
            if (typeof paper.deltaE !== 'number') paper.deltaE = 2
            if (typeof paper.thicknessMm !== 'number') paper.thicknessMm = 0.06
          })
      })
    // v3：库房 ↔ 修复室占用协调
    // 新增 occupancies（在修占用）/ accessRequests（调阅单）/ reservations（预约）
    // / repairOps（修复室本侧重试队列）；旧数据按当前在修状态回填历史占用。
    this.version(DB_VERSION)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt',
        occupancies: 'id, volumeId, status, source, needsReview, updatedAt',
        accessRequests: 'id, volumeId, reservationId, state, requestDate, updatedAt',
        reservations: 'id, volumeId, state, reserveDate, updatedAt',
        repairOps: 'id, orderId, leafId, kind, state, updatedAt'
      })
      .upgrade((tx) => backfillHistoricalOccupancy(tx))
  }
}

/* ------------------------- v2 → v3 历史占用回填 ------------------------- */

/** 把 yyyy-MM-dd 的工序日期解析为当日 0 点时间戳，无法解析返回 null */
function parseOrderDate(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '')
  if (!match) return null
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(time) ? null : time
}

/**
 * 升级回填：旧数据没有占用记录，按当前在修状态回填一张历史占用。
 * - 册次 state=repairing：按「在册册次 + 在修/已完成工序证据」回填；
 *   有开工证据（工序日期）→ 直接占用；无证据 → needsReview 只读等人认领。
 * - 工序挂在已删除册次下（旧账常见）：回填一张 volumeId=null 的待认领占用，
 *   只读留着等人认领，不臆测册次。
 * 回填只依据修复室本侧在修状态，不触碰库房（旧库里本也没有调阅单）。
 */
async function backfillHistoricalOccupancy(tx: Transaction): Promise<void> {
  const occupancyTable = tx.table<Occupancy>('occupancies')
  const volumes = await tx.table<Volume>('volumes').toArray()
  const leaves = await tx.table<Leaf>('leaves').toArray()
  const orders = await tx.table<RepairOrder>('repairOrders').toArray()
  const now = Date.now()

  const leafById = new Map(leaves.map((leaf) => [leaf.id, leaf]))
  /** 册次 id → 该册开工证据（最早工序日期；无日期取最早 createdAt） */
  const evidenceByVolume = new Map<string, number>()
  const orphanVolumeIds = new Set<string>()
  orders.forEach((order) => {
    const leaf = leafById.get(order.leafId)
    if (!leaf) {
      // 工序指向的书叶已不存在，无法定位册次 → 待认领历史账
      orphanVolumeIds.add(order.leafId)
      return
    }
    const startedAt = parseOrderDate(order.date) ?? order.createdAt
    const prev = evidenceByVolume.get(leaf.volumeId)
    evidenceByVolume.set(leaf.volumeId, prev === undefined ? startedAt : Math.min(prev, startedAt))
  })

  const backfilled: Occupancy[] = []
  volumes
    .filter((volume) => volume.state === 'repairing')
    .forEach((volume) => {
      const startAt = evidenceByVolume.get(volume.id) ?? null
      backfilled.push({
        id: `occ_bf_${volume.id}`,
        volumeId: volume.id,
        startAt,
        endAt: null,
        releaseNote: '',
        status: 'active',
        source: 'backfill',
        // 有开工证据直接生效；回填不出开工时间的只读等人认
        needsReview: startAt === null,
        confirmedAt: null,
        operator: '',
        createdAt: volume.updatedAt ?? now,
        updatedAt: now
      })
    })

  // 找不到在册册次的在修工序：留一张待认领占位，绝不参与库房占用判断
  let orphanIndex = 0
  orphanVolumeIds.forEach((missingLeafId) => {
    orphanIndex += 1
    backfilled.push({
      id: `occ_orphan_${orphanIndex}`,
      volumeId: null,
      startAt: null,
      endAt: null,
      releaseNote: '',
      status: 'active',
      source: 'backfill',
      needsReview: true,
      confirmedAt: null,
      operator: '',
      createdAt: now,
      updatedAt: now
    })
    void missingLeafId
  })

  if (backfilled.length > 0) await occupancyTable.bulkPut(backfilled)
}

export const db = new BookRestoreDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open()
  stampDbVersion()
  if ((await db.books.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Book → Volume → Leaf →（Paper / RepairOrder）＋ Volume → Binding */

export async function seedDatabase(): Promise<void> {
  const now = Date.now()
  const day = 86400000

  const books: Book[] = [
    {
      id: 'book_01',
      title: '昌黎先生集',
      edition: '明万历刻本',
      era: '明',
      volumeCount: 2,
      collectionNo: 'GJ-0017',
      level: 'first',
      createdAt: now - day * 40,
      updatedAt: now - day * 3
    },
    {
      id: 'book_02',
      title: '梦溪笔谈',
      edition: '清乾隆写刻',
      era: '清',
      volumeCount: 1,
      collectionNo: 'GJ-0042',
      level: 'second',
      createdAt: now - day * 32,
      updatedAt: now - day * 2
    },
    {
      id: 'book_03',
      title: '重刊巢氏诸病源候总论',
      edition: '元至正刻本（残）',
      era: '元',
      volumeCount: 1,
      collectionNo: 'GJ-0008',
      level: 'first',
      createdAt: now - day * 60,
      updatedAt: now - day * 5
    }
  ]

  const volumes: Volume[] = [
    { id: 'vol_0101', bookId: 'book_01', volumeNo: 1, leafCount: 24, bindingType: 'thread', state: 'repairing', createdAt: now - day * 38, updatedAt: now - day * 3 },
    { id: 'vol_0102', bookId: 'book_01', volumeNo: 2, leafCount: 18, bindingType: 'wrapped', state: 'pending', createdAt: now - day * 38, updatedAt: now - day * 6 },
    { id: 'vol_0201', bookId: 'book_02', volumeNo: 1, leafCount: 30, bindingType: 'thread', state: 'archived', createdAt: now - day * 30, updatedAt: now - day * 2 },
    { id: 'vol_0301', bookId: 'book_03', volumeNo: 1, leafCount: 12, bindingType: 'butterfly', state: 'archived', createdAt: now - day * 55, updatedAt: now - day * 5 }
  ]

  const leaves: Leaf[] = [
    { id: 'leaf_010101', volumeId: 'vol_0101', leafNo: 3, damageType: 'worm', damageAreaCm2: 6.5, phValue: 6.4, state: 'repairing', createdAt: now - day * 20, updatedAt: now - day * 3 },
    { id: 'leaf_010102', volumeId: 'vol_0101', leafNo: 8, damageType: 'acid', damageAreaCm2: 12.2, phValue: 5.1, state: 'pending', createdAt: now - day * 20, updatedAt: now - day * 4 },
    { id: 'leaf_010103', volumeId: 'vol_0101', leafNo: 8, damageType: 'stain', damageAreaCm2: 4.8, phValue: 6.1, state: 'pending', createdAt: now - day * 19, updatedAt: now - day * 4 },
    { id: 'leaf_010201', volumeId: 'vol_0102', leafNo: 2, damageType: 'loss', damageAreaCm2: 9.4, phValue: 6.7, state: 'pending', createdAt: now - day * 18, updatedAt: now - day * 6 },
    { id: 'leaf_020101', volumeId: 'vol_0201', leafNo: 5, damageType: 'fibrin', damageAreaCm2: 15.6, phValue: 6.9, state: 'repaired', createdAt: now - day * 25, updatedAt: now - day * 2 },
    { id: 'leaf_020102', volumeId: 'vol_0201', leafNo: 11, damageType: 'worm', damageAreaCm2: 7.2, phValue: 6.6, state: 'repaired', createdAt: now - day * 24, updatedAt: now - day * 3 },
    { id: 'leaf_030101', volumeId: 'vol_0301', leafNo: 1, damageType: 'acid', damageAreaCm2: 20.5, phValue: 4.8, state: 'repaired', createdAt: now - day * 50, updatedAt: now - day * 5 },
    { id: 'leaf_030102', volumeId: 'vol_0301', leafNo: 6, damageType: 'loss', damageAreaCm2: 11.1, phValue: 5.6, state: 'repaired', createdAt: now - day * 49, updatedAt: now - day * 6 }
  ]

  const papers: Paper[] = [
    { id: 'paper_0101', leafId: 'leaf_010101', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.4, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0102', leafId: 'leaf_010101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, deltaE: 3.6, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0103', leafId: 'leaf_010102', paperType: 'xuan', laidPattern: '细帘纹', thicknessMm: 0.05, deltaE: 2.1, dyeRecipe: DEFAULT_DYE_RECIPE.xuan, createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'paper_0201', leafId: 'leaf_020101', paperType: 'bamboo', laidPattern: '三指帘纹', thicknessMm: 0.06, deltaE: 0.9, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'paper_0301', leafId: 'leaf_030101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.08, deltaE: 5.2, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 45, updatedAt: now - day * 45 }
  ]

  const repairOrders: RepairOrder[] = [
    { id: 'order_010101', leafId: 'leaf_010101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '沈玉', date: '2026-03-04', state: 'done', createdAt: now - day * 16, updatedAt: now - day * 14 },
    { id: 'order_010102', leafId: 'leaf_010101', seq: 2, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-03-06', state: 'doing', createdAt: now - day * 15, updatedAt: now - day * 3 },
    { id: 'order_010103', leafId: 'leaf_010101', seq: 3, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-03-09', state: 'todo', createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'order_010201', leafId: 'leaf_010201', seq: 1, name: 'mend', material: '补纸 0.05mm + 小麦淀粉糊', operator: '陆敏', date: '2026-03-08', state: 'todo', createdAt: now - day * 10, updatedAt: now - day * 10 },
    { id: 'order_020101', leafId: 'leaf_020101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '陆敏', date: '2026-02-26', state: 'done', createdAt: now - day * 22, updatedAt: now - day * 20 },
    { id: 'order_020102', leafId: 'leaf_020101', seq: 2, name: 'corner', material: '溜口纸条 + 稠浆糊', operator: '陆敏', date: '2026-02-28', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 19 },
    { id: 'order_020103', leafId: 'leaf_020101', seq: 3, name: 'trim', material: '裁板 + 竹起子', operator: '陆敏', date: '2026-03-01', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 18 },
    { id: 'order_020104', leafId: 'leaf_020101', seq: 4, name: 'press', material: '压书板 + 宣纸吸水层', operator: '陆敏', date: '2026-03-02', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 17 },
    { id: 'order_030101', leafId: 'leaf_030101', seq: 1, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-02-12', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 38 },
    { id: 'order_030102', leafId: 'leaf_030101', seq: 2, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-02-15', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 36 }
  ]

  const bindings: Binding[] = [
    { id: 'bind_0201', volumeId: 'vol_0201', method: '六眼线装', finishDate: '2026-03-03', verdict: 'pass', inspector: '程砚', createdAt: now - day * 3, updatedAt: now - day * 2 },
    { id: 'bind_0301', volumeId: 'vol_0301', method: '蝴蝶装复原', finishDate: '2026-02-18', verdict: 'pass', inspector: '程砚', createdAt: now - day * 8, updatedAt: now - day * 5 },
    { id: 'bind_0101', volumeId: 'vol_0101', method: '四眼线装', finishDate: '2026-03-10', verdict: 'rework', inspector: '程砚', createdAt: now - day * 2, updatedAt: now - day * 2 }
  ]

  /* -------- 库房 ↔ 修复室协调：占用 / 预约 / 调阅单 / 本侧重试 -------- */
  // vol_0101 正在修（沈玉接手），vol_0102 待修（预约 + 调阅单可放行）
  const occupancies: Occupancy[] = [
    {
      id: 'occ_0101',
      volumeId: 'vol_0101',
      startAt: now - day * 14,
      endAt: null,
      releaseNote: '',
      status: 'active',
      source: 'desk',
      needsReview: false,
      confirmedAt: now - day * 14,
      operator: '沈玉',
      createdAt: now - day * 14,
      updatedAt: now - day * 3
    },
    // 历史回填但证据不足：只读等人认领（演示「回填不出的留着等人认」）
    {
      id: 'occ_review_demo',
      volumeId: null,
      startAt: null,
      endAt: null,
      releaseNote: '',
      status: 'active',
      source: 'backfill',
      needsReview: true,
      confirmedAt: null,
      operator: '',
      createdAt: now - day * 1,
      updatedAt: now - day * 1
    }
  ]

  const reservations: Reservation[] = [
    {
      id: 'res_0101',
      reserveNo: 'YY-2026-0311',
      volumeId: 'vol_0101',
      reader: '文献研究所 · 顾衡',
      reserveDate: '2026-10-08',
      state: 'active',
      requestId: 'req_0101',
      note: '明代刻本版式比对，约用到十月中旬',
      createdAt: now - day * 2,
      updatedAt: now - day * 2
    },
    {
      id: 'res_0102',
      reserveNo: 'YY-2026-0312',
      volumeId: 'vol_0102',
      reader: '历史系 · 林晚',
      reserveDate: '2026-10-07',
      state: 'active',
      requestId: 'req_0102',
      note: '',
      createdAt: now - day * 1,
      updatedAt: now - day * 1
    }
  ]

  const accessRequests: AccessRequest[] = [
    // vol_0101 在修占用：调阅单挂起，预约照留，等修完自动转待放行
    {
      id: 'req_0101',
      requestNo: 'DY-2026-0311',
      volumeId: 'vol_0101',
      reservationId: 'res_0101',
      reader: '文献研究所 · 顾衡',
      purpose: '明代刻本版式比对',
      state: 'held',
      blockedByOccupancyId: 'occ_0101',
      heldReason: '修复室在修占用（沈玉 接手，尚未修完归还）',
      requestDate: '2026-10-06',
      lentAt: null,
      createdAt: now - day * 2,
      updatedAt: now - day * 2
    },
    // vol_0102 无占用：待审核，可直接放行
    {
      id: 'req_0102',
      requestNo: 'DY-2026-0312',
      volumeId: 'vol_0102',
      reservationId: 'res_0102',
      reader: '历史系 · 林晚',
      purpose: '包背装装帧考察',
      state: 'reviewing',
      blockedByOccupancyId: null,
      heldReason: '',
      requestDate: '2026-10-06',
      lentAt: null,
      createdAt: now - day * 1,
      updatedAt: now - day * 1
    }
  ]

  // 一条登记工序失败的本侧记录：只重试修复室这一侧（工序/书叶），
  // 库房调阅单与预约完全不在此事务内。
  const repairOps: RepairOperation[] = [
    {
      id: 'rop_demo_fail',
      kind: 'advance-order',
      orderId: 'order_010102',
      leafId: 'leaf_010101',
      targetOrderState: 'done',
      targetLeafState: null,
      state: 'failed',
      lastError: '本地写入冲突：登记工序时事务中断（模拟）',
      attempts: 1,
      createdAt: now - day * 1,
      updatedAt: now - day * 1
    }
  ]

  await db.transaction(
    'rw',
    [
      db.books,
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.occupancies,
      db.accessRequests,
      db.reservations,
      db.repairOps
    ],
    async () => {
      await db.books.bulkPut(books)
      await db.volumes.bulkPut(volumes)
      await db.leaves.bulkPut(leaves)
      await db.papers.bulkPut(papers)
      await db.repairOrders.bulkPut(repairOrders)
      await db.bindings.bulkPut(bindings)
      await db.occupancies.bulkPut(occupancies)
      await db.reservations.bulkPut(reservations)
      await db.accessRequests.bulkPut(accessRequests)
      await db.repairOps.bulkPut(repairOps)
    }
  )
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RestoreSnapshot {
  app: typeof DB_NAME
  schemaVersion: number
  exportedAt: string
  books: Book[]
  volumes: Volume[]
  leaves: Leaf[]
  papers: Paper[]
  repairOrders: RepairOrder[]
  bindings: Binding[]
  occupancies: Occupancy[]
  accessRequests: AccessRequest[]
  reservations: Reservation[]
  repairOps: RepairOperation[]
}

export async function exportSnapshot(): Promise<RestoreSnapshot> {
  const [books, volumes, leaves, papers, repairOrders, bindings, occupancies, accessRequests, reservations, repairOps] =
    await Promise.all([
      db.books.toArray(),
      db.volumes.toArray(),
      db.leaves.toArray(),
      db.papers.toArray(),
      db.repairOrders.toArray(),
      db.bindings.toArray(),
      db.occupancies.toArray(),
      db.accessRequests.toArray(),
      db.reservations.toArray(),
      db.repairOps.toArray()
    ])
  return {
    app: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    books,
    volumes,
    leaves,
    papers,
    repairOrders,
    bindings,
    occupancies,
    accessRequests,
    reservations,
    repairOps
  }
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象'
  const snapshot = input as Partial<RestoreSnapshot>
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`
  const keys: Array<keyof RestoreSnapshot> = [
    'books',
    'volumes',
    'leaves',
    'papers',
    'repairOrders',
    'bindings',
    'occupancies',
    'accessRequests',
    'reservations',
    'repairOps'
  ]
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`
  }
  return ''
}

export async function importSnapshot(snapshot: RestoreSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.books,
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.occupancies,
      db.accessRequests,
      db.reservations,
      db.repairOps
    ],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.occupancies.clear(),
        db.accessRequests.clear(),
        db.reservations.clear(),
        db.repairOps.clear()
      ])
      await db.books.bulkPut(snapshot.books)
      await db.volumes.bulkPut(snapshot.volumes)
      await db.leaves.bulkPut(snapshot.leaves)
      await db.papers.bulkPut(snapshot.papers)
      await db.repairOrders.bulkPut(snapshot.repairOrders)
      await db.bindings.bulkPut(snapshot.bindings)
      await db.occupancies.bulkPut(snapshot.occupancies)
      await db.accessRequests.bulkPut(snapshot.accessRequests)
      await db.reservations.bulkPut(snapshot.reservations)
      await db.repairOps.bulkPut(snapshot.repairOps)
    }
  )
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.books,
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.occupancies,
      db.accessRequests,
      db.reservations,
      db.repairOps
    ],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.occupancies.clear(),
        db.accessRequests.clear(),
        db.reservations.clear(),
        db.repairOps.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [books, volumes, leaves, papers, repairOrders, bindings, occupancies, accessRequests, reservations, repairOps] =
    await Promise.all([
      db.books.count(),
      db.volumes.count(),
      db.leaves.count(),
      db.papers.count(),
      db.repairOrders.count(),
      db.bindings.count(),
      db.occupancies.count(),
      db.accessRequests.count(),
      db.reservations.count(),
      db.repairOps.count()
    ])
  return { books, volumes, leaves, papers, repairOrders, bindings, occupancies, accessRequests, reservations, repairOps }
}

/** 级联删除古籍 → 册次 → 书叶 → 补纸 / 工序 / 装订 / 占用 / 调阅 / 预约 */
export async function removeBookCascade(bookId: string): Promise<void> {
  const volumeRows = await db.volumes.where('bookId').equals(bookId).toArray()
  const volumeIds = volumeRows.map((row) => row.id)
  const leafIds = volumeIds.length
    ? (await db.leaves.where('volumeId').anyOf(volumeIds).toArray()).map((row) => row.id)
    : []
  await db.transaction(
    'rw',
    [
      db.books,
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.occupancies,
      db.accessRequests,
      db.reservations
    ],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
      }
      if (volumeIds.length > 0) {
        await db.leaves.where('volumeId').anyOf(volumeIds).delete()
        await db.bindings.where('volumeId').anyOf(volumeIds).delete()
        await db.occupancies.where('volumeId').anyOf(volumeIds).delete()
        await db.accessRequests.where('volumeId').anyOf(volumeIds).delete()
        await db.reservations.where('volumeId').anyOf(volumeIds).delete()
      }
      await db.volumes.where('bookId').equals(bookId).delete()
      await db.books.delete(bookId)
    }
  )
}

/** 级联删除册次 → 书叶 → 补纸 / 工序 / 装订 / 占用 / 调阅 / 预约 */
export async function removeVolumeCascade(volumeId: string): Promise<void> {
  const leafIds = (await db.leaves.where('volumeId').equals(volumeId).toArray()).map((row) => row.id)
  await db.transaction(
    'rw',
    [
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.occupancies,
      db.accessRequests,
      db.reservations
    ],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
      }
      await db.leaves.where('volumeId').equals(volumeId).delete()
      await db.bindings.where('volumeId').equals(volumeId).delete()
      await db.occupancies.where('volumeId').equals(volumeId).delete()
      await db.accessRequests.where('volumeId').equals(volumeId).delete()
      await db.reservations.where('volumeId').equals(volumeId).delete()
      await db.volumes.delete(volumeId)
    }
  )
}

/** 级联删除书叶 → 补纸 / 工序 */
export async function removeLeafCascade(leafId: string): Promise<void> {
  await db.transaction('rw', [db.leaves, db.papers, db.repairOrders], async () => {
    await db.papers.where('leafId').equals(leafId).delete()
    await db.repairOrders.where('leafId').equals(leafId).delete()
    await db.leaves.delete(leafId)
  })
}
