import DataLoader from 'dataloader'
import tracer from 'dd-trace'
import {Selectable, SqlBool, sql} from 'kysely'
import {PARABOL_AI_USER_ID} from '../../client/utils/constants'
import getRethink from '../database/rethinkDriver'
import {RDatum} from '../database/stricterR'
import MeetingTemplate from '../database/types/MeetingTemplate'
import Task, {TaskStatusEnum} from '../database/types/Task'
import getFileStoreManager from '../fileStorage/getFileStoreManager'
import {ReactableEnum} from '../graphql/public/resolverTypes'
import {SAMLSource} from '../graphql/public/types/SAML'
import getKysely from '../postgres/getKysely'
import {TeamMeetingTemplate} from '../postgres/pg.d'
import {IGetLatestTaskEstimatesQueryResult} from '../postgres/queries/generated/getLatestTaskEstimatesQuery'
import getGitHubAuthByUserIdTeamId, {
  GitHubAuth
} from '../postgres/queries/getGitHubAuthByUserIdTeamId'
import getGitHubDimensionFieldMaps, {
  GitHubDimensionFieldMap
} from '../postgres/queries/getGitHubDimensionFieldMaps'
import getGitLabDimensionFieldMaps, {
  GitLabDimensionFieldMap
} from '../postgres/queries/getGitLabDimensionFieldMaps'
import getLatestTaskEstimates from '../postgres/queries/getLatestTaskEstimates'
import getMeetingTaskEstimates, {
  MeetingTaskEstimatesResult
} from '../postgres/queries/getMeetingTaskEstimates'
import {selectMeetingSettings, selectTeams} from '../postgres/select'
import {MeetingSettings, OrganizationUser, Team} from '../postgres/types'
import {AnyMeeting, MeetingTypeEnum} from '../postgres/types/Meeting'
import {Logger} from '../utils/Logger'
import getRedis from '../utils/getRedis'
import isUserVerified from '../utils/isUserVerified'
import NullableDataLoader from './NullableDataLoader'
import RootDataLoader, {RegisterDependsOn} from './RootDataLoader'
import normalizeArrayResults from './normalizeArrayResults'
import normalizeResults from './normalizeResults'

export interface MeetingSettingsKey {
  teamId: string
  meetingType: MeetingTypeEnum
}

export interface MeetingTemplateKey {
  teamId: string
  meetingType: MeetingTypeEnum
}

export interface ReactablesKey {
  id: string | number
  type: ReactableEnum
}

export interface UserTasksKey {
  first: number
  after?: Date | null
  userIds: string[]
  teamIds: string[]
  archived?: boolean
  statusFilters?: TaskStatusEnum[] | null
  filterQuery?: string | null
  includeUnassigned?: boolean
}

export const serializeUserTasksKey = (key: UserTasksKey) => {
  const {userIds, teamIds, first, after, archived, statusFilters, filterQuery} = key
  const parts = [
    (userIds?.length && userIds.sort().join(':')) || '*',
    teamIds.sort().join(':'),
    first,
    after || '*',
    archived,
    (statusFilters?.length && statusFilters.sort().join(':')) || '*',
    filterQuery || '*'
  ]
  return parts.join(':')
}

export const commentCountByDiscussionId = (
  parent: RootDataLoader,
  dependsOn: RegisterDependsOn
) => {
  dependsOn('comments')
  return new DataLoader<string, number, string>(
    async (discussionIds) => {
      const commentsByDiscussionId = await Promise.all(
        discussionIds.map((discussionId) => parent.get('commentsByDiscussionId').load(discussionId))
      )
      return commentsByDiscussionId.map((commentArr) => {
        const activeHumanComments = commentArr.filter(
          (comment) => comment.isActive && comment.createdBy !== PARABOL_AI_USER_ID
        )
        return activeHumanComments.length
      })
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}
export const latestTaskEstimates = (parent: RootDataLoader) => {
  return new DataLoader<string, IGetLatestTaskEstimatesQueryResult[], string>(
    async (taskIds) => {
      const rows = await getLatestTaskEstimates(taskIds)
      return taskIds.map((taskId) => rows.filter((row) => row.taskId === taskId))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const meetingTaskEstimates = (parent: RootDataLoader) => {
  return new DataLoader<{meetingId: string; taskId: string}, MeetingTaskEstimatesResult[], string>(
    async (keys) => {
      const meetingIds = keys.map(({meetingId}) => meetingId)
      const taskIds = keys.map(({taskId}) => taskId)

      const rows = await getMeetingTaskEstimates(taskIds, meetingIds)
      return keys.map(({meetingId, taskId}) =>
        rows.filter((row) => row.taskId === taskId && row.meetingId === meetingId)
      )
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.meetingId}:${key.taskId}`
    }
  )
}

export const userTasks = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('tasks')
  return new DataLoader<UserTasksKey, Task[], string>(
    async (keys) => {
      const r = await getRethink()
      const uniqKeys = [] as UserTasksKey[]
      const keySet = new Set()
      keys.forEach((key) => {
        const serializedKey = serializeUserTasksKey(key)
        if (!keySet.has(serializedKey)) {
          keySet.add(serializedKey)
          uniqKeys.push(key)
        }
      })
      const taskLoader = parent.get('tasks')

      const entryArray = await Promise.all(
        uniqKeys.map(async (key) => {
          const {
            first,
            after,
            userIds,
            teamIds,
            archived,
            statusFilters,
            filterQuery,
            includeUnassigned
          } = key
          const dbAfter = after ? new Date(after) : r.maxval

          let teamTaskPartial = r.table('Task').getAll(r.args(teamIds), {index: 'teamId'})
          if (userIds?.length) {
            teamTaskPartial = teamTaskPartial.filter((row: RDatum) =>
              r(userIds).contains(row('userId'))
            )
          }
          if (statusFilters?.length) {
            teamTaskPartial = teamTaskPartial.filter((row: RDatum) =>
              r(statusFilters).contains(row('status'))
            )
          }
          if (filterQuery) {
            // TODO: deal with tags like #archived and #private. should strip out of plaintextContent??
            teamTaskPartial = teamTaskPartial.filter(
              (row: RDatum) => row('plaintextContent').match(filterQuery) as any
            )
          }

          return {
            key: serializeUserTasksKey(key),
            data: await teamTaskPartial
              .filter((task: RDatum) => task('updatedAt').lt(dbAfter))
              .filter((task: RDatum) =>
                archived
                  ? task('tags').contains('archived')
                  : task('tags').contains('archived').not()
              )
              .filter((task: RDatum) => {
                if (includeUnassigned) return true
                return task('userId').ne(null)
              })
              .orderBy(r.desc('updatedAt'))
              .limit(first + 1)
              .run()
          }
        })
      )

      const tasksByKey = Object.assign(
        {},
        ...entryArray.map((entry) => ({[entry.key]: entry.data}))
      ) as {[key: string]: Task[]}
      const tasks = Object.values(tasksByKey)
      tasks.flat().forEach((task) => {
        taskLoader.clear(task.id).prime(task.id, task)
      })
      return keys.map((key) => tasksByKey[serializeUserTasksKey(key)]!)
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: serializeUserTasksKey
    }
  )
}

export const githubAuth = (parent: RootDataLoader) => {
  return new DataLoader<{teamId: string; userId: string}, GitHubAuth | null, string>(
    async (keys) => {
      const results = await Promise.allSettled(
        keys.map(async ({teamId, userId}) => getGitHubAuthByUserIdTeamId(userId, teamId))
      )
      const vals = results.map((result) => (result.status === 'fulfilled' ? result.value : null))
      return vals
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: ({teamId, userId}) => `${userId}:${teamId}`
    }
  )
}

export const gitlabDimensionFieldMaps = (parent: RootDataLoader) => {
  return new DataLoader<
    {teamId: string; dimensionName: string; projectId: number; providerId: number},
    GitLabDimensionFieldMap | null,
    string
  >(
    async (keys) => {
      const results = await Promise.allSettled(
        keys.map(async ({teamId, dimensionName, projectId, providerId}) =>
          getGitLabDimensionFieldMaps(teamId, dimensionName, projectId, providerId)
        )
      )
      const vals = results.map((result) => (result.status === 'fulfilled' ? result.value : null))
      return vals
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: ({teamId, dimensionName, projectId, providerId}) =>
        `${teamId}:${dimensionName}:${projectId}:${providerId}`
    }
  )
}

export const githubDimensionFieldMaps = (parent: RootDataLoader) => {
  return new DataLoader<
    {teamId: string; dimensionName: string; nameWithOwner: string},
    GitHubDimensionFieldMap | null,
    string
  >(
    async (keys) => {
      const results = await Promise.allSettled(
        keys.map(async ({teamId, dimensionName, nameWithOwner}) =>
          getGitHubDimensionFieldMaps(teamId, dimensionName, nameWithOwner)
        )
      )
      const vals = results.map((result) => (result.status === 'fulfilled' ? result.value : null))
      return vals
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: ({teamId, dimensionName, nameWithOwner}) =>
        `${teamId}:${dimensionName}:${nameWithOwner}`
    }
  )
}

export const meetingSettingsByType = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('meetingSettings')
  return new DataLoader<MeetingSettingsKey, MeetingSettings, string>(
    async (keys) => {
      const res = await selectMeetingSettings()
        .where(({eb, refTuple, tuple}) =>
          eb(
            refTuple('teamId', 'meetingType'),
            'in',
            keys.map((key) => tuple(key.teamId, key.meetingType))
          )
        )
        .execute()
      return keys.map(
        (key) =>
          res.find((doc) => doc.teamId === key.teamId && doc.meetingType === key.meetingType)!
      )
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.teamId}:${key.meetingType}`
    }
  )
}

export const organizationApprovedDomainsByOrgId = (parent: RootDataLoader) => {
  return new DataLoader<string, string[], string>(
    async (orgIds) => {
      const pg = getKysely()
      const currentApprovals = await pg
        .selectFrom('OrganizationApprovedDomain')
        .selectAll()
        .where('orgId', 'in', orgIds)
        .where('removedAt', 'is', null)
        .execute()
      return orgIds.map((orgId) => {
        return currentApprovals
          .filter((approval) => approval.orgId === orgId)
          .map((approval) => approval.domain)
      })
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const organizationApprovedDomains = (parent: RootDataLoader) => {
  return new DataLoader<string, boolean, string>(
    async (domains) => {
      const pg = getKysely()
      const currentApprovals = await pg
        .selectFrom('OrganizationApprovedDomain')
        .selectAll()
        .where('domain', 'in', domains)
        .where('removedAt', 'is', null)
        .execute()
      return domains.map((domain) => {
        return !!currentApprovals.find((approval) => approval.domain === domain)
      })
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const organizationUsersByUserIdOrgId = (
  parent: RootDataLoader,
  dependsOn: RegisterDependsOn
) => {
  dependsOn('organizationUsers')
  return new DataLoader<{orgId: string; userId: string}, OrganizationUser | null, string>(
    async (keys) => {
      const pg = getKysely()
      return Promise.all(
        keys.map(async (key) => {
          const {userId, orgId} = key
          if (!userId || !orgId) return null
          const res = await pg
            .selectFrom('OrganizationUser')
            .selectAll()
            .where('userId', '=', userId)
            .where('orgId', '=', orgId)
            .where('removedAt', 'is', null)
            .limit(1)
            .executeTakeFirst()
          return res || null
        })
      )
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.orgId}:${key.userId}`
    }
  )
}

export const meetingTemplatesByType = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('meetingTemplates')
  return new DataLoader<MeetingTemplateKey, MeetingTemplate[], string>(
    async (keys) => {
      const types = {} as Record<MeetingTypeEnum, string[]>
      keys.forEach((key) => {
        const {meetingType} = key
        types[meetingType] = types[meetingType] || []
        types[meetingType]!.push(key.teamId)
      })
      const entries = Object.entries(types) as [MeetingTypeEnum, string[]][]
      const resultsByType = await Promise.all(
        entries.map((entry) => {
          const [meetingType, teamIds] = entry
          const pg = getKysely()
          return pg
            .selectFrom('MeetingTemplate')
            .selectAll()
            .where('teamId', 'in', teamIds)
            .where('isActive', '=', true)
            .where('type', '=', meetingType)
            .execute()
        })
      )
      const docs = resultsByType.flat()
      return keys.map((key) => {
        const {teamId, meetingType} = key
        return docs.filter((doc) => doc.teamId === teamId && doc.type === meetingType)!
      })
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.teamId}:${key.meetingType}`
    }
  )
}

export const teamMeetingTemplateByTeamId = (parent: RootDataLoader) => {
  return new DataLoader<string, Selectable<TeamMeetingTemplate>[], string>(
    async (teamIds) => {
      const pg = getKysely()
      const teamMeetingTemplates = await pg
        .selectFrom('TeamMeetingTemplate')
        .selectAll()
        .where('teamId', 'in', teamIds)
        .execute()
      return normalizeArrayResults(teamIds, teamMeetingTemplates, 'teamId')
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const meetingTemplatesByOrgId = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('meetingTemplates')
  return new DataLoader<string, MeetingTemplate[], string>(
    async (orgIds) => {
      const pg = getKysely()
      const docs = await pg
        .selectFrom('MeetingTemplate')
        .selectAll()
        .where('orgId', 'in', orgIds)
        .where('isActive', '=', true)
        .where(({or, eb}) =>
          or([
            eb('hideStartingAt', 'is', null),
            sql<SqlBool>`DATE '2020-01-01' + EXTRACT(DOY FROM CURRENT_DATE)::INTEGER - 1 between "hideEndingAt" and "hideStartingAt"`,
            sql<SqlBool>`DATE '2019-01-01' + EXTRACT(DOY FROM CURRENT_DATE)::INTEGER - 1 between "hideEndingAt" and "hideStartingAt"`
          ])
        )
        .orderBy('createdAt', 'desc')
        .execute()
      return orgIds.map((orgId) => docs.filter((doc) => doc.orgId === orgId))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const meetingTemplatesByTeamId = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('meetingTemplates')
  return new DataLoader<string, MeetingTemplate[], string>(
    async (teamIds) => {
      const pg = getKysely()
      const docs = await pg
        .selectFrom('MeetingTemplate')
        .selectAll()
        .where('teamId', 'in', teamIds)
        .where('isActive', '=', true)
        .execute()
      return teamIds.map((teamId) => docs.filter((doc) => doc.teamId === teamId))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

type MeetingStat = {
  id: string
  meetingType: MeetingTypeEnum
  createdAt: Date
}
export const meetingStatsByOrgId = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('newMeetings')
  return new DataLoader<string, MeetingStat[], string>(
    async (orgIds) => {
      const r = await getRethink()
      const meetingStatsByOrgId = await Promise.all(
        orgIds.map(async (orgId) => {
          // note: does not include archived teams!
          const teams = await parent.get('teamsByOrgIds').load(orgId)
          const teamIds = teams.map(({id}) => id)
          const stats = (await r
            .table('NewMeeting')
            .getAll(r.args(teamIds), {index: 'teamId'})
            .pluck('createdAt', 'meetingType')
            // DO NOT CALL orderBy, it makes the query 10x more expensive!
            // .orderBy('createdAt')
            .run()) as {createdAt: Date; meetingType: MeetingTypeEnum}[]
          return stats.map((stat) => ({
            createdAt: stat.createdAt,
            meetingType: stat.meetingType,
            id: `ms${stat.createdAt.getTime()}`
          }))
        })
      )
      return meetingStatsByOrgId
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const teamStatsByOrgId = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('teams')
  return new DataLoader<string, {id: string; createdAt: Date}[], string>(
    async (orgIds) => {
      const teamStatsByOrgId = await Promise.all(
        orgIds.map(async (orgId) => {
          const teams = await parent.get('teamsByOrgIds').load(orgId)
          return teams.map((team) => ({
            id: `ts:${team.createdAt.getTime()}`,
            createdAt: team.createdAt
          }))
        })
      )
      return teamStatsByOrgId
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const taskIdsByTeamAndGitHubRepo = (
  parent: RootDataLoader,
  dependsOn: RegisterDependsOn
) => {
  dependsOn('tasks')
  return new DataLoader<{teamId: string; nameWithOwner: string}, string[], string>(
    async (keys) => {
      const r = await getRethink()
      const res = await Promise.all(
        keys.map((key) => {
          const {teamId, nameWithOwner} = key
          // This is very expensive! We should move tasks to PG ASAP
          return r
            .table('Task')
            .getAll(teamId, {index: 'teamId'})
            .filter((row: RDatum) => row('integration')('nameWithOwner').eq(nameWithOwner))('id')
            .run()
        })
      )
      return res
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.teamId}:${key.nameWithOwner}`
    }
  )
}

export const meetingHighlightedTaskId = (parent: RootDataLoader) => {
  return new DataLoader<string, string | null, string>(
    async (meetingIds) => {
      const redis = getRedis()
      const redisKeys = meetingIds.map((id) => `meetingTaskHighlight:${id}`)
      const highlightedTaskIds = await redis.mget(redisKeys)
      return highlightedTaskIds
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const activeMeetingsByMeetingSeriesId = (
  parent: RootDataLoader,
  dependsOn: RegisterDependsOn
) => {
  dependsOn('newMeetings')
  return new DataLoader<number, AnyMeeting[], string>(
    async (keys) => {
      const r = await getRethink()
      const res = await r
        .table('NewMeeting')
        .getAll(r.args(keys), {index: 'meetingSeriesId'})
        .filter({endedAt: null}, {default: true})
        .orderBy(r.asc('createdAt'))
        .run()
      return normalizeArrayResults(keys, res, 'meetingSeriesId')
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const lastMeetingByMeetingSeriesId = (
  parent: RootDataLoader,
  dependsOn: RegisterDependsOn
) => {
  dependsOn('newMeetings')
  return new DataLoader<number, AnyMeeting | null, string>(
    async (keys) =>
      tracer.trace('lastMeetingByMeetingSeriesId', async () => {
        const r = await getRethink()
        const res = await (
          r
            .table('NewMeeting')
            .getAll(r.args(keys), {index: 'meetingSeriesId'})
            .group('meetingSeriesId') as RDatum
        )
          .orderBy(r.desc('createdAt'))
          .nth(0)
          .default(null)
          .ungroup()('reduction')
          .run()
        return normalizeResults(keys, res as AnyMeeting[], 'meetingSeriesId')
      }),
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const billingLeadersIdsByOrgId = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('organizationUsers')
  return new DataLoader<string, string[], string>(
    async (keys) => {
      const pg = getKysely()
      const res = await Promise.all(
        keys.map(async (orgId) => {
          const rows = await pg
            .selectFrom('OrganizationUser')
            .select('userId')
            .where('orgId', '=', orgId)
            .where('removedAt', 'is', null)
            .where('role', 'in', ['BILLING_LEADER', 'ORG_ADMIN'])
            .execute()
          return rows.map((row) => row.userId)
        })
      )
      return res
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const samlByDomain = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('saml')
  return new NullableDataLoader<string, SAMLSource | null, string>(
    async (domains) => {
      const pg = getKysely()
      const res = await pg
        .selectFrom('SAMLDomain')
        .innerJoin('SAML', 'SAML.id', 'SAMLDomain.samlId')
        .where('SAMLDomain.domain', 'in', domains)
        .groupBy('SAML.id')
        .selectAll('SAML')
        .select(({fn}) => [fn.agg<string[]>('array_agg', ['SAMLDomain.domain']).as('domains')])
        .execute()
      // not the same as normalizeResults
      return domains.map((domain) => res.find((row) => row.domains.includes(domain)))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}
export const samlByOrgId = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('saml')
  return new NullableDataLoader<string, SAMLSource | null, string>(
    async (orgIds) => {
      const pg = getKysely()
      const res = await pg
        .selectFrom('SAMLDomain')
        .innerJoin('SAML', 'SAML.id', 'SAMLDomain.samlId')
        .where('SAML.orgId', 'in', orgIds)
        .groupBy('SAML.id')
        .selectAll('SAML')
        .select(({fn}) => [fn.agg<string[]>('array_agg', ['SAMLDomain.domain']).as('domains')])
        .execute()
      // not the same as normalizeResults
      return orgIds.map((orgId) => res.find((row) => row.orgId === orgId))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

// Check if the org has a founder or billing lead with a verified email and their email domain is the same as the org domain
export const isOrgVerified = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('organizationUsers')
  return new DataLoader<string, boolean, string>(
    async (orgIds) => {
      return await Promise.all(
        orgIds.map(async (orgId) => {
          const [organization, orgUsers] = await Promise.all([
            parent.get('organizations').loadNonNull(orgId),
            parent.get('organizationUsersByOrgId').load(orgId)
          ])
          const orgLeaders = orgUsers.filter(
            ({role}) => role && ['BILLING_LEADER', 'ORG_ADMIN'].includes(role)
          )
          const orgLeaderUsers = await Promise.all(
            orgLeaders.map(({userId}) => parent.get('users').loadNonNull(userId))
          )
          const isALeaderVerifiedAtOrgDomain = orgLeaderUsers.some(
            (user) => isUserVerified(user) && user.domain === organization.activeDomain
          )
          if (isALeaderVerifiedAtOrgDomain) return true
          const isOrgSAML = await parent.get('samlByOrgId').load(orgId)
          return !!isOrgSAML
        })
      )
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const autoJoinTeamsByOrgId = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('teams')
  return new DataLoader<string, Team[], string>(
    async (orgIds) => {
      const verificationResults = await parent.get('isOrgVerified').loadMany(orgIds)
      const verifiedOrgIds = orgIds.filter((_, index) => verificationResults[index])

      const teams =
        verifiedOrgIds.length === 0
          ? []
          : await selectTeams()
              .where('orgId', 'in', verifiedOrgIds)
              .where('autoJoin', '=', true)
              .where('isArchived', '!=', true)
              .selectAll()
              .execute()

      return orgIds.map((orgId) => teams.filter((team) => team.orgId === orgId))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

/**
 * Assuming the input is a domain, is it also a company domain?
 */
export const isCompanyDomain = (parent: RootDataLoader) => {
  return new DataLoader<string, boolean, string>(
    async (domains) => {
      const pg = getKysely()
      const res = await pg
        .selectFrom('FreemailDomain')
        .where('domain', 'in', domains)
        .select('domain')
        .execute()
      const freemailDomains = new Set(res.map(({domain}) => domain))
      return domains.map((domain) => !freemailDomains.has(domain))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const favoriteTemplateIds = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('users')
  return new DataLoader<string, string[], string>(
    async (userIds) => {
      const pg = getKysely()
      const users = await pg
        .selectFrom('User')
        .select(['id', 'favoriteTemplateIds'])
        .where('id', 'in', userIds)
        .execute()

      const userIdToFavoriteTemplateIds = new Map(
        users.map((user) => [user.id, user.favoriteTemplateIds])
      )
      return userIds.map((userId) => userIdToFavoriteTemplateIds.get(userId) || [])
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const fileStoreAsset = (parent: RootDataLoader) => {
  return new DataLoader<string, string, string>(
    async (urls) => {
      // Our cloud saas has a public file store, so no need to make a presigned url
      if (process.env.IS_ENTERPRISE !== 'true') return urls
      const manager = getFileStoreManager()
      const {baseUrl} = manager
      const presignedUrls = await Promise.all(
        urls.map(async (url) => {
          // if the image is not hosted by us, ignore it
          if (!url.startsWith(baseUrl)) return url
          try {
            return await manager.presignUrl(url)
          } catch (e) {
            Logger.log('Unable to presign url', url, e)
            return url
          }
        })
      )
      return presignedUrls
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const meetingCount = (parent: RootDataLoader, dependsOn: RegisterDependsOn) => {
  dependsOn('newMeetings')
  return new DataLoader<{teamId: string; meetingType: MeetingTypeEnum}, number, string>(
    async (keys) => {
      const r = await getRethink()
      const res = await Promise.all(
        keys.map(async ({teamId, meetingType}) => {
          return r
            .table('NewMeeting')
            .getAll(teamId, {index: 'teamId'})
            .filter({meetingType: meetingType as any})
            .count()
            .default(0)
            .run()
        })
      )
      return res
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.teamId}:${key.meetingType}`
    }
  )
}
