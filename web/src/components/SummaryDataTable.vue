<script setup lang="ts">
import type { SummaryResponse } from '../types'
import { hasObservation } from '../utils/observations'
defineProps<{ data: SummaryResponse; title: string }>()
const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })
</script>
<template>
  <details class="mb-4 text-sm"><summary class="cursor-pointer font-medium">View {{ title }} data</summary>
    <div class="overflow-x-auto"><table class="wt-data-table"><caption class="sr-only">{{ title }} values by month</caption>
      <thead><tr><th scope="col">Month</th><th scope="col">Phase</th><th scope="col">Total</th><th v-for="series in data.series" :key="series.category_id" scope="col">{{ series.category_name }}</th></tr></thead>
      <tbody><tr v-for="(month, i) in data.months" :key="month"><th scope="row">{{ month }}</th><td>{{ data.current_month && month.slice(0, 7) > data.current_month ? 'Planned' : 'Actual' }}</td><td>{{ hasObservation(data, i) ? fmt.format(data.totals[i] ?? 0) : '—' }}</td><td v-for="series in data.series" :key="series.category_id">{{ hasObservation(data, i, series.category_id) ? fmt.format(series.values[i] ?? 0) : '—' }}</td></tr></tbody>
    </table></div>
  </details>
</template>
