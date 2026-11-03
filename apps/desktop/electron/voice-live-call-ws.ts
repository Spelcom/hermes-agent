import { type GatewayEndpoint, localGatewayDial, type mintLocalGatewayTicket } from './local-gateway'

/** The bridge accepts one opaque call ID, never a renderer-selected core path. */
export function voiceLiveCallPath(callId: unknown): string {
  if (typeof callId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(callId)) {
    throw new Error('Invalid voice call identity')
  }

  return `/api/audio/voice-live/calls/${callId}`
}

interface VoiceCallRequest { connectionId?: unknown; profile?: unknown; callId?: unknown }
interface ResolvedBackend { baseUrl: string; gatewayEndpoint?: GatewayEndpoint }

/** Remote intent resolves through the registry and never falls to a local launch. */
export function createVoiceLiveCallWsUrlHandler(deps: {
  ensureBackend: (profile: unknown) => Promise<ResolvedBackend>
  ensureRegistryBackend: (connectionId: unknown, profile: unknown) => Promise<ResolvedBackend>
  forgetLocalGatewayDescriptor: (profile: unknown) => Promise<void> | void
  forgetRegistryLocalGatewayDescriptor: (connectionId: unknown, profile: unknown) => Promise<void> | void
  launchHome: string
  mint?: typeof mintLocalGatewayTicket
  prepare: (origin: string, callId: string, ticket: string, webContentsId: number, profile: string) => string
}) {
  return async (request: VoiceCallRequest, webContentsId: number): Promise<string | null> => {
    voiceLiveCallPath(request?.callId)
    const { connectionId, profile, callId } = request
    const ensure = () => connectionId ? deps.ensureRegistryBackend(connectionId, profile) : deps.ensureBackend(profile)

    if (!(await ensure()).gatewayEndpoint) { return null }

    return localGatewayDial({
      ensure,
      forget: () => connectionId ? deps.forgetRegistryLocalGatewayDescriptor(connectionId, profile) : deps.forgetLocalGatewayDescriptor(profile),
      launchHome: deps.launchHome,
      mint: deps.mint,
      prepare: (origin, ticket) => deps.prepare(origin, callId as string, ticket, webContentsId, typeof profile === 'string' ? profile : ''),
      profile: typeof profile === 'string' ? profile : '',
      purpose: 'interactive'
    })
  }
}
