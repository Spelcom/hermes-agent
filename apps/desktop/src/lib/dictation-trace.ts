type DictationStage =
  | 'start'
  | 'mic-open'
  | 'config-start'
  | 'config-ready'
  | 'stop'
  | 'clip-ready'
  | 'warmup-ready'
  | 'live-ready'
  | 'transcribe-start'
  | 'transcribe-ready'
  | 'relay-start'
  | 'relay-ready'
  | 'inserted'
  | 'finish'
  | 'error'
  | 'cancel'

let nextId = 0

/** Bounded lifecycle diagnostics only: never audio, transcript, config or credentials. */
export function createDictationTrace() {
  const id = ++nextId
  const started = Date.now()

  return (stage: DictationStage) => {
    window.hermesDesktop?.logLine?.(`[dictation] id=${id} stage=${stage} elapsed_ms=${Date.now() - started}`)
  }
}
