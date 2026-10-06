<script setup lang="ts">
/**
 * /circulation 库房—修复室占用协同
 * 修复室：开工登记占用、修完解除；历史待认领占用只读等人认。
 * 库房：预约记录照留、登记调阅单；放行前按册次号查占用，
 *       在修 / 待认领占用未解除则挂起调阅单，修完解除后自动回到待放行再放行。
 * 消费 Occupation、AccessRequest、Reservation；复用 StatBadge、EmptyPanel。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Lock, Promotion, RefreshRight, Select, Tickets, Unlock } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBookStore } from '@/stores/bookStore'
import { useCirculationStore } from '@/stores/circulationStore'
import { evaluateRelease } from '@/utils/circulation'
import {
  OCCUPATION_SOURCE_LABEL,
  OCCUPATION_STATUS_COLOR,
  OCCUPATION_STATUS_LABEL,
  createEmptyOccupationDraft,
  type Occupation,
  type OccupationDraft
} from '@/types/occupation'
import {
  ACCESS_STATUS_COLOR,
  ACCESS_STATUS_LABEL,
  createEmptyAccessDraft,
  type AccessRequest,
  type AccessRequestDraft
} from '@/types/accessRequest'
import {
  RESERVATION_STATUS_COLOR,
  RESERVATION_STATUS_LABEL,
  createEmptyReservationDraft,
  type Reservation,
  type ReservationDraft
} from '@/types/reservation'

const bookStore = useBookStore()
const circulationStore = useCirculationStore()

interface VolumeOption {
  value: string
  volumeNo: number
  volumeId: string
  bookTitle: string
  label: string
}

/** 可登记的册次（台账在册），作为开工占用 / 调阅 / 预约的选择来源 */
const volumeOptions = computed<VolumeOption[]>(() =>
  bookStore.books.flatMap((book) =>
    bookStore
      .volumesOfBook(book.id)
      .map((volume) => ({
        value: volume.id,
        volumeNo: volume.volumeNo,
        volumeId: volume.id,
        bookTitle: book.title,
        label: `《${book.title}》第 ${volume.volumeNo} 册`
      }))
  )
)

function optionByVolumeId(volumeId: string): VolumeOption | undefined {
  return volumeOptions.value.find((item) => item.volumeId === volumeId)
}

const stats = computed(() => ({
  active: circulationStore.occupations.filter((item) => item.status === 'active').length,
  unclaimed: circulationStore.occupations.filter((item) => item.status === 'unclaimed').length,
  held: circulationStore.requests.filter((item) => item.status === 'held').length,
  pending: circulationStore.requests.filter((item) => item.status === 'pending').length,
  released: circulationStore.requests.filter((item) => item.status === 'released').length,
  reservations: circulationStore.reservations.length
}))

function statusColor(map: Record<string, string>, status: string): string {
  return map[status] ?? '#8c8c8c'
}
function statusLabel(map: Record<string, string>, status: string): string {
  return map[status] ?? status
}

/* --------------------------- 修复室：占用登记 --------------------------- */
const occDialog = ref(false)
const occForm = reactive(createOccupationForm())
const occVolumeId = ref('')

function createOccupationForm(): OccupationDraft {
  const first = volumeOptions.value[0]
  return createEmptyOccupationDraft(first?.volumeNo ?? 1, first?.volumeId ?? null, first?.bookTitle ?? '')
}

function openOccCreate(): void {
  const first = volumeOptions.value[0]
  if (!first) {
    ElMessage.warning('请先在古籍台账中登记册次')
    return
  }
  occVolumeId.value = first.volumeId
  Object.assign(occForm, createEmptyOccupationDraft(first.volumeNo, first.volumeId, first.bookTitle))
  occDialog.value = true
}

function syncOccVolume(volumeId: string): void {
  const option = optionByVolumeId(volumeId)
  if (!option) return
  occForm.volumeNo = option.volumeNo
  occForm.volumeId = option.volumeId
  occForm.bookTitle = option.bookTitle
}

async function submitOccupation(): Promise<void> {
  if (!occForm.restorer.trim()) {
    ElMessage.warning('请填写接手修复师')
    return
  }
  const existing = circulationStore.activeOccupationOf(occForm.volumeNo)
  if (existing) {
    ElMessage.warning(`第 ${occForm.volumeNo} 册已在修占用中，无需重复登记`)
    return
  }
  await circulationStore.startOccupation({ ...occForm })
  ElMessage.success(`已登记第 ${occForm.volumeNo} 册在修占用，库房放行前会先看到该占用`)
  occDialog.value = false
}

async function releaseOccupation(occupation: Occupation): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认第 ${occupation.volumeNo} 册已修完并解除占用？解除后该册挂起的调阅单将回到待放行。`, '解除修复占用', {
      type: 'warning',
      confirmButtonText: '修完解除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const resumed = await circulationStore.releaseOccupation(occupation.id)
  ElMessage.success(
    resumed.length > 0 ? `占用已解除，${resumed.length} 张挂起调阅单已回到待放行，可去库房放行` : '占用已解除'
  )
}

/* --------------------------- 历史待认领：认领 --------------------------- */
const claimDialog = ref(false)
const claimTarget = ref<Occupation | null>(null)
const claimVolumeId = ref('')

function openClaim(occupation: Occupation): void {
  claimTarget.value = occupation
  claimVolumeId.value = ''
  claimDialog.value = true
}

async function submitClaim(): Promise<void> {
  const target = claimTarget.value
  const option = optionByVolumeId(claimVolumeId.value)
  if (!target || !option) {
    ElMessage.warning('请指认该历史占用对应的在册册次')
    return
  }
  await circulationStore.claimOccupation(target.id, {
    volumeNo: option.volumeNo,
    volumeId: option.volumeId,
    bookTitle: option.bookTitle,
    restorer: occRestorerForClaim.value
  })
  ElMessage.success('已认领并转为在修占用，参与库房占用判定')
  claimDialog.value = false
}
const occRestorerForClaim = ref('待补修复师')

/* ------------------------------ 库房：预约 ------------------------------ */
const rsvDialog = ref(false)
const rsvForm = reactive(createReservationForm())
const rsvVolumeId = ref('')

function createReservationForm(): ReservationDraft {
  const first = volumeOptions.value[0]
  return createEmptyReservationDraft(first?.volumeNo ?? 1, first?.volumeId ?? null, first?.bookTitle ?? '')
}

function openRsvCreate(): void {
  const first = volumeOptions.value[0]
  if (!first) {
    ElMessage.warning('请先在古籍台账中登记册次')
    return
  }
  rsvVolumeId.value = first.volumeId
  Object.assign(rsvForm, createEmptyReservationDraft(first.volumeNo, first.volumeId, first.bookTitle))
  rsvDialog.value = true
}

function syncRsvVolume(volumeId: string): void {
  const option = optionByVolumeId(volumeId)
  if (!option) return
  rsvForm.volumeNo = option.volumeNo
  rsvForm.volumeId = option.volumeId
  rsvForm.bookTitle = option.bookTitle
}

async function submitReservation(): Promise<void> {
  if (!rsvForm.reader.trim()) {
    ElMessage.warning('请填写预约阅览人')
    return
  }
  await circulationStore.createReservation({ ...rsvForm })
  ElMessage.success('预约记录已留存（即使后续调阅被挂起，预约记录也照留）')
  rsvDialog.value = false
}

async function convertReservation(reservation: Reservation): Promise<void> {
  if (reservation.status === 'converted') {
    ElMessage.info('该预约已转调阅')
    return
  }
  const request = await circulationStore.convertReservation(reservation.id, reservation.reader)
  if (request) ElMessage.success(`已由预约生成调阅单 ${request.requestNo}`)
}

/* ----------------------------- 库房：调阅单 ----------------------------- */
const reqDialog = ref(false)
const reqForm = reactive(createAccessForm())
const reqVolumeId = ref('')

function createAccessForm(): AccessRequestDraft {
  const first = volumeOptions.value[0]
  return createEmptyAccessDraft(first?.volumeNo ?? 1, first?.volumeId ?? null, first?.bookTitle ?? '')
}

function openReqCreate(): void {
  const first = volumeOptions.value[0]
  if (!first) {
    ElMessage.warning('请先在古籍台账中登记册次')
    return
  }
  reqVolumeId.value = first.volumeId
  Object.assign(reqForm, createEmptyAccessDraft(first.volumeNo, first.volumeId, first.bookTitle))
  reqDialog.value = true
}

function syncReqVolume(volumeId: string): void {
  const option = optionByVolumeId(volumeId)
  if (!option) return
  reqForm.volumeNo = option.volumeNo
  reqForm.volumeId = option.volumeId
  reqForm.bookTitle = option.bookTitle
  const linked = circulationStore.reservations.find(
    (item) => item.volumeId === option.volumeId && item.status === 'reserved'
  )
  reqForm.reservationId = linked?.id ?? null
  if (linked) reqForm.reader = linked.reader
}

async function submitRequest(): Promise<void> {
  if (!reqForm.reader.trim()) {
    ElMessage.warning('请填写调阅阅览人')
    return
  }
  const created = await circulationStore.createRequest({ ...reqForm })
  // 登记后立即按占用判定放行 / 挂起
  const result = await circulationStore.tryReleaseRequest(created.id)
  if (result.status === 'released') ElMessage.success('无修复占用，调阅单已放行出库房')
  else ElMessage.warning(`占用未解除，调阅单已挂起，预约记录照留。${result.reason}`)
  reqDialog.value = false
}

async function tryRelease(request: AccessRequest): Promise<void> {
  const result = await circulationStore.tryReleaseRequest(request.id)
  if (result.status === 'released') ElMessage.success(`调阅单 ${request.requestNo} 已放行`)
  else ElMessage.warning(result.reason)
}

async function tryReleaseAll(): Promise<void> {
  const { released, held } = await circulationStore.tryReleaseAll()
  if (released > 0) ElMessage.success(`已放行 ${released} 张调阅单`)
  if (held > 0) ElMessage.warning(`${held} 张仍被修复占用挂起，等修完解除后再放行`)
  if (released === 0 && held === 0) ElMessage.info('当前没有待放行的调阅单')
}

async function markReturned(request: AccessRequest): Promise<void> {
  await circulationStore.returnRequest(request.id)
  ElMessage.success('已登记归还')
}

async function cancelRequest(request: AccessRequest): Promise<void> {
  await circulationStore.cancelRequest(request.id)
  ElMessage.success('调阅单已取消（预约记录仍保留）')
}

/** 表格行内预判：未放行时给出当前是否被占用阻塞 */
function precheck(volumeNo: number): { allowed: boolean; reason: string } {
  const decision = evaluateRelease(circulationStore.occupations, volumeNo)
  return { allowed: decision.allowed, reason: decision.reason }
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>库房—修复室占用协同</h2>
        <p>
          修复室接手即登记在修占用、修完解除；库房放行一册前先按册次号查占用，在修 / 待认领占用未解除则挂起调阅单、预约记录照留，等修完再放行。
        </p>
      </div>
    </div>

    <el-alert
      v-if="stats.unclaimed > 0"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 14px"
      title="存在升级回填但对账不出的历史占用（待认领）"
      description="这些记录为旧数据升级时按在修状态回填、按册次号对不上台账而只读留档，需修复室人工指认认领后才参与正常占用 / 解除。"
    />

    <div class="gb-stat-row">
      <StatBadge label="在修占用" :value="stats.active" suffix="册" tone="danger" icon="WarningFilled" />
      <StatBadge label="待认领历史占用" :value="stats.unclaimed" suffix="条" tone="warning" icon="Files" />
      <StatBadge label="挂起调阅单" :value="stats.held" suffix="张" tone="danger" icon="WarningFilled" />
      <StatBadge label="待放行" :value="stats.pending" suffix="张" tone="warning" icon="Histogram" />
      <StatBadge label="已放行" :value="stats.released" suffix="张" tone="success" icon="PieChart" />
      <StatBadge label="预约记录" :value="stats.reservations" suffix="条" tone="info" icon="Files" />
    </div>

    <el-row :gutter="16">
      <!-- 修复室侧 -->
      <el-col :xs="24" :xl="12">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span><el-icon><Lock /></el-icon> 修复室 · 在修占用</span>
              <el-button type="primary" size="small" :icon="Lock" @click="openOccCreate">接手开工登记</el-button>
            </div>
          </template>

          <EmptyPanel
            v-if="circulationStore.occupations.length === 0"
            title="还没有占用记录"
            description="修复室接手一册即在案上开工并登记占用，库房放行前会先看到。"
            action-text="接手开工登记"
            size="small"
            @action="openOccCreate"
          />
          <el-table v-else :data="circulationStore.occupations" size="small" border>
            <el-table-column label="册次" width="90">
              <template #default="{ row }">
                <span v-if="row.volumeNo > 0">第 {{ row.volumeNo }} 册</span>
                <el-tag v-else type="warning" size="small" effect="plain">册次待认</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="bookTitle" label="书名 / 说明" min-width="170" show-overflow-tooltip />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :style="{ color: statusColor(OCCUPATION_STATUS_COLOR, row.status), borderColor: `${statusColor(OCCUPATION_STATUS_COLOR, row.status)}66` }" effect="plain" round size="small">
                  {{ statusLabel(OCCUPATION_STATUS_LABEL, row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="来源" width="90">
              <template #default="{ row }">
                <el-tag effect="plain" round size="small" type="info">
                  {{ OCCUPATION_SOURCE_LABEL[row.source as keyof typeof OCCUPATION_SOURCE_LABEL] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="restorer" label="修复师" width="90" />
            <el-table-column prop="currentStep" label="工序" width="90" show-overflow-tooltip />
            <el-table-column label="操作" width="170">
              <template #default="{ row }">
                <el-button v-if="row.status === 'active'" size="small" text type="success" :icon="Unlock" @click="releaseOccupation(row)">
                  修完解除
                </el-button>
                <el-button v-else-if="row.status === 'unclaimed'" size="small" text type="warning" :icon="Select" @click="openClaim(row)">
                  认领指认
                </el-button>
                <el-tag v-else size="small" type="success" effect="plain">已解除 {{ row.releaseDate }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
          <p class="gb-muted" style="margin: 8px 0 0">
            待认领记录只读留档，不允许直接解除；认领指认在册册次后转为在修占用。
          </p>
        </el-card>
      </el-col>

      <!-- 库房侧：预约 + 调阅 -->
      <el-col :xs="24" :xl="12">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span><el-icon><Tickets /></el-icon> 库房 · 预约记录（照留）</span>
              <el-button size="small" :icon="Tickets" @click="openRsvCreate">登记预约</el-button>
            </div>
          </template>
          <el-table :data="circulationStore.reservations" size="small" border>
            <el-table-column label="预约单号" prop="reservationNo" width="140" />
            <el-table-column label="册次" width="80">
              <template #default="{ row }">第 {{ row.volumeNo }} 册</template>
            </el-table-column>
            <el-table-column prop="reader" label="阅览人" width="80" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :style="{ color: statusColor(RESERVATION_STATUS_COLOR, row.status), borderColor: `${statusColor(RESERVATION_STATUS_COLOR, row.status)}66` }" effect="plain" round size="small">
                  {{ statusLabel(RESERVATION_STATUS_LABEL, row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110">
              <template #default="{ row }">
                <el-button size="small" text type="primary" :disabled="row.status === 'converted'" @click="convertReservation(row)">
                  转调阅
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span><el-icon><Promotion /></el-icon> 库房 · 调阅单放行</span>
              <div style="display: flex; gap: 8px">
                <el-button size="small" :icon="RefreshRight" @click="tryReleaseAll">一键放行无占用册</el-button>
                <el-button type="primary" size="small" :icon="Promotion" @click="openReqCreate">登记调阅单</el-button>
              </div>
            </div>
          </template>

          <EmptyPanel
            v-if="circulationStore.requests.length === 0"
            title="还没有调阅单"
            description="库房放行一册前先看修复室有没有在修占用；占用未解除的先挂起，预约记录照留，等修完再放行。"
            action-text="登记调阅单"
            size="small"
            @action="openReqCreate"
          />
          <el-table v-else :data="circulationStore.requests" size="small" border>
            <el-table-column label="调阅单号" prop="requestNo" width="140" />
            <el-table-column label="册次" width="72">
              <template #default="{ row }">第 {{ row.volumeNo }} 册</template>
            </el-table-column>
            <el-table-column prop="bookTitle" label="书名" min-width="120" show-overflow-tooltip />
            <el-table-column prop="reader" label="阅览人" width="72" />
            <el-table-column label="状态" width="84">
              <template #default="{ row }">
                <el-tag :style="{ color: statusColor(ACCESS_STATUS_COLOR, row.status), borderColor: `${statusColor(ACCESS_STATUS_COLOR, row.status)}66` }" effect="plain" round size="small">
                  {{ statusLabel(ACCESS_STATUS_LABEL, row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="占用判定 / 挂起原因" min-width="150">
              <template #default="{ row }">
                <span v-if="row.status === 'held'" class="gb-muted">{{ row.holdReason }}</span>
                <el-tag v-else-if="row.status === 'pending' || row.status === 'returned' || row.status === 'cancelled'" size="small" :type="precheck(row.volumeNo).allowed ? 'success' : 'danger'" effect="plain">
                  {{ precheck(row.volumeNo).allowed ? '当前无占用，可放行' : '仍有占用阻塞' }}
                </el-tag>
                <span v-else class="gb-muted">已出库房 {{ row.releaseDate }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180">
              <template #default="{ row }">
                <el-button
                  v-if="row.status === 'pending' || row.status === 'held'"
                  size="small"
                  text
                  type="primary"
                  @click="tryRelease(row)"
                >
                  放行
                </el-button>
                <el-button v-if="row.status === 'released'" size="small" text type="success" @click="markReturned(row)">
                  归还
                </el-button>
                <el-button
                  v-if="row.status === 'pending' || row.status === 'held'"
                  size="small"
                  text
                  type="info"
                  @click="cancelRequest(row)"
                >
                  取消
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 修复室：开工占用登记 -->
    <el-dialog v-model="occDialog" title="修复室接手开工 · 登记在修占用" width="520px">
      <el-form label-width="92px">
        <el-form-item label="指认册次" required>
          <el-select v-model="occVolumeId" filterable style="width: 100%" @change="syncOccVolume">
            <el-option v-for="item in volumeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="接手修复师" required>
          <el-input v-model="occForm.restorer" placeholder="如：沈玉" />
        </el-form-item>
        <el-form-item label="开工工序">
          <el-input v-model="occForm.currentStep" placeholder="如：托裱" />
        </el-form-item>
        <el-form-item label="开工日期">
          <el-input v-model="occForm.startDate" type="date" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="occDialog = false">取消</el-button>
        <el-button type="primary" @click="submitOccupation">登记占用</el-button>
      </template>
    </el-dialog>

    <!-- 历史待认领：认领指认 -->
    <el-dialog v-model="claimDialog" title="认领历史待认领占用" width="520px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 10px"
        :title="claimTarget?.bookTitle ?? ''"
        :description="claimTarget?.note ?? ''"
      />
      <el-form label-width="92px">
        <el-form-item label="指认册次" required>
          <el-select v-model="claimVolumeId" filterable placeholder="该历史占用实际对应哪一在册册次" style="width: 100%">
            <el-option v-for="item in volumeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="修复师">
          <el-input v-model="occRestorerForClaim" placeholder="如：沈玉" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="claimDialog = false">取消</el-button>
        <el-button type="warning" @click="submitClaim">认领并转为在修占用</el-button>
      </template>
    </el-dialog>

    <!-- 库房：预约登记 -->
    <el-dialog v-model="rsvDialog" title="库房登记阅览预约" width="520px">
      <el-form label-width="92px">
        <el-form-item label="指认册次" required>
          <el-select v-model="rsvVolumeId" filterable style="width: 100%" @change="syncRsvVolume">
            <el-option v-for="item in volumeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="阅览人" required>
          <el-input v-model="rsvForm.reader" placeholder="如：周衡" />
        </el-form-item>
        <el-form-item label="到馆日期">
          <el-input v-model="rsvForm.reserveDate" type="date" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rsvDialog = false">取消</el-button>
        <el-button type="primary" @click="submitReservation">留存预约</el-button>
      </template>
    </el-dialog>

    <!-- 库房：调阅登记 -->
    <el-dialog v-model="reqDialog" title="库房登记调阅单" width="520px">
      <el-form label-width="92px">
        <el-form-item label="指认册次" required>
          <el-select v-model="reqVolumeId" filterable style="width: 100%" @change="syncReqVolume">
            <el-option v-for="item in volumeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="阅览人" required>
          <el-input v-model="reqForm.reader" placeholder="如：周衡" />
        </el-form-item>
        <el-form-item label="关联预约">
          <el-tag v-if="reqForm.reservationId" type="info" effect="plain">已关联一条在册预约（照留）</el-tag>
          <span v-else class="gb-muted">无预约直接调阅</span>
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="保存后立即按修复占用判定：无占用即放行；在修 / 待认领占用未解除则挂起，预约记录照留。"
      />
      <template #footer>
        <el-button @click="reqDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRequest">登记并判定放行</el-button>
      </template>
    </el-dialog>
  </div>
</template>
