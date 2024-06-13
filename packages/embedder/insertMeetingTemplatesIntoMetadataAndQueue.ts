import {sql} from 'kysely'
import getKysely from 'parabol-server/postgres/getKysely'
import getModelManager from './ai_models/ModelManager'
import {getEmbedderPriority} from './getEmbedderPriority'

export interface MeetingTemplateMeta {
  id: string
  teamId: string
  updatedAt: Date
}

export const insertMeetingTemplatesIntoMetadataAndQueue = async (
  meetingTemplates: MeetingTemplateMeta[],
  maxDelayInDays: number
) => {
  const pg = getKysely()
  const metadataRows = meetingTemplates.map(({id, teamId, updatedAt}) => ({
    refId: id,
    objectType: 'meetingTemplate' as const,
    teamId,
    refUpdatedAt: updatedAt
  }))
  if (!metadataRows[0]) return

  const modelManager = getModelManager()
  const tableNames = [...modelManager.embeddingModels.keys()]
  const priority = getEmbedderPriority(maxDelayInDays)
  // This is ugly but it runs fast, which is what we need for historical data
  return pg
    .with('Insert', (qc) =>
      qc
        .insertInto('EmbeddingsMetadata')
        .values(metadataRows)
        .onConflict((oc) => oc.doNothing())
        .returning('id')
    )
    .with('Metadata', (qc) =>
      qc
        .selectFrom('Insert')
        .fullJoin(
          sql<{model: string}>`UNNEST(ARRAY[${sql.join(tableNames)}])`.as('model'),
          (join) => join.onTrue()
        )
        .select(['id', 'model'])
    )
    .insertInto('EmbeddingsJobQueue')
    .columns(['jobType', 'priority', 'embeddingsMetadataId', 'model'])
    .expression(({selectFrom}) =>
      selectFrom('Metadata').select(({lit, ref}) => [
        sql.lit('embed:start').as('jobType'),
        lit(priority).as('priority'),
        ref('Metadata.id').as('embeddingsMetadataId'),
        ref('Metadata.model').as('model')
      ])
    )
    .execute()
}
