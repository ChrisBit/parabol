export interface JiraUser {
  self: string
  key: string
  accountId: string
  name: string
  emailAddress: string
  avatarUrls: {[key: string]: string}
  displayName: string
  active: boolean
  timeZone: string
}

export interface AccessibleResource {
  id: string
  name: string
  scopes: string[]
  avatarUrl: string
}

export interface JiraProject {
  self: string
  id: string
  key: string
  name: string
  avatarUrls: {
    '48x48': string
    '24x24': string
    '16x16': string
    '32x32': string
  }
  projectCategory: {
    self: string
    id: string
    name: string
    description: string
  }
  simplified: boolean
  style: string
}

export interface JiraProjectResponse {
  self: string
  nextPage: string
  maxResults: number
  startAt: number
  total: number
  isLast: boolean
  values: JiraProject[]
}

export interface JiraIssueType {
  self: string
  id: string
  description: string
  iconUrl: string
  name: string
  subtask: boolean
  fields?: {
    issuetype: {
      required: boolean
      name: string
      key: string
      hasDefaultValue: false
      operations: string[]
    }
  }
}

export interface AtlassianError {
  code: number
  message: string
}

interface GetProjectsResult {
  cloudId: string
  newProjects: JiraProject[]
}

interface Reporter {
  id: string
}

interface Assignee {
  id: string
}

interface CreateIssueFields {
  assignee: Assignee
  summary: string
  description?: object
  reporter?: Reporter // probably can't use, it throws a lot of errors
  project?: Partial<JiraProject>
  issuetype?: Partial<JiraIssueType>
}

interface IssueCreateMetadata {
  projects: (Pick<JiraProject, 'self' | 'id' | 'key' | 'name' | 'avatarUrls'> & {
    issuetypes: JiraIssueType[]
  })[]
}

interface JiraCreateIssueResponse {
  id: string
  key: string
  self: string
}

type GetProjectsCallback = (error: AtlassianError | null, result: GetProjectsResult | null) => void

interface JiraError {
  errorMessages: any[]
  errors: {
    [fieldName: string]: string
  }
}

type JiraRenderedFields = any
type JiraIssueProperties = any
type JiraIssueNames = any
type JiraIssueSchema = any
type JiraIssueTransition = any
type JiraOperations = any
type JiraIssueUpdateMetadata = any
type JiraPageOfChangelogs = any
type JiraVersionedRepresentations = any
type JiraIncludedFields = any


interface JiraIssueBean<F = {description: any, summary: string}> {
  expand: string
  id: string
  self: string
  key: string
  renderedFields: JiraRenderedFields
  properties: JiraIssueProperties
  names: JiraIssueNames
  schema: JiraIssueSchema
  transitions: JiraIssueTransition[]
  operations: JiraOperations
  editmeta: JiraIssueUpdateMetadata
  changelog: JiraPageOfChangelogs
  versionedRepresentations: JiraVersionedRepresentations
  fieldsToInclude: JiraIncludedFields
  fields: F

}

interface JiraSearchResponse<T = {summary: string, description: string}> {
  expand: string,
  startAt: number,
  maxResults: number
  total: number
  issues: {
    expand: string
    id: string
    self: string
    key: string
    fields: T
  }[]
}

interface JiraField {
  clauseNames: string[]
  custom: boolean
  id: string
  key: string
  name: string
  navigable: boolean
  orderable: boolean
  schema: {
    custom: string
    customId: number
    type: string
  }
  searchable: boolean
  untranslatedName: string
}

export default abstract class AtlassianManager {
  abstract fetch: any
  static SCOPE = 'read:jira-user read:jira-work write:jira-work offline_access'
  accessToken: string
  private readonly get: (url: string) => any
  private readonly post: (url: string, payload: object) => any
  private readonly put: (url: string, payload: object) => any
  // the any is for node until we can use tsc in nodeland
  cache: {[key: string]: {result: any; expiration: number | any}} = {}
  timeout = 5000

  constructor(accessToken: string) {
    this.accessToken = accessToken
    const headers = {
      // an Authorization requires a preflight request, ie reqs are slow
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json' as 'application/json',
      'Content-Type': 'application/json'
    }
    this.post = async (url, payload) => {
      const res = await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      })
      return res.json()
    }

    this.put = async (url, payload) => {
      const res = await this.fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload)
      })
      if (res.status == 204) return null
      return res.json()
    }

    this.get = async (url) => {
      const record = this.cache[url]
      if (!record) {
        const res = await this.fetch(url, {headers})
        const result = await res.json()
        this.cache[url] = {
          result,
          expiration: setTimeout(() => {
            delete this.cache[url]
          }, this.timeout)
        }
      } else {
        clearTimeout(record.expiration)
        record.expiration = setTimeout(() => {
          delete this.cache[url]
        }, this.timeout)
      }
      return this.cache[url].result
    }
  }

  async getAccessibleResources() {
    return this.get('https://api.atlassian.com/oauth/token/accessible-resources') as
      | AccessibleResource[]
      | AtlassianError
  }

  async getMyself(cloudId: string) {
    return this.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`) as
      | JiraUser
      | AtlassianError
  }

  async getPaginatedProjects(cloudId: string, url: string, callback: GetProjectsCallback) {
    const res = (await this.get(url)) as JiraProjectResponse | AtlassianError
    if ('message' in res) {
      callback(res, null)
    } else {
      callback(null, {cloudId, newProjects: res.values})
      if (res.nextPage) {
        await this.getPaginatedProjects(cloudId, res.nextPage, callback).catch(console.error)
      }
    }
  }

  async getProjects(cloudIds: string[], callback: GetProjectsCallback) {
    return Promise.all(
      cloudIds.map(async (cloudId) => {
        return this.getPaginatedProjects(
          cloudId,
          `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project/search?orderBy=name`,
          callback
        ).catch(console.error)
      })
    )
  }

  async getProject(cloudId: string, projectId: string) {
    return this.get(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project/${projectId}`
    ) as JiraProject | AtlassianError
  }

  async convertMarkdownToADF(markdown: string) {
    return this.post('https://api.atlassian.com/pf-editor-service/convert?from=markdown&to=adf', {
      input: markdown
    }) as object
  }

  async getCreateMeta(cloudId: string, projectKeys?: string[]) {
    let args = ''
    if (projectKeys) {
      args += `projectKeys=${projectKeys.join(',')}`
    }
    if (args.length) {
      args = '?' + args
    }
    return this.get(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/createmeta${args}`
    ) as IssueCreateMetadata | AtlassianError | JiraError
  }

  async createIssue(cloudId: string, projectKey: string, issueFields: CreateIssueFields) {
    const payload = {
      fields: {
        project: {
          key: projectKey
        },
        ...issueFields
      } as CreateIssueFields
    }
    return this.post(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue`, payload) as
      | JiraCreateIssueResponse
      | AtlassianError
      | JiraError
  }

  async getCloudNameLookup() {
    const sites = await this.getAccessibleResources()
    const cloudNameLookup = {} as {[cloudId: string]: string}
    if ('message' in sites) {
      return cloudNameLookup
    }
    sites.forEach((site) => {
      cloudNameLookup[site.id] = site.name
    })
    return cloudNameLookup
  }

  async getIssue(cloudId: string, issueKey: string) {
    const [cloudNameLookup, issueRes] = await Promise.all([
      this.getCloudNameLookup(),
      this.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}?fields=summary,description`) as AtlassianError | JiraError | JiraIssueBean
    ])
    if ('fields' in issueRes) {
      (issueRes.fields as any).cloudName = cloudNameLookup[cloudId]
    }
    return issueRes as AtlassianError | JiraError | JiraIssueBean<{description: any, summary: string, cloudName: string}>
  }

  async getIssues(queryString: string, isJQL: boolean, projectKeyFilters: {cloudId: string, projectId?: string}[]) {
    const projectsByCloudId = {} as {[cloudId: string]: string[]}
    projectKeyFilters.forEach((project) => {
      const {cloudId, projectId} = project
      projectsByCloudId[cloudId] = projectsByCloudId[cloudId] || []
      if (projectId) {
        projectsByCloudId[cloudId].push(projectId)
      }
    })
    const cloudIds = Object.keys(projectsByCloudId)
    const allIssues = [] as {id: number, key: string, summary: string, cloudId: string, cloudName: string}[]
    let firstError: string | null = null

    const reqs = cloudIds.map(async (cloudId) => {
      // TODO add project filter
      // const projects = projectsByCloudId[cloudId]
      const order = 'order by lastViewed DESC'
      const jql = queryString ? isJQL ? queryString : `text ~ \"${queryString}\" ${order}` : order
      const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search`
      const payload = {
        jql,
        maxResults: 100,
        fields: ['summary', 'description']
      }
      // TODO add type
      const res = await this.post(url, payload) as AtlassianError | JiraError | JiraSearchResponse
      if ('issues' in res) {
        const {issues} = res
        issues.forEach((issue) => {
          const {id, key, fields} = issue
          const {summary} = fields
          allIssues.push({key, summary, cloudId, id: Number(id), cloudName: ''})
        })
      }
    })
    const [cloudNameLookup] = await Promise.all([
      this.getCloudNameLookup() as any,
      ...reqs
    ])
    allIssues.forEach((issue) => {
      issue.cloudName = cloudNameLookup[issue.cloudId]
    })
    return {error: firstError, issues: allIssues}
  }

  async getComments(cloudId: string, issueKey: string) {
    return this.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}/comment`) as any
  }

  async getFields(cloudId: string) {
    return this.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/field`) as JiraField[]
  }

  async addComment(cloudId: string, issueKey: string, body: object) {
    const payload = {
      body
    }
    return this.post(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}/comment`, payload) as any
  }

  async updateStoryPoints(cloudId: string, issueKey: string, storyPoints: string | number, dimensionName: string | null) {
    // try to update the field by dimension name.
    // if the dimension name is null, use the jira defaults
    // if we can't trigger an update, then just write a comment
    const fields = await this.getFields(cloudId)
    const searchFields = fields.map((field) => ({
      ...field,
      searchName: field.name.toLowerCase().trim()
    }))

    let fieldsToTry = [] as JiraField[]
    if (!dimensionName) {
      const namesToTry = ['Story Points', 'Story point estimate'].map((val) => val.toLowerCase())
      fieldsToTry = searchFields.filter((field) => namesToTry.includes(field.searchName))
    } else {
      const normalizedDimensionName = dimensionName.toLowerCase().trim()
      fieldsToTry = searchFields.filter((field) => field.searchName === normalizedDimensionName)
    }

    let updatedFieldSuccess = false
    if (fieldsToTry.length > 0) {
      const res = await Promise.all(fieldsToTry.map((field) => {
        const {id} = field
        const payload = {
          fields: {
            [id]: storyPoints
          }
        }
        return this.put(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}`, payload)
      }))
      updatedFieldSuccess = res.indexOf(null) !== -1
    }
    if (!updatedFieldSuccess) {
      await this.addComment(cloudId, issueKey, {
        "version": 1,
        "type": "doc",
        "content": [
          {
            "type": "paragraph",
            "content": [
              {
                "type": "text",
                "text": "This issue is worth "
              },
              {
                "type": "text",
                "text": `${storyPoints} story points`,
                "marks": [
                  {
                    "type": "strong"
                  }
                ]
              },
              {
                "type": "text",
                "text": "."
              }
            ]
          },
          {
            "type": "paragraph",
            "content": [
              {
                "type": "text",
                "text": "Visit the meeting where it happened at "
              },
              {
                "type": "text",
                "text": "Parabol",
                "marks": [
                  {
                    "type": "link",
                    "attrs": {
                      "href": "http://action.parabol.co"
                    }
                  }
                ]
              },
              {
                "type": "text",
                "text": "."
              }
            ]
          }
        ]
      })
    }
    return true
  }

  async getIssues(queryString: string, isJQL: boolean, projectKeyFilters: {cloudId: string, projectId?: string}[]) {
    const projectsByCloudId = {} as {[cloudId: string]: string[]}
    projectKeyFilters.forEach((project) => {
      const {cloudId, projectId} = project
      projectsByCloudId[cloudId] = projectsByCloudId[cloudId] || []
      if (projectId) {
        projectsByCloudId[cloudId].push(projectId)
      }
    })
    const cloudIds = Object.keys(projectsByCloudId)
    const allIssues = [] as {id: number, key: string, summary: string, cloudId: string, cloudName: string}[]
    let firstError: string | null = null
    const sitesPromise = this.getAccessibleResources()
    const reqs = cloudIds.map(async (cloudId) => {
      // TODO add project filter
      // const projects = projectsByCloudId[cloudId]
      const order = 'order by lastViewed DESC'
      const jql = queryString ? isJQL ? queryString : `text ~ \"${queryString}\" ${order}` : order
      const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search`
      const payload = {
        jql,
        maxResults: 100,
        fields: ['summary', 'description']
      }
      // TODO add type
      const res = await this.post(url, payload) as AtlassianError | JiraError | JiraSearchResponse
      if ('issues' in res) {
        const {issues} = res
        issues.forEach((issue) => {
          const {id, key, fields} = issue
          const {summary} = fields
          allIssues.push({key, summary, cloudId, id: Number(id), cloudName: ''})
        })
      }
    })
    await Promise.all(reqs)
    const sites = await sitesPromise
    if ('message' in sites) {
      // no cloud name available
    } else {
      const cloudNameLookup = {} as {[cloudId: string]: string}
      sites.forEach((site) => {
        cloudNameLookup[site.id] = site.name
      })
      allIssues.forEach((issue) => {
        issue.cloudName = cloudNameLookup[issue.cloudId]
      })
    }
    return {error: firstError, issues: allIssues}
  }

  async getComments(cloudId: string, issueKey: string) {
    return this.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}/comment`) as any
  }

  async getFields(cloudId: string) {
    return this.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/field`) as JiraField[]
  }

  async addComment(cloudId: string, issueKey: string, body: object) {
    const payload = {
      body
    }
    return this.post(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}/comment`, payload) as any
  }

  async updateStoryPoints(cloudId: string, issueKey: string, storyPoints: string | number, dimensionName: string | null) {
    // try to update the field by dimension name.
    // if the dimension name is null, use the jira defaults
    // if we can't trigger an update, then just write a comment
    const fields = await this.getFields(cloudId)
    const searchFields = fields.map((field) => ({
      ...field,
      searchName: field.name.toLowerCase().trim()
    }))

    let fieldsToTry = [] as JiraField[]
    if (!dimensionName) {
      const namesToTry = ['Story Points', 'Story point estimate'].map((val) => val.toLowerCase())
      fieldsToTry = searchFields.filter((field) => namesToTry.includes(field.searchName))
    } else {
      const normalizedDimensionName = dimensionName.toLowerCase().trim()
      fieldsToTry = searchFields.filter((field) => field.searchName === normalizedDimensionName)
    }

    let updatedFieldSuccess = false
    if (fieldsToTry.length > 0) {
      const res = await Promise.all(fieldsToTry.map((field) => {
        const {id} = field
        const payload = {
          fields: {
            [id]: storyPoints
          }
        }
        return this.put(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}`, payload)
      }))
      updatedFieldSuccess = res.indexOf(null) !== -1
    }
    if (!updatedFieldSuccess) {
      await this.addComment(cloudId, issueKey, {
        "version": 1,
        "type": "doc",
        "content": [
          {
            "type": "paragraph",
            "content": [
              {
                "type": "text",
                "text": "This issue is worth "
              },
              {
                "type": "text",
                "text": `${storyPoints} story points`,
                "marks": [
                  {
                    "type": "strong"
                  }
                ]
              },
              {
                "type": "text",
                "text": "."
              }
            ]
          },
          {
            "type": "paragraph",
            "content": [
              {
                "type": "text",
                "text": "Visit the meeting where it happened at "
              },
              {
                "type": "text",
                "text": "Parabol",
                "marks": [
                  {
                    "type": "link",
                    "attrs": {
                      "href": "http://action.parabol.co"
                    }
                  }
                ]
              },
              {
                "type": "text",
                "text": "."
              }
            ]
          }
        ]
      })
    }
    return true
  }
}
