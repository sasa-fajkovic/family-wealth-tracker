<script setup lang="ts">
import { computed, ref } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import { ApiError, importFile, previewImport } from '../../api/client'
import type { ImportConflict, ImportSuccess, ImportTarget, ImportPreview } from '../../api/client'

const props = defineProps<{
  visible: boolean
}>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'imported'): void
}>()

const targetOptions: { label: string; value: ImportTarget; accept: string }[] = [
  { label: 'database.yaml', value: 'database', accept: '.yaml,.yml' },
  { label: 'datapoints.csv', value: 'datapoints', accept: '.csv' },
]

const target = ref<ImportTarget>('database')
const file = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const submitting = ref(false)
const error = ref<string | null>(null)
const conflict = ref<ImportConflict | null>(null)
const success = ref<ImportSuccess | null>(null)
const preview = ref<ImportPreview | null>(null)
const previewedFile = ref<File | null>(null)
const previewedTarget = ref<ImportTarget | null>(null)
let requestSequence = 0

const accept = computed(() => targetOptions.find(o => o.value === target.value)!.accept)

function reset() {
  requestSequence++
  previewedFile.value = null
  previewedTarget.value = null
  file.value = null
  if (fileInput.value) fileInput.value.value = ''
  error.value = null
  conflict.value = null
  preview.value = null
  success.value = null
  submitting.value = false
}

function close() {
  reset()
  emit('update:visible', false)
}

function onFileChange(e: Event) {
  requestSequence++
  previewedFile.value = null
  previewedTarget.value = null
  const f = (e.target as HTMLInputElement).files?.[0] ?? null
  file.value = f
  conflict.value = null
  preview.value = null
  success.value = null
  error.value = null
}

function onTargetChange() {
  requestSequence++
  previewedFile.value = null
  previewedTarget.value = null
  // Reset the file when target changes — the previously-selected file likely has the wrong extension.
  file.value = null
  if (fileInput.value) fileInput.value.value = ''
  conflict.value = null
  preview.value = null
  success.value = null
  error.value = null
}

async function inspect() {
  if (!file.value || submitting.value) return
  const selectedFile = file.value
  const selectedTarget = target.value
  const sequence = ++requestSequence
  submitting.value = true
  error.value = null
  try {
    const result = await previewImport(selectedTarget, selectedFile)
    if (sequence !== requestSequence || file.value !== selectedFile || target.value !== selectedTarget) return
    previewedFile.value = selectedFile
    previewedTarget.value = selectedTarget
    preview.value = result
  } catch (e) {
    if (sequence === requestSequence) error.value = e instanceof ApiError ? e.message : 'Unexpected error'
  } finally {
    if (sequence === requestSequence) submitting.value = false
  }
}

async function submit(force = false) {
  if (!file.value || submitting.value || file.value !== previewedFile.value || target.value !== previewedTarget.value) return
  submitting.value = true
  error.value = null
  try {
    const res = await importFile(target.value, file.value, force)
    if (res.ok) {
      success.value = res
      conflict.value = null
      emit('imported')
    } else {
      conflict.value = res
    }
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Unexpected error'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Dialog
    :visible="props.visible"
    @update:visible="(v) => !v && close()"
    :style="{ width: '34rem' }"
    modal
    :draggable="false"
    :closable="!submitting"
    :dismissable-mask="!submitting"
    header="Import data"
  >
    <div v-if="!success" class="flex flex-col gap-4">
      <p class="text-xs text-gray-500 dark:text-zinc-400">
        The selected file replaces the live <strong>{{ target === 'database' ? 'database.yaml' : 'datapoints.csv' }}</strong>.
        A timestamped backup of the current file is written to the data directory before the live file is overwritten.
      </p>

      <div>
        <label class="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1">What to import</label>
        <Select
          v-model="target"
          :disabled="submitting"
          :options="targetOptions"
          option-label="label"
          option-value="value"
          @change="onTargetChange"
          class="w-full"
        />
      </div>

      <div>
        <label class="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1">File ({{ accept }})</label>
        <input
          ref="fileInput"
          type="file"
          :disabled="submitting"
          :accept="accept"
          @change="onFileChange"
          class="w-full text-sm"
        />
      </div>

      <div v-if="preview" class="rounded-md border p-3 text-sm space-y-2">
        <p class="font-semibold">Import preview</p>
        <p>{{ Object.entries(preview.counts).map(([k, v]) => `${k}: ${v}`).join(' · ') }}</p>
        <ul v-if="preview.changes"><li v-for="(change, kind) in preview.changes" :key="kind">{{ kind }}: {{ change.added }} added, {{ change.replaced }} replaced, {{ change.removed }} removed</li></ul>
        <details v-for="group in [...preview.conflicts, ...preview.orphans]" :key="group.kind"><summary class="cursor-pointer">{{ group.kind }} ({{ group.ids.length }})</summary><ul><li v-for="id in group.ids" :key="id">{{ id }}</li></ul></details>
        <p v-if="preview.conflicts.length" class="text-red-700">Resolve these conflicts in the file before importing.</p>
        <p v-if="preview.needs_force" class="text-amber-700">Applying this import will remove or orphan existing data.</p>
      </div>

      <div v-if="conflict" class="border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 rounded-md p-3 text-xs space-y-2">
        <p class="font-medium text-amber-800 dark:text-amber-200">Confirm destructive import</p>
        <p class="text-amber-700 dark:text-amber-300">{{ conflict.message }}</p>
        <details class="text-amber-700 dark:text-amber-300">
          <summary class="cursor-pointer">Show affected ids ({{ conflict.orphans[0]?.ids.length ?? 0 }})</summary>
          <ul class="mt-1 list-disc list-inside font-mono">
            <li v-for="id in conflict.orphans[0]?.ids ?? []" :key="id">{{ id }}</li>
          </ul>
        </details>
      </div>

      <p v-if="error" class="text-xs text-red-600">{{ error }}</p>
    </div>

    <div v-else class="border border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/40 rounded-md p-3 text-xs space-y-1">
      <p class="font-medium text-emerald-800 dark:text-emerald-200">Import complete</p>
      <p class="text-emerald-700 dark:text-emerald-300">
        Backup: <span class="font-mono">{{ success.backup }}</span>
      </p>
      <p class="text-emerald-700 dark:text-emerald-300">
        Imported: <span class="font-mono">{{ Object.entries(success.counts).map(([k, v]) => `${k}=${v}`).join(', ') }}</span>
      </p>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <Button v-if="!success" label="Cancel" outlined :disabled="submitting" @click="close" type="button" />
        <Button
          v-if="!success && !preview"
          :label="submitting ? 'Checking…' : 'Preview import'"
          :disabled="!file || submitting"
          @click="inspect"
          type="button"
        />
        <Button v-if="preview && !conflict && !success" :label="submitting ? 'Importing…' : 'Apply import'" :severity="preview.needs_force ? 'danger' : undefined" :disabled="submitting || preview.conflicts.length > 0" @click="submit(preview.needs_force)" type="button" />
        <Button
          v-if="conflict"
          :label="submitting ? 'Importing…' : 'Import anyway'"
          severity="danger"
          :disabled="submitting"
          @click="submit(true)"
          type="button"
        />
        <Button v-if="success" label="Close" @click="close" type="button" />
      </div>
    </template>
  </Dialog>
</template>
