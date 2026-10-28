<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import SummaryDataTable from '../components/SummaryDataTable.vue'
import { useRouter } from 'vue-router'
import { RouterLink } from 'vue-router'
import { getSummary, getPersons, getAssets, getCategories, ApiError } from '../api/client'
import type { SummaryResponse, RangeKey, Person, Asset, Category } from '../types/index'
import DashboardTrendCharts from '../components/DashboardTrendCharts.vue'
import PageShell from '../components/ui/PageShell.vue'
import PlannedToggle from '../components/ui/PlannedToggle.vue'
import SelectButton from 'primevue/selectbutton'
import Skeleton from 'primevue/skeleton'
import Message from 'primevue/message'
import Button from 'primevue/button'
import { useDataRefresh } from '../composables/useDataRefresh'
import { useShowPlanned } from '../composables/useShowPlanned'
import { useSharedFilters } from '../composables/useSharedFilters'
import { hasObservation } from '../utils/observations'

const RANGES: { label: string; value: RangeKey }[] = [
  { label: 'YTD', value: 'ytd' }, { label: '6M',  value: '6m'  },
  { label: '1Y',  value: '1y'  }, { label: '2Y',  value: '2y'  },
  { label: '3Y',  value: '3y'  }, { label: '5Y',  value: '5y'  },
  { label: '10Y', value: '10y' }, { label: 'Max', value: 'max' },
]

const { range, person } = useSharedFilters()
const persons = ref<Person[]>([])
const assets = ref<Asset[]>([])
const categories = ref<Category[]>([])
const data = ref<SummaryResponse | null>(null)
const cashInflowData = ref<SummaryResponse | null>(null)
const plannedData = ref<SummaryResponse | null>(null)
const plannedCashInflowData = ref<SummaryResponse | null>(null)
const { showPlanned } = useShowPlanned()
const loading = ref(true)
const error = ref<string | null>(null)
const retryCount = ref(0)
const inventoryLoading = ref(true)
const { referenceDataVersion, dataPointsVersion } = useDataRefresh()
const router = useRouter()

function onTrendChartClick(payload: { kind: 'netWorth' | 'assets' | 'liabilities' | 'income'; monthIndex: number; month: string }) {
  const month = payload.month.slice(0, 7)
  const query: Record<string, string> = { month }
  if (person.value) query.person = person.value
  router.push({ path: '/monthly-update', query })
}

async function loadReferenceData() {
  inventoryLoading.value = true
  try {
    const [personList, assetList, categoryList] = await Promise.all([getPersons(), getAssets(), getCategories()])
    persons.value = personList
    assets.value = assetList
    categories.value = categoryList
    if (person.value && !personList.some(p => p.id === person.value)) person.value = null
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Unexpected error loading setup data'
  } finally {
    inventoryLoading.value = false
  }
}

onMounted(() => {
  document.title = 'Dashboard — WealthTrack'
  loadReferenceData()
})

let loadSequence = 0
async function loadSummary() {
  const sequence = ++loadSequence
  loading.value = true
  error.value = null
  try {
    const personId = person.value ?? undefined
    const [result, inflowResult, plannedResult, plannedInflowResult] = await Promise.all([
      getSummary(range.value, personId),
      getSummary(range.value, personId, true),
      showPlanned.value ? getSummary(range.value, personId, false, true) : null,
      showPlanned.value ? getSummary(range.value, personId, true, true) : null,
    ])
    if (sequence !== loadSequence) return
    data.value = result
    cashInflowData.value = inflowResult
    plannedData.value = plannedResult
    plannedCashInflowData.value = plannedInflowResult
  } catch (err) {
    if (sequence === loadSequence) error.value = err instanceof ApiError ? err.message : 'Unexpected error'
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

watch([range, person, showPlanned, retryCount, referenceDataVersion, dataPointsVersion], loadSummary, { immediate: true })
watch(referenceDataVersion, loadReferenceData)

const personOptions = computed(() => [
  { label: 'All', value: 'all' },
  ...persons.value.map(p => ({ label: p.name, value: p.id })),
])
const personValue = computed({
  get: () => person.value ?? 'all',
  set: (v: string) => { person.value = v === 'all' ? null : v },
})

// Metric cards computed from response
const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })
const inventoryCounts = computed(() => {
  const categoryTypes = new Map(categories.value.map(category => [category.id, category.type]))
  return assets.value.filter(asset => !person.value || asset.person_id === person.value).reduce(
    (acc, asset) => {
      const type = categoryTypes.get(asset.category_id) ?? 'asset'
      acc[type] += 1
      return acc
    },
    { asset: 0, liability: 0, 'cash-inflow': 0 } as Record<Category['type'], number>,
  )
})

// Empty-state detection: distinguish "no data at all" from "income data only"
const hasWealthAssets = computed(() => inventoryCounts.value.asset > 0 || inventoryCounts.value.liability > 0)
const hasIncomeAssets = computed(() => inventoryCounts.value['cash-inflow'] > 0)
const showIncomeOnlyHint = computed(() =>
  !inventoryLoading.value && !loading.value && !hasWealthAssets.value && hasIncomeAssets.value,
)
const showNoAssetsHint = computed(() =>
  !inventoryLoading.value && !loading.value && !hasWealthAssets.value && !hasIncomeAssets.value,
)

function deltaClass(v: number) {
  return v >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'
}
function formatSignedEur(v: number) {
  const sign = v >= 0 ? '+' : '\u2212'
  return `${sign}${eurFmt.format(Math.abs(v))}`
}
</script>

<template>
  <PageShell>
      <!-- Controls row -->
      <div class="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div class="wt-control-strip -mx-4 px-4 sm:mx-0 sm:px-0" v-active-scroll>
          <SelectButton
            v-model="range"
            :options="RANGES"
            option-label="label"
            option-value="value"
            aria-label="Chart time range"
            class="whitespace-nowrap wt-touch-select wt-soft-select wt-range-select"
          />
        </div>
        <PlannedToggle class="self-start sm:self-auto" />
      </div>

      <!-- Person filter -->
      <div v-if="persons.length > 0" class="wt-control-strip -mx-4 px-4 sm:mx-0 sm:px-0 mb-3" v-active-scroll>
        <SelectButton
          v-model="personValue"
          :options="personOptions"
          option-label="label"
          option-value="value"
          aria-label="Filter by person"
          class="whitespace-nowrap wt-touch-select wt-soft-select wt-person-select"
        />
      </div>

      <div v-if="error" class="mb-4">
        <Message severity="error" class="w-full">Could not load data. Check your connection.</Message>
        <div class="mt-2">
          <Button label="Retry loading data" link @click="retryCount++" />
        </div>
      </div>

      <!-- Empty-state hints (after data loads) -->
      <template v-if="showIncomeOnlyHint">
        <div class="mb-4 rounded-lg border border-teal-200 dark:border-teal-700/60 bg-teal-50 dark:bg-teal-900/20 p-4">
          <p class="text-sm font-semibold text-teal-900 dark:text-teal-100 mb-1">No wealth assets yet — only income data is tracked</p>
          <p class="text-sm text-teal-800 dark:text-teal-200 mb-3">
            Your imported data lives on the <RouterLink to="/income" class="underline font-medium">Income page</RouterLink>. To see net worth here, add assets (e.g. ETFs, vehicles, real estate) on the
            <RouterLink to="/admin" class="underline font-medium">Setup page</RouterLink> and record values on the
            <RouterLink :to="{ path: '/monthly-update', query: person ? { person } : {} }" class="underline font-medium">Monthly Update page</RouterLink>.
          </p>
          <div class="flex flex-wrap gap-2">
            <RouterLink to="/income"><Button label="Open Income" size="small" /></RouterLink>
            <RouterLink to="/admin"><Button label="Add assets" size="small" severity="secondary" outlined /></RouterLink>
          </div>
        </div>
      </template>
      <template v-else-if="showNoAssetsHint">
        <div class="mb-4 rounded-lg border border-amber-200 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/20 p-4">
          <p class="text-sm font-semibold text-amber-900 dark:text-amber-100 mb-1">No data to display</p>
          <p class="text-sm text-amber-800 dark:text-amber-200 mb-3">
            Get started by adding categories, assets and persons on the
            <RouterLink to="/admin" class="underline font-medium">Setup page</RouterLink>, or import an existing dataset from there.
          </p>
          <RouterLink to="/admin"><Button label="Go to Setup" size="small" /></RouterLink>
        </div>
      </template>

      <p v-if="data && !loading && data.months.length" class="mb-3 text-sm text-gray-600 dark:text-zinc-400">
        As of {{ data.current_month ?? data.months[data.months.length - 1] }} · Period {{ data.months[0] }} to {{ data.months[data.months.length - 1] }}
        <span v-if="data.monthly_coverage?.carried"> · {{ data.monthly_coverage.carried }} entries use earlier observations</span>
      </p>

      <!-- Metric cards row -->
      <template v-if="data && cashInflowData && !loading">
        <div class="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <div class="bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-3 shadow-sm">
            <p class="text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wide mb-1">Net Worth</p>
            <p class="text-lg font-bold text-gray-900 dark:text-zinc-100 tabular-nums">{{ hasObservation(data, data.months.length - 1) ? eurFmt.format(data.current_total) : '—' }}</p>
          </div>
          <div class="bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-3 shadow-sm">
            <p class="text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wide mb-1">Gross Assets</p>
            <p class="text-lg font-bold text-gray-900 dark:text-zinc-100 tabular-nums">{{ hasObservation(data, data.months.length - 1, undefined, 'asset') ? eurFmt.format(data.gross_assets) : '—' }}</p>
          </div>
          <div class="bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-3 shadow-sm">
            <p class="text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wide mb-1">Liabilities</p>
            <p class="text-lg font-bold text-red-600 dark:text-red-400 tabular-nums">{{ hasObservation(data, data.months.length - 1, undefined, 'liability') ? eurFmt.format(data.total_liabilities) : '—' }}</p>
          </div>
          <div class="bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-3 shadow-sm">
            <p class="text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wide mb-1">Period Change</p>
            <p :class="['text-lg font-bold tabular-nums', data.period_delta_available ? deltaClass(data.period_delta_abs) : 'text-gray-500 dark:text-zinc-400']">
              {{ data.period_delta_available ? formatSignedEur(data.period_delta_abs) : '—' }}
            </p>
            <p v-if="data.period_delta_available && data.period_start_month" class="mt-1 text-xs text-gray-500 dark:text-zinc-400">Since {{ data.period_start_month }}</p>
          </div>
        </div>
      </template>

      <div v-if="data?.monthly_coverage && !loading" class="mb-4 text-sm text-gray-600 dark:text-zinc-400">
        <RouterLink :to="{ path: '/monthly-update', query: person ? { person } : {} }" class="underline font-medium">Monthly completion: {{ data.monthly_coverage.observed }}/{{ data.monthly_coverage.total }} observed</RouterLink>
        <span> · {{ data.monthly_coverage.carried }} carried · {{ data.monthly_coverage.missing }} missing</span>
        <RouterLink v-if="data.monthly_coverage.observed < data.monthly_coverage.total" :to="{ path: '/monthly-update', query: { month: data.current_month ?? data.months[data.months.length - 1], ...(person ? { person } : {}), missing: '1' } }" class="ml-2 underline font-medium">Update missing</RouterLink>
        <span v-if="showPlanned"> · planned values shown in charts</span>
        <span> · Tracked: {{ inventoryCounts.asset }} assets, {{ inventoryCounts.liability }} liabilities, {{ inventoryCounts['cash-inflow'] }} income sources</span>
      </div>

      <!-- Loading skeleton -->
      <template v-if="loading">
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
          <Skeleton v-for="i in 5" :key="i" height="72px" border-radius="8px" />
        </div>
        <div class="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Skeleton v-for="i in 3" :key="i" height="380px" border-radius="8px" />
        </div>
      </template>

      <!-- Dashboard trends -->
      <template v-else-if="data && cashInflowData">
        <SummaryDataTable :data="plannedData ?? data" title="wealth trends" />
        <SummaryDataTable :data="plannedCashInflowData ?? cashInflowData" title="income trend" />
        <DashboardTrendCharts
          :data="plannedData ?? data"
          :cash-inflow-data="plannedCashInflowData ?? cashInflowData"
          @point-click="onTrendChartClick"
        />
      </template>
  </PageShell>
</template>
