import dayjs from 'dayjs'
import tracer from 'dd-trace'
import ms from 'ms'
import {SubscriptionChannel} from 'parabol-client/types/constEnums'
import {DateTime, RRuleSet} from 'rrule-rust'
import {fromDateTime, toDateTime} from '../../../../client/shared/rruleUtil'
import getRethink from '../../../database/rethinkDriver'
import MeetingRetrospective, {
  isMeetingRetrospective
} from '../../../database/types/MeetingRetrospective'
import MeetingTeamPrompt, {isMeetingTeamPrompt} from '../../../database/types/MeetingTeamPrompt'
import {getActiveMeetingSeries} from '../../../postgres/queries/getActiveMeetingSeries'
import {MeetingSeries} from '../../../postgres/types/MeetingSeries'
import {analytics} from '../../../utils/analytics/analytics'
import {getNextRRuleDate} from '../../../utils/getNextRRuleDate'
import publish, {SubOptions} from '../../../utils/publish'
import standardError from '../../../utils/standardError'
import {DataLoaderWorker} from '../../graphql'
import {createMeetingSeriesTitle} from '../../mutations/helpers/createMeetingSeriesTitle'
import isStartMeetingLocked from '../../mutations/helpers/isStartMeetingLocked'
import {IntegrationNotifier} from '../../mutations/helpers/notifications/IntegrationNotifier'
import safeCreateRetrospective from '../../mutations/helpers/safeCreateRetrospective'
import safeCreateTeamPrompt, {DEFAULT_PROMPT} from '../../mutations/helpers/safeCreateTeamPrompt'
import safeEndRetrospective from '../../mutations/helpers/safeEndRetrospective'
import safeEndTeamPrompt from '../../mutations/helpers/safeEndTeamPrompt'
import {MutationResolvers} from '../resolverTypes'

const startRecurringMeeting = async (
  meetingSeries: MeetingSeries,
  startTime: Date,
  dataLoader: DataLoaderWorker,
  subOptions: SubOptions
) => {
  const r = await getRethink()
  const {id: meetingSeriesId, teamId, facilitatorId, meetingType} = meetingSeries

  // AUTH
  const [unpaidError, facilitator] = await Promise.all([
    isStartMeetingLocked(teamId, dataLoader),
    dataLoader.get('users').loadNonNull(facilitatorId)
  ])
  if (unpaidError) return standardError(new Error(unpaidError), {userId: facilitatorId})

  const [lastMeeting, meetingSettings] = await Promise.all([
    dataLoader.get('lastMeetingByMeetingSeriesId').load(meetingSeriesId),
    dataLoader.get('meetingSettingsByType').load({teamId, meetingType})
  ])

  const rrule = RRuleSet.parse(meetingSeries.recurrenceRule)
  const scheduledEndTime = getNextRRuleDate(rrule)

  const meetingName = createMeetingSeriesTitle(meetingSeries.title, startTime, rrule.tzid)
  const meeting = await (async () => {
    if (meetingSeries.meetingType === 'teamPrompt') {
      const teamPromptMeeting = lastMeeting as MeetingTeamPrompt | null
      const meeting = await safeCreateTeamPrompt(
        meetingName,
        teamId,
        facilitatorId,
        r,
        dataLoader,
        {
          scheduledEndTime,
          meetingSeriesId: meetingSeries.id,
          meetingPrompt: teamPromptMeeting?.meetingPrompt ?? DEFAULT_PROMPT
        }
      )
      await r.table('NewMeeting').insert(meeting).run()
      const data = {teamId, meetingId: meeting.id}
      publish(SubscriptionChannel.TEAM, teamId, 'StartTeamPromptSuccess', data, subOptions)
      return meeting
    } else if (meetingSeries.meetingType === 'retrospective') {
      const {totalVotes, maxVotesPerGroup, disableAnonymity, templateId} =
        (lastMeeting as MeetingRetrospective) ?? {
          templateId: meetingSettings.selectedTemplateId,
          ...meetingSettings
        }
      const meeting = await safeCreateRetrospective(
        {
          teamId,
          facilitatorUserId: facilitatorId,
          totalVotes,
          maxVotesPerGroup,
          disableAnonymity,
          templateId,
          videoMeetingURL: undefined,
          meetingSeriesId: meetingSeries.id,
          scheduledEndTime,
          name: meetingName
        },
        dataLoader
      )
      await r.table('NewMeeting').insert(meeting).run()
      const data = {teamId, meetingId: meeting.id}
      publish(SubscriptionChannel.TEAM, teamId, 'StartRetrospectiveSuccess', data, subOptions)
      return meeting
    }
    return standardError(new Error('Unhandled recurring meeting type'), {
      tags: {meetingSeriesId: meetingSeries.id, meetingType: meetingSeries.meetingType}
    })
  })()

  if ('error' in meeting) {
    return meeting
  }

  IntegrationNotifier.startMeeting(dataLoader, meeting.id, teamId)
  analytics.meetingStarted(facilitator, meeting)
  return undefined
}

const processRecurrence: MutationResolvers['processRecurrence'] = async (
  _source,
  _args,
  context
) => {
  const {dataLoader, socketId: mutatorId} = context
  const r = await getRethink()
  const now = new Date()
  const operationId = dataLoader.share()
  const subOptions = {mutatorId, operationId}

  // RESOLUTION
  // Find any meetings with a scheduledEndTime before now, and close them
  const meetingsToEnd = await r
    .table('NewMeeting')
    .between([false, r.minval], [false, now], {index: 'hasEndedScheduledEndTime'})
    .run()

  const res = await tracer.trace('processRecurrence.endMeetings', async () =>
    Promise.all(
      meetingsToEnd.map((meeting) => {
        if (isMeetingTeamPrompt(meeting)) {
          return safeEndTeamPrompt({meeting, now, context, r, subOptions})
        } else if (isMeetingRetrospective(meeting)) {
          return safeEndRetrospective({meeting, now, context})
        } else {
          return standardError(new Error('Unhandled recurring meeting type'), {
            tags: {meetingId: meeting.id, meetingType: meeting.meetingType}
          })
        }
      })
    )
  )

  const meetingsEnded = res.filter((res) => !('error' in res)).length

  let meetingsStarted = 0

  // For each active meeting series, get the meeting start times (according to rrule) after the most
  // recent meeting start time and before now.
  const activeMeetingSeries = await tracer.trace(
    'processRecurrence.getActiveMeetingSeries',
    getActiveMeetingSeries
  )
  await tracer.trace('processRecurrence.startActiveMeetingSeries', async () =>
    Promise.allSettled(
      activeMeetingSeries.map(async (meetingSeries) => {
        const seriesTeam = await dataLoader.get('teams').loadNonNull(meetingSeries.teamId)
        if (seriesTeam.isArchived || !seriesTeam.isPaid) {
          return
        }

        const [seriesOrg, lastMeeting] = await Promise.all([
          dataLoader.get('organizations').loadNonNull(seriesTeam.orgId),
          dataLoader.get('lastMeetingByMeetingSeriesId').load(meetingSeries.id)
        ])

        if (seriesOrg.lockedAt) {
          return
        }

        // For meetings that should still be active, start the meeting and set its end time.
        // Any subscriptions are handled by the shared meeting start code
        const rrule = RRuleSet.parse(meetingSeries.recurrenceRule)

        // Only get meetings that should currently be active, i.e. meetings that should have started
        // within the last 24 hours, started after the last meeting in the series, and started before
        // 'now'.
        const fromDate = lastMeeting
          ? new Date(
              Math.max(lastMeeting.createdAt.getTime() + ms('10m'), now.getTime() - ms('24h'))
            )
          : new Date(0)
        const newMeetingsStartTimes = rrule.between(
          DateTime.fromString(toDateTime(dayjs(fromDate), rrule.tzid)),
          DateTime.fromString(toDateTime(dayjs(), rrule.tzid))
        )
        for (const startTime of newMeetingsStartTimes) {
          const err = await tracer.trace('startRecurringMeeting', async (span) => {
            span?.addTags({meetingSeriesId: meetingSeries.id})
            return startRecurringMeeting(
              meetingSeries,
              fromDateTime(startTime.toString(), rrule.tzid).toDate(),
              dataLoader,
              subOptions
            )
          })
          if (!err) meetingsStarted++
        }
      })
    )
  )

  const data = {meetingsStarted, meetingsEnded}
  return data
}

export default processRecurrence
