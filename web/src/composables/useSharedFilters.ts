import { ref, watch } from 'vue'
import type { RangeKey } from '../types'

const ranges: RangeKey[] = ['ytd', '6m', '1y', '2y', '3y', '5y', '10y', 'max']
const storedRange = localStorage.getItem('wealthtrack-range') as RangeKey | null
const range = ref<RangeKey>(storedRange && ranges.includes(storedRange) ? storedRange : '3y')
const person = ref<string | null>(localStorage.getItem('wealthtrack-person') || null)
watch(range, value => localStorage.setItem('wealthtrack-range', value))
watch(person, value => value ? localStorage.setItem('wealthtrack-person', value) : localStorage.removeItem('wealthtrack-person'))
export function useSharedFilters() { return { range, person } }
