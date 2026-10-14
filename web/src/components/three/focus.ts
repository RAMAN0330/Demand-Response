// Shared map-focus vocabulary (planned → sent → acked → delivering, or failed/excluded).
export type FocusStatus = 'planned' | 'sent' | 'acked' | 'delivering' | 'failed' | 'excluded'
export type Focus = Record<string, { mw: number; status: FocusStatus }>

export const STATUS_COLOR: Record<FocusStatus, string> = {
  planned: '#8d76ee',
  sent: '#c07e18',
  acked: '#9bbf5a',
  delivering: '#47a37b',
  failed: '#b83b3a',
  excluded: '#b83b3a',
}
