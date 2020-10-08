import {GraphQLID, GraphQLNonNull} from 'graphql'
import {SubscriptionChannel} from 'parabol-client/types/constEnums'
import {IPokerTemplate, IPokerMeetingSettings, MeetingTypeEnum} from 'parabol-client/types/graphql'
import getRethink from '../../database/rethinkDriver'
import {getUserId, isTeamMember} from '../../utils/authorization'
import publish from '../../utils/publish'
import standardError from '../../utils/standardError'
import RemovePokerTemplatePayload from '../types/RemovePokerTemplatePayload'

const removePokerTemplate = {
  description: 'Remove a poker meeting template',
  type: RemovePokerTemplatePayload,
  args: {
    templateId: {
      type: new GraphQLNonNull(GraphQLID)
    }
  },
  async resolve(_source, {templateId}, {authToken, dataLoader, socketId: mutatorId}) {
    const r = await getRethink()
    const now = new Date()
    const operationId = dataLoader.share()
    const subOptions = {operationId, mutatorId}
    const template = await r
      .table('MeetingTemplate')
      .get(templateId)
      .run()
    const viewerId = getUserId(authToken)

    // AUTH
    if (!template || !isTeamMember(authToken, template.teamId) || !template.isActive) {
      return standardError(new Error('Team not found'), {userId: viewerId})
    }

    // VALIDATION
    const {teamId} = template
    const {templates, settings} = await r({
      templates: (r
        .table('MeetingTemplate')
        .getAll(teamId, {index: 'teamId'})
        .filter({isActive: true, type: MeetingTypeEnum.poker})
        .orderBy('name')
        .coerceTo('array') as unknown) as IPokerTemplate[],
      settings: (r
        .table('MeetingSettings')
        .getAll(teamId, {index: 'teamId'})
        .filter({meetingType: MeetingTypeEnum.poker})
        .nth(0) as unknown) as IPokerMeetingSettings
    }).run()

    // RESOLUTION
    const {id: settingsId} = settings
    await r({
      template: r
        .table('MeetingTemplate')
        .get(templateId)
        .update({isActive: false, updatedAt: now}),
      dimensions: r
        .table('TemplateDimension')
        .getAll(teamId, {index: 'teamId'})
        .filter({
          templateId
        })
        .update({
          isActive: false,
          updatedAt: now
        }),
      scales: r
        .table('TemplateScale')
        .getAll(teamId, {index: 'teamId'})
        .filter({
          templateId
        })
        .update({
          isActive: false,
          updatedAt: now
        })
    }).run()

    if (settings.selectedTemplateId === templateId) {
      const nextTemplate = templates.find((template) => template.id !== templateId)
      const nextTemplateId = nextTemplate?.id ?? 'estimatedEffortTemplate'
      await r
        .table('MeetingSettings')
        .get(settingsId)
        .update({
          selectedTemplateId: nextTemplateId
        })
        .run()
    }

    const data = {templateId, settingsId}
    publish(SubscriptionChannel.TEAM, teamId, 'RemovePokerTemplatePayload', data, subOptions)
    return data
  }
}

export default removePokerTemplate
