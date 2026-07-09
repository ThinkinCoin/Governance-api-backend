import { Models } from '@dbModels'
import {
  ErrorKeyEnum,
  type HexAddress,
  type IDaoExtraParams,
  type IDaoResponse,
  type IPaginatedResult,
  type IPaginationParams,
  IPluginInterfaceType,
  IPluginStatus,
  type NetworksEnum,
  type MembershipData,
  type NetworkGroupedAddresses,
} from '@types'
import { assertExposable } from '@errors'
import PairDataModule from '@modules/pairData'
import NameResolver from '@helpers/nameResolver'
import DaoEnsHelper from '@helpers/daoEns'
import { ethers } from 'ethers'
import logger from '@logger'

const llo = logger.logMeta.bind(null, { service: 'api:controllers:DaoController' })

const DaoController = {
  getDaosWithPagination: async (
    paginationParams: IPaginationParams,
    extraParams: IDaoExtraParams,
  ): Promise<IPaginatedResult<IDaoResponse>> => {
    try {
      paginationParams = await PairDataModule.pairFromPaginationParams(paginationParams)
      const extraQueryData = await PairDataModule.pairExtraQueryData(extraParams)
      return await Models.Dao.findWithPagination({ extraParams, paginationParams, extraQueryData })
    } catch (error) {
      logger.error(
        'Error getting DAOs with pagination',
        llo({
          paginationParams,
          extraParams,
          error,
        }),
      )
      throw error
    }
  },

  getDaoById: async (id: string): Promise<IDaoResponse> => {
    const dao = await Models.Dao.findByEntityId(id)
    assertExposable(dao, ErrorKeyEnum.notFound)
    return await Models.Dao.getDaoDetails(dao.address, dao.network)
  },

  getDaoByAddress: async (address: HexAddress, network: NetworksEnum): Promise<IDaoResponse> => {
    const dao = await Models.Dao.findByAddress(address, network)
    assertExposable(dao, ErrorKeyEnum.notFound)
    return await Models.Dao.getDaoDetails(dao.address, dao.network)
  },

  getDaoByEns: async (ens: string, network: NetworksEnum): Promise<IDaoResponse> => {
    const dao = await Models.Dao.findOne({ ens, network, isHidden: { $ne: true }, isActive: { $eq: true } })
    if (dao) {
      return await Models.Dao.getDaoDetails(dao.address, dao.network)
    }

    const resolvedAddress = await NameResolver.resolveNameToAddress(ens, network)
    assertExposable(!!resolvedAddress, ErrorKeyEnum.notFound)

    const daoByAddress = await Models.Dao.findByAddress(resolvedAddress!, network)
    assertExposable(daoByAddress, ErrorKeyEnum.notFound)
    return await Models.Dao.getDaoDetails(daoByAddress.address, daoByAddress.network)
  },

  setDaoEnsByDaoAdminSignature: async (params: {
    address: HexAddress
    network: NetworksEnum
    ens?: string | null
    signer: HexAddress
    signature: string
    issuedAt: number
  }): Promise<{ ens: string | null }> => {
    const dao = await Models.Dao.findByAddress(params.address, params.network)
    assertExposable(dao, ErrorKeyEnum.notFound)

    const signer = ethers.getAddress(params.signer)
    const daoAddress = ethers.getAddress(params.address)
    const ens = typeof params.ens === 'string' ? params.ens.trim().toLowerCase() : ''

    const issuedAtMs = Number(params.issuedAt)
    assertExposable(Number.isFinite(issuedAtMs), ErrorKeyEnum.badParams)
    const now = Date.now()
    const maxSkewMs = 10 * 60 * 1000
    assertExposable(Math.abs(now - issuedAtMs) <= maxSkewMs, ErrorKeyEnum.badParams)

    const message = `Aragon DAO ENS update\nnetwork:${params.network}\ndao:${daoAddress}\nens:${ens}\nissuedAt:${issuedAtMs}`
    const recovered = ethers.verifyMessage(message, params.signature)
    assertExposable(ethers.getAddress(recovered) === signer, ErrorKeyEnum.accessDenied)

    const plugins = await Models.Plugin.find({
      daoAddress: dao.address,
      network: dao.network,
      status: IPluginStatus.installed,
      interfaceType: { $in: [IPluginInterfaceType.admin, IPluginInterfaceType.multisig] },
    })

    const pluginAddresses = plugins.map(p => p.address)
    assertExposable(pluginAddresses.length > 0, ErrorKeyEnum.accessDenied)

    const isMember = await Models.PluginMember.exists({
      memberAddress: signer,
      network: dao.network,
      pluginAddress: { $in: pluginAddresses },
    })
    assertExposable(!!isMember, ErrorKeyEnum.accessDenied)

    return await DaoEnsHelper.setDaoEnsValidated({
      address: dao.address,
      network: dao.network,
      ens: params.ens ?? null,
    })
  },

  getDaosByMember: async (
    paginationParams: IPaginationParams,
    extraParams: IDaoExtraParams,
  ): Promise<IPaginatedResult<IDaoResponse>> => {
    paginationParams = await PairDataModule.pairFromPaginationParams(paginationParams)
    extraParams.memberAddress = await PairDataModule.checkIFEns(extraParams.memberAddress!)
    extraParams.excludedDao = extraParams.excludeDaoId
      ? ((await PairDataModule.pairFromExtraParams({}, { daoId: extraParams.excludeDaoId })) as {
          daoAddress: string
          network: NetworksEnum
        })
      : undefined

    const networkFilter = extraParams.networks?.length ? { network: { $in: extraParams.networks } } : {}
    const allDaoAddresses = await DaoController.getDaosOfMemberInNetwork(extraParams.memberAddress, networkFilter)

    const extraQueryData = { daoAddresses: allDaoAddresses }

    return await Models.Dao.findWithPagination({ extraParams, paginationParams, extraQueryData })
  },

  getDaosOfMemberInNetwork: async (memberAddress: string, networkFilter: any = {}): Promise<string[]> => {
    const [tokenMembersQuery, veMembersQuery, lockMembersQuery, pluginMembersQuery] = await Promise.all([
      Models.TokenMember.aggregate([
        { $match: { memberAddress, ...networkFilter } },
        { $project: { _id: 0, tokenAddress: 1, network: 1 } },
      ]),
      Models.Lock.aggregate([
        { $match: { delegateReceiverAddress: memberAddress, ...networkFilter } },
        { $project: { _id: 0, tokenAddress: 1, network: 1 } },
      ]),
      Models.LockToVoteMember.aggregate([
        { $match: { memberAddress, ...networkFilter } },
        { $project: { _id: 0, lockManagerAddress: 1, network: 1 } },
      ]),
      Models.PluginMember.aggregate([
        { $match: { memberAddress, ...networkFilter } },
        { $project: { _id: 0, pluginAddress: 1, network: 1 } },
      ]),
    ])

    if (
      tokenMembersQuery.length === 0 &&
      veMembersQuery.length === 0 &&
      lockMembersQuery.length === 0 &&
      pluginMembersQuery.length === 0
    ) {
      return []
    }

    const orQueries: any[] = []

    const tokenMembersByNetwork = DaoController.groupByNetwork(tokenMembersQuery as MembershipData[], 'tokenAddress')
    const veMembersByNetwork = DaoController.groupByNetwork(veMembersQuery as MembershipData[], 'tokenAddress')

    const lockMembersByNetwork = DaoController.groupByNetwork(
      lockMembersQuery as MembershipData[],
      'lockManagerAddress',
    )

    const pluginMembersByNetwork = DaoController.groupByNetwork(pluginMembersQuery as MembershipData[], 'pluginAddress')

    Object.keys(tokenMembersByNetwork).forEach(network => {
      if (tokenMembersByNetwork[network].length > 0) {
        orQueries.push({
          tokenAddress: { $in: tokenMembersByNetwork[network] },
          interfaceType: IPluginInterfaceType.tokenVoting,
          network,
        })
      }
    })

    Object.keys(veMembersByNetwork).forEach(network => {
      if (veMembersByNetwork[network].length > 0) {
        orQueries.push({
          tokenAddress: { $in: veMembersByNetwork[network] },
          interfaceType: IPluginInterfaceType.tokenVoting,
          network,
        })
      }
    })

    Object.keys(lockMembersByNetwork).forEach(network => {
      if (lockMembersByNetwork[network].length > 0) {
        orQueries.push({
          lockManagerAddress: { $in: lockMembersByNetwork[network] },
          interfaceType: IPluginInterfaceType.lockToVote,
          network,
        })
      }
    })

    Object.keys(pluginMembersByNetwork).forEach(network => {
      if (pluginMembersByNetwork[network].length > 0) {
        orQueries.push({
          address: { $in: pluginMembersByNetwork[network] },
          interfaceType: { $in: [IPluginInterfaceType.multisig, IPluginInterfaceType.admin] },
          network,
        })
      }
    })

    if (orQueries.length === 0) {
      return []
    }

    return await Models.Plugin.distinct('daoAddress', {
      $or: orQueries,
      status: IPluginStatus.installed,
      isSupported: true,
      ...networkFilter,
    })
  },

  groupByNetwork: (data: MembershipData[], addressField: keyof MembershipData): NetworkGroupedAddresses => {
    return data.reduce<NetworkGroupedAddresses>((acc, item) => {
      const network = item.network
      const address = item[addressField]!

      if (address) {
        if (!acc[network]) {
          acc[network] = []
        }
        acc[network].push(address)
      }
      return acc
    }, {})
  },
}

export default DaoController
