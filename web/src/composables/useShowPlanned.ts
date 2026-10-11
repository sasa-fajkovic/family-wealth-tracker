import { ref, watch } from 'vue'

const STORAGE_KEY = 'wealthtrack-show-planned'

const showPlanned = ref(localStorage.getItem(STORAGE_KEY) === 'true')

watch(showPlanned, (v) => {
  localStorage.setItem(STORAGE_KEY, String(v))
})

export function useShowPlanned() {
  return { showPlanned }
}
