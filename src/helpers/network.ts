import { type ISupportedNetwork, NetworksEnum } from '@types'
import ProviderModule from '@modules/provider'
import config from '@config'
import utils from '@helpers/utils'

export const NetworkHelper = {
  supportedNetworks(): ISupportedNetwork[] {
    const configuredNetworks = Array.isArray(config.SUPPORTED_NETWORKS) ? config.SUPPORTED_NETWORKS : []
    const allowedNetworks = configuredNetworks.length > 0 ? new Set(configuredNetworks) : null
    const networks = Object.values(NetworksEnum).filter(networkName => {
      if (!allowedNetworks) return true
      return allowedNetworks.has(networkName)
    })

    const result = networks.reduce((acc: any, networkName) => {
      const provider = ProviderModule.getAnyRpcProvider(networkName)
      if (provider) {
        const rawNetwork = {
          networkName,
          provider,
        }
        acc.push(rawNetwork)
      }

      return acc
    }, [])

    return result as ISupportedNetwork[]
  },
  getAverageBlockTime(network: NetworksEnum): number {
    const networkConfig = config.NODES[utils.networkToAragon(network)]
    return networkConfig.INTERVAL_BLOCK_TIME
  },
}
