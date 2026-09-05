import { createPetRenderer } from './renderer.ts'
import { PET_STATUS_LABELS, type PetStatus } from './state-machine.ts'
import './pet.css'

const canvas = document.querySelector<HTMLCanvasElement>('#pet')
const fallback = document.querySelector<HTMLElement>('#pet-fallback')
const liveLabel = document.querySelector<HTMLElement>('#pet-status')

if (!canvas) throw new Error('FlowPal pet canvas is missing')

const setLiveStatus = (status: PetStatus): void => {
  if (liveLabel) liveLabel.textContent = PET_STATUS_LABELS[status]
}

const renderer = createPetRenderer({
  canvas,
  fallback,
  // quiet-pebble's production-sized preset is 96 logical px. The 224px
  // preset remains available through the renderer contract for an explicit
  // enlarged presentation, but a resident desktop pet must stay unobtrusive.
  size: 96,
  onInteraction: (event) => {
    const pet = window.flowpal?.pet
    if (event.type === 'hit') {
      pet?.reportHit(event.inside)
      return
    }
    if (event.type === 'dragstart') pet?.beginDrag(event.pointer)
    if (event.type === 'dragmove') pet?.moveDrag(event.pointer)
    if (event.type === 'pointerup') void pet?.endDrag()
    if (event.type === 'pointercancel') pet?.cancelDrag()
  },
})

// Gesture transitions (including cancel/restore) happen inside the renderer,
// so the accessibility label follows the same source of truth as the pixels.
const removeStateSubscription = renderer.state.subscribe(
  (snapshot) => setLiveStatus(snapshot.status),
  true,
)

const removePetCommand = window.flowpal?.pet?.onCommand((command) => {
  if (command.type === 'set-status' && command.status) {
    renderer.setStatus(command.status, command.meta)
  } else if (command.type === 'open-main') {
    void window.flowpal?.openMain?.(command.hash)
  } else if (command.type === 'hide') {
    void window.flowpal?.hideWindow()
  }
})

window.addEventListener('beforeunload', () => renderer.dispose(), { once: true })
window.addEventListener('beforeunload', () => removeStateSubscription(), { once: true })
window.addEventListener('beforeunload', () => removePetCommand?.(), { once: true })
