const {
  generateConfigID,
  getConfigParams,
  getGlobalUserParams,
  getScopedFullConfig,
  getAllApps,
} = require("@budibase/backend-core/db")
const { Configs } = require("../../../constants")
const email = require("../../../utilities/email")
const {
  upload,
  ObjectStoreBuckets,
} = require("@budibase/backend-core/objectStore")
const { getGlobalDB, getTenantId } = require("@budibase/backend-core/tenancy")
const env = require("../../../environment")
const { googleCallbackUrl, oidcCallbackUrl } = require("./auth")
const { events } = require("@budibase/backend-core")

const BB_TENANT_CDN = "https://tenants.cdn.budi.live"

const getEventFns = async (db, config) => {
  const fns = []
  const type = config.type

  let existing
  if (config._id) {
    existing = await db.get(config._id)
  }

  if (!existing) {
    switch (config.type) {
      case Configs.SMTP:
        fns.push(events.email.SMTPCreated)
        break
      case Configs.GOOGLE:
        fns.push(() => events.auth.SSOCreated(type))
        break
      case Configs.OIDC:
        fns.push(() => events.auth.SSOCreated(type))
        break
      case Configs.SETTINGS:
        if (config.company) {
          fns.push(events.org.nameUpdated)
        }
        if (config.logoUrl) {
          fns.push(events.org.logoUpdated)
        }
        if (config.platformUrl) {
          fns.push(events.org.platformURLUpdated)
        }
        break
    }
  } else {
    switch (config.type) {
      case Configs.SMTP:
        fns.push(events.email.SMTPUpdated)
        break
      case Configs.GOOGLE:
        fns.push(() => events.auth.SSOUpdated(type))
        break
      case Configs.OIDC:
        fns.push(() => events.auth.SSOUpdated(type))
        break
      case Configs.SETTINGS:
        if (config.company && existing.company !== config.company) {
          fns.push(events.org.nameUpdated)
        }
        if (config.logoUrl && existing.logoUrl !== config.logoUrl) {
          fns.push(events.org.logoUpdated)
        }
        if (config.platformUrl && existing.platformUrl !== config.platformUrl) {
          fns.push(events.org.platformURLUpdated)
        }
        break
    }
  }

  return fns
}

exports.save = async function (ctx) {
  const db = getGlobalDB()
  const { type, workspace, user, config } = ctx.request.body
  let eventFns = await getEventFns(db, ctx.request.body)
  // Config does not exist yet
  if (!ctx.request.body._id) {
    ctx.request.body._id = generateConfigID({
      type,
      workspace,
      user,
    })
  }
  try {
    // verify the configuration
    switch (type) {
      case Configs.SMTP:
        await email.verifyConfig(config)
        break
    }
  } catch (err) {
    ctx.throw(400, err)
  }

  try {
    const response = await db.put(ctx.request.body)
    for (const fn of eventFns) {
      fn()
    }
    ctx.body = {
      type,
      _id: response.id,
      _rev: response.rev,
    }
  } catch (err) {
    ctx.throw(400, err)
  }
}

exports.fetch = async function (ctx) {
  const db = getGlobalDB()
  const response = await db.allDocs(
    getConfigParams(
      { type: ctx.params.type },
      {
        include_docs: true,
      }
    )
  )
  ctx.body = response.rows.map(row => row.doc)
}

/**
 * Gets the most granular config for a particular configuration type.
 * The hierarchy is type -> workspace -> user.
 */
exports.find = async function (ctx) {
  const db = getGlobalDB()

  const { userId, workspaceId } = ctx.query
  if (workspaceId && userId) {
    const workspace = await db.get(workspaceId)
    const userInWorkspace = workspace.users.some(
      workspaceUser => workspaceUser === userId
    )
    if (!ctx.user.admin && !userInWorkspace) {
      ctx.throw(400, `User is not in specified workspace: ${workspace}.`)
    }
  }

  try {
    // Find the config with the most granular scope based on context
    const scopedConfig = await getScopedFullConfig(db, {
      type: ctx.params.type,
      user: userId,
      workspace: workspaceId,
    })

    if (scopedConfig) {
      ctx.body = scopedConfig
    } else {
      // don't throw an error, there simply is nothing to return
      ctx.body = {}
    }
  } catch (err) {
    ctx.throw(err.status, err)
  }
}

exports.publicOidc = async function (ctx) {
  const db = getGlobalDB()
  try {
    // Find the config with the most granular scope based on context
    const oidcConfig = await getScopedFullConfig(db, {
      type: Configs.OIDC,
    })

    if (!oidcConfig) {
      ctx.body = {}
    } else {
      ctx.body = oidcConfig.config.configs.map(config => ({
        logo: config.logo,
        name: config.name,
        uuid: config.uuid,
      }))
    }
  } catch (err) {
    ctx.throw(err.status, err)
  }
}

exports.publicSettings = async function (ctx) {
  const db = getGlobalDB()

  try {
    // Find the config with the most granular scope based on context
    const publicConfig = await getScopedFullConfig(db, {
      type: Configs.SETTINGS,
    })

    const googleConfig = await getScopedFullConfig(db, {
      type: Configs.GOOGLE,
    })

    const oidcConfig = await getScopedFullConfig(db, {
      type: Configs.OIDC,
    })

    let config
    if (!publicConfig) {
      config = {
        config: {},
      }
    } else {
      config = publicConfig
    }

    // google button flag
    if (googleConfig && googleConfig.config) {
      // activated by default for configs pre-activated flag
      config.config.google =
        googleConfig.config.activated == null || googleConfig.config.activated
    } else {
      config.config.google = false
    }

    // callback urls
    config.config.oidcCallbackUrl = await oidcCallbackUrl()
    config.config.googleCallbackUrl = await googleCallbackUrl()

    // oidc button flag
    if (oidcConfig && oidcConfig.config) {
      config.config.oidc = oidcConfig.config.configs[0].activated
    } else {
      config.config.oidc = false
    }

    ctx.body = config
  } catch (err) {
    ctx.throw(err.status, err)
  }
}

exports.upload = async function (ctx) {
  if (ctx.request.files == null || ctx.request.files.file.length > 1) {
    ctx.throw(400, "One file must be uploaded.")
  }
  const file = ctx.request.files.file
  const { type, name } = ctx.params

  let bucket
  if (env.SELF_HOSTED) {
    bucket = ObjectStoreBuckets.GLOBAL
  } else {
    bucket = ObjectStoreBuckets.GLOBAL_CLOUD
  }

  let key
  if (env.MULTI_TENANCY) {
    key = `${getTenantId()}/${type}/${name}`
  } else {
    key = `${type}/${name}`
  }

  await upload({
    bucket,
    filename: key,
    path: file.path,
    type: file.type,
  })

  // add to configuration structure
  // TODO: right now this only does a global level
  const db = getGlobalDB()
  let cfgStructure = await getScopedFullConfig(db, { type })
  if (!cfgStructure) {
    cfgStructure = {
      _id: generateConfigID({ type }),
      config: {},
    }
  }
  let url
  if (env.SELF_HOSTED) {
    url = `/${bucket}/${key}`
  } else {
    url = `${BB_TENANT_CDN}/${key}`
  }

  cfgStructure.config[`${name}`] = url
  // write back to db with url updated
  await db.put(cfgStructure)

  ctx.body = {
    message: "File has been uploaded and url stored to config.",
    url,
  }
}

exports.destroy = async function (ctx) {
  const db = getGlobalDB()
  const { id, rev } = ctx.params

  try {
    await db.remove(id, rev)
    ctx.body = { message: "Config deleted successfully" }
  } catch (err) {
    ctx.throw(err.status, err)
  }
}

exports.configChecklist = async function (ctx) {
  const db = getGlobalDB()
  const tenantId = getTenantId()

  try {
    // TODO: Watch get started video

    let apps = []
    if (!env.MULTI_TENANCY || tenantId) {
      // Apps exist
      apps = await getAllApps({ idsOnly: true, efficient: true })
    }

    // They have set up SMTP
    const smtpConfig = await getScopedFullConfig(db, {
      type: Configs.SMTP,
    })

    // They have set up Google Auth
    const googleConfig = await getScopedFullConfig(db, {
      type: Configs.GOOGLE,
    })

    // They have set up OIDC
    const oidcConfig = await getScopedFullConfig(db, {
      type: Configs.OIDC,
    })
    // They have set up an global user
    const users = await db.allDocs(
      getGlobalUserParams(null, {
        include_docs: true,
      })
    )
    const adminUser = users.rows.some(row => row.doc.admin)

    ctx.body = {
      apps: {
        checked: apps.length > 0,
        label: "Create your first app",
        link: "/builder/portal/apps",
      },
      smtp: {
        checked: !!smtpConfig,
        label: "Set up email",
        link: "/builder/portal/manage/email",
      },
      adminUser: {
        checked: adminUser,
        label: "Create your first user",
        link: "/builder/portal/manage/users",
      },
      sso: {
        checked: !!googleConfig || !!oidcConfig,
        label: "Set up single sign-on",
        link: "/builder/portal/manage/auth",
      },
    }
  } catch (err) {
    ctx.throw(err.status, err)
  }
}
