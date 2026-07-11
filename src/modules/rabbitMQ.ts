import { connect, type AmqpConnectionManager, type ChannelWrapper } from 'amqp-connection-manager'
import { type ConfirmChannel } from 'amqplib'
import config from '@config'
import logger from '@logger'
import { EnumQueueName } from '@types'

const llo = logger.logMeta.bind(null, { service: 'rabbitmq' })

function describeRabbitTarget(uri: string): string {
  const trimmed = uri.trim()
  if (!trimmed) return 'unconfigured'

  const protocol = trimmed.match(/^amqps?:\/\//i)?.[0] || 'amqp://'
  const withoutProtocol = trimmed.replace(/^[a-z0-9+.-]+:\/\//i, '')
  const slashIndex = withoutProtocol.indexOf('/')
  const authority = slashIndex === -1 ? withoutProtocol : withoutProtocol.slice(0, slashIndex)
  const host = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  const vhost = slashIndex === -1 ? '' : withoutProtocol.slice(slashIndex + 1).split('?')[0]

  return `${protocol}${host}${vhost ? `/${vhost}` : ''}`
}

const RabbitMQ = {
  connection: null as AmqpConnectionManager | null,
  channelsMap: new Map<EnumQueueName, ChannelWrapper>(),
  noopInterval: null as NodeJS.Timeout | null,

  async connect(): Promise<boolean> {
    return await new Promise((resolve, reject) => {
      // Avoid re-connecting if already connected
      if (RabbitMQ.connection && RabbitMQ.isConnected()) {
        resolve(true)
        return
      }

      // Set a connection timeout
      const connectionTimeout = setTimeout(() => {
        const error = new Error('RabbitMQ connection timeout')
        logger.error(
          'RabbitMQ connection timeout',
          llo({
            target: describeRabbitTarget(config.RABBITMQ.URI),
            timeout: config.RABBITMQ.TIMEOUT,
          }),
        )
        reject(error)
      }, config.RABBITMQ.TIMEOUT)

      RabbitMQ.connection = connect([config.RABBITMQ.URI], {
        heartbeatIntervalInSeconds: config.RABBITMQ.HEARTBEAT_INTERVAL_SECONDS,
        reconnectTimeInSeconds: config.RABBITMQ.RECONNECT_TIME_SECONDS,
        connectionOptions: {
          noDelay: true,
          keepAlive: true,
          keepAliveDelay: 60000,
          timeout: 10000,
        },
      })

      // Track if we've resolved the promise
      let promiseResolved = false

      RabbitMQ.connection.on('connect', () => {
        clearTimeout(connectionTimeout)
        logger.info('RabbitMQ connected', llo({ target: describeRabbitTarget(config.RABBITMQ.URI) }))
        RabbitMQ.startNoopInterval()

        // Only resolve once
        if (!promiseResolved) {
          promiseResolved = true
          resolve(true)
        }
      })

      RabbitMQ.connection.on('disconnect', (err: Error) => {
        logger.error('RabbitMQ disconnected', llo({ reason: err }))
        RabbitMQ.stopNoopInterval()

        // If we haven't resolved yet, this is a connection failure
        if (!promiseResolved) {
          promiseResolved = true
          clearTimeout(connectionTimeout)
          reject(new Error(`RabbitMQ connection failed: ${err?.message || 'Unknown error'}`))
        }
      })

      RabbitMQ.connection.on('connectFailed', (err: Error) => {
        logger.error('RabbitMQ connect failed', llo({ reason: err }))
        RabbitMQ.stopNoopInterval()

        // Keep waiting for the connection manager to retry until either
        // a real connection happens or the global timeout expires.
        if (!promiseResolved) {
          logger.error('RabbitMQ connection failed', llo({ reason: err?.message || 'Unknown error' }))
        }
      })

      // For each queue in EnumQueueName, create a dedicated channel wrapper
      for (const queueName of Object.values(EnumQueueName)) {
        const channelWrapper = RabbitMQ.connection.createChannel({
          json: true,
          confirm: true,
          setup: async (channel: ConfirmChannel) => {
            try {
              await channel.assertQueue(queueName, { durable: true })
              logger.verbose('Channel set up for queue', llo({ queueName }))
            } catch (err) {
              logger.error('Failed to set up channel for queue', llo({ queueName, err }))
              throw err
            }
          },
        })

        RabbitMQ.channelsMap.set(queueName, channelWrapper)
      }
    })
  },

  /**
   * Check if RabbitMQ is connected
   */
  isConnected(): boolean {
    return RabbitMQ.connection?.isConnected() || false
  },

  /**
   * Get connection status
   */
  getStatus(): {
    connected: boolean
    uri: string
    channels: number
  } {
    return {
      connected: RabbitMQ.isConnected(),
      uri: describeRabbitTarget(config.RABBITMQ.URI),
      channels: RabbitMQ.channelsMap.size,
    }
  },

  getChannel(queueName: EnumQueueName): ChannelWrapper {
    if (!RabbitMQ.connection) {
      throw new Error('RabbitMQ is not connected. Call RabbitMQ.connect() first.')
    }
    const cw = RabbitMQ.channelsMap.get(queueName)
    if (!cw) {
      throw new Error(`No channel found for queue "${queueName}"`)
    }
    return cw
  },

  async close(): Promise<void> {
    if (RabbitMQ.connection) {
      try {
        RabbitMQ.stopNoopInterval()
        await RabbitMQ.connection.close()
        logger.verbose('RabbitMQ connection closed', llo({}))
      } catch (err) {
        logger.warn('Error closing RabbitMQ connection', llo({ err }))
      } finally {
        RabbitMQ.connection = null
        RabbitMQ.channelsMap.clear()
      }
    }
  },

  stopNoopInterval(): void {
    if (RabbitMQ.noopInterval) {
      clearInterval(RabbitMQ.noopInterval)
      RabbitMQ.noopInterval = null
      logger.verbose('Stopped noop interval', llo({}))
    }
  },

  /**
   * Starts a noop interval to keep the RabbitMQ connection alive.
   */
  startNoopInterval(): void {
    if (RabbitMQ.noopInterval) {
      clearInterval(RabbitMQ.noopInterval)
      RabbitMQ.noopInterval = null
    }

    const intervalMs = (config.RABBITMQ.HEARTBEAT_INTERVAL_SECONDS * 1000) / 2

    logger.info('Starting noop interval', llo({ intervalMs }))

    RabbitMQ.noopInterval = setInterval(async () => {
      try {
        const firstChannel = Array.from(RabbitMQ.channelsMap.values())[0]
        if (firstChannel) {
          await firstChannel.addSetup(async (channel: ConfirmChannel) => {
            const firstQueue = Array.from(RabbitMQ.channelsMap.keys())[0]
            await channel.checkQueue(firstQueue)
          })
        }
      } catch (err) {
        logger.error('Noop operation failed', llo({ error: err }))
      }
    }, intervalMs)
  },
}

export default RabbitMQ
