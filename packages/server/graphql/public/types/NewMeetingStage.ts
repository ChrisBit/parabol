import GenericMeetingStage from '../../../database/types/GenericMeetingStage'
import {Logger} from '../../../utils/Logger'
import {getUserId} from '../../../utils/authorization'
import {NewMeetingPhaseTypeEnum, NewMeetingStageResolvers} from '../resolverTypes'

export interface NewMeetingStageSource extends GenericMeetingStage {
  meetingId: string
  teamId: string
  phaseType: NewMeetingPhaseTypeEnum
}

const NewMeetingStage: NewMeetingStageResolvers = {
  meeting: ({meetingId}, _args, {dataLoader}) => dataLoader.get('newMeetings').load(meetingId),

  phase: async ({meetingId, phaseType, teamId}, _args, {dataLoader}) => {
    const meeting = await dataLoader.get('newMeetings').load(meetingId)
    const {phases} = meeting
    const phase = phases.find((phase) => phase.phaseType === phaseType)!
    return {...phase, meetingId, teamId}
  },

  isViewerReady: ({readyToAdvance}, _args, {authToken}) => {
    const viewerId = getUserId(authToken)
    return readyToAdvance?.includes(viewerId) ?? false
  },

  readyCount: async ({meetingId, readyToAdvance}, _args, {dataLoader}, ref) => {
    if (!readyToAdvance) return 0
    if (!meetingId) Logger.log('no meetingid', ref)
    const meeting = await dataLoader.get('newMeetings').load(meetingId)
    const {facilitatorUserId} = meeting
    return readyToAdvance.filter((userId: string) => userId !== facilitatorUserId).length
  },

  timeRemaining: ({scheduledEndTime}) => {
    return scheduledEndTime ? scheduledEndTime.valueOf() - Date.now() : null
  }
}

export default NewMeetingStage
