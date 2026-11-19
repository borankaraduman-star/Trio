import type { ChannelPins } from '../../store'
import type { Member } from '../../types'
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
  users,
}: {
  family: MessageFamily
  pins: ChannelPins | undefined
  channelName: string
  nameOf: (userId: number) => string
  /** v4: current members, so a pin shows its author's current name and avatar. */
  users?: Record<number, Member>
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
          users={users}
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
