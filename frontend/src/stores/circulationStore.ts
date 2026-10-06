/**
 * 库房—修复室协同 store（Pinia setup store）
 * 维护修复占用、库房调阅单与预约记录：
 * - 库房放行前按册次号查占用，在修 / 待认领占用未解除则挂起调阅单，预约记录照留；
 * - 修复室开工登记占用、修完解除占用；解除后把挂起的调阅单自动回到「待放行」；
 * - 历史待认领占用只读，等人来认领后才参与正常占用 / 解除。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createBizNo, createId, db } from '@/utils/db'
import { decideRequestPatch } from '@/utils/circulation'
import type { Occupation, OccupationDraft } from '@/types/occupation'
import type { AccessRequest, AccessRequestDraft } from '@/types/accessRequest'
import type { Reservation, ReservationDraft } from '@/types/reservation'

export const useCirculationStore = defineStore('circulation', () => {
  const occupations = ref<Occupation[]>([])
  const requests = ref<AccessRequest[]>([])
  const reservations = ref<Reservation[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      const [occ, req, rsv] = await Promise.all([
        db.occupations.toArray(),
        db.accessRequests.toArray(),
        db.reservations.toArray()
      ])
      occupations.value = occ.sort((a, b) => b.updatedAt - a.updatedAt)
      requests.value = req.sort((a, b) => b.updatedAt - a.updatedAt)
      reservations.value = rsv.sort((a, b) => b.updatedAt - a.updatedAt)
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '协同数据读取失败'
    } finally {
      loading.value = false
    }
  }

  /* ------------------------------- 占用 ------------------------------- */

  function activeOccupationOf(volumeNo: number): Occupation | undefined {
    return occupations.value.find((item) => item.volumeNo === volumeNo && item.status === 'active')
  }

  const activeOccupations = computed<Occupation[]>(() =>
    occupations.value.filter((item) => item.status === 'active')
  )
  const unclaimedOccupations = computed<Occupation[]>(() =>
    occupations.value.filter((item) => item.status === 'unclaimed')
  )

  /** 修复室接手一册开工：登记在修占用（同册已有在修占用则直接返回） */
  async function startOccupation(draft: OccupationDraft): Promise<Occupation> {
    const existing = activeOccupationOf(draft.volumeNo)
    if (existing) return existing
    const now = Date.now()
    const row: Occupation = { ...draft, id: createId('occ'), createdAt: now, updatedAt: now }
    await db.occupations.put(row)
    await loadAll()
    return row
  }

  /**
   * 修复室修完解除占用：占用置为已解除；
   * 同时把该册「已挂起」的调阅单自动回到「待放行」（修完再放行，预约记录始终照留）。
   */
  async function releaseOccupation(id: string): Promise<AccessRequest[]> {
    const occupation = occupations.value.find((item) => item.id === id)
    const today = new Date().toISOString().slice(0, 10)
    const resumed: AccessRequest[] = []
    await db.transaction('rw', [db.occupations, db.accessRequests], async () => {
      if (occupation) {
        await db.occupations.update(id, {
          status: 'released',
          releaseDate: today,
          updatedAt: Date.now()
        } as never)
      }
      if (occupation) {
        const held = await db.accessRequests
          .where('status')
          .equals('held')
          .toArray()
        for (const request of held.filter((item) => item.volumeNo === occupation.volumeNo)) {
          await db.accessRequests.update(request.id, {
            status: 'pending',
            holdReason: '',
            updatedAt: Date.now()
          } as never)
          resumed.push(request)
        }
      }
    })
    await loadAll()
    return resumed
  }

  /**
   * 认领历史待认领占用：只读记录等人认，认领时由修复室指认册次号 / 册次并转为在修占用。
   */
  async function claimOccupation(
    id: string,
    patch: Pick<Occupation, 'volumeNo' | 'volumeId' | 'bookTitle' | 'restorer'>
  ): Promise<void> {
    await db.occupations.update(id, {
      ...patch,
      status: 'active',
      note: '历史待认领占用已人工指认',
      updatedAt: Date.now()
    } as never)
    await loadAll()
  }

  async function updateOccupation(id: string, patch: Partial<Occupation>): Promise<void> {
    await db.occupations.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  /** 装订验收合格归档时联动：解除该册在修占用（待认领历史占用不动），并恢复挂起调阅单 */
  async function releaseActiveByVolumeId(volumeId: string): Promise<number> {
    const occupation = occupations.value.find((item) => item.volumeId === volumeId && item.status === 'active')
    if (!occupation) return 0
    const resumed = await releaseOccupation(occupation.id)
    return resumed.length
  }

  /* ------------------------------ 调阅单 ------------------------------ */

  async function createRequest(draft: AccessRequestDraft): Promise<AccessRequest> {
    const now = Date.now()
    const row: AccessRequest = {
      ...draft,
      requestNo: draft.requestNo || createBizNo('DY'),
      id: createId('req'),
      createdAt: now,
      updatedAt: now
    }
    await db.accessRequests.put(row)
    await loadAll()
    return row
  }

  /**
   * 库房放行一册前先看修复室占用：占用未解除则挂起（预约记录不动），否则放行。
   * 返回最终落库状态与说明，由页面给出提示。
   */
  async function tryReleaseRequest(id: string): Promise<{ status: AccessRequest['status']; reason: string }> {
    const request = requests.value.find((item) => item.id === id)
    if (!request) return { status: 'pending', reason: '调阅单不存在' }
    const patch = decideRequestPatch(request, occupations.value)
    await db.accessRequests.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
    return {
      status: patch.status,
      reason: patch.status === 'held' ? patch.holdReason : ''
    }
  }

  /** 一键放行当前所有无占用阻塞的待处理调阅单；仍被占用的继续挂起 */
  async function tryReleaseAll(): Promise<{ released: number; held: number }> {
    let released = 0
    let held = 0
    const candidates = requests.value.filter((item) => item.status === 'pending' || item.status === 'held')
    for (const request of candidates) {
      const result = await tryReleaseRequest(request.id)
      if (result.status === 'released') released += 1
      else held += 1
    }
    return { released, held }
  }

  async function returnRequest(id: string): Promise<void> {
    await db.accessRequests.update(id, { status: 'returned', updatedAt: Date.now() } as never)
    await loadAll()
  }

  async function cancelRequest(id: string): Promise<void> {
    await db.accessRequests.update(id, { status: 'cancelled', updatedAt: Date.now() } as never)
    await loadAll()
  }

  /* ------------------------------ 预约记录 ------------------------------ */

  async function createReservation(draft: ReservationDraft): Promise<Reservation> {
    const now = Date.now()
    const row: Reservation = {
      ...draft,
      reservationNo: draft.reservationNo || createBizNo('YY'),
      id: createId('rsv'),
      createdAt: now,
      updatedAt: now
    }
    await db.reservations.put(row)
    await loadAll()
    return row
  }

  /** 由预约记录转调阅单：预约照留并标记已转调阅，双向回填关联 id */
  async function convertReservation(reservationId: string, reader: string): Promise<AccessRequest | null> {
    const reservation = reservations.value.find((item) => item.id === reservationId)
    if (!reservation) return null
    const draft: AccessRequestDraft = {
      requestNo: createBizNo('DY'),
      volumeNo: reservation.volumeNo,
      volumeId: reservation.volumeId,
      bookTitle: reservation.bookTitle,
      reader: reader || reservation.reader,
      reservationId: reservation.id,
      status: 'pending',
      holdReason: '',
      applyDate: new Date().toISOString().slice(0, 10),
      releaseDate: ''
    }
    const request = await createRequest(draft)
    await db.reservations.update(reservation.id, {
      status: 'converted',
      requestId: request.id,
      updatedAt: Date.now()
    } as never)
    await loadAll()
    return request
  }

  async function updateReservation(id: string, patch: Partial<Reservation>): Promise<void> {
    await db.reservations.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  return {
    occupations,
    requests,
    reservations,
    loading,
    ready,
    error,
    activeOccupations,
    unclaimedOccupations,
    loadAll,
    activeOccupationOf,
    startOccupation,
    releaseOccupation,
    releaseActiveByVolumeId,
    claimOccupation,
    updateOccupation,
    createRequest,
    tryReleaseRequest,
    tryReleaseAll,
    returnRequest,
    cancelRequest,
    createReservation,
    convertReservation,
    updateReservation
  }
})
