// The full-screen game guide, hoisted to the top level.
//
// It lives here rather than inside the media widget because two very different
// things open it: a tap on a game in the Watch/Play list, and the assistant being
// asked out loud ("put the Majora's Mask guide up", "open the Woodfall Temple
// chapter"). Both go through the useGuideOverlay store, so neither has to know
// about the other — and the guide can be on screen with the widget closed.
//
// Portalled to body like BrowserOverlay so it escapes every widget's stacking
// context.
//
// THE STACK, top to bottom — the three portals that can be on screen together:
//
//   9200/9190  BrowserOverlay window / its backdrop — a video or page opened
//              from inside a chapter has to land on top of the chapter
//   9100       this guide
//   9000       Widget's expanded overlay (the Watch/Play list itself)
//
// The guide sat at 8900 until it was reported invisible: tapping a game in the
// expanded list calls openGuide, which rendered the guide UNDER the very widget
// you tapped it from, so it only appeared once you closed the list. Anything
// added here must keep the guide above 9000 and below the browser window.

import { createPortal } from 'react-dom'
import { useMediaList } from '../hooks/useMediaList'
import { useGuide, requestGuide, removeGuide } from '../hooks/useGuides'
import { closeGuide, useGuideTarget } from '../hooks/useGuideOverlay'
import { GuideView } from './widgets/MediaListWidget/GuideView'

export function GuideOverlay() {
  const target = useGuideTarget()
  // The list is already loaded and cached by App's own hook; this second reader
  // is only here so the overlay can resolve an id to a title and cover without
  // having them threaded through the store.
  const { items } = useMediaList()
  const {
    guide, loading, toggleStep, toggleSubStep, togglePart, toggleSection, rebuildSection, enrichSection,
    addPin, movePin, removePin, moveStepPin,
  } = useGuide(target?.itemId ?? null)

  if (!target) return null
  const item = items.find(i => i.id === target.itemId)
  // The item can vanish (removed from the list while the guide was up).
  if (!item) return null

  return createPortal(
    <div className="fixed inset-0 z-[9100]">
      <GuideView
        item={item}
        guide={guide}
        loading={loading}
        chapterHint={target.chapter}
        hintSeq={target.seq}
        onClose={closeGuide}
        onToggleStep={toggleStep}
        onToggleSub={toggleSubStep}
        onTogglePart={togglePart}
        onToggleSection={toggleSection}
        onRebuildSection={rebuildSection}
        onEnrichSection={enrichSection}
        onAddPin={addPin}
        onMovePin={movePin}
        onRemovePin={removePin}
        onMoveStepPin={moveStepPin}
        onGenerate={order => requestGuide(item.id, item.title, order)}
        onDelete={() => removeGuide(item.id)}
      />
    </div>,
    document.body,
  )
}
