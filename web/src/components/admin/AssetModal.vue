<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Asset, Category, Person, CreateAssetPayload, UpdateAssetPayload } from '../../types/index'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import Button from 'primevue/button'

function toSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

const props = defineProps<{
  mode: 'create' | 'edit'
  item?: Asset
  entityLabel?: string
  categories: Category[]
  persons?: Person[]
  existingIds?: string[]
  saving: boolean
  saveError: string | null
  onSave: (payload: CreateAssetPayload | UpdateAssetPayload) => void
  onCancel: () => void
}>()

const name = ref(props.mode === 'edit' ? props.item!.name : '')
const categoryId = ref(props.mode === 'edit' ? props.item!.category_id : (props.categories[0]?.id ?? ''))
const personId = ref(props.mode === 'edit' ? props.item!.person_id : (props.persons?.[0]?.id ?? ''))
const rateInput = ref<number | null>(
  props.item?.projected_yearly_growth !== null && props.item?.projected_yearly_growth !== undefined
    ? props.item.projected_yearly_growth * 100
    : null
)
const includeCurrent = ref<boolean | null>(props.item?.include_in_current_wealth ?? null)
const includeProjection = ref<boolean | null>(props.item?.include_in_projections ?? null)
const selectedCategory = computed(() => props.categories.find(category => category.id === categoryId.value))
const futureOnly = computed(() =>
  !(includeCurrent.value ?? selectedCategory.value?.include_in_current_wealth ?? true) &&
  (includeProjection.value ?? selectedCategory.value?.include_in_projections ?? true),
)
const notes = ref(props.mode === 'edit' ? (props.item!.notes ?? '') : '')
const showFrom = ref(props.mode === 'edit' ? (props.item!.show_from ?? '') : '')
const showUntil = ref(props.mode === 'edit' ? (props.item!.show_until ?? '') : '')
const isClosed = ref(!!props.item?.closed_at)
const currentDate = new Date()
const currentMonth = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`
const closeMonth = ref(props.item?.closed_at ?? currentMonth)
const validationError = ref<string | null>(null)

const slugPreview = computed(() => props.mode === 'create' ? toSlug(name.value) : props.item!.id)
const personOptions = computed(() => props.persons ?? [])

const slugConflict = computed(() => {
  if (props.mode !== 'create') return false
  const slug = slugPreview.value
  if (!slug) return false
  return (props.existingIds ?? []).includes(slug)
})

watch(() => props.categories, (list) => {
  if (props.mode === 'create' && !categoryId.value && list[0]) {
    categoryId.value = list[0].id
  }
})

watch(() => props.persons, (list) => {
  if (props.mode === 'create' && !personId.value && list?.[0]) {
    personId.value = list[0].id
  }
})

function handleSubmit() {
  if (!name.value.trim()) {
    validationError.value = 'Name is required'
    return
  }
  if (!categoryId.value) {
    validationError.value = 'Category is required'
    return
  }
  if (!personId.value) {
    validationError.value = 'Person is required'
    return
  }
  if (slugConflict.value) {
    validationError.value = `An entry with id '${slugPreview.value}' already exists. Choose a different name.`
    return
  }
  const yearMonthRe = /^\d{4}-(0[1-9]|1[0-2])$/
  const from = showFrom.value.trim()
  const until = showUntil.value.trim()
  if (from && !yearMonthRe.test(from)) {
    validationError.value = 'Visible from must be YYYY-MM'
    return
  }
  if (until && !yearMonthRe.test(until)) {
    validationError.value = 'Visible until must be YYYY-MM'
    return
  }
  if (props.mode === 'edit' && isClosed.value && !yearMonthRe.test(closeMonth.value)) {
    validationError.value = 'Closing month is required and must be YYYY-MM'
    return
  }
  if (from && until && from > until) {
    validationError.value = 'Visible from must be on or before Visible until'
    return
  }
  validationError.value = null
  const storedRate = rateInput.value !== null ? rateInput.value / 100 : null
  if (props.mode === 'create') {
    props.onSave({
      name: name.value.trim(),
      category_id: categoryId.value,
      include_in_current_wealth: includeCurrent.value,
      include_in_projections: includeProjection.value,
      projected_yearly_growth: storedRate,
      notes: notes.value.trim() || undefined,
      person_id: personId.value,
      show_from: from || null,
      show_until: until || null,
    })
  } else {
    props.onSave({
      closed_at: isClosed.value ? closeMonth.value : null,
      name: name.value.trim(),
      category_id: categoryId.value,
      include_in_current_wealth: includeCurrent.value,
      include_in_projections: includeProjection.value,
      projected_yearly_growth: storedRate,
      notes: notes.value.trim(),
      person_id: personId.value,
      show_from: from || null,
      show_until: until || null,
    })
  }
}
</script>

<template>
  <Dialog
    :header="`${mode === 'create' ? 'Add' : 'Edit'} ${entityLabel ?? 'Asset'}`"
    :visible="true"
    @update:visible="(v) => !v && onCancel()"
    :style="{ width: '32rem' }"
    modal
    :draggable="false"
  >
    <div class="mb-3">
      <label class="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1">Name</label>
      <InputText v-model="name" class="w-full" />
    </div>
    <div class="mb-3">
      <label class="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1">ID (slug) — read only</label>
      <input type="text" :value="slugPreview" readonly
        class="w-full bg-gray-50 dark:bg-zinc-950 cursor-not-allowed px-3 py-2 text-sm border border-gray-200 dark:border-zinc-700 rounded-md text-gray-500 dark:text-zinc-400" />
      <p v-if="slugConflict" class="text-xs text-red-600 mt-1">An entry with id '{{ slugPreview }}' already exists.</p>
    </div>
    <div class="mb-3">
      <label class="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1">Category</label>
      <Select v-model="categoryId" :options="categories" option-label="name" option-value="id" class="w-full" />
    </div>
    <div class="mb-3">
      <label class="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1">Growth Rate % (optional — leave blank to inherit from category)</label>
      <InputNumber v-model="rateInput" suffix=" %" :min-fraction-digits="0" :max-fraction-digits="4" class="w-full" placeholder="e.g. 8" />
    </div>
    <div class="mb-3">
      <label class="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1">Notes (optional)</label>
      <InputText v-model="notes" class="w-full" />
    </div>
    <div class="mb-3">
      <label class="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1">Person</label>
      <Select v-model="personId" :options="personOptions" option-label="name" option-value="id" class="w-full" />
    </div>
    <div class="mb-3 grid grid-cols-2 gap-3">
      <div>
        <label class="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1">Visible from (optional)</label>
        <input
          type="month"
          v-model="showFrom"
          class="w-full bg-white dark:bg-zinc-900 px-3 py-2 text-sm border border-gray-200 dark:border-zinc-700 rounded-md text-gray-900 dark:text-zinc-100"
          placeholder="YYYY-MM"
        />
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1">Visible until (optional)</label>
        <input
          type="month"
          v-model="showUntil"
          class="w-full bg-white dark:bg-zinc-900 px-3 py-2 text-sm border border-gray-200 dark:border-zinc-700 rounded-md text-gray-900 dark:text-zinc-100"
          placeholder="YYYY-MM"
        />
      </div>
    </div>
    <details v-if="mode === 'edit' || selectedCategory?.type !== 'cash-inflow'" class="mb-4 rounded-lg border border-gray-200 p-3 dark:border-zinc-700">
      <summary class="cursor-pointer text-sm font-semibold">Advanced</summary>
      <template v-if="selectedCategory?.type !== 'cash-inflow'">
      <p class="mt-2 text-xs text-gray-500 dark:text-zinc-400">Inherit uses the selected category's setting.</p>
      <fieldset class="mt-3 rounded-lg border border-gray-200 p-3 dark:border-zinc-700"><legend class="px-1 text-sm font-medium">Current wealth</legend>
        <div class="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <label class="inline-flex min-h-11 items-center gap-2"><input v-model="includeCurrent" type="radio" class="accent-emerald-600" name="asset-current-inclusion" :value="null" /> Inherit ({{ selectedCategory?.include_in_current_wealth === false ? 'excluded' : 'included' }})</label>
          <label class="inline-flex min-h-11 items-center gap-2"><input v-model="includeCurrent" type="radio" class="accent-emerald-600" name="asset-current-inclusion" :value="true" /> Include</label>
          <label class="inline-flex min-h-11 items-center gap-2"><input v-model="includeCurrent" type="radio" class="accent-emerald-600" name="asset-current-inclusion" :value="false" /> Exclude</label>
        </div>
      </fieldset>
      <fieldset class="mt-4 rounded-lg border border-gray-200 p-3 dark:border-zinc-700"><legend class="px-1 text-sm font-medium">Projections</legend>
        <div class="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <label class="inline-flex min-h-11 items-center gap-2"><input v-model="includeProjection" type="radio" class="accent-emerald-600" name="asset-projection-inclusion" :value="null" /> Inherit ({{ selectedCategory?.include_in_projections === false ? 'excluded' : 'included' }})</label>
          <label class="inline-flex min-h-11 items-center gap-2"><input v-model="includeProjection" type="radio" class="accent-emerald-600" name="asset-projection-inclusion" :value="true" /> Include</label>
          <label class="inline-flex min-h-11 items-center gap-2"><input v-model="includeProjection" type="radio" class="accent-emerald-600" name="asset-projection-inclusion" :value="false" /> Exclude</label>
        </div>
      </fieldset>
      <p v-if="futureOnly" class="mb-0 mt-3 text-xs text-gray-500 dark:text-zinc-400">Uses future-dated values in projections; current estimates are excluded.</p>
      </template>
      <div v-if="mode === 'edit'" class="mt-4 border-t border-gray-200 pt-3 dark:border-zinc-700">
        <label class="inline-flex min-h-11 items-center gap-2 text-sm font-medium"><input v-model="isClosed" type="checkbox" class="accent-emerald-600" /> Closed</label>
        <div v-if="isClosed" class="mt-2">
          <label for="closing-month" class="mb-1 block text-xs font-medium text-gray-600 dark:text-zinc-300">Closing month</label>
          <input id="closing-month" v-model="closeMonth" type="month" required :aria-invalid="!!validationError && !closeMonth" aria-describedby="closing-help" class="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" />
          <p id="closing-help" class="mt-2 text-xs text-gray-500 dark:text-zinc-400">{{ selectedCategory?.type === 'cash-inflow' ? 'This item remains active through the closing month.' : 'Record a final zero value for the closing month before closing. This item remains active through that month.' }}</p>
        </div>
      </div>
    </details>
    <p v-if="selectedCategory?.type === 'cash-inflow'" class="mb-4 text-xs text-gray-500 dark:text-zinc-400">Income is tracked separately on the Income page.</p>
    <p v-if="validationError" role="alert" class="text-xs text-red-600 mt-2">{{ validationError }}</p>
    <p v-if="saveError" role="alert" class="text-xs text-red-600 mt-2">{{ saveError }}</p>
    <template #footer>
      <div class="flex justify-end gap-2">
        <Button label="Cancel" outlined @click="onCancel" type="button" />
        <Button :label="saving ? 'Saving…' : 'Save'" :disabled="saving || slugConflict" @click="handleSubmit" type="button" />
      </div>
    </template>
  </Dialog>
</template>
