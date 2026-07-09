import config from '@config'
import dayjs from '@helpers/dayjs'
import { NetworkHelper } from '@helpers/network'
import * as packageJson from '@package'
import { type IStatusResponse } from '@types'

const StatusController = {
  getStatus: (): IStatusResponse => ({
    status: 'healthy',
    appName: config.APP_NAME,
    service: config.SERVICES.ARAGON_API.NAME,
    nodeVersion: process.version,
    environment: config.ENVIRONMENT,
    supportedNetworks: NetworkHelper.supportedNetworks().map(({ networkName }) => networkName),
    appVersionPackage: packageJson.version,
    time: dayjs().format(),
  }),
}

export default StatusController
