import type { ChannelPins } from '../../store'
import type { MessageFamily } from '../../useMessageFamily'
import { PinIcon } from './icons'
import { PinsPanel } from './PinsPanel'
import { rectOf } from './Popover'

/** The header's pin button and the "Sabitlenenler" panel it opens. */
export function PinsButton({
  family,
  pins,
  channelName,
  nameOf,
}: {
  family: MessageFamily
  pins: ChannelPins | undefined
  channelName: string
  nameOf: (userId: number) => string
}) {
  const { actions, pinsOpen } = family
  return (
    <>
      <button
        type="button"
        className={`icon-button pins-button${pinsOpen ? ' active' : ''}`}
        data-testid="btn-pins"
        aria-label="Sabitlenenler"
        aria-expanded={pinsOpen}
        title="Sabitlenenler"
        onClick={(event) => actions.setPinsOpen(!pinsOpen, rectOf(event.currentTarget))}
      >
        <PinIcon size={18} />
      </button>
      {pinsOpen && (
        <PinsPanel
          channelName={channelName}
          pins={pins}
          anchor={family.pinsAnchor}
          nameOf={nameOf}
          onClose={() => actions.setPinsOpen(false)}
          onRetry={actions.reloadPins}
          onUnpin={(message) => actions.togglePin(message)}
          onJump={(message) => {
            actions.setPinsOpen(false)
            actions.jumpTo(message.id)
          }}
        />
      )}
    </>
  )
}
