import { type Next } from 'koa'
import { type RouterContext } from '@koa/router'
import { ErrorKeyEnum, type ICustomError, type IErrorResponse } from '@types'
import { ERRORS } from '@errors'
import logger from '@logger'

const llo = logger.logMeta.bind(null, { service: 'middleware:error' })

export default () => async (ctx: RouterContext, next: Next) => {
  try {
    await next()
  } catch (error: any) {
    ctx.requestInfo = Object.assign({ error }, ctx.requestInfo)

    let status = 500
    const response: IErrorResponse = {
      code: ErrorKeyEnum.unknownError, // Default error code
      description: 'Internal server error', // Default error message
    }

    if (error.exposeCustom_) {
      const customError = error as ICustomError

      const errorMsg = ERRORS[customError.message]
      status = errorMsg?.status ?? ERRORS[ErrorKeyEnum.unknownError].status
      response.code = (ErrorKeyEnum as any)[customError.message] || ErrorKeyEnum.unknownError

      if (customError.description) {
        response.description = customError.description
      }
      if (customError.exposeMeta) {
        response.meta = customError.exposeMeta
      }
    }

    response.status = status
    ctx.status = status
    ctx.body = response

    logger.error(
      'Unhandled API request error',
      llo({
        status,
        method: ctx.method,
        path: ctx.path,
        query: ctx.query,
        code: response.code,
        errorName: error?.name,
        errorMessage: error?.message,
        errorStack: error?.stack,
      }),
    )
  }
}
