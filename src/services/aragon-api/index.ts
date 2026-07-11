import Utils from '@helpers/utils'
import { EnumConnection, EnumServiceName, type IService } from '@types'
import App from '@services/aragon-api/app'
import config from '@config'

const AragonAPIService: IService = {
  name: EnumServiceName.ARAGON_API,
  // The public API delegates contract, gauge, member, plugin and proposal
  // operations to workers through RabbitMQ. Keep the broker as a required
  // dependency so those routes cannot start in a deceptively broken state.
  NEED_CONNECTIONS: [EnumConnection.MONGODB, EnumConnection.RABBITMQ],
  START_BEFORE_CONNECTIONS: true,
  options: { mongoSync: config.MONGO_DB.SYNC_MODELS },

  async start() {
    return await App()
  },

  stop: Utils.noop,
}

export default AragonAPIService
