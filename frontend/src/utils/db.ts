/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Paper 增加 dyeRecipe 字段并按纸种回填默认配方
 *   v2 → v3：新增库房—修复室协同四表（占用 / 调阅单 / 预约 / 本侧重试发件箱），
 *            按当前在修状态回填一张历史占用；修复室在修但台账对账不上的回填为「待认领」只读留档
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
import type { Occupation } from '@/types/occupation'
import type { AccessRequest } from '@/types/accessRequest'
import type { Reservation } from '@/types/reservation'
import type { RepairTaskOutbox } from '@/types/repairTaskOutbox'

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
  occupations!: Table<Occupation, string>
  accessRequests!: Table<AccessRequest, string>
  reservations!: Table<Reservation, string>
  repairTaskOutbox!: Table<RepairTaskOutbox, string>

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
    this.version(2)
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
    // v3：库房—修复室协同四表；按当前在修状态回填一张历史占用
    this.version(DB_VERSION)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt',
        occupations: 'id, volumeNo, volumeId, status, source, updatedAt',
        accessRequests: 'id, requestNo, volumeNo, volumeId, status, reservationId, updatedAt',
        reservations: 'id, reservationNo, volumeNo, volumeId, status, requestId, updatedAt',
        repairTaskOutbox: 'id, leafId, status, attempts, updatedAt'
      })
      .upgrade(async (tx) => {
        await backfillHistoricalOccupations(tx)
      })
  }
}

export const db = new BookRestoreDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 生成库房业务单号：前缀 + yyyyMMdd + 三位随机数（调阅单 / 预约记录） */
export function createBizNo(prefix: 'DY' | 'YY'): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const seq = Math.floor(100 + Math.random() * 900)
  return `${prefix}${ymd}${seq}`
}

/* ------------------------- v2→v3 历史占用回填 ------------------------- */

/**
 * 升级时按当前在修状态回填一张历史占用：
 * - 台账中「修复中」的册次 → 回填为在修占用（能对上古籍书名）
 * - 修复室有未完工工序、但台账按册次对不上的「在修信号」→ 回填为「待认领」，只读留档等人认
 */
async function backfillHistoricalOccupations(tx: Transaction): Promise<void> {
  const occupationTable = tx.table<Occupation>('occupations')
  // 已回填过（重复升级）则跳过，保证幂等
  if (await occupationTable.count()) return

  const now = Date.now()
  const books = await tx.table<Book>('books').toArray()
  const volumes = await tx.table<Volume>('volumes').toArray()
  const leaves = await tx.table<Leaf>('leaves').toArray()
  const orders = await tx.table<RepairOrder>('repairOrders').toArray()

  const bookTitleOf = (bookId: string): string => books.find((book) => book.id === bookId)?.title ?? ''

  // 1）台账中处于修复中的册次 → 在修占用
  const repairing = volumes.filter((volume) => volume.state === 'repairing')
  const activeBackfills: Occupation[] = repairing.map((volume) => ({
    id: `occ_hist_${volume.id}`,
    volumeNo: volume.volumeNo,
    volumeId: volume.id,
    bookTitle: bookTitleOf(volume.bookId) || '未知名古籍',
    status: 'active',
    source: 'backfilled',
    restorer: '历史回填',
    currentStep: '历史在修（工序待核）',
    startDate: new Date(volume.updatedAt || now).toISOString().slice(0, 10),
    releaseDate: '',
    note: '升级时按当前在修状态回填',
    createdAt: now,
    updatedAt: now
  }))

  // 2）修复室侧仍有未完工工序、但台账按册次号对不上 → 待认领只读留档
  const unfinishedLeafIds = new Set(
    orders.filter((order) => order.state !== 'done').map((order) => order.leafId)
  )
  const orphanLeaves = leaves.filter(
    (leaf) => unfinishedLeafIds.has(leaf.id) && !volumes.some((volume) => volume.id === leaf.volumeId)
  )
  const unclaimedBackfills: Occupation[] = orphanLeaves.map((leaf) => ({
    // 台账对账不上时没有可信册次号，用 0 占位（只读等人认领时再指认）
    id: `occ_orphan_${leaf.id}`,
    volumeNo: 0,
    volumeId: null,
    bookTitle: `修复室在修信号（书叶 ${leaf.leafNo}，册次待认）`,
    status: 'unclaimed',
    source: 'backfilled',
    restorer: '待认领',
    currentStep: '历史在修（台账无此册）',
    startDate: new Date(leaf.updatedAt || now).toISOString().slice(0, 10),
    releaseDate: '',
    note: `升级回填：修复室有未完工工序（书叶 ${leaf.leafNo} 叶），但台账按册次号对不上，只读留档等人认领`,
    createdAt: now,
    updatedAt: now
  }))

  const all = [...activeBackfills, ...unclaimedBackfills]
  if (all.length > 0) await occupationTable.bulkAdd(all)
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

  /* 库房—修复室协同：占用 / 调阅单 / 预约 / 本侧重试发件箱 */
  const occupations: Occupation[] = [
    // vol_0101 当前修复中（且验收返修）→ 在修占用
    {
      id: 'occ_0101',
      volumeNo: 1,
      volumeId: 'vol_0101',
      bookTitle: '昌黎先生集',
      status: 'active',
      source: 'current',
      restorer: '沈玉',
      currentStep: '托裱',
      startDate: '2026-03-02',
      releaseDate: '',
      note: '',
      createdAt: now - day * 5,
      updatedAt: now - day * 3
    },
    // 旧数据：修复室说在修、台账按册次号对不上 → 待认领只读留档
    {
      id: 'occ_orphan_seed',
      volumeNo: 0,
      volumeId: null,
      bookTitle: '修复室在修信号（旧账残册，册次待认）',
      status: 'unclaimed',
      source: 'backfilled',
      restorer: '待认领',
      currentStep: '历史在修（台账无此册）',
      startDate: '2026-02-20',
      releaseDate: '',
      note: '升级回填：修复室有在修记录，但库房台账按册次号对账不上，只读留档等人认领',
      createdAt: now - day * 4,
      updatedAt: now - day * 4
    }
  ]

  const reservations: Reservation[] = [
    {
      id: 'rsv_0101',
      reservationNo: 'YY20260306001',
      volumeNo: 1,
      volumeId: 'vol_0101',
      bookTitle: '昌黎先生集',
      reader: '周衡',
      reserveDate: '2026-03-08',
      status: 'converted',
      requestId: 'req_0101',
      createdAt: now - day * 4,
      updatedAt: now - day * 3
    },
    {
      id: 'rsv_0102',
      reservationNo: 'YY20260306002',
      volumeNo: 2,
      volumeId: 'vol_0102',
      bookTitle: '昌黎先生集',
      reader: '林照',
      reserveDate: '2026-03-11',
      status: 'reserved',
      requestId: null,
      createdAt: now - day * 2,
      updatedAt: now - day * 2
    }
  ]

  const accessRequests: AccessRequest[] = [
    // 第 1 册修复室在修占用 → 已挂起（预约照留），修完解除后可再放行
    {
      id: 'req_0101',
      requestNo: 'DY20260307001',
      volumeNo: 1,
      volumeId: 'vol_0101',
      bookTitle: '昌黎先生集',
      reader: '周衡',
      reservationId: 'rsv_0101',
      status: 'held',
      holdReason: '修复室在修占用（托裱），占用未解除，调阅单挂起，预约记录照留',
      applyDate: '2026-03-07',
      releaseDate: '',
      createdAt: now - day * 3,
      updatedAt: now - day * 3
    },
    // 第 2 册待修复、无占用 → 待放行
    {
      id: 'req_0102',
      requestNo: 'DY20260307002',
      volumeNo: 2,
      volumeId: 'vol_0102',
      bookTitle: '昌黎先生集',
      reader: '林照',
      reservationId: 'rsv_0102',
      status: 'pending',
      holdReason: '',
      applyDate: '2026-03-07',
      releaseDate: '',
      createdAt: now - day * 2,
      updatedAt: now - day * 2
    }
  ]

  // 本侧工序登记失败的一条待重试记录（重试只回写 repairOrders，不动库房调阅单）
  const repairTaskOutbox: RepairTaskOutbox[] = [
    {
      id: 'outbox_01',
      leafId: 'leaf_010101',
      payload: {
        id: 'order_retry_010104',
        leafId: 'leaf_010101',
        seq: 4,
        name: 'corner',
        material: '溜口纸条 + 稠浆糊',
        operator: '沈玉',
        date: '2026-03-10',
        state: 'todo'
      },
      status: 'pending',
      lastError: '登记工序时本侧写入失败（本地存储忙），待重试',
      attempts: 1,
      lastAttemptAt: now - day * 1,
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
      db.occupations,
      db.accessRequests,
      db.reservations,
      db.repairTaskOutbox
    ],
    async () => {
      await db.books.bulkPut(books)
      await db.volumes.bulkPut(volumes)
      await db.leaves.bulkPut(leaves)
      await db.papers.bulkPut(papers)
      await db.repairOrders.bulkPut(repairOrders)
      await db.bindings.bulkPut(bindings)
      await db.occupations.bulkPut(occupations)
      await db.reservations.bulkPut(reservations)
      await db.accessRequests.bulkPut(accessRequests)
      await db.repairTaskOutbox.bulkPut(repairTaskOutbox)
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
  occupations: Occupation[]
  accessRequests: AccessRequest[]
  reservations: Reservation[]
  repairTaskOutbox: RepairTaskOutbox[]
}

const ALL_TABLES = [
  'books',
  'volumes',
  'leaves',
  'papers',
  'repairOrders',
  'bindings',
  'occupations',
  'accessRequests',
  'reservations',
  'repairTaskOutbox'
] as const

export async function exportSnapshot(): Promise<RestoreSnapshot> {
  const [books, volumes, leaves, papers, repairOrders, bindings, occupations, accessRequests, reservations, repairTaskOutbox] =
    await Promise.all([
      db.books.toArray(),
      db.volumes.toArray(),
      db.leaves.toArray(),
      db.papers.toArray(),
      db.repairOrders.toArray(),
      db.bindings.toArray(),
      db.occupations.toArray(),
      db.accessRequests.toArray(),
      db.reservations.toArray(),
      db.repairTaskOutbox.toArray()
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
    occupations,
    accessRequests,
    reservations,
    repairTaskOutbox
  }
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象'
  const snapshot = input as Partial<RestoreSnapshot>
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`
  for (const key of ALL_TABLES) {
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
      db.occupations,
      db.accessRequests,
      db.reservations,
      db.repairTaskOutbox
    ],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.occupations.clear(),
        db.accessRequests.clear(),
        db.reservations.clear(),
        db.repairTaskOutbox.clear()
      ])
      await db.books.bulkPut(snapshot.books)
      await db.volumes.bulkPut(snapshot.volumes)
      await db.leaves.bulkPut(snapshot.leaves)
      await db.papers.bulkPut(snapshot.papers)
      await db.repairOrders.bulkPut(snapshot.repairOrders)
      await db.bindings.bulkPut(snapshot.bindings)
      await db.occupations.bulkPut(snapshot.occupations)
      await db.accessRequests.bulkPut(snapshot.accessRequests)
      await db.reservations.bulkPut(snapshot.reservations)
      await db.repairTaskOutbox.bulkPut(snapshot.repairTaskOutbox)
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
      db.occupations,
      db.accessRequests,
      db.reservations,
      db.repairTaskOutbox
    ],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.occupations.clear(),
        db.accessRequests.clear(),
        db.reservations.clear(),
        db.repairTaskOutbox.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [books, volumes, leaves, papers, repairOrders, bindings, occupations, accessRequests, reservations, repairTaskOutbox] =
    await Promise.all([
      db.books.count(),
      db.volumes.count(),
      db.leaves.count(),
      db.papers.count(),
      db.repairOrders.count(),
      db.bindings.count(),
      db.occupations.count(),
      db.accessRequests.count(),
      db.reservations.count(),
      db.repairTaskOutbox.count()
    ])
  return { books, volumes, leaves, papers, repairOrders, bindings, occupations, accessRequests, reservations, repairTaskOutbox }
}

/** 级联删除古籍 → 册次 → 书叶 → 补纸 / 工序 / 装订（协同表按册次 / 书叶清理） */
export async function removeBookCascade(bookId: string): Promise<void> {
  const volumeIds = (await db.volumes.where('bookId').equals(bookId).toArray()).map((row) => row.id)
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
      db.occupations,
      db.accessRequests,
      db.reservations,
      db.repairTaskOutbox
    ],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
        await db.repairTaskOutbox.where('leafId').anyOf(leafIds).delete()
      }
      if (volumeIds.length > 0) {
        await db.leaves.where('volumeId').anyOf(volumeIds).delete()
        await db.bindings.where('volumeId').anyOf(volumeIds).delete()
        await db.occupations.where('volumeId').anyOf(volumeIds).delete()
        await db.accessRequests.where('volumeId').anyOf(volumeIds).delete()
        await db.reservations.where('volumeId').anyOf(volumeIds).delete()
      }
      await db.volumes.where('bookId').equals(bookId).delete()
      await db.books.delete(bookId)
    }
  )
}

/** 级联删除册次 → 书叶 → 补纸 / 工序 / 装订（协同表按册次 / 书叶清理） */
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
      db.occupations,
      db.accessRequests,
      db.reservations,
      db.repairTaskOutbox
    ],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
        await db.repairTaskOutbox.where('leafId').anyOf(leafIds).delete()
      }
      await db.leaves.where('volumeId').equals(volumeId).delete()
      await db.bindings.where('volumeId').equals(volumeId).delete()
      await db.occupations.where('volumeId').equals(volumeId).delete()
      await db.accessRequests.where('volumeId').equals(volumeId).delete()
      await db.reservations.where('volumeId').equals(volumeId).delete()
      await db.volumes.delete(volumeId)
    }
  )
}

/** 级联删除书叶 → 补纸 / 工序 / 本侧重试发件箱（不动库房调阅单 / 预约） */
export async function removeLeafCascade(leafId: string): Promise<void> {
  await db.transaction('rw', [db.leaves, db.papers, db.repairOrders, db.repairTaskOutbox], async () => {
    await db.papers.where('leafId').equals(leafId).delete()
    await db.repairOrders.where('leafId').equals(leafId).delete()
    await db.repairTaskOutbox.where('leafId').equals(leafId).delete()
    await db.leaves.delete(leafId)
  })
}
