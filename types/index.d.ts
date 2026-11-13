// State contract of the reasoning-controller mod: what it keeps in $.state
// for the session (survives a hot reload; never the prompt's text).

export type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ReasoningSource =
  | 'auto'
  | 'fallback'
  | 'continuation'
  | 'override'
  | 'keys'
  | 'manual'
  | 'session'
  | 'unsupported'

/** The decision for the current (or last) main-loop task, as the UI shows it. */
export type ReasoningDecisionView = {
  turnId: string
  /** The level sent with the turn's requests; absent: left untouched. */
  level?: ReasoningLevel
  requested?: ReasoningLevel
  /** The session's own level for this model, as the engine reported it. */
  baseline?: ReasoningLevel
  source: ReasoningSource
  mode: string
  categoryLabel: string
  reasons: string[]
  notes: string[]
  family: string
  score: number
  escalated: boolean
  escalationReason?: string
}

declare module 'claude-code' {
  interface PluginState {
    'reasoning-controller': {
      current: Shaped<ReasoningDecisionView | null>
      /** A /reasoning <level> waiting for the next task. */
      pending: ReasoningLevel | null
    }
    /**
     * The two values of the effort-cycle plugin (Anerco) this mod reads and
     * keeps consistent, as that plugin's own contract declares them. Absent
     * plugin: both read null.
     */
    'effort-cycle': {
      override: { model: string; level: string } | null
      base: { model: string; level: string } | null
    }
  }
}
