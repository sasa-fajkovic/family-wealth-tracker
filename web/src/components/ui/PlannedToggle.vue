<script setup lang="ts">
import { useShowPlanned } from '../../composables/useShowPlanned'

const { showPlanned } = useShowPlanned()
</script>

<template>
  <button
    type="button"
    :class="[
      'inline-flex shrink-0 items-center gap-1.5 min-h-10 px-3 text-xs font-medium rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-200 dark:focus-visible:ring-indigo-500/40',
      showPlanned
        ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300'
        : 'bg-gray-100/70 dark:bg-zinc-800/80 border-transparent text-gray-600 dark:text-zinc-300 hover:bg-gray-200/70 dark:hover:bg-zinc-700',
    ]"
    :aria-pressed="showPlanned"
    title="Extend charts past today with planned future values"
    @click="showPlanned = !showPlanned"
  >
    <span class="w-2 h-2 rounded-full" :class="showPlanned ? 'bg-indigo-500' : 'bg-gray-300 dark:bg-zinc-600'" />
    Show planned
  </button>
</template>
