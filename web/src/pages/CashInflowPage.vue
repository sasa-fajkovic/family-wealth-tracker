<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getSummary, getPersons, getAssets, ApiError } from '../api/client'
import type { SummaryResponse, RangeKey, Person, Asset } from '../types/index'
import ChartTypeSelector from '../components/ChartTypeSelector.vue'
import ChartCard from '../components/ui/ChartCard.vue'
import PlannedToggle from '../components/ui/PlannedToggle.vue'
import WealthChart from '../components/WealthChart.vue'
import SelectButton from 'primevue/selectbutton'
import Skeleton from 'primevue/skeleton'
import Message from 'primevue/message'
import Button from 'primevue/button'
import { useChartType } from '../composables/useChartType'
import { useDataRefresh } from '../composables/useDataRefresh'
import { useShowPlanned } from '../composables/useShowPlanned'
import { useSharedFilters } from '../composables/useSharedFilters'

const RANGES: { label: string; value: RangeKey }[] = [
  { label: 'YTD', value: 'ytd' }, { label: '6M',  value: '6m'  },
  { label: '1Y',  value: '1y'  }, { label: '2Y',  value: '2y'  },
  { label: '3Y',  value: '3y'  }, { label: '5Y',  value: '5y'  },
  { label: '10Y', value: '10y' }, { label: 'Max', value: 'max' },
]

const { range, person } = useSharedFilters()
const persons = ref<Person[]>([])
const assets = ref<Asset[]>([])
const data = ref<SummaryResponse | null>(null)
const plannedData = ref<SummaryResponse | null>(null)
const { showPlanned } = useShowPlanned()
const disabledSourceIds = ref<Set<string>>(new Set())
const loading = ref(true)
const error = ref<string | null>(null)
const retryCount = ref(0)
const { chartType, setChartType } = useChartType('cashinflow-chart-type-v2', 'trend')
const { referenceDataVersion, dataPointsVersion } = useDataRefresh()
const router = useRouter()

const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })

async function loadPersons() {
  try {
    const list = await getPersons()
    persons.value = list
    if (person.value && !list.some(p => p.id === person.value)) person.value = null
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Unexpected error loading people'
  }
}

async function loadAssets() {
  try {
    assets.value = await getAssets()
  } catch (err) {
    // Asset list is only used for click-drill resolution; failure is non-fatal
    console.warn('Income page: failed to load assets', err)
  }
}

onMounted(() => {
  document.title = 'Income — WealthTrack'
  loadPersons()
  loadAssets()
})

let loadSequence = 0
async function loadSummary() {
  const sequence = ++loadSequence
  loading.value = true
  error.value = null
  try {
    const personId = person.value ?? undefined
    const [result, planned] = await Promise.all([
      getSummary(range.value, personId, true),
      showPlanned.value ? getSummary(range.value, personId, true, true) : null,
    ])
    if (sequence !== loadSequence) return
    data.value = result
    plannedData.value = planned
  } catch (err) {
    if (sequence === loadSequence) error.value = err instanceof ApiError ? err.message : 'Unexpected error'
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

watch([range, person, showPlanned, retryCount, referenceDataVersion, dataPointsVersion], loadSummary, { immediate: true })
watch(person, () => { disabledSourceIds.value = new Set() })
watch(referenceDataVersion, () => {
  loadPersons()
  loadAssets()
})

const personOptions = computed(() => [
  { label: 'All', value: 'all' },
  ...persons.value.map(p => ({ label: p.name, value: p.id })),
])
const personValue = computed({
  get: () => person.value ?? 'all',
  set: (v: string) => { person.value = v === 'all' ? null : v },
})
const isEmpty = computed(() => !loading.value && data.value && data.value.series.length === 0)

// Summary stats — when person is selected, derive from enabled sources only
const totalInflow = computed(() => displayData.value?.current_total ?? data.value?.current_total ?? 0)
const monthsWithData = computed(() => data.value?.months.filter((_, i) =>
  data.value?.asset_series.some(series => !disabledSourceIds.value.has(series.asset_id) && series.observation_status?.[i] === 'observed')
).length ?? 0)
const noSourcesSelected = computed(() => person.value !== null && personSources.value.length > 0 && personSources.value.every(source => source.disabled))
const missingMonths = computed(() => (data.value?.months.length ?? 0) - monthsWithData.value)
const avgMonthlyInflow = computed(() => {
  const months = monthsWithData.value
  return months > 0 ? totalInflow.value / months : 0
})
const chartTitle = computed(() => {
  if (chartType.value === 'trend') return 'Total Income Trend'
  return person.value === null ? 'Income by Person' : 'Income Sources'
})
const chartSubtitle = computed(() => {
  if (chartType.value === 'trend') return 'Total income over time.'
  return person.value === null ? 'All income grouped by person.' : 'Selected person split into individual income sources.'
})
// "All" view (person === null): top 5 click-to-drill list of people
const topSources = computed(() => {
  if (person.value !== null || !displayData.value) return []
  return [...displayData.value.category_breakdown]
    .filter(r => r.value !== 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
})

// Per-person view: every source for that person, with an enabled/disabled flag.
// Built from the unfiltered data so that disabled rows still appear in the list
// (so the user can click them back on).
const personSources = computed(() => {
  if (person.value === null || !data.value) return []
  const groups = new Map<string, { id: string; name: string; color: string; total: number }>()
  data.value.asset_series.forEach((series, index) => {
    const total = series.values.reduce((sum, v) => sum + v, 0)
    if (total === 0 && !series.observation_status?.includes('observed')) return
    const existing = groups.get(series.asset_id)
    if (existing) {
      existing.total += total
    } else {
      groups.set(series.asset_id, {
        id: series.asset_id,
        name: series.asset_name,
        color: series.color || colorAt(index),
        total,
      })
    }
  })
  const enabledTotal = [...groups.values()]
    .filter(g => !disabledSourceIds.value.has(g.id))
    .reduce((sum, g) => sum + g.total, 0)
  return [...groups.values()]
    .sort((a, b) => b.total - a.total)
    .map(g => ({
      category_id: g.id,
      category_name: g.name,
      color: g.color,
      value: g.total,
      pct_of_total: enabledTotal === 0 ? 0 : (g.total / enabledTotal) * 100,
      disabled: disabledSourceIds.value.has(g.id),
    }))
})

function selectTopSource(row: SummaryResponse['category_breakdown'][number]) {
  if (person.value !== null) return
  person.value = row.category_id
}

function toggleSource(id: string) {
  const next = new Set(disabledSourceIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  disabledSourceIds.value = next
}

const palette = ['#14b8a6', '#22c55e', '#6366f1', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4']

function colorAt(index: number): string {
  return palette[index % palette.length]
}

const personNameById = computed(() =>
  new Map(persons.value.map(p => [p.id, p.name]))
)

function personName(id: string): string {
  return personNameById.value.get(id) ?? id
}

function buildDisplayData(source: SummaryResponse | null): SummaryResponse | null {
  if (!source) return null

  const groupByPerson = person.value === null
  const groups = new Map<string, {
    id: string
    name: string
    color: string
    values: number[]
  }>()

  source.asset_series.forEach((series, index) => {
    // When viewing a single person, allow excluding individual sources via toggle
    if (!groupByPerson && disabledSourceIds.value.has(series.asset_id)) return
    const id = groupByPerson ? series.person_id : series.asset_id
    const name = groupByPerson ? personName(series.person_id) : series.asset_name
    const existing = groups.get(id)
    if (existing) {
      existing.values = existing.values.map((value, valueIndex) => value + (series.values[valueIndex] ?? 0))
    } else {
      groups.set(id, {
        id,
        name,
        color: groupByPerson ? colorAt(groups.size) : series.color || colorAt(index),
        values: [...series.values],
      })
    }
  })

  const series = [...groups.values()]
    .filter(group => group.values.some(v => v !== 0))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(group => ({
      category_id: group.id,
      category_name: group.name,
      color: group.color,
      category_type: 'cash-inflow' as const,
      values: group.values,
    }))

  // Recompute totals timeline + grand total based on the (possibly filtered) series
  const monthCount = source.months.length
  const totals = Array.from({ length: monthCount }, (_, i) =>
    series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)
  )
  const currentTotal = totals.reduce((sum, v) => sum + v, 0)

  const category_breakdown = series.map(group => {
    const value = group.values.reduce((sum, v) => sum + v, 0)
    return {
      category_id: group.category_id,
      category_name: group.category_name,
      color: group.color,
      category_type: group.category_type,
      value,
      pct_of_total: currentTotal === 0 ? 0 : (value / currentTotal) * 100,
    }
  })

  return {
    ...source,
    asset_series: source.asset_series.filter(series => groupByPerson || !disabledSourceIds.value.has(series.asset_id)),
    series,
    totals,
    current_total: currentTotal,
    category_breakdown,
  }
}

const displayData = computed(() => buildDisplayData(data.value))
// The chart may run past today into planned months; the summary cards always use displayData.
const chartDisplayData = computed(() => (plannedData.value ? buildDisplayData(plannedData.value) : displayData.value))
const actualRange = computed(() => {
  const months = data.value?.months ?? []
  return months.length ? `${months[0]} – ${data.value?.current_month ?? months[months.length - 1]}` : null
})
const plannedTimeline = computed(() => {
  const source = chartDisplayData.value
  const current = data.value?.current_month
  if (!source || !current || !showPlanned.value) return null
  const future = source.months.map((month, index) => ({ month, index })).filter(item => item.month > current)
  const observed = future.filter(item => source.asset_series.some(series => series.observation_status?.[item.index] === 'observed'))
  if (!observed.length) return null
  return { start: future[0].month, end: future[future.length - 1].month, count: observed.length }
})

const assetCategoryById = computed(() => new Map(assets.value.map(a => [a.id, a.category_id])))

function onChartPointClick(payload: { monthIndex: number; datasetIndex: number; datasetLabel: string }) {
  if (!data.value || !chartDisplayData.value) return
  const months = chartDisplayData.value.months
  const monthRaw = months[payload.monthIndex]
  if (!monthRaw) return
  const month = monthRaw.slice(0, 7)
  const query: Record<string, string> = { month, type: 'cash-inflow' }

  // Trend chart shows total only — no per-series filter (but carry active person)
  const isTotal = chartType.value === 'trend' || payload.datasetLabel === 'Total'
  const series = chartDisplayData.value.series[payload.datasetIndex]
  if (isTotal) {
    if (person.value !== null) query.person = person.value
  } else if (series) {
    if (person.value === null) {
      // Grouped by person → series id IS person_id
      if (persons.value.some(p => p.id === series.category_id)) {
        query.person = series.category_id
      }
    } else {
      // Grouped by asset for a specific person → carry person + map asset → category
      query.person = person.value
      const categoryId = assetCategoryById.value.get(series.category_id)
      if (categoryId) query.category = categoryId
    }
  }

  router.push({ path: '/monthly-update', query })
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-zinc-950">
    <div class="px-4 sm:px-6 py-6">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
        <div class="wt-control-strip -mx-4 px-4 sm:mx-0 sm:px-0" v-active-scroll>
          <SelectButton v-model="range" :options="RANGES" option-label="label" option-value="value" class="whitespace-nowrap wt-touch-select wt-soft-select wt-range-select" />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <PlannedToggle :disabled="chartType === 'pie'" :description-id="chartType === 'pie' ? 'income-pie-help' : undefined" />
          <ChartTypeSelector :value="chartType" @change="setChartType" />
        </div>
      </div>

      <p v-if="chartType === 'pie'" id="income-pie-help" class="mb-3 text-sm text-gray-600 dark:text-zinc-400">Pie shows current-month income. Choose a timeline chart to show planned income.</p>
      <p v-else-if="data && !loading && actualRange" class="mb-3 text-sm text-gray-600 dark:text-zinc-400" role="status">
        Actual: {{ actualRange }} ·
        <template v-if="!showPlanned">Planned income hidden.</template>
        <template v-else-if="plannedTimeline">Planned timeline: {{ plannedTimeline.start }} – {{ plannedTimeline.end }} · {{ plannedTimeline.count }} {{ plannedTimeline.count === 1 ? 'month' : 'months' }} with planned entries.</template>
        <template v-else>No planned income for the selected sources.</template>
      </p>

      <div v-if="persons.length > 0" class="wt-control-strip -mx-4 px-4 sm:mx-0 sm:px-0 mb-3" v-active-scroll>
        <SelectButton v-model="personValue" :options="personOptions" option-label="label" option-value="value" class="whitespace-nowrap wt-touch-select wt-soft-select wt-person-select" />
      </div>

      <div v-if="error" class="mb-4">
        <Message severity="error" class="w-full">Could not load data.</Message>
        <div class="mt-2">
          <Button label="Retry" link @click="retryCount++" />
        </div>
      </div>

      <!-- Summary cards -->
      <template v-if="data && !loading && !isEmpty">
        <p class="mb-3 text-xs text-gray-500 dark:text-zinc-400">Summary cards show actual income only.</p>
        <div
          class="grid grid-cols-1 gap-3 mb-4"
          :class="(person === null ? topSources.length > 0 : personSources.length > 0)
            ? 'lg:grid-cols-[minmax(20rem,36rem)_minmax(0,1fr)]'
            : 'sm:grid-cols-2 lg:max-w-xl'"
        >
          <div class="grid grid-cols-2 gap-3 self-start">
            <div class="bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-3 shadow-sm">
              <p class="text-[11px] font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wide mb-1">Total Income</p>
              <p class="text-base font-bold text-green-600 dark:text-green-400 tabular-nums sm:text-lg">{{ monthsWithData ? eurFmt.format(totalInflow) : '—' }}</p>
            </div>
            <div class="bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-3 shadow-sm">
              <p class="text-[11px] font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wide mb-1">Avg / Month</p>
              <p class="text-base font-bold text-gray-900 dark:text-zinc-100 tabular-nums sm:text-lg">{{ monthsWithData ? eurFmt.format(avgMonthlyInflow) : '—' }}</p>
              <p class="text-xs text-gray-500">{{ noSourcesSelected ? 'No sources selected' : `${monthsWithData} observed months · ${missingMonths} missing months` }}</p>
            </div>
          </div>

          <!-- "All" view: top 5 income sources, click-to-drill into a person -->
          <div v-if="person === null && topSources.length > 0" class="min-w-0 bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-4 shadow-sm">
            <p class="text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wide mb-3">
              Income by Person
            </p>
            <div class="flex flex-col gap-1.5">
              <button
                v-for="row in topSources"
                :key="row.category_id"
                type="button"
                :aria-label="`Show only ${row.category_name}`"
                class="flex w-full appearance-none items-center gap-3 rounded-md border-0 bg-transparent px-2 py-1 text-left transition-colors cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200 dark:focus-visible:ring-emerald-500/40"
                @click="selectTopSource(row)"
              >
                <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" :style="{ backgroundColor: row.color }" />
                <span class="min-w-0 flex-1 text-sm text-gray-700 dark:text-zinc-300 truncate">{{ row.category_name }}</span>
                <span class="text-sm font-semibold text-gray-900 dark:text-zinc-100 tabular-nums">{{ eurFmt.format(row.value) }}</span>
                <span class="text-xs text-gray-400 dark:text-zinc-500 tabular-nums w-12 text-right">{{ row.pct_of_total.toFixed(1) }}%</span>
              </button>
            </div>
          </div>

          <!-- Per-person view: full source list, click to enable/disable each source -->
          <div v-else-if="person !== null && personSources.length > 0" class="min-w-0 bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-4 shadow-sm">
            <p class="text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wide mb-3">
              Income Sources
            </p>
            <div class="flex flex-col gap-1.5">
              <button
                v-for="row in personSources"
                :key="row.category_id"
                type="button"
                :aria-pressed="!row.disabled"
                :aria-label="`${row.disabled ? 'Enable' : 'Disable'} ${row.category_name}`"
                class="flex w-full appearance-none items-center gap-3 rounded-md border-0 bg-transparent px-2 py-1 text-left transition-colors cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200 dark:focus-visible:ring-emerald-500/40"
                :class="row.disabled ? 'opacity-50' : ''"
                @click="toggleSource(row.category_id)"
              >
                <span
                  class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  :style="{ backgroundColor: row.color }"
                  :class="row.disabled ? 'ring-1 ring-gray-400 dark:ring-zinc-500' : ''"
                />
                <span
                  class="min-w-0 flex-1 text-sm text-gray-700 dark:text-zinc-300 truncate"
                  :class="row.disabled ? 'line-through' : ''"
                >{{ row.category_name }}</span>
                <span
                  class="text-sm font-semibold tabular-nums"
                  :class="row.disabled ? 'text-gray-400 dark:text-zinc-500 line-through' : 'text-gray-900 dark:text-zinc-100'"
                >{{ eurFmt.format(row.value) }}</span>
                <span class="text-xs text-gray-400 dark:text-zinc-500 tabular-nums w-12 text-right">
                  {{ row.disabled ? '—' : `${row.pct_of_total.toFixed(1)}%` }}
                </span>
              </button>
            </div>
          </div>
        </div>
      </template>

      <Skeleton v-if="loading" height="420px" border-radius="8px" />

      <div v-else-if="isEmpty" class="bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-4">
        <div class="text-center py-16 text-gray-400 dark:text-zinc-500">
          <p class="text-lg font-medium mb-2">No income data yet</p>
          <p class="text-sm">Create a category marked as <strong>Income</strong> in Admin, then add data points for it.</p>
        </div>
      </div>

      <ChartCard v-else-if="chartDisplayData" :title="chartTitle" :subtitle="chartSubtitle">
        <WealthChart :data="chartDisplayData" :chart-type="chartType" @point-click="onChartPointClick" />
      </ChartCard>
    </div>
  </div>
</template>
