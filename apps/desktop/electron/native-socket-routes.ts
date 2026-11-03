import type { IpcMain } from 'electron'

import { createPluginWsUrlHandler } from './plugin-ws-url'
import { createVoiceLiveCallWsUrlHandler } from './voice-live-call-ws'

type PluginDependencies = Parameters<typeof createPluginWsUrlHandler>[0]
type VoiceDependencies = Parameters<typeof createVoiceLiveCallWsUrlHandler>[0]

/** Native sibling sockets reserve their final path before the renderer dials. */
export function registerNativeSocketRoutes(ipcMain: Pick<IpcMain, 'handle'>, deps: Omit<PluginDependencies, 'prepare'> & {
  preparePlugin: PluginDependencies['prepare']
  prepareVoiceCall: VoiceDependencies['prepare']
}) {
  const plugin = createPluginWsUrlHandler({ ...deps, prepare: deps.preparePlugin })
  const voice = createVoiceLiveCallWsUrlHandler({ ...deps, prepare: deps.prepareVoiceCall })

  ipcMain.handle('hermes:plugin:ws-url', (event, payload) => plugin(payload ?? {}, event.sender.id))
  ipcMain.handle('hermes:voice-live:call-ws-url', (event, payload) => voice(payload ?? {}, event.sender.id))
}
