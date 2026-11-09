export type SamPose = 'mark' | 'happy' | 'thinking' | 'concerned' | 'full' | 'celebrating'

const FILE: Record<SamPose, string> = {
  mark: 'sam-mark.svg',
  happy: 'sam-mark-happy.svg',
  thinking: 'sam-mark-thinking.svg',
  concerned: 'sam-mark-concerned.svg',
  full: 'sam-full.svg',
  celebrating: 'sam-full-celebrating.svg',
}

/** SAM the owl, as decoration beside text that carries the meaning. */
export function Sam({ pose = 'mark', className }: { pose?: SamPose; className?: string }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}brand/sam/${FILE[pose]}`}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-sam={pose}
      className={className}
    />
  )
}
