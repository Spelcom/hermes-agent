import path from 'node:path'

/** Seal a personal local build without selecting certificates from the keychain.
 * The configured signer owns entitlements and refreshes payload digests before
 * the outer seal, just as it does for a release.
 */
export async function signKontoraLocalMacApp(context, env = process.env) {
  if (context.electronPlatformName !== 'darwin' || env.KONTORA_ADHOC_SIGN !== '1') return
  if (env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false') {
    throw new Error('KONTORA_ADHOC_SIGN=1 requires CSC_IDENTITY_AUTO_DISCOVERY=false')
  }
  const { packager } = context
  if (packager.config.electronFuses) {
    throw new Error('KONTORA_ADHOC_SIGN must run after fuse changes; this local hook requires no electronFuses')
  }
  if (typeof packager.config.mac.sign !== 'function') {
    throw new Error('KONTORA_ADHOC_SIGN requires the configured Hermes macOS signer')
  }
  await packager.config.mac.sign({
    app: path.join(context.appOutDir, `${packager.appInfo.productFilename}.app`),
    platform: 'darwin',
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true
  }, packager)
}
