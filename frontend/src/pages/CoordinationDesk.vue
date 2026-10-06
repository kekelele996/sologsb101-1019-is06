<script setup lang="ts">
/**
 * /desk 库房 ↔ 修复室占用协调台
 * 库房：预约记录、调阅单（放行前先查在修占用，占用未解除则挂起，预约照留）
 * 修复室：在修占用（接手占用 / 修完解除，挂起单自动转待放行）
 * 历史回填证据不足的占用只读，等修复室人工认领。
 * 消费 Occupancy、AccessRequest、Reservation；复用 <StatBadge>、<EmptyPanel>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, Lock, Promotion, RefreshRight, Select, Timer } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBookStore } from '@/stores/bookStore'
import { useCoordinationStore } from '@/stores/coordinationStore'
import { BINDING_TYPE_LABEL, VOLUME_STATE_LABEL } from '@/types/volume'
import {
  OCCUPANCY_SOURCE_LABEL,
  OCCUPANCY_STATUS_COLOR,
  OCCUPANCY_STATUS_LABEL
} from '@/types/occupancy'
import { ACCESS_STATE_COLOR, ACCESS_STATE_LABEL } from '@/types/accessRequest'
import { RESERVATION_STATE_COLOR, RESERVATION_STATE_LABEL } from '@/types/reservation'

const bookStore = useBookStore()
const coord = useCoordinationStore()
const activeTab = ref<'stacks' | 'desk' | 'review'>('stacks')

function volumeLabel(volumeId: string | null): string {
  if (!volumeId) return '册次待认领'
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册 · ${BINDING_TYPE_LABEL[volume.bindingType]}`
}

function formatTime(value: number | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

const stats = computed(() => ({
  occupying: coord.activeOccupancies.length,
  held: coord.heldCount,
  ready: coord.readyCount,
  review: coord.reviewOccupancies.length
}))

/* ------------------------------ 库房：预约 ------------------------------ */
const reserveDialog = ref(false)
const reserveForm = reactive({ volumeId: '', reader: '', reserveDate: new Date().toISOString().slice(0, 10), note: '' })
const reserveVolumeOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => ({
      value: volume.id,
      label: `《${book.title}》第 ${volume.volumeNo} 册 · ${VOLUME_STATE_LABEL[volume.state]}`,
      occupied: coord.isVolumeOccupied(volume.id)
    }))
  )
)

function openReserve(): void {
  const first = reserveVolumeOptions.value[0]
  reserveForm.volumeId = first?.value ?? ''
  reserveForm.reader = ''
  reserveForm.reserveDate = new Date().toISOString().slice(0, 10)
  reserveForm.note = ''
  reserveDialog.value = true
}

async function submitReserve(): Promise<void> {
  if (!reserveForm.volumeId || !reserveForm.reader.trim()) {
    ElMessage.warning('请选择册次并填写预约人')
    return
  }
  await coord.createReservation({
    volumeId: reserveForm.volumeId,
    reader: reserveForm.reader.trim(),
    reserveDate: reserveForm.reserveDate,
    reserveNo: '',
    note: reserveForm.note
  })
  ElMessage.success('预约已登记，记录照留')
  reserveDialog.value = false
}

/* ----------------------------- 库房：调阅单 ----------------------------- */
const requestDialog = ref(false)
const requestForm = reactive({ volumeId: '', reservationId: '' as string | null, reader: '', purpose: '' })

const requestVolumeOptions = computed(() =>
  reserveVolumeOptions.value.map((item) => ({ ...item }))
)

function openRequest(reservationId?: string): void {
  const preset = reservationId ? coord.reservations.find((item) => item.id === reservationId) : undefined
  requestForm.volumeId = preset?.volumeId ?? reserveVolumeOptions.value[0]?.value ?? ''
  requestForm.reservationId = preset?.id ?? null
  requestForm.reader = preset?.reader ?? ''
  requestForm.purpose = ''
  requestDialog.value = true
}

async function submitRequest(): Promise<void> {
  if (!requestForm.volumeId || !requestForm.reader.trim()) {
    ElMessage.warning('请选择册次并填写调阅人')
    return
  }
  const row = await coord.submitRequest({
    volumeId: requestForm.volumeId,
    reservationId: requestForm.reservationId,
    reader: requestForm.reader.trim(),
    purpose: requestForm.purpose,
    requestNo: ''
  })
  if (row.state === 'held') {
    ElMessage.warning('修复室正在占用该册，调阅单已挂起，预约照留，修完再放行')
  } else {
    ElMessage.success('调阅单已提交，库房可放行')
  }
  requestDialog.value = false
}

async function lend(reqId: string): Promise<void> {
  const result = await coord.lendRequest(reqId)
  if (result.ok) ElMessage.success(result.reason)
  else ElMessage.warning(result.reason)
}

async function giveBack(reqId: string): Promise<void> {
  await coord.returnRequest(reqId)
  ElMessage.success('已归还入库')
}

async function cancelReq(reqId: string): Promise<void> {
  try {
    await ElMessageBox.confirm('撤销后调阅单不再放行（预约记录保留）。', '撤销调阅单', {
      type: 'warning',
      confirmButtonText: '确认撤销',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await coord.cancelRequest(reqId)
  ElMessage.success('调阅单已撤销')
}

/* --------------------------- 修复室：在修占用 --------------------------- */
const occupyDialog = ref(false)
const occupyForm = reactive({ volumeId: '', operator: '' })

function openOccupy(): void {
  const free = reserveVolumeOptions.value.find((item) => !item.occupied)
  occupyForm.volumeId = free?.value ?? reserveVolumeOptions.value[0]?.value ?? ''
  occupyForm.operator = ''
  occupyDialog.value = true
}

async function submitOccupy(): Promise<void> {
  if (!occupyForm.volumeId || !occupyForm.operator.trim()) {
    ElMessage.warning('请选择册次并填写修复负责人')
    return
  }
  const row = await coord.occupy(occupyForm.volumeId, occupyForm.operator.trim())
  if (!row) {
    ElMessage.warning('该册已有在修占用，勿重复接手')
    return
  }
  ElMessage.success('已接手开工，库房放行前会看到在修占用')
  occupyDialog.value = false
}

async function release(occId: string): Promise<void> {
  const { value } = await ElMessageBox.prompt('登记修完说明，解除占用后挂起的调阅单自动转待放行。', '修完解除占用', {
    confirmButtonText: '解除占用',
    cancelButtonText: '取消',
    inputPlaceholder: '如：全部工序完成，待装订验收'
  }).catch(() => ({ value: null }))
  if (value === null || value === undefined) return
  const count = await coord.releaseOccupancy(occId, String(value))
  ElMessage.success(count > 0 ? `占用已解除，${count} 张挂起调阅单转待放行` : '占用已解除')
}

/* --------------------------- 历史占用人工认领 --------------------------- */
const claimDialog = ref(false)
const claimTargetId = ref('')
const claimForm = reactive({ volumeId: '', startDate: new Date().toISOString().slice(0, 10), operator: '' })

function openClaim(occId: string): void {
  claimTargetId.value = occId
  claimForm.volumeId = reserveVolumeOptions.value[0]?.value ?? ''
  claimForm.startDate = new Date().toISOString().slice(0, 10)
  claimForm.operator = ''
  claimDialog.value = true
}

async function submitClaim(): Promise<void> {
  if (!claimForm.volumeId || !claimForm.operator.trim()) {
    ElMessage.warning('请认领册次并填写修复负责人')
    return
  }
  const startAt = new Date(`${claimForm.startDate}T00:00:00`).getTime()
  await coord.claimOccupancy(claimTargetId.value, {
    volumeId: claimForm.volumeId,
    startAt,
    operator: claimForm.operator.trim()
  })
  ElMessage.success('历史占用已认领，开始按在修占用参与放行判断')
  claimDialog.value = false
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>库房 ↔ 修复室占用协调</h2>
        <p>库房放行一册前先查修复室在修占用：占用未解除的调阅单挂起、预约照留，修完解除再放行。</p>
      </div>
      <div class="gb-toolbar">
        <el-button v-if="activeTab === 'stacks'" type="primary" :icon="Timer" @click="openReserve">登记预约</el-button>
        <el-button v-if="activeTab === 'stacks'" type="primary" plain :icon="Promotion" @click="openRequest()">开调阅单</el-button>
        <el-button v-if="activeTab === 'desk'" type="primary" :icon="Select" @click="openOccupy">接手开工</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="在修占用" :value="stats.occupying" suffix="册" tone="warning" />
      <StatBadge label="占用挂起调阅单" :value="stats.held" suffix="张" tone="warning" />
      <StatBadge label="修完待放行" :value="stats.ready" suffix="张" tone="primary" />
      <StatBadge label="历史占用待认领" :value="stats.review" suffix="条" tone="info" />
    </div>

    <el-tabs v-model="activeTab" class="gb-panel">
      <!-- ============================ 库房 ============================ -->
      <el-tab-pane name="stacks">
        <template #label>
          <span><el-icon><Timer /></el-icon> 库房调阅与预约</span>
        </template>

        <h3 class="gb-sub-title">调阅单（放行前查占用）</h3>
        <el-card v-if="coord.requests.length === 0" shadow="never">
          <EmptyPanel
            title="还没有调阅单"
            description="开调阅单时会先查修复室在修占用：占用中自动挂起，修完解除后转待放行。"
            action-text="开调阅单"
            @action="openRequest()"
          />
        </el-card>
        <el-table v-else :data="coord.requests" size="small" border style="margin-bottom: 20px">
          <el-table-column label="单号" prop="requestNo" width="140" />
          <el-table-column label="册次" min-width="200">
            <template #default="{ row }">{{ volumeLabel(row.volumeId) }}</template>
          </el-table-column>
          <el-table-column label="调阅人" prop="reader" width="160" />
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag
                effect="plain"
                round
                :style="{ color: ACCESS_STATE_COLOR[row.state as keyof typeof ACCESS_STATE_COLOR], borderColor: `${ACCESS_STATE_COLOR[row.state as keyof typeof ACCESS_STATE_COLOR]}66` }"
              >
                {{ ACCESS_STATE_LABEL[row.state as keyof typeof ACCESS_STATE_LABEL] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="说明" min-width="220">
            <template #default="{ row }">
              <span v-if="row.state === 'held'" class="gb-muted">
                <el-icon style="vertical-align: -2px"><Lock /></el-icon>
                {{ row.heldReason }}
              </span>
              <span v-else-if="row.state === 'ready'" class="gb-muted">修复室已修完解除占用，待库房放行</span>
              <span v-else-if="row.state === 'lent'" class="gb-muted">放行于 {{ formatTime(row.lentAt) }}</span>
              <span v-else class="gb-muted">{{ row.purpose || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="220" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.state === 'reviewing' || row.state === 'ready'"
                size="small"
                type="primary"
                text
                :icon="Promotion"
                @click="lend(row.id)"
              >
                {{ row.state === 'ready' ? '放行（修完）' : '放行' }}
              </el-button>
              <el-button v-if="row.state === 'lent'" size="small" type="success" text :icon="CircleCheck" @click="giveBack(row.id)">
                归还
              </el-button>
              <el-button
                v-if="row.state === 'held'"
                size="small"
                text
                disabled
              >
                等修复室修完
              </el-button>
              <el-button
                v-if="row.state === 'reviewing' || row.state === 'held' || row.state === 'ready'"
                size="small"
                type="danger"
                text
                @click="cancelReq(row.id)"
              >
                撤销
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <h3 class="gb-sub-title">预约记录（挂起期间照留）</h3>
        <el-card v-if="coord.reservations.length === 0" shadow="never">
          <EmptyPanel title="还没有预约记录" description="预约独立保留，调阅单挂起也不删除预约。" action-text="登记预约" @action="openReserve" />
        </el-card>
        <el-table v-else :data="coord.reservations" size="small" border>
          <el-table-column label="预约号" prop="reserveNo" width="140" />
          <el-table-column label="册次" min-width="200">
            <template #default="{ row }">{{ volumeLabel(row.volumeId) }}</template>
          </el-table-column>
          <el-table-column label="预约人" prop="reader" width="160" />
          <el-table-column label="到馆日期" prop="reserveDate" width="120" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag
                effect="plain"
                round
                :style="{ color: RESERVATION_STATE_COLOR[row.state as keyof typeof RESERVATION_STATE_COLOR] }"
              >
                {{ RESERVATION_STATE_LABEL[row.state as keyof typeof RESERVATION_STATE_LABEL] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="备注" prop="note" min-width="160" />
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.state === 'active'" size="small" type="primary" text @click="openRequest(row.id)">
                开调阅单
              </el-button>
              <el-button v-if="row.state === 'active'" size="small" text @click="coord.closeReservation(row.id)">关闭</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ============================ 修复室 ============================ -->
      <el-tab-pane name="desk">
        <template #label>
          <span><el-icon><Select /></el-icon> 修复室在修占用</span>
        </template>
        <el-card v-if="coord.occupancies.filter((o) => !o.needsReview).length === 0" shadow="never">
          <EmptyPanel
            title="修复室还没有登记占用"
            description="修复师接手一册就在这里登记在修占用；修完解除占用，库房挂起的调阅单自动转待放行。"
            action-text="接手开工"
            @action="openOccupy"
          />
        </el-card>
        <el-table v-else :data="coord.occupancies.filter((o) => !o.needsReview)" size="small" border>
          <el-table-column label="册次" min-width="220">
            <template #default="{ row }">{{ volumeLabel(row.volumeId) }}</template>
          </el-table-column>
          <el-table-column label="负责人" prop="operator" width="110" />
          <el-table-column label="接手开工" width="180">
            <template #default="{ row }">{{ formatTime(row.startAt) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag
                effect="plain"
                round
                :style="{ color: OCCUPANCY_STATUS_COLOR[row.status as keyof typeof OCCUPANCY_STATUS_COLOR] }"
              >
                {{ OCCUPANCY_STATUS_LABEL[row.status as keyof typeof OCCUPANCY_STATUS_LABEL] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="来源" width="110">
            <template #default="{ row }">{{ OCCUPANCY_SOURCE_LABEL[row.source as keyof typeof OCCUPANCY_SOURCE_LABEL] }}</template>
          </el-table-column>
          <el-table-column label="解除说明" prop="releaseNote" min-width="180" />
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.status === 'active'" size="small" type="warning" text :icon="RefreshRight" @click="release(row.id)">
                修完解除
              </el-button>
              <span v-else class="gb-muted">已于 {{ formatTime(row.endAt) }} 归还</span>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ====================== 历史回填 · 人工认领 ====================== -->
      <el-tab-pane name="review">
        <template #label>
          <span>
            <el-icon><Lock /></el-icon> 历史占用待认领
            <el-badge v-if="stats.review > 0" :value="stats.review" class="gb-review-badge" />
          </span>
        </template>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="旧数据没有占用记录，升级时按当前在修状态回填历史占用；回填不出在册册次或开工时间的留在这里，只读等人认领。"
          style="margin-bottom: 12px"
        />
        <el-card v-if="coord.reviewOccupancies.length === 0" shadow="never">
          <EmptyPanel title="没有待认领的历史占用" description="证据充分的在修册次已在升级时自动回填为在修占用。" />
        </el-card>
        <el-table v-else :data="coord.reviewOccupancies" size="small" border>
          <el-table-column label="回填记录" prop="id" min-width="160" />
          <el-table-column label="对应册次" min-width="180">
            <template #default="{ row }">{{ volumeLabel(row.volumeId) }}</template>
          </el-table-column>
          <el-table-column label="开工时间" width="180">
            <template #default="{ row }">{{ formatTime(row.startAt) }}</template>
          </el-table-column>
          <el-table-column label="状态" min-width="220">
            <template #default>
              <el-tag type="info" effect="plain" round>只读 · 等待人工认领</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="primary" text :icon="Select" @click="openClaim(row.id)">人工认领</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 预约对话框 -->
    <el-dialog v-model="reserveDialog" title="登记预约（记录照留）" width="520px">
      <el-form label-width="92px">
        <el-form-item label="册次" required>
          <el-select v-model="reserveForm.volumeId" filterable style="width: 100%">
            <el-option v-for="item in reserveVolumeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="预约人" required>
          <el-input v-model="reserveForm.reader" placeholder="如：文献研究所 · 顾衡" />
        </el-form-item>
        <el-form-item label="到馆日期">
          <el-input v-model="reserveForm.reserveDate" type="date" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="reserveForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reserveDialog = false">取消</el-button>
        <el-button type="primary" @click="submitReserve">保存预约</el-button>
      </template>
    </el-dialog>

    <!-- 调阅单对话框 -->
    <el-dialog v-model="requestDialog" title="开调阅单（提交即查在修占用）" width="520px">
      <el-form label-width="92px">
        <el-form-item label="册次" required>
          <el-select v-model="requestForm.volumeId" filterable style="width: 100%">
            <el-option v-for="item in requestVolumeOptions" :key="item.value" :value="item.value">
              <span>{{ item.label }}</span>
              <el-tag v-if="item.occupied" type="warning" size="small" effect="plain" style="margin-left: 8px">在修占用·将挂起</el-tag>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="关联预约">
          <el-select v-model="requestForm.reservationId" clearable placeholder="无（直接调阅）" style="width: 100%">
            <el-option
              v-for="res in coord.reservations.filter((r) => r.state === 'active' && r.volumeId === requestForm.volumeId)"
              :key="res.id"
              :label="`${res.reserveNo} · ${res.reader}`"
              :value="res.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="调阅人" required>
          <el-input v-model="requestForm.reader" />
        </el-form-item>
        <el-form-item label="用途">
          <el-input v-model="requestForm.purpose" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="requestDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRequest">提交并查占用</el-button>
      </template>
    </el-dialog>

    <!-- 接手占用对话框 -->
    <el-dialog v-model="occupyDialog" title="修复室接手开工（登记在修占用）" width="480px">
      <el-form label-width="92px">
        <el-form-item label="册次" required>
          <el-select v-model="occupyForm.volumeId" filterable style="width: 100%">
            <el-option
              v-for="item in reserveVolumeOptions.filter((i) => !i.occupied)"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="修复负责人" required>
          <el-input v-model="occupyForm.operator" placeholder="如：沈玉" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="occupyDialog = false">取消</el-button>
        <el-button type="primary" @click="submitOccupy">接手开工</el-button>
      </template>
    </el-dialog>

    <!-- 历史占用认领对话框 -->
    <el-dialog v-model="claimDialog" title="人工认领历史占用" width="480px">
      <el-alert type="warning" :closable="false" show-icon title="该条为升级回填但证据不足的只读记录，认领后按在修占用参与库房放行判断。" style="margin-bottom: 12px" />
      <el-form label-width="92px">
        <el-form-item label="认领册次" required>
          <el-select v-model="claimForm.volumeId" filterable style="width: 100%">
            <el-option v-for="item in reserveVolumeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="开工时间" required>
          <el-input v-model="claimForm.startDate" type="date" />
        </el-form-item>
        <el-form-item label="负责人" required>
          <el-input v-model="claimForm.operator" placeholder="如：沈玉" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="claimDialog = false">取消</el-button>
        <el-button type="primary" @click="submitClaim">确认认领</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.gb-sub-title {
  margin: 4px 0 10px;
  font-size: 15px;
}

.gb-review-badge {
  margin-left: 6px;
}
</style>
