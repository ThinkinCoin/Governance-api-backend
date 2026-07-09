import logger from '@logger'
import { EnumConnection, EnumQueueName, EnumServiceName, IPluginStatus, type IService } from '@types'
import { TaskSchedulerState } from '@state/taskSchedulerState'
import { NetworkHelper } from '@helpers/network'
import configIndexer from '@indexer/configIndexer'
import utils from '@helpers/utils'
import { BlockchainLogCrawler, ProgressTracker } from '@modules/crawlers'
import { SyncAll } from '@indexer/syncAll'
import config from '@config'
import PoolingCrawler from '@modules/poolingCrawler'
import { Models } from '@dbModels'
import RabbitMQHelper from '@helpers/rabbitMQ'
import ConfigIndexerHelper from '@helpers/configIndexer'
import Web3Helper from '@helpers/web3'
import HarmonyVotingFinalizer from './harmonyVotingFinalizer'
import { resolveActiveContractsVersion } from '@helpers/contractsConfigVersion'

import harmonyMainnetContracts from '../../../config/contracts/harmonyMainnet.json'
import harmonyTestnetContracts from '../../../config/contracts/harmonyTestnet.json'

const llo = logger.logMeta.bind(null, { service: 'service:IndexerService' })

type ContractsConfig = Record<string, Record<string, { address: string; blockNumber?: number; deploymentTx?: string }>>

const backfillInstalledPlugins = async (networkName: string) => {
  const pluginsToSync = await Models.Plugin.find({
    network: networkName,
    status: IPluginStatus.installed,
    isHistoricalSynced: { $ne: true },
  })

  if (!pluginsToSync.length) return

  logger.info('Scheduling historical plugin sync', llo({ networkName, count: pluginsToSync.length }))

  await Promise.all(
    pluginsToSync.map(async plugin =>
      RabbitMQHelper.sendMessage(EnumQueueName.plugins, {
        id: `historical-${plugin.address}-${plugin.network}`,
        params: { address: plugin.address, network: plugin.network, isHistorical: true },
      }),
    ),
  )
}

const getIndexerCoreAddresses = async (networkName: string): Promise<string[] | undefined> => {
  const configByNetwork: Partial<Record<string, ContractsConfig>> = {
    'harmony-mainnet': harmonyMainnetContracts as unknown as ContractsConfig,
    'harmony-testnet': harmonyTestnetContracts as unknown as ContractsConfig,
  }

  const cfg = configByNetwork[networkName]
  if (!cfg) return undefined

  const overrideEnvVar =
    networkName === 'harmony-mainnet'
      ? 'HARMONY_MAINNET_CONTRACTS_VERSION'
      : networkName === 'harmony-testnet'
        ? 'HARMONY_TESTNET_CONTRACTS_VERSION'
        : undefined

  const version = resolveActiveContractsVersion(cfg, {
    overrideVersionKey: overrideEnvVar ? process.env[overrideEnvVar] : undefined,
  })

  const candidates = [
    version.DAORegistryProxy?.address,
    version.PluginRepoRegistryProxy?.address,
    version.PluginSetupProcessor?.address,
  ]

  const addresses = candidates
    .filter((address): address is string => typeof address === 'string')
    .map(address => address.toLowerCase())
    .filter(address => address !== '0x0000000000000000000000000000000000000000')

  // CRITICAL FIX: Add all installed plugin addresses for this network
  try {
    const installedPlugins = await Models.Plugin.find({
      network: networkName,
      status: 'installed',
    })
      .select('address')
      .lean()
      .exec()

    const pluginAddresses = installedPlugins
      .map(p => p.address?.toLowerCase())
      .filter(
        (addr): addr is string => typeof addr === 'string' && addr !== '0x0000000000000000000000000000000000000000',
      )

    if (pluginAddresses.length > 0) {
      logger.info(
        `Added ${pluginAddresses.length} installed plugin addresses to indexer for ${networkName}`,
        llo({ pluginAddresses }),
      )
      addresses.push(...pluginAddresses)
    }
  } catch (error) {
    logger.warn('Failed to fetch installed plugins for indexer', llo({ networkName, error }))
  }

  return addresses.length > 0 ? addresses : undefined
}

const getHarmonyAdaptiveConfig = (networkName: string) => {
  if (networkName !== 'harmony-mainnet' && networkName !== 'harmony-testnet') return undefined

  // Harmony RPC often imposes very low limits on eth_getLogs (e.g., range <= 1024 blocks).
  // Use a small initial batch and a lower minimum to avoid repeatedly hitting the limit.
  return {
    initialBatchDays: 0.02,
    minBatchDays: 0.001,
    maxBatchDays: 1,
  }
}

const AragonIndexerService: IService & { repeaters: any } = {
  name: EnumServiceName.ARAGON_INDEXER,
  NEED_CONNECTIONS: [EnumConnection.MONGODB, EnumConnection.BLOCKCHAIN, EnumConnection.RABBITMQ],
  options: { mongoSync: config.MONGO_DB.SYNC_MODELS },
  repeaters: {},

  start: async function () {
    logger.info('IndexerService historical started', llo({}))

    const networks = NetworkHelper.supportedNetworks()

    await Promise.all(
      networks.map(async ({ networkName }) => {
        const logService = ConfigIndexerHelper.builders.indexer(networkName)
        const initialBlock = config.NODES[utils.networkToAragon(networkName)].FROM_BLOCK

        const indexerAddresses = await getIndexerCoreAddresses(networkName)

        if (
          (networkName === 'harmony-mainnet' || networkName === 'harmony-testnet') &&
          config.NODES[utils.networkToAragon(networkName)]?.FROM_BLOCK === 0
        ) {
          logger.warn(
            'Harmony FROM_BLOCK is 0; historical sync can be extremely slow. Consider setting NODES_HARMONY_*_FROM_BLOCK near your deployment/first DAO block.',
            llo({ networkName }),
          )
        }

        const existingConfig = await Models.ConfigIndexer.findExistingLog({
          network: networkName,
          service: logService,
        })

        let shouldReplayHistorical = !existingConfig

        if (existingConfig) {
          const daoCount = await Models.Dao.countDocuments({ network: networkName })

          if (daoCount === 0) {
            const latestBlock = await Web3Helper.getBlockNumber('latest', networkName)
            const confirmationBlocks = config.NODES[utils.networkToAragon(networkName)].CONFIRMATION_BLOCKS ?? 0
            const nearChainHead = existingConfig.lastSync >= Math.max(initialBlock, latestBlock - confirmationBlocks - 5)

            if (nearChainHead) {
              logger.warn(
                'Indexer progress exists at chain head but DAO collection is empty; resetting historical progress',
                llo({
                  networkName,
                  logService,
                  initialBlock,
                  lastSync: existingConfig.lastSync,
                  latestBlock,
                }),
              )

              const progressTracker = new ProgressTracker({
                network: networkName,
                service: logService,
                initialBlock,
              })

              await progressTracker.resetProgress()
              shouldReplayHistorical = true
            }
          }
        }

        // sync historical data
        if (shouldReplayHistorical) {
          logger.info('HistoricalCrawler start', llo({ networkName }))
          const historicalCrawler = new BlockchainLogCrawler({
            onlyHistorical: true,
            network: networkName,
            address: indexerAddresses,
            events: utils.filterArrayByProperty(configIndexer, 'enableHistorical'),
            adaptiveConfig: getHarmonyAdaptiveConfig(networkName),
            onError: async (error: any) => logger.error('Error Indexer', llo(error)),
            logService,
            stopOnError: true,
          })
          await historicalCrawler.crawl()
          logger.info('HistoricalCrawler end', llo({ networkName }))
        }

        // Ensure newly installed plugins receive a one-time historical sync
        await backfillInstalledPlugins(networkName)

        // sync all metrics by network
        logger.info('Sync all metrics start', llo({ networkName }))
        await RabbitMQHelper.sendMessage(EnumQueueName.allMetrics, {
          id: `${EnumQueueName.allMetrics}-${networkName}`,
          params: { network: networkName },
        })

        // realtime after sync
        logger.info('PoolingCrawler start', llo({ networkName }))

        const taskOptions = {
          fn: () => [[{ poolingCrawler: PoolingCrawler, params: { logService, network: networkName, address: indexerAddresses } }]],
          interval: config.NODES[utils.networkToAragon(networkName)].POOLING_INTERVAL,
          checkInterval: config.NODES[utils.networkToAragon(networkName)].POOLING_INTERVAL / 2,
          runNow: true,
          stopOnError: false,
          onError: (error: any) => logger.error('Error pooling logs', llo({ networkName, error })),
        }

        const scheduler = TaskSchedulerState.getInstance()
        await scheduler.startTask(logService, taskOptions)
      }),
    )

    // re-sync all installed plugins
    if (config.SERVICES.ARAGON_INDEXER.SYNC_ALL) {
      logger.info('Sync all plugins start', llo({}))

      const taskOptions = {
        fn: () => [[{ syncAllPlugins: SyncAll }]],
        interval: 5 * 1000,
        runNow: true,
        stopOnError: false,
        onError: (error: any) => logger.error('Error sync all plugins', llo({ error })),
      }
      const scheduler = TaskSchedulerState.getInstance()
      await scheduler.startTask('allPlugins', taskOptions)
    }

    // harmony voting: finalize proposals automatically after endDate
    if (config.SERVICES.ARAGON_INDEXER.HARMONY_VOTING_FINALIZER?.ENABLED) {
      const taskOptions = {
        fn: () => [[{ harmonyVotingFinalizer: HarmonyVotingFinalizer }]],
        interval: config.SERVICES.ARAGON_INDEXER.HARMONY_VOTING_FINALIZER.INTERVAL,
        checkInterval: config.SERVICES.ARAGON_INDEXER.HARMONY_VOTING_FINALIZER.CHECK_INTERVAL,
        runNow: true,
        stopOnError: false,
        onError: (error: any) => logger.error('Error harmony voting finalizer', llo({ error })),
      }

      const scheduler = TaskSchedulerState.getInstance()
      await scheduler.startTask('harmonyVotingFinalizer', taskOptions)
    }
  },

  async stop() {
    const scheduler = TaskSchedulerState.getInstance()
    scheduler.stopTask('allPlugins')

    logger.info('IndexerService service stopped', llo({}))
  },
}

export default AragonIndexerService
