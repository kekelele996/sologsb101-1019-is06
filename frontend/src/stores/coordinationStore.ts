/**
 * 库房 ↔ 修复室协调 store（Pinia setup store）
 *
 * 持有在修占用、调阅单、预约三张表；核心规则：
 * - 库房放行一册前先查修复室在修占用：active 占用未解除 → 调阅单挂起（held），
 *   预约记录照留；修完解除占用后挂起单自动转「待放行（ready）」。
 * - 修复室只读写占用表；登记工序的本侧重试不在此 store（见 utils/repairDesk），
 *   其重试绝不触碰调阅单 / 预约。
 * - 历史回填证据不足的占用 needsReview=true，只读，等修复室人工认领。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import type { Occupancy } from '@/types/occupancy'
import { isOccupying } from '@/types/occupancy'
import type { AccessRequest } from '@/types/accessRequest'
import type { Reservation } from '@/types/reservation'

export const useCoordinationStore = defineStore('coordination', () => {
  const occupancies = ref<Occupancy[]>([])
  const requests = ref<AccessRequest[]>([])
  const reservations = ref<Reservation[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      const [occ, req, res] = await Promise.all([
        db.occupancies.toArray(),
        db.accessRequests.toArray(),
        db.reservations.toArray()
      ])
      occupancies.value = occ.sort((a, b) => b.updatedAt - a.updatedAt)
      requests.value = req.sort((a, b) => b.updatedAt - a.updatedAt)
      reservations.value = res.sort((a, b) => b.updatedAt - a.updatedAt)
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '协调数据读取失败'
    } finally {
      loading.value = false
    }
  }

  /* ------------------------------- 占用 ------------------------------- */

  /** 当前阻塞某册次的在修占用（active 且非待认领） */
  const activeOccupancyOf = (volumeId: string): Occupancy | undefined =>
    occupancies.value.find((occ) => occ.volumeId === volumeId && isOccupying(occ))

  const isVolumeOccupied = (volumeId: string): boolean => activeOccupancyOf(volumeId) !== undefined

  const activeOccupancies = computed<Occupancy[]>(() => occupancies.value.filter(isOccupying))

  /** 历史回填证据不足、等人认领的占用（只读） */
  const reviewOccupancies = computed<Occupancy[]>(() => occupancies.value.filter((occ) => occ.needsReview))

  /** 修复室接手一册：登记在修占用（已有 active 占用则不重复登记） */
  async function occupy(volumeId: string, operator: string): Promise<Occupancy | null> {
    if (activeOccupancyOf(volumeId)) return null
    const now = Date.now()
    const row: Occupancy = {
      id: createId('occ'),
      volumeId,
      startAt: now,
      endAt: null,
      releaseNote: '',
      status: 'active',
      source: 'desk',
      needsReview: false,
      confirmedAt: now,
      operator,
      createdAt: now,
      updatedAt: now
    }
    await db.occupancies.put(row)
    await loadAll()
    return row
  }

  /**
   * 修完解除占用，并把因此挂起的调阅单自动转为「待放行」。
   * 预约记录原样保留；不撤销、不改写任何调阅单字段以外的修复室数据。
   */
  async function releaseOccupancy(occupancyId: string, note: string): Promise<number> {
    const occ = occupancies.value.find((item) => item.id === occupancyId)
    if (!occ || occ.status !== 'active') return 0
    const now = Date.now()
    let unblocked = 0
    await db.transaction('rw', [db.occupancies, db.accessRequests], async () => {
      await db.occupancies.put({ ...occ, status: 'released', endAt: now, releaseNote: note, updatedAt: now })
      if (occ.volumeId) {
        const held = (await db.accessRequests.where('volumeId').equals(occ.volumeId).toArray()).filter(
          (req) => req.state === 'held'
        )
        unblocked = held.length
        for (const req of held) {
          await db.accessRequests.put({
            ...req,
            state: 'ready',
            blockedByOccupancyId: null,
            heldReason: '',
            updatedAt: now
          })
        }
      }
    })
    await loadAll()
    return unblocked
  }

  /**
   * 人工认领历史回填占用：补登记册次、开工时间与负责人，
   * 解除只读待认领状态；认领后立即按在修占用参与库房判断。
   */
  async function claimOccupancy(
    occupancyId: string,
    patch: { volumeId: string; startAt: number; operator: string }
  ): Promise<void> {
    const occ = occupancies.value.find((item) => item.id === occupancyId)
    if (!occ || !occ.needsReview) return
    const now = Date.now()
    await db.occupancies.put({
      ...occ,
      volumeId: patch.volumeId,
      startAt: patch.startAt,
      operator: patch.operator,
      needsReview: false,
      confirmedAt: now,
      updatedAt: now
    })
    await loadAll()
  }

  /* ------------------------------ 调阅单 ------------------------------ */

  /**
   * 库房提交调阅申请：放行前先查修复室占用。
   * - 无占用：直接进入待审核 reviewing
   * - 占用未解除：挂起 held，记下阻塞占用，预约照留（不动修复室任何数据）
   */
  async function submitRequest(input: {
    volumeId: string
    reservationId: string | null
    reader: string
    purpose: string
    requestNo: string
  }): Promise<AccessRequest> {
    const now = Date.now()
    const blocking = activeOccupancyOf(input.volumeId)
    const row: AccessRequest = {
      id: createId('req'),
      requestNo: input.requestNo || `DY-${now.toString(36)}`,
      volumeId: input.volumeId,
      reservationId: input.reservationId,
      reader: input.reader,
      purpose: input.purpose,
      state: blocking ? 'held' : 'reviewing',
      blockedByOccupancyId: blocking ? blocking.id : null,
      heldReason: blocking ? `修复室在修占用（${blocking.operator || '负责人未登记'} 接手，尚未修完归还）` : '',
      requestDate: new Date().toISOString().slice(0, 10),
      lentAt: null,
      createdAt: now,
      updatedAt: now
    }
    await db.accessRequests.put(row)
    if (input.reservationId) {
      await db.reservations.update(input.reservationId, { requestId: row.id, updatedAt: now } as never)
    }
    await loadAll()
    return row
  }

  /**
   * 库房放行：只有当前没有在修占用才放行（reviewing / ready 可放行）。
   * held 单子占用解除后会先变 ready，再由库房人工放行，避免自动出库。
   */
  async function lendRequest(requestId: string): Promise<{ ok: boolean; reason: string }> {
    const req = requests.value.find((item) => item.id === requestId)
    if (!req) return { ok: false, reason: '调阅单不存在' }
    if (req.state === 'held') return { ok: false, reason: '该册仍在修复室占用中，调阅单挂起，暂不能放行' }
    if (req.state !== 'reviewing' && req.state !== 'ready') {
      return { ok: false, reason: '当前状态不可放行' }
    }
    const blocking = activeOccupancyOf(req.volumeId)
    if (blocking) {
      const now = Date.now()
      await db.accessRequests.put({
        ...req,
        state: 'held',
        blockedByOccupancyId: blocking.id,
        heldReason: `修复室在修占用（${blocking.operator || '负责人未登记'} 接手，尚未修完归还）`,
        updatedAt: now
      })
      await loadAll()
      return { ok: false, reason: '放行时发现修复室已开工占用，调阅单已挂起' }
    }
    const now = Date.now()
    await db.transaction('rw', [db.accessRequests, db.reservations], async () => {
      await db.accessRequests.put({ ...req, state: 'lent', lentAt: now, updatedAt: now })
      if (req.reservationId) {
        await db.reservations.update(req.reservationId, { state: 'fulfilled', updatedAt: now } as never)
      }
    })
    await loadAll()
    return { ok: true, reason: '已放行到阅览' }
  }

  async function returnRequest(requestId: string): Promise<void> {
    const req = requests.value.find((item) => item.id === requestId)
    if (!req || req.state !== 'lent') return
    await db.accessRequests.put({ ...req, state: 'returned', updatedAt: Date.now() })
    await loadAll()
  }

  async function cancelRequest(requestId: string): Promise<void> {
    const req = requests.value.find((item) => item.id === requestId)
    if (!req) return
    await db.accessRequests.put({ ...req, state: 'cancelled', updatedAt: Date.now() })
    await loadAll()
  }

  /* ------------------------------- 预约 ------------------------------- */

  async function createReservation(input: {
    volumeId: string
    reader: string
    reserveDate: string
    reserveNo: string
    note: string
  }): Promise<Reservation> {
    const now = Date.now()
    const row: Reservation = {
      id: createId('res'),
      reserveNo: input.reserveNo || `YY-${now.toString(36)}`,
      volumeId: input.volumeId,
      reader: input.reader,
      reserveDate: input.reserveDate,
      state: 'active',
      requestId: null,
      note: input.note,
      createdAt: now,
      updatedAt: now
    }
    await db.reservations.put(row)
    await loadAll()
    return row
  }

  async function closeReservation(reservationId: string): Promise<void> {
    const res = reservations.value.find((item) => item.id === reservationId)
    if (!res || res.state !== 'active') return
    await db.reservations.put({ ...res, state: 'closed', updatedAt: Date.now() })
    await loadAll()
  }

  const heldCount = computed(() => requests.value.filter((req) => req.state === 'held').length)
  const readyCount = computed(() => requests.value.filter((req) => req.state === 'ready').length)

  return {
    occupancies,
    requests,
    reservations,
    loading,
    ready,
    error,
    activeOccupancies,
    reviewOccupancies,
    heldCount,
    readyCount,
    loadAll,
    activeOccupancyOf,
    isVolumeOccupied,
    occupy,
    releaseOccupancy,
    claimOccupancy,
    submitRequest,
    lendRequest,
    returnRequest,
    cancelRequest,
    createReservation,
    closeReservation
  }
})
