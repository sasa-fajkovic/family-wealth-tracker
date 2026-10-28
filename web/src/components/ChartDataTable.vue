<script setup lang="ts">
defineProps<{ title: string; columns: string[]; rows: string[][] }>()
</script>
<template>
  <details class="mt-3 text-sm"><summary class="cursor-pointer font-medium">View {{ title }} data</summary>
    <div class="overflow-x-auto"><table class="wt-data-table"><caption class="sr-only">{{ title }} chart data</caption>
      <thead><tr><th v-for="column in columns" :key="column" scope="col">{{ column }}</th></tr></thead>
      <tbody><tr v-for="(row, index) in rows" :key="index"><th scope="row">{{ row[0] }}</th><td v-for="(value, i) in row.slice(1)" :key="i">{{ value }}</td></tr></tbody>
    </table></div>
  </details>
</template>
